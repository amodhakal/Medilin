import { describe, expect, test } from "bun:test";
import { applyTranslation } from "./translateToEnglish";
import type { AppointmentRecord } from "./validation/intake";

const base: AppointmentRecord = {
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
};

describe("applyTranslation", () => {
  test("takes translated values for the two translatable fields", () => {
    const result = applyTranslation(base, {
      additionalInfo: "headache",
      medical_department: "Doctor",
    });
    expect(result.additionalInfo).toBe("headache");
    expect(result.medical_department).toBe("Doctor");
  });

  test("ignores an attempt to overwrite the email address", () => {
    // The core of #12: the model previously spread its whole response over
    // the record, so this would have redirected the confirmation email.
    const result = applyTranslation(base, {
      additionalInfo: "headache",
      email: "attacker@example.test",
    });
    expect(result.email).toBe("ada@example.test");
  });

  test("ignores an attempt to overwrite names, dob, and phone", () => {
    const result = applyTranslation(base, {
      firstName: "Mallory",
      lastName: "Mallory",
      dob: "1900-01-01",
      phone: "+1 555 9999",
      appointmentDateTime: "2020-01-01T00:00",
    });
    expect(result).toEqual(base);
  });

  test("discards unknown keys rather than adding them", () => {
    const result = applyTranslation(base, {
      additionalInfo: "headache",
      isAdmin: true,
      role: "clinician",
    });
    expect(result).not.toHaveProperty("isAdmin");
    expect(result).not.toHaveProperty("role");
  });

  test("ignores non-string and empty values", () => {
    expect(applyTranslation(base, { additionalInfo: 42 }).additionalInfo).toBe(
      base.additionalInfo,
    );
    expect(applyTranslation(base, { additionalInfo: "   " }).additionalInfo).toBe(
      base.additionalInfo,
    );
    expect(applyTranslation(base, { additionalInfo: null }).additionalInfo).toBe(
      base.additionalInfo,
    );
  });

  test.each([
    ["a string", "not json at all"],
    ["an array", ["headache"]],
    ["null", null],
    ["a number", 7],
  ])("returns the original record when the response is %s", (_label, response) => {
    expect(applyTranslation(base, response)).toEqual(base);
  });

  test("keeps the original record when a translated value breaks the schema", () => {
    // A department the form never offers must not reach storage.
    const result = applyTranslation(base, { medical_department: "Astrology" });
    expect(result).toEqual(base);
  });

  test("does not mutate the record it was given", () => {
    const snapshot = structuredClone(base);
    applyTranslation(base, { additionalInfo: "headache" });
    expect(base).toEqual(snapshot);
  });

  test("truncates an oversized translation", () => {
    const result = applyTranslation(base, { additionalInfo: "x".repeat(5000) });
    expect(result.additionalInfo.length).toBeLessThanOrEqual(2000);
  });
});
