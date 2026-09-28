import { afterEach, describe, expect, test } from "bun:test";
import {
  AUDIT_ACTORS,
  InMemoryAuditLogStore,
  readAuditLog,
  setAuditLogStore,
  verifyAuditChain,
} from "./audit";
import { resetSqlClient } from "@/lib/storage";
import {
  InMemoryAppointmentStore,
  PostgresAppointmentStore,
  cancelAppointment,
  createAppointment,
  getAppointment,
  getAppointmentStore,
  isDurableAppointmentStore,
  setAppointmentStore,
  updateAppointment,
} from "./appointments";
import type { AppointmentRecord } from "./validation/intake";

/**
 * The appointment facade, and the trail it writes.
 *
 * These are the tests for the default that ships: no DATABASE_URL, so the
 * in-memory stores, so a contributor's `bun test` and CI need no database and no
 * credentials. The stores' own behaviour is covered in ./memory-store.test and
 * ./postgres-store.test; what matters here is that the four functions route to
 * whichever store is selected, that the selection is the thing #17 is about, and
 * that every one of the four leaves an entry behind.
 *
 * The audit assertions are the point of the second half of this file. A trail
 * that only exists in a module nothing calls is a module nothing calls, and this
 * is where it stops being that.
 */

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

const savedDatabaseUrl = process.env.DATABASE_URL;
let audit: InMemoryAuditLogStore;

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  resetSqlClient();
  setAppointmentStore(null);
  setAuditLogStore(audit);
});

/** Install a fresh trail, so each test reads only its own entries. */
function freshAudit() {
  audit = new InMemoryAuditLogStore();
  setAuditLogStore(audit);
  return audit;
}

describe("appointment store selection", () => {
  test("uses the in-memory store when DATABASE_URL is unset", () => {
    // The default, and the reason a test run needs no credentials.
    delete process.env.DATABASE_URL;
    resetSqlClient();

    expect(getAppointmentStore()).toBeInstanceOf(InMemoryAppointmentStore);
    expect(isDurableAppointmentStore()).toBe(false);
  });

  test("uses the Postgres store when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = "https://db.example.test/neon";
    resetSqlClient();

    expect(getAppointmentStore()).toBeInstanceOf(PostgresAppointmentStore);
    expect(isDurableAppointmentStore()).toBe(true);
  });

  test("chooses once and keeps the choice", () => {
    // A store that was re-selected per call would drop every in-memory booking
    // the moment the environment was read differently, and would open a new
    // connection pool on every request.
    delete process.env.DATABASE_URL;
    resetSqlClient();
    expect(getAppointmentStore()).toBe(getAppointmentStore());
  });

  test("a store installed through the seam is the one that is used", () => {
    const installed = new InMemoryAppointmentStore();
    setAppointmentStore(installed);

    expect(getAppointmentStore()).toBe(installed);
    expect(isDurableAppointmentStore()).toBe(false);
  });

  test("setAppointmentStore(null) goes back to selecting from the environment", () => {
    process.env.DATABASE_URL = "https://db.example.test/neon";
    resetSqlClient();
    setAppointmentStore(new InMemoryAppointmentStore());
    setAppointmentStore(null);

    expect(getAppointmentStore()).toBeInstanceOf(PostgresAppointmentStore);
  });
});

describe("createAppointment", () => {
  test("creates and retrieves an appointment", async () => {
    freshAudit();
    const created = await createAppointment(record());
    const found = await getAppointment(created.id, AUDIT_ACTORS.internalApi);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.patientInfo).toEqual(record());
    expect(found?.conversationEnded).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test("assigns a unique id per appointment", async () => {
    freshAudit();
    const ids = new Set(
      await Promise.all(
        Array.from({ length: 50 }, async () => (await createAppointment(record())).id),
      ),
    );
    expect(ids.size).toBe(50);
  });

  test("starts scheduled, with createdAt and updatedAt in step", async () => {
    freshAudit();
    const created = await createAppointment(record());

    expect(created.status).toBe("scheduled");
    expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await getAppointment("00000000-0000-0000-0000-000000000000", AUDIT_ACTORS.internalApi)).toBeUndefined();
    expect(await getAppointment("not-a-uuid", AUDIT_ACTORS.internalApi)).toBeUndefined();
    expect(await getAppointment("", AUDIT_ACTORS.internalApi)).toBeUndefined();
  });

  test("a stored appointment survives a read that goes through a fresh reference", async () => {
    // What a durable store has to deliver and the in-memory one only
    // coincidentally does today: the record the booking path stored is the
    // record the read path finds.
    freshAudit();
    const created = await createAppointment(record({ firstName: "Ada" }));
    expect((await getAppointment(created.id, AUDIT_ACTORS.linkBearer))?.patientInfo.firstName).toBe("Ada");
  });
});

