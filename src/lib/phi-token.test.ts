import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openRecord, sealRecord } from "./phi-token";
import { resetServerEnvCache } from "./env";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

const saved = process.env.HIPAA_MASTER_KEY;

beforeAll(() => {
  process.env.HIPAA_MASTER_KEY = KEY;
  resetServerEnvCache();
});

// Restored in afterAll rather than in a test: an ordinary test case runs
// before its later siblings, so restoring there would unset the key for the
// rest of the file and fail every seal after it.
afterAll(() => {
  if (saved === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = saved;
  resetServerEnvCache();
});

const record = JSON.stringify({
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  additionalInfo: "headache",
});

describe("sealRecord", () => {
  test("round-trips", () => {
    expect(openRecord(sealRecord(record))).toBe(record);
  });

  test("produces no plaintext in the token", () => {
    // The whole point: this string is what lands in a URL, a browser history
    // entry, and an access log.
    const token = sealRecord(record);
    for (const leak of ["Ada", "Lovelace", "ada@example.test", "1985-12-10", "headache"]) {
      expect(token).not.toContain(leak);
      expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain(leak);
    }
  });

  test("is URL-safe", () => {
    const token = sealRecord(record);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  test("is fresh per call", () => {
    expect(sealRecord(record)).not.toBe(sealRecord(record));
  });

  test("is a bearer credential only the server can open", () => {
    const token = sealRecord(record);
    process.env.HIPAA_MASTER_KEY = OTHER;
    resetServerEnvCache();
    expect(openRecord(token)).toBeNull();
    process.env.HIPAA_MASTER_KEY = KEY;
    resetServerEnvCache();
    expect(openRecord(token)).toBe(record);
  });
});

describe("openRecord", () => {
  test("rejects a tampered ciphertext", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[raw.length - 1] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test("rejects a tampered auth tag", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[20] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test("rejects a tampered IV", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[3] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test.each([
    ["an empty string", ""],
    ["a short string", "abc"],
    ["not base64 at all", "!!!!"],
    ["random hex", "deadbeef"],
    ["a truncated token", "AAAA"],
  ])("returns null for %s", (_label, token) => {
    expect(openRecord(token)).toBeNull();
  });

  test("rejects an unknown version", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[0] = 9;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });
});
