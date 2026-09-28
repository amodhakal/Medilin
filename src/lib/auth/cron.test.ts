import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import { requireCronSecret, verifyCronSecret } from "./cron";

/**
 * The lock on the cron route (#67).
 *
 * The reminder endpoint sends email to real patients in bulk, and it is reachable
 * by anyone who can guess the URL. So the tests here are as much about the lock as
 * they are about the comparison, and the first of them is the one that matters
 * most: an *unset* secret must mean closed, not open. The old state of this
 * variable was "declared and never read", and the only thing standing between that
 * and an open relay is what happens when someone deploys without setting it.
 */

const SECRET = "cron-secret-value";
const OTHER = "cron-secret-valu";

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const saved = { ...process.env };

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  process.env.CRON_SECRET = SECRET;
  resetServerEnvCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetServerEnvCache();
});

function request(authorization?: string) {
  return new Request("https://clinic.test/api/cron/reminders", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe("verifyCronSecret", () => {
  test("accepts the configured secret as a bearer token", () => {
    // The exact header Vercel sends when CRON_SECRET is set, and the reason the
    // header name here is `Authorization` rather than a custom one.
    expect(verifyCronSecret(`Bearer ${SECRET}`)).toBe(true);
  });

  test("refuses when CRON_SECRET is not set, rather than treating it as open", () => {
    delete process.env.CRON_SECRET;
    resetServerEnvCache();

    // Fail closed. The alternative is that forgetting one variable turns a
    // deployment into a bulk mail relay pointed at a list of real patients.
    expect(verifyCronSecret(`Bearer ${SECRET}`)).toBe(false);
    expect(verifyCronSecret("Bearer anything")).toBe(false);
    expect(verifyCronSecret(null)).toBe(false);
  });

  test.each([
    ["the wrong secret", `Bearer ${OTHER}`],
    ["a secret that is a prefix of the real one", "Bearer cron-secret"],
    ["an empty bearer", "Bearer "],
    ["the raw secret with no scheme", SECRET],
    ["a lowercase scheme", `bearer ${SECRET}`],
    ["no header at all", undefined],
    ["a header that is only whitespace", "   "],
  ])("refuses %s", (_label, header) => {
    expect(verifyCronSecret(header ?? null)).toBe(false);
  });

  test("compares without leaking length through an exception", () => {
    // `timingSafeEqual` throws when the two buffers differ in length, so a naive
    // implementation that hashed nothing would throw on a short guess and return
    // `false` on a long one. Hashing first means every guess is the same shape.
    expect(verifyCronSecret("Bearer x")).toBe(false);
    expect(verifyCronSecret(`Bearer ${SECRET}${"y".repeat(5000)}`)).toBe(false);
    expect(verifyCronSecret("")).toBe(false);
  });
});

describe("requireCronSecret", () => {
  test("lets a scheduler through", () => {
    expect(requireCronSecret(request(`Bearer ${SECRET}`))).toEqual({ ok: true });
  });

  test("answers 401 for everyone else", () => {
    const guard = requireCronSecret(request("Bearer wrong"));

    expect(guard.ok).toBe(false);
    if (guard.ok) return;

    expect(guard.response.status).toBe(401);
  });

  test("the same body whatever the guess, so probing learns nothing", async () => {
    const bodies = await Promise.all(
      ["wrong", "Bearer ", SECRET.toUpperCase(), undefined].map(async (header) => {
        const guard = requireCronSecret(request(header));
        return guard.ok ? null : await guard.response.text();
      }),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  test("does not accept the internal secret in its place", () => {
    // Two different credentials for two different trust boundaries. A caller that
    // holds INTERNAL_API_SECRET is this application's own code; a caller that
    // holds CRON_SECRET is the scheduler. Neither implies the other.
    expect(verifyCronSecret(`Bearer ${BASELINE.INTERNAL_API_SECRET}`)).toBe(false);
  });
});
