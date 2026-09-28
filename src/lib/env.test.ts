import { afterEach, describe, expect, test } from "bun:test";
import { getServerEnv, resetServerEnvCache } from "./env";

const VALID = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
} as const;

const TOUCHED = [
  "GEMINI_KEY",
  "RESEND_KEY",
  "HIPAA_MASTER_KEY",
  "ELEVENLABS_AGENT_PATIENT_ID",
  "ELEVENLABS_AGENT_RECEPTIONIST_ID",
  "ELEVENLABS_API_KEY",
  "DATABASE_URL",
  "INTERNAL_API_SECRET",
  "SENTRY_DSN",
  "CRON_SECRET",
  "CLINIC_NAME",
  "EMAIL_FROM",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
];

const saved = new Map<string, string | undefined>();

beforeEachSave();
function beforeEachSave() {
  for (const key of TOUCHED) saved.set(key, process.env[key]);
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

function setValidEnv() {
  for (const key of TOUCHED) delete process.env[key];
  Object.assign(process.env, VALID);
  resetServerEnvCache();
}

describe("server env", () => {
  test("accepts a fully populated environment", () => {
    setValidEnv();
    const env = getServerEnv();
    expect(env.GEMINI_KEY).toBe(VALID.GEMINI_KEY);
    expect(env.HIPAA_MASTER_KEY).toBe(VALID.HIPAA_MASTER_KEY);
  });

  test("reports every missing required variable at once", () => {
    for (const key of TOUCHED) delete process.env[key];
    resetServerEnvCache();

    // Fixing variables one round-trip at a time is how a deploy ends up
    // failing five times in a row.
    expect(() => getServerEnv()).toThrow(/Invalid server environment/);
    for (const key of Object.keys(VALID)) {
      expect(() => getServerEnv()).toThrow(new RegExp(key));
    }
  });

  test("rejects a malformed HIPAA_MASTER_KEY", () => {
    setValidEnv();
    process.env.HIPAA_MASTER_KEY = "abc123";
    resetServerEnvCache();
    expect(() => getServerEnv()).toThrow(/64 hex characters/);
  });

  test("rejects an empty required variable", () => {
    setValidEnv();
    process.env.GEMINI_KEY = "";
    resetServerEnvCache();
    expect(() => getServerEnv()).toThrow(/GEMINI_KEY/);
  });

  test("rejects a too-short INTERNAL_API_SECRET", () => {
    setValidEnv();
    process.env.INTERNAL_API_SECRET = "short";
    resetServerEnvCache();
    expect(() => getServerEnv()).toThrow(/INTERNAL_API_SECRET/);
  });

  test("optional variables may be absent", () => {
    setValidEnv();
    const env = getServerEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
  });

  test("applies defaults for clinic identity", () => {
    setValidEnv();
    const env = getServerEnv();
    expect(env.CLINIC_NAME).toBe("City Medical Center");
    expect(env.EMAIL_FROM).toBe("onboarding@resend.dev");
  });

  test("honours overrides for clinic identity", () => {
    setValidEnv();
    process.env.CLINIC_NAME = "Test Clinic";
    process.env.EMAIL_FROM = "no-reply@example.test";
    resetServerEnvCache();

    const env = getServerEnv();
    expect(env.CLINIC_NAME).toBe("Test Clinic");
    expect(env.EMAIL_FROM).toBe("no-reply@example.test");
  });

  test("caches until reset", () => {
    setValidEnv();
    expect(getServerEnv().GEMINI_KEY).toBe(VALID.GEMINI_KEY);

    process.env.GEMINI_KEY = "changed-without-reset";
    expect(getServerEnv().GEMINI_KEY).toBe(VALID.GEMINI_KEY);

    resetServerEnvCache();
    expect(getServerEnv().GEMINI_KEY).toBe("changed-without-reset");
  });
});