describe("updateAppointment", () => {
  test("changes a status", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, { status: "confirmed" });

    expect(updated?.status).toBe("confirmed");
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("confirmed");
  });

  test("changes the patient record", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, {
      patientInfo: record({ appointmentDateTime: "2026-10-02T14:00" }),
    });

    expect(updated?.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await updateAppointment("missing", { status: "confirmed" })).toBeUndefined();
  });

  test("refuses a status outside the closed set, before it reaches a store", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await expect(
      updateAppointment(created.id, { status: "Cancelled" as never }),
    ).rejects.toThrow(/unknown appointment status/);
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("scheduled");
  });

  test("refuses an unknown status without an appointment to reject it against", async () => {
    freshAudit();
    await expect(updateAppointment("missing", { status: "nope" as never })).rejects.toThrow(
      /unknown appointment status/,
    );
  });
});

describe("cancelAppointment", () => {
  test("cancels an appointment", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const cancelled = await cancelAppointment(created.id);

    expect(cancelled?.status).toBe("cancelled");
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("cancelled");
  });

  test("is idempotent", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await cancelAppointment(created.id);
    expect((await cancelAppointment(created.id))?.status).toBe("cancelled");
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await cancelAppointment("missing")).toBeUndefined();
  });
});

describe("the audit trail", () => {
  test("a booking is in the trail before the record is written", async () => {
    // Intent first, then the write. If the trail cannot be written the booking
    // does not happen, which is the only ordering in which an access cannot
    // occur unrecorded.
    const trail = freshAudit();
    const created = await createAppointment(record({ language: "spanish" }));

    const logs = await readAuditLog();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("APPOINTMENT_CREATED");
    expect(logs[0].resource).toBe(`appointment:${created.id}`);
    expect(logs[0].details).toEqual({ reason: "intake", status: "scheduled", language: "spanish" });
    expect(trail.size).toBe(1);
  });

  test("a record read is in the trail, attributed to whoever read it", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);
    await getAppointment(created.id, AUDIT_ACTORS.internalApi);

    const reads = (await readAuditLog()).filter((entry) => entry.action === "PHI_READ");
    expect(reads.map((entry) => entry.actor)).toEqual([
      AUDIT_ACTORS.linkBearer,
      AUDIT_ACTORS.internalApi,
    ]);
    expect(reads[0].resource).toBe(`appointment:${created.id}`);
  });

  test("a read of an appointment that is not there is not an access", async () => {
    // Nothing was read, so there is nothing to record. Logging it anyway would
    // fill the trail with misses and make the real accesses harder to find.
    freshAudit();
    await getAppointment("missing", AUDIT_ACTORS.internalApi);

    expect(await readAuditLog()).toEqual([]);
  });

  test("an update and a cancellation are in the trail", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await updateAppointment(created.id, { status: "confirmed" });
    await cancelAppointment(created.id);

    const actions = (await readAuditLog()).map((entry) => entry.action);
    expect(actions).toEqual([
      "APPOINTMENT_CREATED",
      "APPOINTMENT_UPDATED",
      "APPOINTMENT_CANCELLED",
    ]);
  });

  test("no entry carries a field of the patient record", async () => {
    // The trail cannot be redacted and cannot be dropped, so what goes in it has
    // to be the three non-identifying fields and nothing else.
    freshAudit();
    const created = await createAppointment(
      record({ firstName: "Ada", additionalInfo: "chest pain", phone: "+1 555 0100" }),
    );
    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);

    const serialised = JSON.stringify(await readAuditLog());
    for (const leak of ["Ada", "chest pain", "+1 555 0100", "1985-12-10", "REDACTED"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  test("the chain covers the whole booking and read sequence", async () => {
    freshAudit();
    const created = await createAppointment(record());
    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);
    await updateAppointment(created.id, { status: "confirmed" });

    expect(await verifyAuditChain()).toBe(true);
  });

  test("a booking fails, and no record is written, when the trail cannot be", async () => {
    // The fail-closed property, and the reason it is worth the extra round trip.
    setAuditLogStore({
      async append() {
        throw new Error("the database could not be reached");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    const store = new InMemoryAppointmentStore();
    setAppointmentStore(store);

    await expect(createAppointment(record())).rejects.toThrow(/could not be reached/);
    expect(store.size).toBe(0);
  });

  test("a read is not disclosed when the trail cannot record it", async () => {
    freshAudit();
    const created = await createAppointment(record());

    setAuditLogStore({
      async append() {
        throw new Error("the database could not be reached");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    // The record was loaded into this process and goes no further: not returned,
    // not rendered, not emailed.
    await expect(getAppointment(created.id, AUDIT_ACTORS.linkBearer)).rejects.toThrow(
      /could not be reached/,
    );
  });
});
