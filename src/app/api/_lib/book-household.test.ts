import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { openRecord } from "@/lib/phi-token";
import type { IntakeFormData } from "@/lib/validation/intake";
import { bookAppointment } from "./book-appointment";

/**
 * A household booking, end to end through the pipeline (#69).
 *
 * The two things worth proving are that everyone in the household survives the
 * round trip, and that a one-person booking is completely unaffected by any of
 * it. The second is the one that is easy to break by accident: everything here
 * sits on the path of every appointment this app takes, and a household feature
 * that changes a single-patient confirmation email would be a regression
 * affecting every patient rather than a feature.
 *
 * The model and the mail provider are stubbed. Storage, sealing, validation,
 * translation and scheduling are the real implementations.
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

const single: IntakeFormData = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Pediatrician",
  additionalInfo: "dolor de cabeza",
  language: "spanish",
};

const household: IntakeFormData = {
  ...single,
  dependents: [
    {
      firstName: "Maya",
      lastName: "Lovelace",
      dob: "2018-04-02",
      relationship: "child",
      additionalInfo: "fiebre desde anoche",
    },
    {
      firstName: "Byron",
      dob: "1950-07-19",
      relationship: "parent",
      additionalInfo: "",
    },
  ],
};

const realFetch = globalThis.fetch;
let emails: { to: string[]; subject: string }[] = [];
/** The fenced appointment records the email model was asked to render. */
let emailPayloads: Record<string, unknown>[] = [];

const EMAIL_PROMPT_FENCE = /<<<UNTRUSTED_PATIENT_INPUT:appointment>>>\n([\s\S]*?)\nUNTRUSTED_PATIENT_INPUT>>>:appointment/;

/** Capture the fenced record an email prompt carries, if this is one. */
function recordEmailPayload(prompt: string): void {
  const match = EMAIL_PROMPT_FENCE.exec(prompt);
  if (!match) return;
  try {
    emailPayloads.push(JSON.parse(match[1]) as Record<string, unknown>);
  } catch {
    // The prompt always carries valid JSON; a fence that did not would be a
    // change in how the email is built, and these tests would rather fail on
    // their own assertions than throw here.
  }
}

function stubModel() {
  setLlmClient({
    async generateJson({ prompt }) {
      // Every prompt on this path: the account holder's intake translation, one
      // per dependent who said something, and the confirmation email. Which one
      // this is, is decided by what the prompt says.
      if (prompt.includes("medical intake form translator")) {
        if (prompt.includes("fiebre desde anoche")) {
          return { additionalInfo: "fever since last night" };
        }
        if (prompt.includes("dolor de cabeza")) {
          return { additionalInfo: "headache", medical_department: "Pediatrician" };
        }
        return { additionalInfo: "headache" };
      }

      recordEmailPayload(prompt);
      return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
    },
  });
}

beforeEach(() => {
  emails = [];
  emailPayloads = [];
  stubModel();

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    emails.push(
      JSON.parse(String(init?.body)) as { to: string[]; subject: string },
    );
    return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
});

afterAll(() => {
  resetServerEnvCache();
});

describe("a single-patient booking", () => {
  test("is unchanged by household support", async () => {
    const booking = await bookAppointment(single, "https://clinic.test");

    expect(booking.spectateUrl).toMatch(/^https:\/\/clinic\.test\/spectate\/[A-Za-z0-9_-]+$/);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ada@example.test"]);
  });

  test("puts no household in the sealed record", async () => {
    // The token is the patient's link. A `dependents: []` here would be bytes of
    // ciphertext in every link this app ever hands out, and the key is optional
    // on the schema precisely so it is not.
    const booking = await bookAppointment(single, "https://clinic.test");
    const token = booking.spectateUrl.split("/").pop() as string;
    const record = JSON.parse(openRecord(token) as string) as Record<string, unknown>;

    expect(record).not.toHaveProperty("dependents");
  });

  test("names no other person in the confirmation payload", async () => {
    await bookAppointment(single, "https://clinic.test");

    // The email is still sent, and the model is still given the record. What
    // must not appear is a household key, because a confirmation that names
    // people who are not in the booking would be a worse bug than the feature
    // being absent -- and it is the only thing a one-person booking's email
    // could have changed.
    expect(emailPayloads).toHaveLength(1);
    expect(emailPayloads[0]).not.toHaveProperty("household");
  });
});

