import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import {
  OUTBOUND_CALL_BUDGET,
  reserveCallBudget,
} from "./call-budget";
import {
  CLINIC_CALL_ANSWER_PATH,
  dialClinic,
  isSafeCallbackUrl,
} from "./clinic-call";
import type { FetchLike } from "./messaging";
import {
  createTwilioVoiceClient,
  setTwilioVoice,
  type TwilioVoice,
  type TwilioVoiceConfig,
} from "./voice";

/**
 * Placing the call, and everything that can stop it.
 *
 * This is the seam the booking pipeline calls instead of simulating a
 * receptionist, and it is where the three ways this can go wrong are made into
 * answers a caller can act on: not configured, out of budget, or refused by the
 * vendor. None of them throws. A booking that has already been stored and whose
 * confirmation is about to be sent must not fail because a telephone call did
 * not connect, and the reverse -- reporting a call that never happened -- is
 * what #20 was about.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const config: TwilioVoiceConfig = {
  accountSid: "ACtest00000000000000000000000000",
  authToken: "twilio-auth-token",
  fromNumber: "+15558675309",
  toNumber: "+15551230000",
  callbackBaseUrl: "https://clinic.example",
};

let captured: { url: string; init: RequestInit | undefined }[] = [];
let status = 201;

function transport(): FetchLike {
  return (async (url, init) => {
    captured.push({ url, init });
    if (status === 201) {
      return new Response(
        JSON.stringify({ sid: "CA00000000000000000000000000", status: "queued" }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ code: 21218, message: "not a valid number" }), { status });
  }) as FetchLike;
}

/** A deployment that has all five variables set. */
function configuredVoice(overrides: Partial<TwilioVoice> = {}): TwilioVoice {
  return {
    from: config.fromNumber,
    to: config.toNumber,
    callbackBaseUrl: config.callbackBaseUrl,
    client: createTwilioVoiceClient(config, transport()),
    ...overrides,
  };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  for (const key of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
    "TWILIO_CLINIC_NUMBER",
    "TWILIO_CALLBACK_BASE_URL",
  ]) {
    delete process.env[key];
  }
  resetServerEnvCache();
  captured = [];
  status = 201;
  setTwilioVoice(null);
  setRateLimitStore(null);
});

afterEach(() => {
  setTwilioVoice(null);
  setRateLimitStore(null);
  resetServerEnvCache();
});

describe("dialClinic", () => {
  test("is simulated, and dials nothing, with no voice configured", async () => {
    // The default deployment. This is the case that must not change: local dev,
    // CI and every contributor without a Twilio account take this path, and the
    // booking they produce is byte-for-byte the one they produced before.
    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({ status: "simulated" });
    expect(captured).toEqual([]);
  });

  test("places a real call, and reports the call Twilio accepted", async () => {
    setTwilioVoice(configuredVoice());

    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({
      status: "dialed",
      sid: "CA00000000000000000000000000",
      callStatus: "queued",
    });
    expect(captured).toHaveLength(1);
  });

  test("dials the configured clinic from the configured sender, at the configured origin", async () => {
    setTwilioVoice(
      configuredVoice({ from: "+15550001111", to: "+15559998888", callbackBaseUrl: "https://voice.example" }),
    );

    await dialClinic({ appointmentId: "appt-1" });

    const form = new URLSearchParams(String((captured[0].init as RequestInit).body));
    expect(form.get("From")).toBe("+15550001111");
    expect(form.get("To")).toBe("+15559998888");
    expect(form.get("Url")).toBe(`https://voice.example${CLINIC_CALL_ANSWER_PATH}`);
  });

  test("puts nothing from the booking record on the wire", async () => {
    // The call is made during a booking, from a booking request, and the record
    // is in scope where this is called. Nothing from it may reach the vendor.
    setTwilioVoice(configuredVoice());

    await dialClinic({ appointmentId: "appt-1" });

    const body = String((captured[0].init as RequestInit).body);
    expect(body).not.toContain("appt-1");
  });

  test("skips, and dials nothing, when the budget is spent", async () => {
    setTwilioVoice(configuredVoice());
    for (let attempt = 0; attempt < OUTBOUND_CALL_BUDGET; attempt += 1) await reserveCallBudget();

    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({ status: "skipped", reason: "budget_exhausted" });
    expect(captured).toEqual([]);
  });

  test("reports a refused call as a failure rather than throwing", async () => {
    status = 400;
    setTwilioVoice(configuredVoice());

    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({ status: "failed", reason: "call_failed" });
  });

  test("reports a transport that never reached Twilio as the same failure", async () => {
    setTwilioVoice(
      configuredVoice({
        client: createTwilioVoiceClient(config, (() =>
          Promise.reject(new Error("network down"))) as unknown as FetchLike),
      }),
    );

    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({ status: "failed", reason: "call_failed" });
  });

  test("refuses to dial through a callback base that is not https", async () => {
    // The base is validated where it is read, and validated again where it is
    // used. Twilio fetches this URL from outside and acts on whatever it says, so
    // the property that matters is the one the outgoing request has -- and a
    // test seam that installed a plaintext base must not be able to drop it.
    setTwilioVoice(configuredVoice({ callbackBaseUrl: "http://clinic.example" }));

    const report = await dialClinic({ appointmentId: "appt-1" });

    expect(report).toEqual({ status: "skipped", reason: "not_configured" });
    expect(captured).toEqual([]);
  });

  test("a second call in the same window is still dialled, one budget slot each", async () => {
    setTwilioVoice(configuredVoice());

    await dialClinic({ appointmentId: "appt-1" });
    await dialClinic({ appointmentId: "appt-2" });

    expect(captured).toHaveLength(2);
  });
});

describe("isSafeCallbackUrl", () => {
  test("accepts an absolute https URL", () => {
    expect(isSafeCallbackUrl("https://clinic.example/api/twilio/voice/answer")).toBe(true);
  });

  test("rejects anything that is not absolute https", () => {
    for (const url of [
      "http://clinic.example/a",
      "/api/twilio/voice/answer",
      "api/twilio/voice/answer",
      "wss://clinic.example/a",
      "https://",
      "",
    ]) {
      expect(isSafeCallbackUrl(url)).toBe(false);
    }
  });
});
