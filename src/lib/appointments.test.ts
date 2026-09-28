import { afterEach, describe, expect, test } from "bun:test";
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
 * The appointment facade.
 *
 * These are the tests for the default that ships: no DATABASE_URL, so the
 * in-memory store, so a contributor's `bun test` and CI need no database and
 * no credentials. The store's own behaviour is covered in ./memory-store.test
 * and ./postgres-store.test; what matters here is that the four functions route
 * to whichever store is selected, and that the selection itself is the thing
 * #17 is about.
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

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  resetSqlClient();
  setAppointmentStore(null);
});

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
    const created = await createAppointment(record());
    const found = await getAppointment(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.patientInfo).toEqual(record());
    expect(found?.conversationEnded).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test("assigns a unique id per appointment", async () => {
    const ids = new Set(
      await Promise.all(Array.from({ length: 50 }, async () => (await createAppointment(record())).id)),
    );
    expect(ids.size).toBe(50);
  });

  test("starts scheduled, with createdAt and updatedAt in step", async () => {
    const created = await createAppointment(record());

    expect(created.status).toBe("scheduled");
    expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());
  });

  test("returns undefined for an unknown id", async () => {
    expect(await getAppointment("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(await getAppointment("not-a-uuid")).toBeUndefined();
    expect(await getAppointment("")).toBeUndefined();
  });

  test("a stored appointment survives a read that goes through a fresh reference", async () => {
    // What a durable store has to deliver and the in-memory one only
    // coincidentally does today: the record the booking path stored is the
    // record the read path finds.
    const created = await createAppointment(record({ firstName: "Ada" }));
    expect((await getAppointment(created.id))?.patientInfo.firstName).toBe("Ada");
  });
});

describe("updateAppointment", () => {
  test("changes a status", async () => {
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, { status: "confirmed" });

    expect(updated?.status).toBe("confirmed");
    expect((await getAppointment(created.id))?.status).toBe("confirmed");
  });

  test("changes the patient record", async () => {
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, {
      patientInfo: record({ appointmentDateTime: "2026-10-02T14:00" }),
    });

    expect(updated?.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
  });

  test("returns undefined for an unknown id", async () => {
    expect(await updateAppointment("missing", { status: "confirmed" })).toBeUndefined();
  });

  test("refuses a status outside the closed set, before it reaches a store", async () => {
    const created = await createAppointment(record());

    await expect(
      updateAppointment(created.id, { status: "Cancelled" as never }),
    ).rejects.toThrow(/unknown appointment status/);
    expect((await getAppointment(created.id))?.status).toBe("scheduled");
  });

  test("refuses an unknown status without an appointment to reject it against", async () => {
    await expect(updateAppointment("missing", { status: "nope" as never })).rejects.toThrow(
      /unknown appointment status/,
    );
  });
});

describe("cancelAppointment", () => {
  test("cancels an appointment", async () => {
    const created = await createAppointment(record());

    const cancelled = await cancelAppointment(created.id);

    expect(cancelled?.status).toBe("cancelled");
    expect((await getAppointment(created.id))?.status).toBe("cancelled");
  });

  test("is idempotent", async () => {
    const created = await createAppointment(record());

    await cancelAppointment(created.id);
    expect((await cancelAppointment(created.id))?.status).toBe("cancelled");
  });

  test("returns undefined for an unknown id", async () => {
    expect(await cancelAppointment("missing")).toBeUndefined();
  });
});
