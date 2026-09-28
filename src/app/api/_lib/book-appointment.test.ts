import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import {
  InMemoryAppointmentStore,
  setAppointmentStore,
  spendPatientAction,
} from "@/lib/appointments";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { setRateLimitStore } from "@/lib/rate-limit";
import type { FetchLike } from "@/lib/twilio/messaging";
import { createTwilioVoiceClient, setTwilioVoice } from "@/lib/twilio/voice";
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
  // A test below installs a store whose grant write fails. Left in place it would
  // break every booking after it.
  setAppointmentStore(null);
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

/**
 * A store that is a real one, except that the grant write fails.
 *
 * Shadowed on the instance rather than spread onto a literal: a class's methods
 * live on its prototype, so `{ ...new InMemoryAppointmentStore() }` is an object
 * with no `create` on it at all, and the failure lands somewhere unrelated.
 */
function storeThatCannotGrant(): InMemoryAppointmentStore {
  const store = new InMemoryAppointmentStore();
  store.issueActionGrant = async () => {
    throw new Error("the database could not be reached");
  };
  return store;
}

/**
 * Dialling the clinic, during a booking (#64).
 *
 * Before this, the receptionist was a log line: `intake.booking_simulated`,
 * printed between storing the record and sending the confirmation. These pin the
 * two halves of replacing it.
 *
 * The first is that the default deployment is unchanged. There are no Twilio
 * credentials here and in CI, so every test above takes the unconfigured path,
 * and this block is mostly about asserting that a configured one *reaches* the
 * vendor -- because "it still books" is also what a silently broken dialer looks
 * like.
 *
 * The second is that a call is a network request on the path a patient is
 * waiting on, and the answer is a report rather than an exception. The record is
 * already stored when this runs: throwing would take down a booking that
 * happened, and returning nothing would report a call that was never placed.
 */
describe("dialling the clinic during a booking", () => {
  const voiceConfig = {
    accountSid: "ACtest00000000000000000000000000",
    authToken: "twilio-auth-token",
    fromNumber: "+15558675309",
    toNumber: "+15551230000",
    callbackBaseUrl: "https://clinic.example",
  };

  let calls: { url: string; init: RequestInit | undefined }[] = [];
  let callStatus = 201;

  function installVoice() {
    calls = [];
    callStatus = 201;
    setTwilioVoice({
      from: voiceConfig.fromNumber,
      to: voiceConfig.toNumber,
      callbackBaseUrl: voiceConfig.callbackBaseUrl,
      client: createTwilioVoiceClient(voiceConfig, (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return callStatus === 201
          ? new Response(JSON.stringify({ sid: "CAabc", status: "queued" }), { status: 201 })
          : new Response(JSON.stringify({ code: 21218 }), { status: callStatus });
      }) as unknown as FetchLike),
    });
  }

  beforeEach(() => {
    setRateLimitStore(null);
    installVoice();
  });

  afterEach(() => {
    setTwilioVoice(null);
    setRateLimitStore(null);
  });

  test("places a real call to the clinic", async () => {
    await bookAppointment(submission, "https://clinic.test");

    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get("To")).toBe("+15551230000");
    expect(form.get("From")).toBe("+15558675309");
    expect(form.get("Url")).toBe("https://clinic.example/api/twilio/voice/answer");
  });

  test("still books, and still emails, when the call is placed", async () => {
    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.appointmentId).toBeTruthy();
    expect(emails).toHaveLength(1);
  });

  test("books the appointment even when Twilio refuses the call", async () => {
    // The record is already stored and the confirmation is already on its way.
    // Failing the booking would trade a working appointment for a phone call,
    // which is the wrong way round.
    callStatus = 400;

    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.appointmentId).toBeTruthy();
    expect(emails).toHaveLength(1);
  });

  test("does not put the booking record on the voice request", async () => {
    await bookAppointment(submission, "https://clinic.test");

    const body = String(calls[0].init?.body);
    expect(body).not.toContain("Ada");
    expect(body).not.toContain("ada@example.test");
    expect(body).not.toContain("headache");
  });

  test("does not tell the patient which path ran", async () => {
    // The return value crosses to a page a patient is looking at. A `dialled:
    // true` is a Twilio account's state, not a patient's booking, and it is the
    // sort of field that ends up in a screenshot.
    callStatus = 400;
    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(Object.keys(booking).sort()).toEqual(["appointmentId", "manageUrl", "spectateUrl"]);
  });

  test("places no call at all without the Twilio variables, and books as before", async () => {
    setTwilioVoice(null);

    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.appointmentId).toBeTruthy();
    expect(emails).toHaveLength(1);
  });
});

/**
 * The management link handed to a patient at booking (#59).
 *
 * Minted here because this is the only moment there is both a record to mint one
 * for and an inbox to put it in. Two things are asserted that are really about
 * ordering: the link is minted *before* the confirmation is sent, so the email
 * that says "here is your appointment" also says "here is how to change it", and
 * a failure to mint does not take the booking down with it.
 */
describe("booking a management link", () => {
  test("mints one, and returns it", async () => {
    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.manageUrl).toMatch(/^https:\/\/clinic\.test\/reschedule\//);
  });

  test("puts it in the confirmation, so the patient has it in their inbox", async () => {
    // The payload the LLM is asked to render *is* the email, so the link has to be
    // in what it was given. Captured from the prompt rather than from the
    // rendered body, which this suite stubs.
    let prompt = "";
    setLlmClient({
      async generateJson({ prompt: sent }) {
        if (sent.includes("medical intake form translator")) {
          return { additionalInfo: "headache", medical_department: "Doctor" };
        }
        prompt = sent;
        return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
      },
    });

    await bookAppointment(submission, "https://clinic.test");

    expect(prompt).toContain("/reschedule/");
  });

  test("is a working link, not just a string", async () => {
    const booking = await bookAppointment(submission, "https://clinic.test");

    const token = booking.manageUrl!.split("/reschedule/")[1];
    const spent = await spendPatientAction(token, "reschedule");

    expect(spent.ok).toBe(true);
  });

  test("a root-relative booking gets a root-relative link", async () => {
    // A server action has no trustworthy absolute origin, so it passes an empty
    // one and every URL this builds has to resolve against wherever the patient
    // actually is.
    const booking = await bookAppointment(submission, "");

    expect(booking.spectateUrl).toMatch(/^\/spectate\//);
    expect(booking.manageUrl).toMatch(/^\/reschedule\//);
  });

  test("does not fail the booking when the link cannot be minted", async () => {
    // The appointment exists and the confirmation is on its way. The cost of
    // having no link is a patient who telephones, which is what happened to all of
    // them before this branch. Failing the booking instead would trade a working
    // appointment for a working link.
    setAppointmentStore(storeThatCannotGrant());

    const booking = await bookAppointment(submission, "https://clinic.test");

    expect(booking.appointmentId).toBeTruthy();
    expect(booking.manageUrl).toBeNull();
    expect(emails).toHaveLength(1);
  });

  test("leaves the field out of the email entirely when there is no link", async () => {
    // A `null` in a confirmation body is a broken link in an inbox. An absent
    // field is not there to be clicked.
    setAppointmentStore(storeThatCannotGrant());
    let payload = "";
    setLlmClient({
      async generateJson({ prompt }) {
        if (prompt.includes("medical intake form translator")) {
          return { additionalInfo: "headache", medical_department: "Doctor" };
        }
        payload = prompt;
        return { subject: "Su cita", body: "<p>Listo</p>" };
      },
    });

    await bookAppointment(submission, "https://clinic.test");

    expect(payload).not.toContain("manageUrl");
  });
});
