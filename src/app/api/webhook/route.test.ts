import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "crypto";
import { NextRequest } from "next/server";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { clearWebhookEvents, listWebhookEvents } from "@/lib/webhook/events";
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
let logSpy: ReturnType<typeof spyOn<Console, "info">> | null = null;

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

/**
 * A request whose body is passed through verbatim, because the HMAC is computed
 * over the exact bytes. Re-serialising here would sign a different body than
 * the one sent, and the signature would (correctly) be rejected.
 */
function callRaw(raw: string, headers: Record<string, string> = {}) {
  return new NextRequest("https://clinic.test/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

const VENDOR_SECRET = "whsec_route_test_secret_32_chars_min!!";

function setVendorSecret(value: string | undefined) {
  if (value === undefined) delete process.env.TWILIO_WEBHOOK_SECRET;
  else process.env.TWILIO_WEBHOOK_SECRET = value;
  resetServerEnvCache();
}

function twilioSignature(raw: string, secret: string = VENDOR_SECRET): string {
  return crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
}

beforeEach(() => {
  sent = [];
  resendStatus = 200;
  clearWebhookEvents();
  setVendorSecret(undefined);

  // Captured rather than printed: the redaction assertions below need to read
  // back exactly what the route would have written to stdout in production,
  // which is the only way to assert a secret or a caller number never lands
  // in a platform log drain.
  logSpy = spyOn(console, "info").mockImplementation(() => {});

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
  logSpy?.mockRestore();
  logSpy = null;
  setVendorSecret(undefined);
  setLlmClient(null);
});

/** Everything the route wrote to the log during the current test. */
function logOutput(): string {
  return (logSpy?.mock.calls ?? []).map((args) => args.map(String).join(" ")).join("\n");
}

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

describe("POST /api/webhook vendor signatures (#65)", () => {
  /**
   * A vendor callback proves itself with an HMAC over its own body, so it
   * never carries the internal shared secret. These tests send no
   * `x-internal-secret` at all: if the vendor path did not work independently,
   * every one of them would be a 401.
   *
   * The payload is deliberately patient-shaped. A call event carries a caller
   * number, and the whole point of logging through @/lib/logger is that it does
   * not reach stdout.
   */
  const VENDOR_EVENT = {
    type: "call.completed",
    call_id: "CA123",
    from: "+15555550123",
    patient: { name: "Ada Lovelace", email: "ada@example.test" },
  };

  test("accepts and ingests a correctly signed Twilio event with no internal secret", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);

    const response = await POST(callRaw(raw, { "x-twilio-signature": twilioSignature(raw) }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; eventId: string };
    expect(body.success).toBe(true);
    expect(body.eventId).toBeTruthy();

    const events = listWebhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0].vendor).toBe("twilio");
    expect(events[0].type).toBe("call.completed");
    expect((events[0].payload as { call_id: string }).call_id).toBe("CA123");
    expect(events[0].receivedAt).toBeTruthy();

    // A vendor event is not a confirmation. Holding a valid vendor signature
    // must not become a way to make the app send mail.
    expect(sent).toEqual([]);
  });

  test("rejects a forged vendor signature with 401 and ingests nothing", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);

    const response = await POST(
      callRaw(raw, { "x-twilio-signature": twilioSignature(raw, "not-the-secret") }),
    );

    expect(response.status).toBe(401);
    expect(listWebhookEvents()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("rejects a signature computed over a different body", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);
    const signature = twilioSignature(JSON.stringify({ ...VENDOR_EVENT, type: "call.failed" }));

    const response = await POST(callRaw(raw, { "x-twilio-signature": signature }));

    expect(response.status).toBe(401);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("a forged vendor signature is not rescued by a valid internal secret", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);

    const response = await POST(
      callRaw(raw, {
        "x-internal-secret": BASELINE.INTERNAL_API_SECRET,
        "x-twilio-signature": twilioSignature(raw, "not-the-secret"),
      }),
    );

    // A request that carries a signature we cannot verify is a request we
    // cannot vouch for. Falling through to the internal secret here would
    // quietly re-open the hole #43 closed for anyone holding that secret.
    expect(response.status).toBe(401);
    expect(listWebhookEvents()).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("falls back to the internal secret when the vendor secret is unconfigured", async () => {
    setVendorSecret(undefined);
    const raw = JSON.stringify(VENDOR_EVENT);

    // Byte-identical to the forging case above, except there is now no vendor
    // secret to check against, so the internal secret decides. That secret is
    // valid, so this is past authentication -- and it still is not ingested,
    // because an unverified vendor header is not a vendor.
    const response = await POST(
      callRaw(raw, {
        "x-internal-secret": BASELINE.INTERNAL_API_SECRET,
        "x-twilio-signature": twilioSignature(raw),
      }),
    );

    expect(response.status).toBe(400);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("still serves the internal confirmation when no vendor secret is configured", async () => {
    setVendorSecret(undefined);

    const response = await POST(call());

    // The vendor work is additive: with nothing configured the original
    // contract has to hold unchanged.
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test("answers 400 for a signed event whose body is not JSON", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = "{ this is not json";

    const response = await POST(callRaw(raw, { "x-twilio-signature": twilioSignature(raw) }));

    // 400, not 401: the signature was genuinely valid for these bytes, so the
    // sender is who they claim to be. The body is the problem.
    expect(response.status).toBe(400);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("answers 400 for a signed event whose body is not a JSON object", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify([VENDOR_EVENT]);

    const response = await POST(callRaw(raw, { "x-twilio-signature": twilioSignature(raw) }));

    expect(response.status).toBe(400);
    expect(listWebhookEvents()).toEqual([]);
  });

  test("answers 400 for a malformed body behind the internal secret", async () => {
    setVendorSecret(undefined);
    const request = new NextRequest("https://clinic.test/api/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": BASELINE.INTERNAL_API_SECRET,
      },
      body: "{ not json",
    });

    expect((await POST(request)).status).toBe(400);
    expect(sent).toEqual([]);
  });

  test("never writes the secret or patient fields to the log", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);

    await POST(callRaw(raw, { "x-twilio-signature": twilioSignature(raw) }));

    const output = logOutput();
    expect(output).toContain("webhook.event_ingested");
    expect(output).not.toContain(VENDOR_SECRET);
    expect(output).not.toContain(twilioSignature(raw));
    expect(output).not.toContain("ada@example.test");
    expect(output).not.toContain("Ada Lovelace");
    expect(output).not.toContain("+15555550123");
    expect(output).not.toContain("call_id");
  });

  test("logs a rejected signature without echoing the presented value", async () => {
    setVendorSecret(VENDOR_SECRET);
    const raw = JSON.stringify(VENDOR_EVENT);
    const forged = twilioSignature(raw, "not-the-secret");

    const response = await POST(callRaw(raw, { "x-twilio-signature": forged }));

    expect(response.status).toBe(401);
    const output = logOutput();
    expect(output).toContain("webhook.signature_rejected");
    expect(output).not.toContain(forged);
    expect(output).not.toContain(VENDOR_SECRET);
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
