import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { submitIntakeForm } from "./actions";

/**
 * The intake server action (#43, #21).
 *
 * This file is only possible because the action stopped `fetch`ing the
 * application's own API. The old version built a URL from the `Host` header
 * and the `NODE_ENV`-derived protocol, and the only way to exercise what came
 * back was to run a server on the other end of it -- which is why it went
 * untested while it carried two response-handling bugs.
 *
 * So the assertions are about the things the fetch used to get wrong: what is
 * sent, where, and what happens when the booking fails.
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

const realFetch = globalThis.fetch;
let outboundCalls: unknown[] = [];

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Doctor",
    additionalInfo: "dolor de cabeza",
    language: "spanish",
    ...overrides,
  };

  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  outboundCalls = [];

  setLlmClient({
    async generateJson() {
      return { additionalInfo: "headache", medical_department: "Doctor" };
    },
  });

  // The action used to call this. It must not, to any origin: the whole
  // complaint about the old self-fetch is that the destination was assembled
  // from request headers.
  globalThis.fetch = (async (input: unknown) => {
    outboundCalls.push(input);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
});

afterAll(() => {
  resetServerEnvCache();
});

describe("submitIntakeForm", () => {
  test("books a valid submission and returns the spectate URL", async () => {
    const result = await submitIntakeForm(form());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spectateUrl).toMatch(/^\/spectate\/[A-Za-z0-9_-]+$/);
    expect(result.appointmentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("makes no HTTP request at all", async () => {
    // The self-fetch is deleted, not hardened. There is no Host header to trust
    // and no NODE_ENV-derived scheme to get wrong, because there is no request.
    await submitIntakeForm(form());

    expect(outboundCalls).toEqual([]);
  });

  test("the spectate URL carries a sealed token, not the record", async () => {
    const result = await submitIntakeForm(form());

    if (!result.ok) throw new Error("expected a booking");
    expect(result.spectateUrl).not.toContain("ada");
    expect(result.spectateUrl).not.toContain("Lovelace");
    expect(result.spectateUrl.length).toBeLessThan(400);
  });

  test("rejects an invalid submission with per-field detail, without booking", async () => {
    const result = await submitIntakeForm(form({ email: "not-an-email" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toContain("email");
    expect(outboundCalls).toEqual([]);
  });

  test("rejects a missing required field", async () => {
    const data = form();
    data.delete("phone");

    const result = await submitIntakeForm(data);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field)).toContain("phone");
  });

  test("does not report a failure as a success", async () => {
    // The old action reported success by truthiness on a parsed body: a 500
    // with `{success: false, error}` was indistinguishable from a booking
    // unless the caller remembered to check three fields.
    setLlmClient({
      async generateJson() {
        throw new Error("Translation failed after 3 attempts: unavailable");
      },
    });

    const result = await submitIntakeForm(form());

    expect(result.ok).toBe(false);
  });

  test("does not put the underlying failure in front of the user", async () => {
    setLlmClient({
      async generateJson() {
        // A vendor error that echoes the request payload, which for this app is
        // the symptom text.
        throw new Error("Gemini 400: invalid value at additionalInfo: 'dolor de cabeza y fiebre'");
      },
    });

    const result = await submitIntakeForm(form());

    if (result.ok) throw new Error("expected a failure");
    expect(result.error).not.toContain("dolor de cabeza");
    expect(result.error).not.toContain("Gemini");
  });

  test("keeps the success result serializable across the server boundary", async () => {
    // A server action's return value is structured-cloned to the client. A
    // NextResponse does not survive that trip, which is a second reason the
    // action cannot be a thin HTTP client.
    const result = await submitIntakeForm(form());

    expect(() => structuredClone(result)).not.toThrow();
  });
});
