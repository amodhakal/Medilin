import { describe, expect, test } from "bun:test";
import { createAppointment, getAppointment } from "./appointments";

describe("appointment store", () => {
  test("creates and retrieves an appointment", () => {
    const created = createAppointment({ firstName: "REDACTED" });
    const found = getAppointment(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.patientInfo).toEqual({ firstName: "REDACTED" });
    expect(found?.conversationEnded).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test("assigns a unique id per appointment", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createAppointment({}).id),
    );
    expect(ids.size).toBe(50);
  });

  test("returns undefined for an unknown id", () => {
    expect(getAppointment("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(getAppointment("not-a-uuid")).toBeUndefined();
  });
});
