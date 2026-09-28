import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { deliverConfirmation } from "./deliver-confirmation";

/**
 * Confirmations, now fanned out across the channels a deployment has (#60).
 *
 * The email is the channel this file has always had and the one whose failure
 * still means the patient was not told, because that is the promise the
 * booking path makes. Adding SMS and WhatsApp must not weaken that: with no
 * Twilio configuration the behaviour has to be byte-for-byte what it was, and
 * with it, one transport refusing a message must not stop the others.
 *
 * The model is stubbed; Resend and Twilio are answered over an injected
 * `fetch`, which is what lets these tests assert what actually left the
 * process for a patient's phone.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
  CLINIC_NAME: "City Medical Center",
};

const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;
const before = new Map<string, string | undefined>();

/** The record the booking path serialises into `info`, PHI and all. */
const info = JSON.stringify({
  patientInfo: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Psychiatrist",
    additionalInfo: "dolor de cabeza",
    language: "spanish",
  },
  agreedDateTime: "2026-10-01T09:30:00.000Z",
  confirmed: true,
  hospitalName: "City Medical Center",
  referenceNumber: "HOSP-6f1c0f0e",
});

const PHI_SENTINELS = [
  "Ada",
  "Lovelace",
  "ada@example.test",
  "1985-12-10",
  "dolor de cabeza",
  "Psychiatrist",
  "HOSP-6f1c0f0e",
];

const request = { email: "ada@example.test", language: "spanish" as const, info };

const realFetch = globalThis.fetch;
interface Sent {
  url: string;
  init: RequestInit | undefined;
}

let sent: Sent[] = [];
let resendStatus = 200;
let twilioStatus = 201;

function configureTwilio(fromNumber: string): void {
  for (const key of TWILIO_KEYS) {
    if (!before.has(key)) before.set(key, process.env[key]);
  }
  process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "twilio-auth-token";
  process.env.TWILIO_FROM_NUMBER = fromNumber;
  resetServerEnvCache();
}

function clearTwilio(): void {
  for (const key of TWILIO_KEYS) {
    if (!before.has(key)) before.set(key, process.env[key]);
    delete process.env[key];
  }
  resetServerEnvCache();
}

function toTwilio(): Sent[] {
  return sent.filter((call) => call.url.includes("api.twilio.com"));
}

function toResend(): Sent[] {
  return sent.filter((call) => call.url.includes("api.resend.com"));
}

function twilioBody(): URLSearchParams {
  return new URLSearchParams(String((toTwilio()[0].init as RequestInit).body));
}

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  clearTwilio();
  sent = [];
  resendStatus = 200;
  twilioStatus = 201;

  setLlmClient({
    async generateJson() {
      return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
    },
  });

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    sent.push({ url: href, init });

    if (href.includes("api.twilio.com")) {
      return twilioStatus === 201
        ? new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 })
        : new Response(JSON.stringify({ code: 21617, message: "Message not delivered" }), {
            status: twilioStatus,
          });
    }

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
  resetServerEnvCache();
});

