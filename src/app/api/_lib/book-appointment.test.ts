import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import type { IntakeFormData } from "@/lib/validation/intake";
import { bookAppointment } from "./book-appointment";
import { ConfirmationDeliveryError } from "./deliver-confirmation";

/**
 * Booking, and whether the patient was actually told about it (#20).
 *
 * The delivery used to be a `fetch` nobody read, so a patient whose
 * confirmation bounced was told their appointment was confirmed. These tests
 * pin the two things that fixes: a failed send is a failure, and a successful
 * one is not taken on trust.
 *
 * The two network calls are stubbed -- the model and Resend, the latter through
 * the global fetch the SDK uses. Storage, sealing and scheduling are real.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

const submission: IntakeFormData = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "dolor de cabeza",
  language: "spanish",
};

const realFetch = globalThis.fetch;
let resendStatus = 200;
let emails: { to: string[]; subject: string }[] = [];

/** Answer both prompts correctly: an intake translation, and an email. */
function stubModel() {
  setLlmClient({
    async generateJson({ prompt }) {
      if (prompt.includes("medical intake form translator")) {
        return { additionalInfo: "headache", medical_department: "Doctor" };
      }
      return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
    },
  });
}

beforeEach(() => {
  resendStatus = 200;
  emails = [];
  stubModel();
  setAuditLogStore(new InMemoryAuditLogStore());

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
    emails.push(body);

    return resendStatus === 200
      ? new Response(JSON.stringify({ id: "resend-1" }), { status: 200 })
      : new Response(JSON.stringify({ message: "domain not verified" }), {
          status: resendStatus,
        });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
});

afterAll(() => {
  resetServerEnvCache();
});

describe("bookAppointment", () => {
  test("books, and sends the confirmation", async () => {
    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.spectateUrl).toMatch(/^https:\/\/clinic\.test\/spectate\/[A-Za-z0-9_-]+$/);
    expect(booking.appointmentId).toBeTruthy();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ada@example.test"]);
    expect(emails[0].subject).toBe("Su cita");
  });

  test("fails the booking when the confirmation email is rejected", async () => {
    resendStatus = 422;

    // The bug: this used to be a fire-and-forget fetch, and the 422 was read by
    // nobody. The patient was told the appointment was confirmed.
    await expect(bookAppointment(submission, "https://clinic.test")).rejects.toBeInstanceOf(
      ConfirmationDeliveryError,
    );
  });

  test("the failure carries a reason, not the vendor's message", async () => {
    resendStatus = 422;

    try {
      await bookAppointment(submission, "https://clinic.test");
      throw new Error("expected the booking to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmationDeliveryError);
      // A reason is a closed union. A message here ends up in a response body,
      // and Resend's error text can quote the payload it rejected.
      expect((error as ConfirmationDeliveryError).reason).toBe("email_failed");
      expect((error as Error).message).not.toContain("domain not verified");
    }
  });

  test("fails the booking when the confirmation cannot be translated", async () => {
    setLlmClient({
      async generateJson({ prompt }) {
        if (prompt.includes("medical intake form translator")) {
          return { additionalInfo: "headache", medical_department: "Doctor" };
        }
        throw new Error("Translation failed after 3 attempts: unavailable");
      },
    });

    await expect(bookAppointment(submission, "https://clinic.test")).rejects.toBeInstanceOf(
      ConfirmationDeliveryError,
    );
    expect(emails).toEqual([]);
  });

  test("fails the booking when the mail service is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;

    await expect(bookAppointment(submission, "https://clinic.test")).rejects.toBeInstanceOf(
      ConfirmationDeliveryError,
    );
  });

  test("does not return a booking whose confirmation never went out", async () => {
    resendStatus = 500;

    const result = await bookAppointment(submission, "https://clinic.test").catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(ConfirmationDeliveryError);
    // Nothing to mistake for a success: no id, no spectate URL.
    expect(result).not.toHaveProperty("spectateUrl");
  });

  test("a booking is in the audit trail, and carries no part of the record", async () => {
    // The write path is audited by the store rather than by this function, which
    // is the point: a booking cannot happen without leaving an entry, and a
    // caller added later cannot skip it.
    const trail = new InMemoryAuditLogStore();
    setAuditLogStore(trail);

    const booking = await bookAppointment(submission, "https://clinic.test");
    const logs = await trail.read();

    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("APPOINTMENT_CREATED");
    expect(logs[0].resource).toBe(`appointment:${booking.appointmentId}`);
    expect(logs[0].details).toEqual({
      reason: "intake",
      status: "scheduled",
      language: "spanish",
    });

    // The trail is immutable and cannot be redacted, so what is in it has to be
    // the appointment id and three non-identifying fields.
    const serialised = JSON.stringify(logs);
    for (const leak of ["Ada", "Lovelace", "ada@example.test", "dolor de cabeza", "1985-12-10"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  test("a booking that cannot be audited does not happen", async () => {
    // Fail closed, and the fail-closed side that is not a crypto key: no trail
    // entry means no appointment, rather than an appointment nobody can account
    // for. The submission is still translated and the confirmation still goes
    // nowhere, because the record is stored before the email is sent.
    setAuditLogStore({
      async append() {
        throw new Error("The database could not be reached.");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    await expect(bookAppointment(submission, "https://clinic.test")).rejects.toThrow(
      /could not be reached/,
    );
    expect(emails).toEqual([]);
  });
});
