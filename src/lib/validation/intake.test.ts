import { describe, expect, test } from "bun:test";
import {
  intakeFromFormData,
  intakeSchema,
  intakeSummaryRequestSchema,
  MEDICAL_DEPARTMENTS,
  webhookPayloadSchema,
} from "./intake";

const valid = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "mild headache",
  language: "spanish",
};

describe("intakeSchema", () => {
  test("accepts a well-formed submission", () => {
    const result = intakeSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("trims whitespace and applies defaults", () => {
    const result = intakeSchema.parse({
      ...valid,
      firstName: "  Ada  ",
      additionalInfo: "",
      language: undefined,
    });
    expect(result.firstName).toBe("Ada");
    expect(result.language).toBe("english");
  });

  test("rejects unknown keys rather than dropping them", () => {
    // This is what stops a caller smuggling extra fields into storage.
    const result = intakeSchema.safeParse({ ...valid, isAdmin: "true" });
    expect(result.success).toBe(false);
  });

  test.each([
    ["firstName", ""],
    ["firstName", "   "],
    ["lastName", ""],
    ["email", "not-an-email"],
    ["email", "a@b"],
    ["dob", "10/12/1985"],
    ["dob", "1985-13-45"],
    ["dob", "1985-02-30"],
    ["insurance", "maybe"],
    ["phone", "12"],
    ["appointmentDateTime", "2026-10-01 09:30"],
    ["medical_department", "Astrology"],
    ["additionalInfo", "x".repeat(2001)],
    ["language", "klingon"],
  ])("rejects an invalid %s (%s)", (field, value) => {
    const result = intakeSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
  });

  test("accepts every declared department", () => {
    for (const department of MEDICAL_DEPARTMENTS) {
      expect(intakeSchema.safeParse({ ...valid, medical_department: department }).success).toBe(true);
    }
  });

  test("rejects a missing required field", () => {
    const { email: _omitted, ...withoutEmail } = valid;
    expect(intakeSchema.safeParse(withoutEmail).success).toBe(false);
  });

  test("reports every failing field at once", () => {
    const result = intakeSchema.safeParse({ ...valid, email: "bad", phone: "1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("email");
      expect(fields).toContain("phone");
    }
  });
});

describe("intakeFromFormData", () => {
  test("reads a submission out of FormData", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) {
      formData.append(key, value);
    }
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(true);
  });

  test("ignores keys the schema does not declare", () => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(valid)) {
      formData.append(key, value);
    }
    formData.append("isAdmin", "true");
    // Ignored rather than passed through, so it cannot trip .strict().
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(true);
  });

  test("reports absent fields as missing", () => {
    const formData = new FormData();
    formData.append("firstName", "Ada");
    expect(intakeSchema.safeParse(intakeFromFormData(formData)).success).toBe(false);
  });
});

describe("webhookPayloadSchema", () => {
  test("accepts a well-formed payload", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "ada@example.test",
        language: "english",
        info: "{}",
      }).success,
    ).toBe(true);
  });

  test("rejects a payload with extra keys", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "ada@example.test",
        language: "english",
        info: "{}",
        from: "attacker@example.test",
      }).success,
    ).toBe(false);
  });

  test("rejects an arbitrary recipient", () => {
    expect(
      webhookPayloadSchema.safeParse({
        email: "victim@example.test",
        language: "english",
        info: "{}",
      }).success,
    ).toBe(true);
  });
});

describe("intakeSummaryRequestSchema", () => {
  test("accepts a sealed token", () => {
    expect(
      intakeSummaryRequestSchema.safeParse({ token: "abc123SEALEDtoken" }).success,
    ).toBe(true);
  });

  test.each([
    ["a missing token", {}],
    ["a blank token", { token: "" }],
    ["a whitespace-only token", { token: "   " }],
    ["a non-string token", { token: 12345 }],
    // There is no id-based alternative, so an id has to be refused rather than
    // ignored: an accepted request that then looks up nothing is a 404 the
    // caller cannot explain.
    ["an appointment id", { token: "abc", appointmentId: "1" }],
    ["a raw record", { token: "abc", record: { firstName: "Ada" } }],
  ])("rejects %s", (_label, value) => {
    expect(intakeSummaryRequestSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a token long enough to be an attempt at something", () => {
    expect(intakeSummaryRequestSchema.safeParse({ token: "x".repeat(20_001) }).success).toBe(
      false,
    );
  });
});
