import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getClinicName } from "@/config";
import { resetServerEnvCache } from "@/lib/env";
import {
  createTwilioMessagingClient,
  setTwilioMessaging,
  type FetchLike,
  type TwilioMessaging,
} from "./messaging";
import {
  buildMinimalBody,
  messagingChannels,
  notifyChannels,
  parseBookingRecord,
  readMessageFacts,
  type NotificationChannel,
  type NotificationRequest,
} from "./notification";

/**
 * The notification abstraction that SMS and WhatsApp sit behind (#60).
 *
 * Three things are being pinned here, and the third is why the module exists:
 *
 *   1. Channel selection. No Twilio variables is the ordinary deployment, and
 *      it has to produce the same set of channels it always did.
 *   2. Failure isolation. One channel refusing a message is that channel's
 *      problem; a patient who got the email has been told, and the text
 *      failing does not un-tell them.
 *   3. The message body. A text message is the worst place this app could put
 *      a patient's record: it is stored on a carrier, read over a radio, and
 *      rendered by a handset with no redaction policy at all. The body is
 *      therefore built from an allowlist of two scheduling facts, and the
 *      tests assert it on the wire rather than on the value the builder
 *      returned -- a body that is safe in memory and unsafe in a POST is still
 *      unsafe.
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

/**
 * The record a booking actually produces, with every field a patient can fill
 * in. Each PHI value is a distinct sentinel so a leak names its own source.
 */
const record = {
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
};

/** Nothing from this list may appear in a message body. */
const PHI_SENTINELS = [
  "Ada",
  "Lovelace",
  "ada@example.test",
  "1985-12-10",
  "dolor de cabeza",
  "Psychiatrist",
  "HOSP-6f1c0f0e",
  // Field names too: a body that names the record's fields is a body that is
  // reporting on the record rather than confirming an appointment.
  "patientInfo",
  "insurance",
];

const request: NotificationRequest = {
  email: {
    to: "ada@example.test",
    subject: "Su cita",
    body: "<p>Martes 09:30</p>",
  },
  record,
  language: "spanish",
};

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

let captured: Captured[] = [];
let status = 201;

/** The real client over an injected transport, so the wire format is asserted. */
function stubTwilio(channel: "sms" | "whatsapp", from = "+15558675309"): TwilioMessaging {
  return {
    channel,
    from,
    client: createTwilioMessagingClient(
      { accountSid: "ACtest00000000000000000000000000", authToken: "twilio-auth-token", fromNumber: from },
      (async (url, init) => {
        captured.push({ url, init });
        return status === 201
          ? new Response(JSON.stringify({ sid: "SM0000000000000000000000", status: "queued" }), {
              status: 201,
            })
          : new Response(JSON.stringify({ code: 21617, message: "Message not delivered" }), {
              status,
            });
      }) as FetchLike,
    ),
  };
}

