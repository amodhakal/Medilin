import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetServerEnvCache } from "@/lib/env";
import { clearWebhookEvents, listWebhookEvents } from "@/lib/webhook/events";
import { computeTwilioSignature } from "@/lib/webhook/verify";
import { POST } from "./route";

/**
 * POST /api/twilio/voice/status -- what happened to the call.
 *
 * A call that was placed is not a call that reached anyone, and this is the only
 * way this application finds out which happened. It is also the only place
 * Twilio's event names meet this application's, so the tests are about the two
 * facts that follow from that: nothing is stored from a request that could not
 * be proved to be Twilio's, and nothing from the payload is answered back.
 *
 * The signature is real -- HMAC-SHA1 over the URL and the sorted form, as
 * Twilio computes it. As in the answer route's tests, signing with this
 * repository's own function proves self-consistency rather than correctness, so
 * the scheme itself is pinned against Twilio's published digest in
 * @/lib/webhook/verify.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const AUTH_TOKEN = "twilio-auth-token";
const URL_UNDER_TEST = "https://clinic.example/api/twilio/voice/status";

const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<string, string>> = {}): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  delete process.env.TWILIO_AUTH_TOKEN;
  Object.assign(process.env, BASELINE, values);
  resetServerEnvCache();
}

/** What Twilio sends for an outbound call that finished. */
function statusCallback(fields: Record<string, string> = {}) {
  return new URLSearchParams({
    CallSid: "CA00000000000000000000000000",
    CallStatus: "completed",
    From: "+15558675309",
    To: "+15551230000",
    Duration: "42",
    ...fields,
  });
}

function signedRequest(authToken = AUTH_TOKEN, fields: Record<string, string> = {}) {
  return new NextRequest(URL_UNDER_TEST, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(
        authToken,
        URL_UNDER_TEST,
        statusCallback(fields),
      ),
    },
    body: statusCallback(fields).toString(),
  });
}

beforeEach(() => {
  for (const key of ["TWILIO_AUTH_TOKEN"]) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
  }
  setEnv();
  clearWebhookEvents();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
  clearWebhookEvents();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("POST /api/twilio/voice/status", () => {
  test("accepts a signed callback with no body, which is what Twilio wants back", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(signedRequest());

    // 204 rather than a JSON receipt: Twilio is not a caller of this app, and a
    // body here is a payload echo waiting to happen.
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("records the call status under Twilio's own name for it", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    await POST(signedRequest(AUTH_TOKEN, { CallStatus: "no-answer" }));

    const events = listWebhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0].vendor).toBe("twilio");
    // Not `status`, not `type`: Twilio's field is `CallStatus`, and a generic
    // derivation would file this as an unnamed event.
    expect(events[0].type).toBe("no-answer");
  });

  test("stores the callback as received, because redaction is a logging control", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    await POST(signedRequest());

    const [event] = listWebhookEvents();
    expect(event.payload.CallSid).toBe("CA00000000000000000000000000");
  });

  test("refuses a callback signed with the wrong token, and stores nothing", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(signedRequest("not-the-token"));

    expect(response.status).toBe(403);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("refuses an unsigned callback once a Twilio account is configured", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: statusCallback().toString(),
      }),
    );

    expect(response.status).toBe(403);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("refuses a JSON body signed as if it were a form", async () => {
    // Twilio sends a form. A JSON body on a Twilio route is either a misconfigured
    // sender or a forgery, and in both cases the parameters that were signed are
    // not the ones that arrived.
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-twilio-signature": computeTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, {
            CallStatus: "completed",
          }),
        },
        body: JSON.stringify({ CallStatus: "completed" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("accepts an unsigned callback with no Twilio account, and still records it", async () => {
    // Same posture as the answer route: nothing to verify against means nothing
    // to refuse on. Useful locally, and it is the state a deployment is in until
    // its first variable is set.
    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: statusCallback().toString(),
      }),
    );

    expect(response.status).toBe(204);
    expect(listWebhookEvents()).toHaveLength(1);
  });

  test("records a callback with no recognisable status, rather than dropping it", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(signedRequest(AUTH_TOKEN, { CallStatus: "" }));

    expect(response.status).toBe(204);
    expect(listWebhookEvents()[0].type).toBe("unknown");
  });
});
