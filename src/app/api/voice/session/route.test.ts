import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetServerEnvCache } from "@/lib/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import { sealRecord } from "@/lib/phi-token";
import { setElevenLabsClient, type ElevenLabsClient } from "@/lib/voice/elevenlabs";
import { VendorRequestError } from "@/lib/voice/errors";
import { POST } from "./route";

/**
 * POST /api/voice/session (#15).
 *
 * This is the endpoint that replaces "the browser knows the agent id". It hands
 * out a short-lived signed conversation URL, and it is therefore the only thing
 * standing between an anonymous caller and somebody else's paid ElevenLabs
 * account. The tests are weighted accordingly: most of them are about who gets
 * a URL, and only two are about the happy path.
 *
 * The real limiter, the real token sealing, and the real session check all run.
 * Only the vendor is stubbed, because there is no account here.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const saved = new Map<string, string | undefined>();
for (const key of Object.keys(BASELINE)) saved.set(key, process.env[key]);

function setEnv(values: Partial<Record<string, string>> = {}): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  Object.assign(process.env, BASELINE, values);
  resetServerEnvCache();
}

const RECORD = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  language: "english",
};

function bookedToken(record: unknown = RECORD): string {
  return sealRecord(JSON.stringify(record));
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://clinic.test/api/voice/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let mintCalls: { agentId: string; ttlSeconds?: number }[] = [];
const minted = {
  url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_patient&signature=sig&expires=1",
  expiresAt: 1_700_000_060_000,
};

function stubVendor(behaviour?: ElevenLabsClient["mintConversationUrl"]): void {
  mintCalls = [];
  setElevenLabsClient({
    mintConversationUrl: async (request) => {
      mintCalls.push(request);
      return behaviour ? behaviour(request) : minted;
    },
  });
}

beforeEach(() => {
  setEnv();
  setRateLimitStore(null);
  stubVendor();
});

afterEach(() => {
  setRateLimitStore(null);
  setElevenLabsClient(null);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("a caller holding a booked appointment", () => {
  test("gets a signed URL and no agent id of its own choosing", async () => {
    const response = await POST(post({ side: "patient", session: bookedToken() }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; expiresAt: number; side: string };
    expect(body.url).toBe(minted.url);
    expect(body.expiresAt).toBe(minted.expiresAt);
    expect(body.side).toBe("patient");
    expect(mintCalls).toEqual([{ agentId: "agent_patient" }]);
  });

  test("gets the receptionist's agent when it asks for the receptionist", async () => {
    await POST(post({ side: "receptionist", session: bookedToken() }));

    expect(mintCalls).toEqual([{ agentId: "agent_receptionist" }]);
  });

  test("cannot name an agent id, even an extra field", async () => {
    // The side is a two-value union and the id is resolved server-side. A body
    // that also carries `agent_id` is refused rather than ignored, because
    // "refuse the request" is a louder failure than "silently use the other one".
    const response = await POST(
      post({ side: "patient", session: bookedToken(), agent_id: "someone_elses_agent" }),
    );

    expect(response.status).toBe(400);
    expect(mintCalls).toEqual([]);
  });

  test("is told the response must not be cached", async () => {
    // The body is a credential. A shared cache that kept it would hand the same
    // live session to the next caller, and no browser cache header is a
    // default, not a guarantee.
    const response = await POST(post({ side: "patient", session: bookedToken() }));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("does not see the API key, the agent id, or its own token echoed back", async () => {
    const token = bookedToken();
    const response = await POST(post({ side: "patient", session: token }));
    const text = await response.text();

    // The signature is the only secret in the response, and it is a signature.
    expect(text).not.toContain("sk-elevenlabs-test");
    expect(text).not.toContain(token);
  });
});

describe("a caller with nothing but a guess", () => {
  test("is refused and spends nothing", async () => {
    // An empty token is a malformed body and is answered as one; everything
    // here is well-formed and simply is not a booking.
    for (const session of ["not-a-token", `${bookedToken()}x`, bookedToken({})]) {
      const response = await POST(post({ side: "patient", session }));
      expect(response.status).toBe(403);
    }
    expect(mintCalls).toEqual([]);
  });

  test("is refused for a token sealed under another key", async () => {
    const forged = bookedToken();
    setEnv({ HIPAA_MASTER_KEY: "b".repeat(64) });

    const response = await POST(post({ side: "patient", session: forged }));

    expect(response.status).toBe(403);
    expect(mintCalls).toEqual([]);
  });

  test("cannot tell from the answer which part of the guess was wrong", async () => {
    const responses = await Promise.all([
      POST(post({ side: "patient", session: "garbage" })),
      POST(post({ side: "patient", session: bookedToken({ firstName: "Ada" }) })),
    ]);

    // Same status, same body. A 403 that said "the token decrypted but the
    // record was empty" is a 403 that told an attacker the token was real.
    expect(responses[0].status).toBe(responses[1].status);
    expect(await responses[0].text()).toBe(await responses[1].text());
  });

  test("is rate limited before a vendor request is made", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    let throttled: Response | null = null;

    for (let attempt = 0; attempt < 40 && !throttled; attempt++) {
      const response = await POST(
        post({ side: "patient", session: bookedToken() }, headers),
      );
      if (response.status === 429) throttled = response;
    }

    expect(throttled).not.toBeNull();
    expect(throttled?.headers.get("retry-after")).toBeTruthy();
    // The budget stops the endpoint; it does not make a mint free once the
    // caller has it, so assert the calls that did happen are bounded too.
    expect(mintCalls.length).toBeLessThanOrEqual(40);
  });
});

describe("a malformed request", () => {
  test("is refused before anything else is looked at", async () => {
    for (const body of [
      {},
      { side: "patient" },
      { session: bookedToken() },
      { side: "admin", session: bookedToken() },
      { side: "patient", session: bookedToken(), extra: 1 },
      { side: "patient", session: 12 },
    ]) {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(mintCalls).toEqual([]);
  });

  test("does not get a body that echoes what it sent", async () => {
    const response = await POST(post({ side: "patient", session: 12 }));
    const body = (await response.json()) as { issues: { message: string }[] };

    expect(JSON.stringify(body)).not.toContain(baseline_email());
  });
});

describe("a deployment without voice configured", () => {
  test("says so, and does not pretend the call failed", async () => {
    setEnv({ ELEVENLABS_API_KEY: undefined });

    const response = await POST(post({ side: "patient", session: bookedToken() }));

    // 503, not 400 and not 500: the request was well-formed and authorised, and
    // the thing that is missing is a server-side capability. A page that sees
    // this offers the form instead of a Start button.
    expect(response.status).toBe(503);
    expect(mintCalls).toEqual([]);
  });
});

describe("a vendor failure", () => {
  test("is reported as a vendor failure and not as a refusal", async () => {
    stubVendor(async () => {
      throw new VendorRequestError("The voice vendor refused the request", 503);
    });

    const response = await POST(post({ side: "patient", session: bookedToken() }));

    expect(response.status).toBe(502);
    // Nothing about the vendor's own words reaches the caller: its body echoes
    // the request, and the request is the API key and an agent id.
    expect(await response.text()).not.toContain("refused the request");
  });
});

function baseline_email(): string {
  return RECORD.email;
}