function configureEnv(values: Partial<Record<string, string>>): void {
  for (const key of TWILIO_KEYS) {
    if (!before.has(key)) before.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetServerEnvCache();
}

function outboundBody(index = 0): URLSearchParams {
  return new URLSearchParams(String((captured[index].init as RequestInit).body));
}

/** A channel that records its send and can be told to fail. */
function fakeChannel(
  id: NotificationChannel["id"],
  outcome: "sent" | "throw" = "sent",
): NotificationChannel & { calls: NotificationRequest[] } {
  const calls: NotificationRequest[] = [];
  return {
    id,
    calls,
    isConfigured: () => true,
    async send(input) {
      calls.push(input);
      if (outcome === "throw") throw new Error("vendor exploded");
      return { status: "sent" };
    },
  };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  resetServerEnvCache();
  captured = [];
  status = 201;
  setTwilioMessaging(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setTwilioMessaging(null);
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

describe("parseBookingRecord", () => {
  test("reads the serialised record the booking path produces", () => {
    expect(parseBookingRecord(JSON.stringify(record))).toEqual(record);
  });

  test("returns null for anything that is not a JSON object", () => {
    expect(parseBookingRecord("not json")).toBeNull();
    expect(parseBookingRecord("[1, 2, 3]")).toBeNull();
    expect(parseBookingRecord("")).toBeNull();
  });
});

describe("readMessageFacts", () => {
  test("takes the phone as the address and the agreed time as the body fact", () => {
    const facts = readMessageFacts(record);

    expect(facts.recipient).toBe("+15550100");
    expect(facts.appointmentTime).toBe("2026-10-01 09:30 UTC");
  });

  test("has no recipient when the record carries no phone", () => {
    expect(readMessageFacts({ ...record, patientInfo: undefined }).recipient).toBeNull();
  });

  test("refuses a national-format number rather than guessing a country code", () => {
    // Guessing is how a confirmation ends up on someone else's handset, and a
    // carrier that receives the wrong number still counts as a disclosure.
    expect(readMessageFacts({ ...record, patientInfo: { phone: "555 0100" } }).recipient).toBeNull();
  });

  test("refuses a number with more than fifteen digits", () => {
    expect(
      readMessageFacts({ ...record, patientInfo: { phone: "+15550100123456789" } }).recipient,
    ).toBeNull();
  });

  test("drops an agreed time that is not a timestamp, instead of sending it", () => {
    const facts = readMessageFacts({
      ...record,
      agreedDateTime: "next Tuesday if your knee still hurts",
    });

    expect(facts.appointmentTime).toBeNull();
  });

  test("drops an impossible date rather than reporting it to the patient", () => {
    expect(readMessageFacts({ ...record, agreedDateTime: "2026-02-30T09:30:00.000Z" })
      .appointmentTime).toBeNull();
  });

  test("reads nothing but the two allowlisted paths", () => {
    const facts = readMessageFacts(record);

    // The clinic name is not read out of the record at all: it comes from the
    // environment, so a caller cannot put arbitrary text into every message
    // body by writing a field into their payload.
    expect(Object.keys(facts).sort()).toEqual(["appointmentTime", "recipient"]);
    expect(facts).not.toHaveProperty("hospitalName");
    expect(facts).not.toHaveProperty("referenceNumber");
  });

  test("tolerates a record it does not recognise", () => {
    expect(readMessageFacts(null)).toEqual({ recipient: null, appointmentTime: null });
    expect(readMessageFacts("a string")).toEqual({ recipient: null, appointmentTime: null });
  });
});

describe("buildMinimalBody", () => {
  test("is the template plus the two allowlisted facts", () => {
    const body = buildMinimalBody({
      clinicName: getClinicName(),
      appointmentTime: "2026-10-01 09:30 UTC",
    });

    expect(body).toBe(
      "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
    );
  });

  test("still confirms when there is no time to quote", () => {
    const body = buildMinimalBody({ clinicName: getClinicName(), appointmentTime: null });

    expect(body).toBe("City Medical Center: your appointment is confirmed.");
  });

  test("cannot be made to carry a patient's record", () => {
    const body = buildMinimalBody({
      clinicName: "Ada Lovelace, Psychiatrist",
      appointmentTime: "dolor de cabeza",
    });

    expect(body).toContain("your appointment is confirmed");
  });

  test("stays inside a two-segment SMS", () => {
    const body = buildMinimalBody({
      clinicName: "C".repeat(200),
      appointmentTime: "2026-10-01 09:30 UTC",
    });

    // 160 GSM characters is one segment; anything past that splits and costs
    // more. Truncating a clinic name is a cosmetic loss, a carrier bill is not.
    expect(body.length).toBeLessThanOrEqual(320);
  });
});

describe("messagingChannels", () => {
  test("is empty with no Twilio configuration, so a deployment changes nothing", () => {
    configureEnv({});

    expect(messagingChannels()).toEqual([]);
  });

  test("is one SMS channel for a plain sender", () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000",
      TWILIO_AUTH_TOKEN: "twilio-auth-token",
      TWILIO_FROM_NUMBER: "+15558675309",
    });

    expect(messagingChannels().map((channel) => channel.id)).toEqual(["sms"]);
  });

  test("is one WhatsApp channel for a whatsapp: sender, not both", () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: "ACtest00000000000000000000000000",
      TWILIO_AUTH_TOKEN: "twilio-auth-token",
      TWILIO_FROM_NUMBER: "whatsapp:+15558675309",
    });

    expect(messagingChannels().map((channel) => channel.id)).toEqual(["whatsapp"]);
  });
});

describe("notifyChannels", () => {
  test("reports every channel that ran", async () => {
    const email = fakeChannel("email");
    const sms = fakeChannel("sms");

    const reports = await notifyChannels([email, sms], request);

    expect(reports).toEqual({ email: { status: "sent" }, sms: { status: "sent" } });
    expect(sms.calls[0]).toBe(request);
  });

  test("one channel throwing does not stop the others", async () => {
    const email = fakeChannel("email");
    const failing = fakeChannel("sms", "throw");

    const reports = await notifyChannels([email, failing], request);

    expect(reports.email).toEqual({ status: "sent" });
    expect(reports.sms).toEqual({ status: "failed", reason: "sms_failed" });
  });

  test("a channel that reports a failure does not stop the others either", async () => {
    const email = fakeChannel("email");
    const whatsapp: NotificationChannel = {
      id: "whatsapp",
      isConfigured: () => true,
      async send() {
        return { status: "failed", reason: "whatsapp_failed" };
      },
    };

    const reports = await notifyChannels([whatsapp, email], request);

    expect(reports).toEqual({
      whatsapp: { status: "failed", reason: "whatsapp_failed" },
      email: { status: "sent" },
    });
  });

  test("skips a channel that is not configured, without calling it", async () => {
    const unconfigured: NotificationChannel = {
      id: "sms",
      isConfigured: () => false,
      async send() {
        throw new Error("should not have been called");
      },
    };

    const reports = await notifyChannels([unconfigured], request);

    expect(reports.sms).toEqual({ status: "skipped", reason: "not_configured" });
  });
});

