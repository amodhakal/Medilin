import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import {
  createTwilioMessagingClient,
  getTwilioMessaging,
  setTwilioMessaging,
  splitChannelPrefix,
  TwilioMessagingError,
  type FetchLike,
  type TwilioConfig,
} from "./messaging";

/**
 * The Twilio transport for SMS and WhatsApp (#60).
 *
 * The REST call is the seam, not the SDK: no Twilio credentials exist in CI,
 * and a test that needs credentials to assert a request body is a test that
 * will be deleted rather than fixed. So the client is built over an injected
 * `fetch` and these tests assert on the bytes that would go on the wire --
 * which is also the only place worth asserting them, because a message body
 * that is safe in memory and unsafe in a POST is still unsafe.
 *
 * Configuration is the other half. The three TWILIO_* variables are optional,
 * so "not configured" has to be a first-class answer rather than an exception,
 * and a half-configured environment has to fail shut rather than half-send.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const TWILIO_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;

const config: TwilioConfig = {
  accountSid: "ACtest00000000000000000000000000",
  authToken: "twilio-auth-token",
  fromNumber: "+15558675309",
};

const realFetch = globalThis.fetch;
const before = new Map<string, string | undefined>();

function configureEnv(values: Partial<Record<string, string>>): void {
  for (const key of TWILIO_KEYS) {
    if (!before.has(key)) before.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  resetServerEnvCache();
}

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

let captured: Captured[] = [];
let status = 201;

/** A transport that records the request and answers like Twilio does. */
function stubTransport(): FetchLike {
  return (async (url, init) => {
    captured.push({ url, init });
    if (status === 201) {
      return new Response(JSON.stringify({ sid: "SM0000000000000000000000", status: "queued" }), {
        status: 201,
      });
    }
    return new Response(
      JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number." }),
      { status },
    );
  }) as FetchLike;
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

describe("splitChannelPrefix", () => {
  test("splits a channel prefix off an address", () => {
    expect(splitChannelPrefix("whatsapp:+15558675309")).toEqual({
      prefix: "whatsapp",
      address: "+15558675309",
    });
  });

  test("reads an address with no prefix as plain SMS", () => {
    expect(splitChannelPrefix("+15558675309")).toEqual({
      prefix: undefined,
      address: "+15558675309",
    });
  });

  test("is case-insensitive about the prefix, which Twilio treats as such", () => {
    expect(splitChannelPrefix("WhatsApp:+15558675309").prefix).toBe("whatsapp");
  });

  test("leaves an address it does not understand alone rather than guessing", () => {
    // A sender this module cannot interpret must not be silently trimmed into
    // something that looks valid.
    expect(splitChannelPrefix("messaging-service:SM123")).toEqual({
      prefix: undefined,
      address: "messaging-service:SM123",
    });
  });
});

describe("createTwilioMessagingClient", () => {
  test("posts an SMS to the account's messages endpoint with basic auth", async () => {
    const client = createTwilioMessagingClient(config, stubTransport());

    const result = await client.sendMessage({
      channel: "sms",
      to: "+15550100",
      body: "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    );
    const init = captured[0].init as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
    );
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(result).toEqual({ sid: "SM0000000000000000000000", status: "queued" });
  });

  test("sends exactly From, To and Body, and nothing else", async () => {
    const client = createTwilioMessagingClient(config, stubTransport());

    await client.sendMessage({ channel: "sms", to: "+15550100", body: "confirmed" });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect([...form.keys()].sort()).toEqual(["Body", "From", "To"]);
    expect(form.get("From")).toBe("+15558675309");
    expect(form.get("To")).toBe("+15550100");
  });

  test("addresses WhatsApp by prefixing both ends, as Twilio requires", async () => {
    // Plain numbers to a WhatsApp-enabled sender are delivered as SMS. The
    // channel is the prefix, so a WhatsApp confirmation that arrives as a text
    // message is a confirmation the clinic never meant to send.
    const client = createTwilioMessagingClient(config, stubTransport());

    await client.sendMessage({ channel: "whatsapp", to: "+15550100", body: "confirmed" });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect(form.get("From")).toBe("whatsapp:+15558675309");
    expect(form.get("To")).toBe("whatsapp:+15550100");
  });

  test("does not stack prefixes on an address that already carries one", async () => {
    const client = createTwilioMessagingClient(
      { ...config, fromNumber: "+15558675309" },
      stubTransport(),
    );

    await client.sendMessage({ channel: "whatsapp", to: "whatsapp:+15550100", body: "confirmed" });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect(form.get("To")).toBe("whatsapp:+15550100");
  });

  test("reports a rejected send as a Twilio error carrying the status", async () => {
    status = 400;
    const client = createTwilioMessagingClient(config, stubTransport());

    const error = await client
      .sendMessage({ channel: "sms", to: "+15550100", body: "confirmed" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TwilioMessagingError);
    expect((error as TwilioMessagingError).statusCode).toBe(400);
  });

  test("keeps the vendor's message -- which echoes the payload -- out of the error", async () => {
    // A Twilio 4xx body can quote the message it rejected, and that message is
    // patient-facing content. The status is kept; the text is not.
    status = 400;
    const client = createTwilioMessagingClient(config, stubTransport());

    const error = (await client
      .sendMessage({
        channel: "sms",
        to: "+15550100",
        body: "City Medical Center: your appointment is confirmed for 2026-10-01 09:30 UTC.",
      })
      .catch((thrown: unknown) => thrown)) as TwilioMessagingError;

    expect(error.message).not.toContain("City Medical Center");
    expect(error.message).not.toContain("appointment");
    expect(error.stack ?? "").not.toContain("City Medical Center");
  });

  test("reports a transport failure as a Twilio error with no status", async () => {
    const client = createTwilioMessagingClient(config, (() =>
      Promise.reject(new Error("network down"))) as unknown as FetchLike);

    const error = (await client
      .sendMessage({ channel: "sms", to: "+15550100", body: "confirmed" })
      .catch((thrown: unknown) => thrown)) as TwilioMessagingError;

    expect(error).toBeInstanceOf(TwilioMessagingError);
    expect(error.statusCode).toBeUndefined();
  });
});

describe("getTwilioMessaging", () => {
  test("is null with no Twilio variables set, which is the default deployment", async () => {
    configureEnv({});

    expect(getTwilioMessaging()).toBeNull();
  });

  test("is null when only some of the three are set, rather than half-configured", async () => {
    configureEnv({ TWILIO_ACCOUNT_SID: config.accountSid, TWILIO_AUTH_TOKEN: config.authToken });

    expect(getTwilioMessaging()).toBeNull();
  });

  test("is null for a sender that is not E.164", async () => {
    // A sender this module cannot read is a sender it must not send from. A
    // rejected confirmation is a bad day; a message delivered to an unknown
    // number is a disclosure.
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: "clinic-lines",
    });

    expect(getTwilioMessaging()).toBeNull();
  });

  test("resolves an SMS sender to the sms channel with the prefix stripped", async () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: "+15558675309",
    });

    const messaging = getTwilioMessaging();

    expect(messaging?.channel).toBe("sms");
    expect(messaging?.from).toBe("+15558675309");
  });

  test("resolves a whatsapp: sender to the WhatsApp channel", async () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: "whatsapp:+15558675309",
    });

    expect(getTwilioMessaging()?.channel).toBe("whatsapp");
  });

  test("uses the injected client in preference to the environment", async () => {
    configureEnv({});
    setTwilioMessaging({
      channel: "sms",
      from: "+15558675309",
      client: createTwilioMessagingClient(config, stubTransport()),
    });

    await getTwilioMessaging()?.client.sendMessage({
      channel: "sms",
      to: "+15550100",
      body: "confirmed",
    });

    expect(captured).toHaveLength(1);
  });
});
