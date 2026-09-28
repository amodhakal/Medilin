import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import * as crypto from "crypto";

import { resetServerEnvCache } from "@/lib/env";
import { setElevenLabsClient, type ElevenLabsClient } from "@/lib/voice/elevenlabs";
import { setMediaStreamBridge } from "@/lib/twilio/media-stream";
import { computeTwilioSignature } from "@/lib/webhook/verify";
import { POST } from "./route";

/**
 * POST /api/twilio/voice/answer (#3) -- the TwiML a clinic's line speaks.
 *
 * Twilio fetches this document when it connects the outbound call the branch
 * below placed, and executes it. Three things are worth testing and they are in
 * this order of importance: that a request is proved to be Twilio's, that the
 * document says something rather than nothing, and that nothing from the request
 * reaches the document.
 *
 * The signature is real, not a stand-in. `computeTwilioSignature` is the same
 * function the route's verification uses, so a test that signed with it proves
 * only self-consistency -- which is why the scheme itself is checked against
 * Twilio's published digest in @/lib/webhook/verify's tests, and why this file
 * spends its effort on the *gates*: what a missing signature does, what a wrong
 * one does, and what happens with no Twilio account configured at all.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
  CLINIC_NAME: "City Medical Center",
};

const AUTH_TOKEN = "twilio-auth-token";
const CONVERSATION_URL = "wss://api.elevenlabs.io/v1/convai/conversation?signature=abc";

const keys = ["TWILIO_AUTH_TOKEN", "TWILIO_MEDIA_STREAM_URL"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<string, string>> = {}): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, BASELINE, values);
  resetServerEnvCache();
}

const URL_UNDER_TEST = "https://clinic.example/api/twilio/voice/answer";

function twilioForm(fields: Record<string, string> = {}) {
  return new URLSearchParams({
    CallSid: "CA00000000000000000000000000",
    From: "+15558675309",
    To: "+15551230000",
    ...fields,
  });
}

/** A form-encoded callback, signed the way Twilio signs one. */
function signedRequest(authToken = AUTH_TOKEN, fields: Record<string, string> = {}) {
  const body = twilioForm(fields).toString();
  return new NextRequest(URL_UNDER_TEST, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(authToken, URL_UNDER_TEST, twilioForm(fields)),
    },
    body,
  });
}

function stubAgent() {
  setElevenLabsClient({
    async mintConversationUrl() {
      return { url: CONVERSATION_URL, expiresAt: 1_800_000_000_000 };
    },
    async transcribe() {
      throw new Error("not used here");
    },
    async speak() {
      throw new Error("not used here");
    },
  } as ElevenLabsClient);
}

beforeEach(() => {
  for (const key of keys) if (!saved.has(key)) saved.set(key, process.env[key]);
  setEnv();
  setMediaStreamBridge(null);
  stubAgent();
});