describe("a household booking", () => {
  test("books every person, translated", async () => {
    const booking = await bookAppointment(household, "https://clinic.test");

    const token = booking.spectateUrl.split("/").pop() as string;
    const record = JSON.parse(openRecord(token) as string) as {
      additionalInfo: string;
      dependents: Array<{ firstName: string; additionalInfo: string }>;
    };

    expect(record.additionalInfo).toBe("headache");
    expect(record.dependents).toHaveLength(2);
    // The point of the whole branch: a clinician reads everyone's account in
    // English, whatever language the household was filled in in.
    expect(record.dependents[0].additionalInfo).toBe("fever since last night");
    expect(record.dependents[1].additionalInfo).toBe("");
  });

  test("keeps the relationship and the date of birth the form collected", async () => {
    const booking = await bookAppointment(household, "https://clinic.test");
    const token = booking.spectateUrl.split("/").pop() as string;
    const record = JSON.parse(openRecord(token) as string) as {
      dependents: Array<{ relationship: string; dob: string; lastName?: string }>;
    };

    expect(record.dependents[0].relationship).toBe("child");
    expect(record.dependents[0].dob).toBe("2018-04-02");
    // `lastName` is optional and was not given for the second person.
    expect(record.dependents[1].lastName).toBeUndefined();
  });

  test("sends one confirmation for the whole household", async () => {
    await bookAppointment(household, "https://clinic.test");

    // One email, to the account holder. Not one per person: the other people
    // generally have no address on file, which is the entire reason the household
    // is one booking rather than several.
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ada@example.test"]);
  });

  test("tells the confirmation who else is in the booking", async () => {
    await bookAppointment(household, "https://clinic.test");

    // The one thing the email has to do that it did not before: confirm that
    // everyone came, not just the account holder. A parent who books a slot for
    // a sick child and receives a confirmation about themselves alone has no way
    // to know the child's appointment was taken.
    expect(emailPayloads).toHaveLength(1);
    const householdInEmail = emailPayloads[0].household as Array<Record<string, unknown>>;

    expect(householdInEmail).toHaveLength(2);
    expect(householdInEmail[0]).toEqual({
      firstName: "Maya",
      relationship: "child",
      additionalInfo: "fever since last night",
    });
    expect(householdInEmail[1].firstName).toBe("Byron");
  });

  test("puts no more of each person in the email than the email needs", async () => {
    await bookAppointment(household, "https://clinic.test");
    const householdInEmail = emailPayloads[0].household as Array<Record<string, unknown>>;

    // A confirmation email goes to the account holder, who already supplied every
    // field on the form. The children's dates of birth are not needed to say
    // "we have booked your appointment for Maya", and an email is forwarded,
    // filed, and kept for years.
    expect(Object.keys(householdInEmail[0]).sort()).toEqual([
      "additionalInfo",
      "firstName",
      "relationship",
    ]);
  });

  test("fails the booking if a dependent cannot be translated", async () => {
    setLlmClient({
      async generateJson({ prompt }) {
        if (prompt.includes("medical intake form translator") && prompt.includes("fiebre")) {
          throw new Error("Translation failed after 3 attempts: unavailable");
        }
        if (prompt.includes("medical intake form translator")) {
          return { additionalInfo: "headache", medical_department: "Pediatrician" };
        }
        return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
      },
    });

    // No half-translated household, and no silent loss of a child. Nothing is
    // stored before this point, so the patient is told to try again.
    await expect(
      bookAppointment(household, "https://clinic.test"),
    ).rejects.toThrow(/unavailable/);
    expect(emails).toEqual([]);
  });
});
