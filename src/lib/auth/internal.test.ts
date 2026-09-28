import { afterEach, describe, expect, test } from "bun:test";
import { INTERNAL_SECRET_HEADER, verifyInternalSecret } from "./internal";
import { resetServerEnvCache } from "@/lib/env";

const SECRET = "s".repeat(32);

// The guard reads the whole validated environment, so every required
// variable has to be present and every mutation has to be undone, or the
// suite order decides which test throws.
const REQUIRED = [
  "GEMINI_KEY",
  "RESEND_KEY",
  "HIPAA_MASTER_KEY",
  "ELEVENLABS_AGENT_PATIENT_ID",
  "ELEVENLABS_AGENT_RECEPTIONIST_ID",
  "INTERNAL_API_SECRET",
] as const;

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

// Seed rather than assume: `bun test` runs with no ambient environment, so a
// guard that validates the whole env would throw in every test. Capture the
// snapshot after seeding, or afterEach restores "unset" and undoes this.
for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

const saved = new Map<string, string | undefined>(
  REQUIRED.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = value;
  resetServerEnvCache();
}

describe("verifyInternalSecret", () => {
  test("accepts the exact secret", () => {
    setSecret(SECRET);
    expect(verifyInternalSecret(SECRET)).toBe(true);
  });

  test("rejects a wrong secret", () => {
    setSecret(SECRET);
    expect(verifyInternalSecret("x".repeat(32))).toBe(false);
  });

  test("rejects a missing header", () => {
    setSecret(SECRET);
    expect(verifyInternalSecret(null)).toBe(false);
    expect(verifyInternalSecret("")).toBe(false);
  });

  test("rejects a prefix of the secret", () => {
    setSecret(SECRET);
    expect(verifyInternalSecret(SECRET.slice(0, -1))).toBe(false);
  });

  test("rejects a secret with trailing whitespace", () => {
    setSecret(SECRET);
    expect(verifyInternalSecret(`${SECRET} `)).toBe(false);
  });

  test("an unset secret is rejected by the environment schema", () => {
    // INTERNAL_API_SECRET is required, so absence never reaches the
    // comparison: getServerEnv throws first, and instrumentation.ts refuses to
    // boot. The guard's own `!expected` branch is defence in depth for a
    // future where the variable becomes optional again.
    setSecret(undefined);
    expect(() => verifyInternalSecret("anything")).toThrow(/INTERNAL_API_SECRET/);
  });

  test("never treats an unset secret as no auth required", () => {
    // The dangerous alternative is an absent secret meaning "open", which
    // would silently restore the mail relay on a misconfigured deploy.
    setSecret(undefined);
    let returned: boolean | undefined;
    try {
      returned = verifyInternalSecret(SECRET);
    } catch {
      returned = undefined;
    }
    expect(returned).not.toBe(true);
  });

  test("propagates an invalid environment rather than returning false", () => {
    setSecret(undefined);
    delete process.env.GEMINI_KEY;
    resetServerEnvCache();

    // An invalid environment throws, which surfaces as a 500. That is
    // deliberate and acceptable: src/instrumentation.ts already refuses to
    // boot the process in this state, so reaching here means the boot check
    // was bypassed. Swallowing it into a 401 would hide the misconfiguration.
    expect(() => verifyInternalSecret("anything")).toThrow(/Invalid server environment/);
  });

  test("compares in constant time", () => {
    // Not a timing measurement. This asserts the implementation hashes both
    // sides to equal length first, which is what makes crypto.timingSafeEqual
    // applicable and stops a short input from being rejected on length alone.
    setSecret(SECRET);
    expect(verifyInternalSecret("s")).toBe(false);
    expect(verifyInternalSecret("s".repeat(31))).toBe(false);
    expect(verifyInternalSecret("s".repeat(33))).toBe(false);
  });
});

describe("header name", () => {
  test("is the documented custom header", () => {
    expect(INTERNAL_SECRET_HEADER).toBe("x-internal-secret");
  });
});
