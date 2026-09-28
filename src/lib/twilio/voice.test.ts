import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import type { FetchLike } from "./messaging";
import {
  createTwilioVoiceClient,
  getTwilioVoice,
  setTwilioVoice,
  TwilioCallError,
  type TwilioVoiceConfig,
} from "./voice";

/**
 * The Twilio voice transport: a real outbound call to the clinic's line (#64).
 *
 * Same shape of test as messaging.test.ts and for the same reason. There are no
 * Twilio credentials in CI, and a test that needed them to assert a request body
 * would be a test that gets deleted rather than fixed. The `fetch` seam is the
 * test, and what is asserted is the bytes that would go on the wire -- because
 * a call that is correct in memory and wrong in the POST dials a stranger.
 *
 * The second half is configuration, and for a transport that spends money it is
 * the more important half: "not configured" has to be a first-class answer, and
 * a half-configured environment has to refuse rather than dial a default.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_CLINIC_NUMBER",
  "TWILIO_CALLBACK_BASE_URL",
] as const;

const config: TwilioVoiceConfig = {
  accountSid: "ACtest00000000000000000000000000",
  authToken: "twilio-auth-token",
  fromNumber: "+15558675309",
  toNumber: "+15551230000",
  callbackBaseUrl: "https://clinic.example",
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

function stubTransport(): FetchLike {
  return (async (url, init) => {
    captured.push({ url, init });
    if (status === 201) {
      return new Response(
        JSON.stringify({ sid: "CA00000000000000000000000000", status: "queued", direction: "outbound-api" }),
        { status: 201 },
      );
    }
    return new Response(
      JSON.stringify({ code: 21218, message: "The 'To' number is not a valid phone number." }),
      { status },
    );
  }) as FetchLike;
}

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  resetServerEnvCache();
  captured = [];
  status = 201;
  setTwilioVoice(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setTwilioVoice(null);
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

describe("createTwilioVoiceClient", () => {
  test("posts a call to the account's calls endpoint with basic auth", async () => {
    const client = createTwilioVoiceClient(config, stubTransport());

    const result = await client.placeCall({
      to: config.toNumber,
      from: config.fromNumber,
      twimlUrl: "https://clinic.example/api/twilio/voice/answer",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
    );
    const init = captured[0].init as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
    );
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(result).toEqual({ sid: "CA00000000000000000000000000", status: "queued" });
  });

  test("sends To, From and the TwiML URL, and nothing that identifies a patient", async () => {
    const client = createTwilioVoiceClient(config, stubTransport());

    await client.placeCall({
      to: config.toNumber,
      from: config.fromNumber,
      twimlUrl: "https://clinic.example/api/twilio/voice/answer",
    });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect([...form.keys()].sort()).toEqual(["From", "To", "Url"]);
    expect(form.get("To")).toBe("+15551230000");
    expect(form.get("From")).toBe("+15558675309");
    expect(form.get("Url")).toBe("https://clinic.example/api/twilio/voice/answer");
    expect(String((captured[0].init as RequestInit).body)).not.toMatch(/patient|symptom|appointment_/i);
  });

  test("omits the status callback entirely when there is none to send to", async () => {
    // A StatusCallback of "" is not "no callback": Twilio fetches the URL, and an
    // empty one is a request it cannot make. The field is left out, not blanked.
    const client = createTwilioVoiceClient(config, stubTransport());

    await client.placeCall({
      to: config.toNumber,
      from: config.fromNumber,
      twimlUrl: "https://clinic.example/api/twilio/voice/answer",
    });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect(form.has("StatusCallback")).toBe(false);
    expect(form.has("StatusCallbackEvent")).toBe(false);
  });

  test("sends the status callback and its events when the caller has one", async () => {
    const client = createTwilioVoiceClient(config, stubTransport());

    await client.placeCall({
      to: config.toNumber,
      from: config.fromNumber,
      twimlUrl: "https://clinic.example/api/twilio/voice/answer",
      statusCallback: "https://clinic.example/api/twilio/voice/status",
    });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect(form.get("StatusCallback")).toBe("https://clinic.example/api/twilio/voice/status");
    // One event, not four: this app records the call reaching the clinic and the
    // call ending, and `completed` is the one that carries the bill.
    expect(form.get("StatusCallbackEvent")).toBe("initiated completed");
  });

  test("reports a rejected call as a Twilio error carrying the status", async () => {
    status = 400;
    const client = createTwilioVoiceClient(config, stubTransport());

    const error = await client
      .placeCall({ to: config.toNumber, from: config.fromNumber, twimlUrl: "https://x.test/a" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TwilioCallError);
    expect((error as TwilioCallError).statusCode).toBe(400);
  });

  test("keeps the vendor's message -- which echoes the request -- out of the error", async () => {
    status = 400;
    const client = createTwilioVoiceClient(config, stubTransport());

    const error = (await client
      .placeCall({ to: config.toNumber, from: config.fromNumber, twimlUrl: "https://x.test/a" })
      .catch((thrown: unknown) => thrown)) as TwilioCallError;

    expect(error.message).not.toContain("+15551230000");
    expect(error.message).not.toContain("phone number");
    expect(error.stack ?? "").not.toContain("+15551230000");
  });

  test("reports a transport failure as a Twilio error with no status", async () => {
    const client = createTwilioVoiceClient(config, (() =>
      Promise.reject(new Error("network down"))) as unknown as FetchLike);

    const error = (await client
      .placeCall({ to: config.toNumber, from: config.fromNumber, twimlUrl: "https://x.test/a" })
      .catch((thrown: unknown) => thrown)) as TwilioCallError;

    expect(error).toBeInstanceOf(TwilioCallError);
    expect(error.statusCode).toBeUndefined();
  });

  test("returns empty strings rather than throwing when the accepted body is unreadable", async () => {
    // Twilio answered 201 with something this client cannot read. The call is
    // queued; treating that as a failure would re-dial a clinic that already has
    // a call from us, which is the expensive direction to be wrong in.
    const client = createTwilioVoiceClient(config, (async () =>
      new Response("not json", { status: 201 })) as unknown as FetchLike);

    const result = await client.placeCall({
      to: config.toNumber,
      from: config.fromNumber,
      twimlUrl: "https://x.test/a",
    });

    expect(result).toEqual({ sid: "", status: "" });
  });
});

describe("getTwilioVoice", () => {
  test("is null with no Twilio variables set, which is the default deployment", () => {
    configureEnv({});

    expect(getTwilioVoice()).toBeNull();
  });

  test("is null without a clinic number, even with a complete messaging set", () => {
    // The three existing TWILIO_* variables are enough to send a text message.
    // They are not enough to place a call: something has to say who to call, and
    // guessing is how this application dials a stranger.
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: config.fromNumber,
    });

    expect(getTwilioVoice()).toBeNull();
  });

  test("is null without a callback base URL, because TwiML has to be fetched from somewhere", () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: config.fromNumber,
      TWILIO_CLINIC_NUMBER: config.toNumber,
    });

    expect(getTwilioVoice()).toBeNull();
  });

  test("is null for a clinic number that is not E.164", () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: config.fromNumber,
      TWILIO_CLINIC_NUMBER: "reception",
      TWILIO_CALLBACK_BASE_URL: config.callbackBaseUrl,
    });

    expect(getTwilioVoice()).toBeNull();
  });

  test("is null for a plain-HTTP callback base URL", () => {
    // Twilio will not sign a plaintext URL usefully, and an http:// callback is
    // TwiML delivered to a name that anyone on the path can rewrite.
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      TWILIO_FROM_NUMBER: config.fromNumber,
      TWILIO_CLINIC_NUMBER: config.toNumber,
      TWILIO_CALLBACK_BASE_URL: "http://clinic.example",
    });

    expect(getTwilioVoice()).toBeNull();
  });

  test("resolves both numbers and a trailing-slash-free base URL", () => {
    configureEnv({
      TWILIO_ACCOUNT_SID: config.accountSid,
      TWILIO_AUTH_TOKEN: config.authToken,
      // The messaging sender may carry a `whatsapp:` prefix, which is a channel
      // decision for text and noise on a voice call.
      TWILIO_FROM_NUMBER: "whatsapp:+15558675309",
      TWILIO_CLINIC_NUMBER: config.toNumber,
      TWILIO_CALLBACK_BASE_URL: "https://clinic.example/",
    });

    const voice = getTwilioVoice();

    expect(voice?.from).toBe("+15558675309");
    expect(voice?.to).toBe("+15551230000");
    expect(voice?.callbackBaseUrl).toBe("https://clinic.example");
  });

  test("uses the injected voice in preference to the environment", async () => {
    configureEnv({});
    setTwilioVoice({
      from: config.fromNumber,
      to: config.toNumber,
      callbackBaseUrl: config.callbackBaseUrl,
      client: createTwilioVoiceClient(config, stubTransport()),
    });

    await getTwilioVoice()?.client.placeCall({
      to: "+15551230000",
      from: "+15558675309",
      twimlUrl: "https://x.test/a",
    });

    expect(captured).toHaveLength(1);
  });
});
