import { describe, expect, test } from "bun:test";
import { InMemoryAppointmentStore } from "./memory-store";
import type { Appointment } from "./store";
import type { AppointmentRecord } from "../validation/intake";

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

function appointment(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const createdAt = new Date("2026-09-01T10:00:00.000Z");
  return {
    id,
    patientInfo: record(),
    createdAt,
    updatedAt: createdAt,
    conversationEnded: false,
    status: "scheduled",
    ...overrides,
  };
}

describe("InMemoryAppointmentStore", () => {
  test("persists and returns an appointment", async () => {
    const store = new InMemoryAppointmentStore();
    const created = appointment("a1");

    expect(await store.create(created)).toEqual(created);
    expect(await store.get("a1")).toEqual(created);
  });

  test("assigns nothing itself: the id is the caller's", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("chosen-id"));
    expect((await store.get("chosen-id"))?.id).toBe("chosen-id");
  });

  test("returns undefined for an unknown id", async () => {
    const store = new InMemoryAppointmentStore();
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.get("")).toBeUndefined();
  });

  test("hands out copies, not the stored record", async () => {
    // The `Map` returned the live object, so a caller could rewrite the store
    // from two call sites away with no write and no trace.
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));

    const first = await store.get("a1");
    first!.patientInfo.firstName = "Mallory";
    first!.status = "cancelled";
    first!.createdAt.setUTCFullYear(1999);

    const second = await store.get("a1");
    expect(second!.patientInfo.firstName).toBe("Ada");
    expect(second!.status).toBe("scheduled");
    expect(second!.createdAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  test("stores a copy of what it was given", async () => {
    const store = new InMemoryAppointmentStore();
    const created = appointment("a1", { patientInfo: record({ firstName: "Ada" }) });
    await store.create(created);

    created.patientInfo.firstName = "Mallory";

    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Ada");
  });

  test("keeps separate ids apart", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));
    await store.create(appointment("a2", { patientInfo: record({ firstName: "Grace" }) }));

    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Ada");
    expect((await store.get("a2"))!.patientInfo.firstName).toBe("Grace");
  });

  test("replaces the id on a second create with the same id", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Grace" }) }));

    expect(store.size).toBe(1);
    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Grace");
  });

  describe("update", () => {
    test("changes a status and stamps updatedAt", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { status: "confirmed" });

      expect(updated!.status).toBe("confirmed");
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        appointment("a1").updatedAt.getTime(),
      );
      expect((await store.get("a1"))!.status).toBe("confirmed");
    });

    test("changes conversationEnded without touching the status", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { conversationEnded: true });

      expect(updated!.conversationEnded).toBe(true);
      expect(updated!.status).toBe("scheduled");
    });

    test("merges into the patient record", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", {
        patientInfo: record({ appointmentDateTime: "2026-10-02T14:00" }),
      });

      expect(updated!.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
      expect(updated!.patientInfo.firstName).toBe("REDACTED");
    });

    test("leaves the identity alone", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { status: "confirmed" });

      expect(updated!.id).toBe("a1");
      expect(updated!.createdAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    });

    test("an empty patch changes nothing but updatedAt", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", {});

      expect(updated!.patientInfo).toEqual(record());
      expect(updated!.status).toBe("scheduled");
    });

    test("returns undefined and stores nothing for an unknown id", async () => {
      const store = new InMemoryAppointmentStore();
      expect(await store.update("missing", { status: "confirmed" })).toBeUndefined();
      expect(store.size).toBe(0);
    });

    test("refuses a status outside the closed set", async () => {
      // A record in a state nothing can compare against is worse than a failed
      // request: every later status lookup silently misses it.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await expect(
        store.update("a1", { status: "CANCELLED" as never }),
      ).rejects.toThrow(/unknown appointment status/);
      expect((await store.get("a1"))!.status).toBe("scheduled");
    });
  });

  describe("cancel", () => {
    test("moves the appointment to cancelled", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const cancelled = await store.cancel("a1");

      expect(cancelled!.status).toBe("cancelled");
      expect((await store.get("a1"))!.status).toBe("cancelled");
    });

    test("is idempotent", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await store.cancel("a1");
      const again = await store.cancel("a1");

      expect(again!.status).toBe("cancelled");
    });

    test("returns undefined for an unknown id", async () => {
      const store = new InMemoryAppointmentStore();
      expect(await store.cancel("missing")).toBeUndefined();
    });

    test("keeps the patient record", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));

      expect((await store.cancel("a1"))!.patientInfo.firstName).toBe("Ada");
    });
  });
});