describe("the SMS channel", () => {
  test("addresses the patient and sends the minimal body", async () => {
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    const reports = await notifyChannels([channel], request);

    expect(reports.sms).toEqual({ status: "sent" });
    expect(outboundBody().get("To")).toBe("+15550100");
    expect(outboundBody().get("From")).toBe("+15558675309");
    expect(outboundBody().get("Body")).toBe(
      "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
    );
  });

  test("puts no clinical or identifying content on the wire", async () => {
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    await notifyChannels([channel], request);

    const body = outboundBody().get("Body") ?? "";
    for (const sentinel of PHI_SENTINELS) {
      expect(body).not.toContain(sentinel);
    }
  });

  test("never puts the phone number in the body, only in the address", async () => {
    // The patient's own number is the minimum necessary to reach them, and it
    // is a part of their record. A body reading "confirmation for +15550100"
    // would be a record quoted into a place that stores it.
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    await notifyChannels([channel], request);

    expect(outboundBody().get("Body")).not.toContain("15550100");
    expect(outboundBody().get("Body")).not.toContain("555 0100");
  });

  test("does not carry the translated email body, which is the record in prose", async () => {
    // The email body is what the model was given, which is the whole record.
    // A confirmation text that repeated it would be the disclosure this
    // channel exists to avoid, and it would be invisible in a body that looks
    // like prose rather than like JSON.
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    await notifyChannels([channel], {
      ...request,
      email: {
        to: "ada@example.test",
        subject: "Su cita: dolor de cabeza",
        body: "<p>Ada Lovelace, 1985-12-10: dolor de cabeza, Psychiatrist.</p>",
      },
    });

    const body = outboundBody().get("Body") ?? "";
    for (const sentinel of PHI_SENTINELS) {
      expect(body).not.toContain(sentinel);
    }
    expect(body).toBe(
      "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
    );
  });

  test("cannot be made to carry a record by an extra field in the payload", async () => {
    // The webhook route is authenticated by a shared secret, not by anything
    // about the caller, so the record is not trusted input.
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    await notifyChannels([channel], {
      ...request,
      record: {
        ...record,
        hospitalName: "City Medical Center. Reply with your date of birth to confirm",
        referenceNumber: "diagnose me",
      },
    });

    const body = outboundBody().get("Body") ?? "";
    expect(body).not.toContain("date of birth");
    expect(body).not.toContain("diagnose me");
  });

  test("sends nothing at all when the record has no phone, and says why", async () => {
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    const reports = await notifyChannels([channel], {
      ...request,
      record: { ...record, patientInfo: undefined },
    });

    expect(reports.sms).toEqual({ status: "skipped", reason: "no_recipient" });
    expect(captured).toEqual([]);
  });

  test("isolates a rejected send as a failure of that channel alone", async () => {
    status = 400;
    setTwilioMessaging(stubTwilio("sms"));

    const [channel] = messagingChannels();
    const reports = await notifyChannels([channel], request);

    expect(reports.sms).toEqual({ status: "failed", reason: "sms_failed" });
  });

  test("logs nothing that names the message, the number, or the patient", async () => {
    const lines: string[] = [];
    const capture = (level: "info" | "warn" | "error") =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    const spies = [capture("info"), capture("warn"), capture("error")];

    try {
      status = 400;
      setTwilioMessaging(stubTwilio("sms"));
      const [channel] = messagingChannels();
      await notifyChannels([channel], request);

      expect(lines.length).toBeGreaterThan(0);
      const emitted = lines.join("\n");
      expect(emitted).not.toContain("Ada");
      expect(emitted).not.toContain("dolor de cabeza");
      expect(emitted).not.toContain("15550100");
      expect(emitted).not.toContain("your appointment is confirmed");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("the WhatsApp channel", () => {
  test("addresses both ends over Twilio's WhatsApp channel", async () => {
    setTwilioMessaging(stubTwilio("whatsapp", "whatsapp:+15558675309"));

    const [channel] = messagingChannels();
    const reports = await notifyChannels([channel], request);

    expect(reports.whatsapp).toEqual({ status: "sent" });
    expect(outboundBody().get("From")).toBe("whatsapp:+15558675309");
    expect(outboundBody().get("To")).toBe("whatsapp:+15550100");
  });

  test("carries the same minimal body, with nothing clinical in it", async () => {
    setTwilioMessaging(stubTwilio("whatsapp", "whatsapp:+15558675309"));

    const [channel] = messagingChannels();
    await notifyChannels([channel], request);

    const body = outboundBody().get("Body") ?? "";
    for (const sentinel of PHI_SENTINELS) {
      expect(body).not.toContain(sentinel);
    }
    expect(body).toBe(
      "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
    );
  });
});
