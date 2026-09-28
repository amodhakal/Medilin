import { describe, expect, test } from "bun:test";
import { InMemoryAppointmentStore } from "./memory-store";
import type { ActionGrant, Appointment } from "./store";
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

const EXPIRES = new Date("2026-09-08T10:00:00.000Z");

function grant(overrides: Partial<ActionGrant> = {}): ActionGrant {
  return {
    jti: "cap-1",
    appointmentId: "a1",
    actions: ["reschedule", "cancel"],
    expiresAt: EXPIRES,
    withdrawnAt: null,
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

  // The capability grants of #59. These are what make a patient link revocable,
  // and the in-memory store is where the semantics are easiest to read: the
  // durable one has to express the same three rules in SQL, and
  // ./postgres-store.test is where those statements are asserted.
  describe("action grants", () => {
    test("remembers a grant and hands it back", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(await store.getActionGrant("cap-1")).toEqual(grant());
    });

    test("returns undefined for a jti that was never issued", async () => {
      // Which is how a token sealed under a stolen key is caught: authentic, and
      // with nothing behind it.
      const store = new InMemoryAppointmentStore();

      expect(await store.getActionGrant("cap-1")).toBeUndefined();
    });

    test("issuing the same jti twice is one live grant, not two", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"));

      await store.issueActionGrant(grant());

      expect(store.grantCount).toBe(1);
      // The re-issue did not un-spend it, which an upsert would have done.
      expect(await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"))).toBeUndefined();
    });

    test("hands out copies, so a caller cannot withdraw a grant in place", async () => {
      const store = new InMemoryAppointmentStore();
      const issued = await store.issueActionGrant(grant());

      issued.withdrawnAt = new Date("2000-01-01T00:00:00.000Z");
      issued.actions.push("cancel", "cancel");

      const stored = await store.getActionGrant("cap-1");
      expect(stored!.withdrawnAt).toBeNull();
      expect(stored!.actions).toEqual(["reschedule", "cancel"]);
    });

    test("spends a live grant once, and returns it marked", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      const spent = await store.spendActionGrant("cap-1", now);

      expect(spent!.withdrawnAt).toEqual(now);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(now);
    });

    test("a second spend of the same link gets nothing", async () => {
      // The patient clicked once, the button was pressed twice, the network
      // retried. Exactly one of them may act on it.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.spendActionGrant("cap-1", now)).toBeDefined();
      expect(await store.spendActionGrant("cap-1", now)).toBeUndefined();
    });

    test("concurrent spends of one link: exactly one wins", async () => {
      // Without the check and the write being adjacent, both would read a live
      // grant and both would act.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => store.spendActionGrant("cap-1", now)),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    test("spends a grant one millisecond before it expires", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(
        await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() - 1)),
      ).toBeDefined();
    });

    test("will not spend one that has already expired", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(await store.spendActionGrant("cap-1", EXPIRES)).toBeUndefined();
      expect(
        await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() + 1_000)),
      ).toBeUndefined();
      // Expiry is a refusal, not a withdrawal: the row is untouched, so a
      // clock that disagrees would still be given the same answer.
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toBeNull();
    });

    test("will not spend one that was never issued", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() - 1))).toBeUndefined();
    });

    test("withdraws every live grant for an appointment, and counts them", async () => {
      // What a cancellation does, and the reason a patient cannot cancel through
      // one link and then reschedule through an old copy of another.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant({ jti: "cap-1" }));
      await store.issueActionGrant(grant({ jti: "cap-2" }));
      await store.issueActionGrant(grant({ jti: "other", appointmentId: "a2" }));
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.withdrawActionGrants("a1", now)).toBe(2);

      expect(await store.spendActionGrant("cap-1", now)).toBeUndefined();
      expect(await store.spendActionGrant("cap-2", now)).toBeUndefined();
      // Another patient's link is untouched.
      expect(await store.spendActionGrant("other", now)).toBeDefined();
    });

    test("withdrawing twice counts once and changes nothing the second time", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.withdrawActionGrants("a1", now)).toBe(1);
      expect(await store.withdrawActionGrants("a1", now)).toBe(0);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(now);
    });

    test("withdrawing for an appointment with no grants is zero, not an error", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.withdrawActionGrants("nobody", new Date())).toBe(0);
    });

    test("keeps a spent grant reportable as spent", async () => {
      // Withdrawal is not deletion: a capability that has been used should still
      // be findable as used, which is what makes the trail worth having.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"));
      await store.withdrawActionGrants("a1", new Date("2026-09-03T10:00:00.000Z"));

      expect(store.grantCount).toBe(1);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(
        new Date("2026-09-02T10:00:00.000Z"),
      );
    });
  });
});