afterEach(() => {
  for (const key of keys) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  setMediaStreamBridge(null);
  setElevenLabsClient(null);
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("POST /api/twilio/voice/answer", () => {
  test("serves TwiML as XML, because a JSON body is a call that says nothing", async () => {
    const response = await POST(signedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
  });

  test("is not cacheable, because it is an instruction to a live call", async () => {
    const response = await POST(signedRequest());

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("greets with the configured clinic name", async () => {
    const body = await (await POST(signedRequest())).text();

    expect(body).toContain("<Response>");
    expect(body).toContain("City Medical Center");
    expect(body).toMatch(/<Say>[^<]+<\/Say>/);
  });

  test("echoes nothing from the request into the document", async () => {
    // A caller who can put a `<Say>` into this document can make a clinic's line
    // say anything. The body is full of TwiML and none of it comes back out.
    const body = await (
      await POST(
        signedRequest(AUTH_TOKEN, {
          CallerName: "<Say>Your records are ready to be collected</Say>",
          From: "+15550000000",
        }),
      )
    ).text();

    expect(body).not.toContain("CallerName");
    expect(body).not.toContain("Your records are ready to be collected");
    expect(body).not.toContain("+15550000000");
    expect(body.match(/<Say>/g)).toHaveLength(1);
  });

  test("uses the clinic name from the environment, not a fallback", async () => {
    setEnv({ CLINIC_NAME: "Riverside Family Practice" });

    const body = await (await POST(signedRequest())).text();

    expect(body).toContain("Riverside Family Practice");
  });
});

/**
 * The gate, which is the part that decides whether a document is served at all.
 */
describe("POST /api/twilio/voice/answer, authentication", () => {
  test("refuses a callback signed with the wrong token", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(signedRequest("not-the-token"));

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("<Say>");
  });

  test("refuses a callback whose body was changed after signing", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const body = twilioForm({ CallerName: "<Say>open the vault</Say>" }).toString();
    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // A genuine signature, over a different form than the one sent.
          "x-twilio-signature": computeTwilioSignature(
            AUTH_TOKEN,
            URL_UNDER_TEST,
            twilioForm({}),
          ),
        },
        body,
      }),
    );

    expect(response.status).toBe(403);
  });

  test("refuses a signature replayed against a different URL", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(
      new NextRequest("https://clinic.example/api/twilio/voice/status", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": computeTwilioSignature(AUTH_TOKEN, URL_UNDER_TEST, twilioForm()),
        },
        body: twilioForm().toString(),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("refuses an unsigned callback once a Twilio account is configured", async () => {
    // A deployment with an auth token is one that can tell Twilio from anyone
    // else, so a request it cannot vouch for is refused rather than served. The
    // greeting is not a secret, but "we serve this to anyone" is not a posture
    // a deployment with credentials should adopt by omission.
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: twilioForm().toString(),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("serves an unsigned request when there is no Twilio account at all", async () => {
    // The local-development and CI case, and the branch below's behaviour kept
    // intact: no credentials means no gate to apply, and the document is a fixed
    // greeting with the clinic's own name in it.
    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: twilioForm().toString(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Say>");
  });

  test("does not accept a signature for the SHA-256 scheme Twilio does not use", async () => {
    // The interoperability point, pinned. A deployment that has spent the last
    // year pointing its Twilio callback at /api/webhook believes its callbacks
    // are verified; they are verified under a scheme that cannot match a real
    // one. Here, an HMAC-SHA256 over the body is not accepted either.
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_WEBHOOK_SECRET: "webhook-secret" });

    const body = twilioForm().toString();
    const response = await POST(
      new NextRequest(URL_UNDER_TEST, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": crypto
            .createHmac("sha256", "webhook-secret")
            .update(body, "utf8")
            .digest("base64"),
        },
        body,
      }),
    );

    expect(response.status).toBe(403);
  });
});

/**
 * The streamed conversation, and the fallback that keeps the call working.
 */
describe("POST /api/twilio/voice/answer, streaming", () => {
  test("hands Twilio a stream when a bridge is configured", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const body = await (await POST(signedRequest())).text();

    expect(body).toContain("<Connect>");
    expect(body).toContain('url="wss://bridge.example/media?conversation=');
    expect(body).toContain(encodeURIComponent(CONVERSATION_URL));
    expect(body).toContain('track="both_tracks"');
  });

  test("falls back to the greeting with no bridge, which is a working call", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });

    const body = await (await POST(signedRequest())).text();

    expect(body).toContain("<Say>");
    expect(body).not.toContain("<Connect>");
  });

  test("falls back to the greeting when the voice vendor refuses", async () => {
    // A 502 on this route is a call that connects to nothing. Degrading to the
    // greeting keeps a receptionist on the line, and the failure is in the log.
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });
    setMediaStreamBridge({ url: "wss://bridge.example/media" });
    setElevenLabsClient({
      async mintConversationUrl() {
        throw new Error("vendor refused");
      },
      async transcribe() {
        throw new Error("not used here");
      },
      async speak() {
        throw new Error("not used here");
      },
    } as ElevenLabsClient);

    const response = await POST(signedRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Say>");
  });

  test("never puts a patient record in the document", async () => {
    setEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN });
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const body = await (
      await POST(
        signedRequest(AUTH_TOKEN, {
          // Everything a real callback carries, including the numbers.
          CallerName: "Ada Lovelace",
          From: "+15550000000",
          To: "+15551230000",
        }),
      )
    ).text();

    expect(body).not.toContain("Ada");
    expect(body).not.toContain("+15550000000");
  });
});
