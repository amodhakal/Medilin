import { describe, expect, test } from "bun:test";
import { decryptPHI, encryptPHI } from "./encryption";

// A throwaway test key. Never reuse a value like this outside a test.
const TEST_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

const plaintext = "Example: name REDACTED, dob 19XX-01-01, note lorem ipsum";

describe("envelope encryption", () => {
  test("round-trips plaintext", () => {
    const envelope = encryptPHI(plaintext, TEST_KEY);
    expect(decryptPHI(envelope, TEST_KEY)).toBe(plaintext);
  });

  test("round-trips unicode and empty input", () => {
    for (const value of ["", "ünïcödé ✅ مرحبا", "x".repeat(100_000)]) {
      const envelope = encryptPHI(value, TEST_KEY);
      expect(decryptPHI(envelope, TEST_KEY)).toBe(value);
    }
  });

  test("produces a distinct DEK and IV per call", () => {
    // A reused IV under a reused DEK is catastrophic for GCM, so identical
    // IVs across two encryptions of different plaintext is the failure this
    // guards.
    const a = encryptPHI("first record", TEST_KEY);
    const b = encryptPHI("second record", TEST_KEY);

    expect(a.iv).not.toBe(b.iv);
    expect(a.dekIv).not.toBe(b.dekIv);
    expect(a.encryptedDEK).not.toBe(b.encryptedDEK);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("does not leak plaintext into the envelope", () => {
    const envelope = encryptPHI(plaintext, TEST_KEY);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("REDACTED");
    expect(serialized).not.toContain(plaintext);
  });

  test("fails closed when no master key is available", () => {
    const previous = process.env.HIPAA_MASTER_KEY;
    delete process.env.HIPAA_MASTER_KEY;
    try {
      expect(() => encryptPHI(plaintext)).toThrow(/HIPAA_MASTER_KEY is not set/);
    } finally {
      if (previous !== undefined) process.env.HIPAA_MASTER_KEY = previous;
    }
  });

  test("rejects a master key of the wrong length", () => {
    expect(() => encryptPHI(plaintext, "abc123")).toThrow(/64 hex characters/);
    expect(() => encryptPHI(plaintext, "z".repeat(64))).toThrow(/64 hex characters/);
    expect(() => encryptPHI(plaintext, "a".repeat(63))).toThrow(/64 hex characters/);
  });

  test("reads the master key from the environment", () => {
    const previous = process.env.HIPAA_MASTER_KEY;
    process.env.HIPAA_MASTER_KEY = TEST_KEY;
    try {
      const envelope = encryptPHI(plaintext);
      expect(decryptPHI(envelope)).toBe(plaintext);
    } finally {
      if (previous === undefined) delete process.env.HIPAA_MASTER_KEY;
      else process.env.HIPAA_MASTER_KEY = previous;
    }
  });

  describe("tamper detection", () => {
    test("rejects a modified ciphertext", () => {
      const envelope = encryptPHI(plaintext, TEST_KEY);
      const flipped = flipFirstHexChar(envelope.ciphertext);
      expect(() => decryptPHI({ ...envelope, ciphertext: flipped }, TEST_KEY)).toThrow();
    });

    test("rejects a modified IV", () => {
      const envelope = encryptPHI(plaintext, TEST_KEY);
      const flipped = flipFirstHexChar(envelope.iv);
      expect(() => decryptPHI({ ...envelope, iv: flipped }, TEST_KEY)).toThrow();
    });

    test("rejects a modified auth tag", () => {
      const envelope = encryptPHI(plaintext, TEST_KEY);
      const flipped = flipFirstHexChar(envelope.authTag);
      expect(() => decryptPHI({ ...envelope, authTag: flipped }, TEST_KEY)).toThrow();
    });

    test("rejects a modified wrapped DEK", () => {
      const envelope = encryptPHI(plaintext, TEST_KEY);
      const flipped = flipFirstHexChar(envelope.encryptedDEK);
      expect(() => decryptPHI({ ...envelope, encryptedDEK: flipped }, TEST_KEY)).toThrow();
    });

    test("rejects decryption under a different master key", () => {
      const envelope = encryptPHI(plaintext, TEST_KEY);
      expect(() => decryptPHI(envelope, OTHER_KEY)).toThrow();
    });
  });
});

/** Change one hex digit so the value is still well-formed but no longer equal. */
function flipFirstHexChar(hex: string): string {
  return (hex[0] === "0" ? "1" : "0") + hex.slice(1);
}
