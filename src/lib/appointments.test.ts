import { describe, expect, test } from "bun:test";
import { createAppointment, getAppointment } from "./appointments";
import type { AppointmentRecord } from "./validation/intake";

// Obviously fake. This repository is public.
function record(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    firstName: "REDACTED",
    lastName: "REDACTED",
    email: "patient@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Doctor",
    additionalInfo: "",
    language: "english",
    ...overrides,
  };
}

describe("appointment store", () => {
  test("creates and retrieves an appointment", () => {
    const created = createAppointment(record());
    const found = getAppointment(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.patientInfo).toEqual(record());
    expect(found?.conversationEnded).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test("assigns a unique id per appointment", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createAppointment(record()).id),
    );
    expect(ids.size).toBe(50);
  });

  test("returns undefined for an unknown id", () => {
    expect(getAppointment("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(getAppointment("not-a-uuid")).toBeUndefined();
  });
});
