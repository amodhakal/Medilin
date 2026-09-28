import { describe, expect, test } from "bun:test";
import { redactFields, redactValue } from "./logger/redact";

describe("redactFields", () => {
  test("keeps allowlisted operational fields", () => {
    const out = redactFields({
      appointmentId: "abc",
      language: "spanish",
      durationMs: 12,
      statusCode: 200,
    });
    expect(out).toEqual({
      appointmentId: "abc",
      language: "spanish",
      durationMs: 12,
      statusCode: 200,
    });
  });

  test("drops a key that is not allowlisted", () => {
    // Deny-by-default: an unrecognised key is omitted rather than logged.
    const out = redactFields({ appointmentId: "abc", somethingNew: "value" });
    expect(out).toEqual({ appointmentId: "abc" });
    expect(out).not.toHaveProperty("somethingNew");
  });

  test("redacts a whole patient record", () => {
    const out = redactFields({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      dob: "1985-12-10",
      insurance: "yes",
      phone: "+1 555 0100",
      medical_department: "Doctor",
      additionalInfo: "severe headache and nausea",
    });
    const serialized = JSON.stringify(out);
    for (const leak of [
      "Ada",
      "Lovelace",
      "ada@example.test",
      "1985-12-10",
      "+1 555 0100",
      "severe headache",
    ]) {
      expect(serialized).not.toContain(leak);
    }
    // Sensitive keys are marked as present-but-withheld rather than dropped,
    // so the log still shows a value existed.
    expect(out.email).toBe("[redacted]");
    expect(out.additionalInfo).toBe("[redacted]");
  });

  test("redacts a nested patient record", () => {
    const out = redactFields({
      resource: "patient-1",
      details: { email: "ada@example.test", dob: "1985-12-10" },
    });
    expect(out.resource).toBe("patient-1");
    expect(JSON.stringify(out)).not.toContain("ada@example.test");
  });

  test("strips an email embedded in an allowlisted string", () => {
    const out = redactFields({ errorMessage: "failed for ada@example.test today" });
    expect(String(out.errorMessage)).not.toContain("ada@example.test");
  });

  test("strips a phone number embedded in an allowlisted string", () => {
    const out = redactFields({ errorMessage: "callback to +1 555 0100 failed" });
    expect(String(out.errorMessage)).not.toContain("555 0100");
  });

  test("truncates a long allowlisted string", () => {
    const out = redactFields({ errorMessage: "x".repeat(5000) });
    expect(String(out.errorMessage).length).toBeLessThanOrEqual(201);
  });

  test("summarises an Error without its stack", () => {
    const error = new Error("request failed for ada@example.test");
    error.stack = "Error: ...\n    at /very/long/path/that/reveals/infrastructure.ts:1:1";
    const out = redactFields({ cause: error });
    expect(out.cause).toMatchObject({ name: "Error" });
    expect(String((out.cause as { message: string }).message)).not.toContain(
      "ada@example.test",
    );
    expect(JSON.stringify(out)).not.toContain("reveals/infrastructure");
  });

  test("handles non-object input", () => {
    expect(redactFields(null)).toEqual({});
    expect(redactFields(undefined)).toEqual({});
    expect(redactFields("a string")).toEqual({});
    expect(redactFields(42)).toEqual({});
  });

  test("preserves booleans and numbers", () => {
    expect(redactFields({ confirmed: true, count: 0 })).toEqual({
      confirmed: true,
      count: 0,
    });
  });
});

describe("redactValue", () => {
  test("redacts an email string wherever it appears", () => {
    expect(redactValue("ada@example.test")).toBe("[redacted]");
  });

  test("redacts an SSN-shaped string", () => {
    expect(redactValue("123-45-6789")).toBe("[redacted]");
  });

  test("leaves ordinary text alone", () => {
    expect(redactValue("translation failed")).toBe("translation failed");
  });

  test("bounds array length", () => {
    const out = redactValue(Array.from({ length: 50 }, () => "x"));
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown[]).length).toBe(10);
  });

  test("bounds recursion depth", () => {
    let nested: Record<string, unknown> = { errorMessage: "leaf" };
    for (let i = 0; i < 10; i += 1) nested = { errorMessage: nested };
    const out = JSON.stringify(redactValue(nested));
    expect(out).toContain("truncated");
  });
});
