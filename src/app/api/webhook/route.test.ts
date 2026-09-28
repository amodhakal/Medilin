import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { POST, GET } from "./route";

/**
 * The internal confirmation webhook (#43).
 *
 * The send moved out of the route so the booking path could call it directly,
 * which is the whole point: there is no longer an HTTP hop between a booking
 * and its confirmation. What must survive the move is the shared secret. This
 * endpoint is reachable by anyone on the internet, and without the secret it is
 * an open mail relay, so the tests are as much about the lock as about the
 * email.
 *
 * Resend posts through the global `fetch`, so the outbound call is captured
 * rather than sent.
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

const payload = {
  email: "ada@example.test",
  language: "spanish" as const,
  info: JSON.stringify({ confirmed: true, agreedDateTime: "2026-10-01T09:30:00.000Z" }),
};

const realFetch = globalThis.fetch;
let sent: { url: string; init: RequestInit | undefined }[] = [];
let resendStatus = 200;

function call(body: unknown = payload, headers: Record<string, string> = {}) {
  return new NextRequest("https://clinic.test/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": BASELINE.INTERNAL_API_SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sent = [];
  resendStatus = 200;

  setLlmClient({
    async generateJson() {
      return { subject: "Su cita", body: "<p>Martes 09:30</p>" };
    },
  });

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), init });
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
});

afterAll(() => {
  resetServerEnvCache();
});

describe("POST /api/webhook", () => {
  test("refuses an unauthenticated caller without touching Resend", async () => {
    const response = await POST(call(payload, { "x-internal-secret": "wrong" }));

    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });

  test("refuses a caller that sends no secret at all", async () => {
    const request = new NextRequest("https://clinic.test/api/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect((await POST(request)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  test("validates the body after authenticating", async () => {
    const response = await POST(call({ ...payload, email: "not-an-email" }));

    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("sends the translated confirmation for an authenticated caller", async () => {
    const response = await POST(call());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; subject: string };
    expect(body.success).toBe(true);
    expect(body.subject).toBe("Su cita");

    expect(sent).toHaveLength(1);
    const request = new Request("https://api.resend.com/emails", sent[0].init);
    const outbound = (await request.json()) as { to: string[]; subject: string };
    expect(outbound.to).toEqual(["ada@example.test"]);
    expect(outbound.subject).toBe("Su cita");
  });

  test("does not echo the patient's address back", async () => {
    const response = await POST(call());

    expect(await response.text()).not.toContain("ada@example.test");
  });

  test("reports a rejected send as a failure", async () => {
    resendStatus = 422;

    const response = await POST(call());

    // 502, not 400: the request was well-formed and authorised, and the
    // upstream that had to accept it refused. The old catch-all answered
    // "Invalid request body" for everything, which sent a caller debugging a
    // domain problem off to inspect their own payload instead.
    expect(response.status).toBe(502);
  });

  test("reports a failed translation as a failure", async () => {
    setLlmClient({
      async generateJson() {
        throw new Error("Translation failed after 1 attempt: unavailable");
      },
    });

    const response = await POST(call());

    expect(response.status).toBe(502);
    expect(sent).toEqual([]);
  });
});

describe("GET /api/webhook", () => {
  test("answers liveness without requiring a credential", async () => {
    // Deliberately unauthenticated and deliberately uninformative: it says the
    // process is up and nothing about the environment behind it.
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