afterAll(() => {
  for (const key of TWILIO_KEYS) {
    const original = before.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetServerEnvCache();
});

describe("deliverConfirmation without Twilio configured", () => {
  test("sends the email and nothing else", async () => {
    const result = await deliverConfirmation(request);

    expect(toResend()).toHaveLength(1);
    expect(toTwilio()).toEqual([]);
    expect(result).toEqual({
      ok: true,
      subject: "Su cita",
      channels: { email: { status: "sent" } },
    });
  });

  test("reports a rejected email as the undelivered confirmation it always was", async () => {
    resendStatus = 422;

    const result = await deliverConfirmation(request);

    // The reason is the closed union the callers switch on. Changing it, or
    // adding a channel name to it, would break every one of them.
    expect(result).toEqual({
      ok: false,
      reason: "email_failed",
      channels: { email: { status: "failed", reason: "email_failed" } },
    });
  });

  test("sends nothing when the confirmation cannot be translated", async () => {
    setLlmClient({
      async generateJson() {
        throw new Error("Translation failed after 3 attempts: unavailable");
      },
    });

    const result = await deliverConfirmation(request);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("translation_failed");
    expect(sent).toEqual([]);
  });
});

describe("deliverConfirmation with Twilio configured", () => {
  test("adds an SMS alongside the email", async () => {
    configureTwilio("+15558675309");

    const result = await deliverConfirmation(request);

    expect(result).toEqual({
      ok: true,
      subject: "Su cita",
      channels: { email: { status: "sent" }, sms: { status: "sent" } },
    });
    expect(toResend()).toHaveLength(1);
    expect(toTwilio()).toHaveLength(1);
    expect(twilioBody().get("To")).toBe("+15550100");
  });

  test("sends over WhatsApp when the sender says WhatsApp", async () => {
    configureTwilio("whatsapp:+15558675309");

    const result = await deliverConfirmation(request);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.channels.whatsapp).toEqual({ status: "sent" });
    expect(result.ok === true && result.channels.sms).toBeUndefined();
    expect(twilioBody().get("From")).toBe("whatsapp:+15558675309");
    expect(twilioBody().get("To")).toBe("whatsapp:+15550100");
  });

  test("keeps the confirmation the email was going to carry", async () => {
    configureTwilio("+15558675309");

    await deliverConfirmation(request);

    const email = new Request("https://api.resend.com/emails", toResend()[0].init);
    const outbound = (await email.json()) as { to: string[]; subject: string; html: string };
    expect(outbound.to).toEqual(["ada@example.test"]);
    expect(outbound.subject).toBe("Su cita");
    expect(outbound.html).toBe("<p>Martes 09:30</p>");
  });

  test("a rejected text message does not undo a delivered email", async () => {
    // The failure isolation, end to end. The patient has the email; reporting
    // the whole confirmation as undelivered because a text was refused would
    // make the booking path throw and tell them to contact the clinic.
    twilioStatus = 400;
    configureTwilio("+15558675309");

    const result = await deliverConfirmation(request);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.channels).toEqual({
      email: { status: "sent" },
      sms: { status: "failed", reason: "sms_failed" },
    });
  });

  test("an undeliverable text does not stop the email being sent", async () => {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      sent.push({ url: href, init });
      if (href.includes("api.twilio.com")) throw new Error("network down");
      return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    configureTwilio("+15558675309");

    const result = await deliverConfirmation(request);

    expect(result.ok).toBe(true);
    expect(toResend()).toHaveLength(1);
  });

  test("a rejected email is still an undelivered confirmation, with the text sent", async () => {
    // The other direction. The status the booking path acts on is the email's,
    // unchanged: a patient told "we could not send the confirmation" is right
    // to believe it, and the text that did go out does not un-say that.
    resendStatus = 422;
    configureTwilio("+15558675309");

    const result = await deliverConfirmation(request);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("email_failed");
    expect(result.ok === false && result.channels).toEqual({
      email: { status: "failed", reason: "email_failed" },
      sms: { status: "sent" },
    });
  });

  test("a record with no phone is skipped rather than failed", async () => {
    configureTwilio("+15558675309");

    const result = await deliverConfirmation({
      ...request,
      info: JSON.stringify({ confirmed: true, agreedDateTime: "2026-10-01T09:30:00.000Z" }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.channels.sms).toEqual({
      status: "skipped",
      reason: "no_recipient",
    });
    expect(toTwilio()).toEqual([]);
  });

  test("a record that is not JSON is skipped rather than failing the email", async () => {
    configureTwilio("+15558675309");

    const result = await deliverConfirmation({ ...request, info: "confirmed" });

    expect(result.ok).toBe(true);
    expect(toResend()).toHaveLength(1);
    expect(result.ok === true && result.channels.sms).toEqual({
      status: "skipped",
      reason: "no_recipient",
    });
  });
});

describe("what a text message is allowed to say", () => {
  test("carries no clinical or identifying content from the booking", async () => {
    configureTwilio("+15558675309");

    await deliverConfirmation(request);

    const body = twilioBody().get("Body") ?? "";
    for (const sentinel of PHI_SENTINELS) {
      expect(body).not.toContain(sentinel);
    }
    expect(body).toBe("City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.");
  });

  test("says no more than the confirmation and the time, whatever the record holds", async () => {
    configureTwilio("+15558675309");

    await deliverConfirmation({
      ...request,
      info: JSON.stringify({
        patientInfo: {
          firstName: "Grace",
          lastName: "Hopper",
          phone: "+15550100",
          dob: "1906-12-09",
          medical_department: "Psychiatrist",
          additionalInfo: "seizures since Tuesday",
        },
        agreedDateTime: "2026-10-01T09:30:00.000Z",
        hospitalName: "City Medical Center. Reply STOP to opt out of all messages",
        referenceNumber: "HOSP-9a2b",
      }),
    });

    const body = twilioBody().get("Body") ?? "";
    for (const sentinel of ["Grace", "Hopper", "1906-12-09", "Psychiatrist", "seizures", "STOP", "HOSP-9a2b"]) {
      expect(body).not.toContain(sentinel);
    }
  });

  test("confirms without a time when the record has no usable one", async () => {
    configureTwilio("+15558675309");

    await deliverConfirmation({
      ...request,
      info: JSON.stringify({
        patientInfo: { phone: "+15550100" },
        agreedDateTime: "whenever the patient is free",
      }),
    });

    expect(twilioBody().get("Body")).toBe(
      "City Medical Center: your appointment is confirmed.",
    );
  });
});
