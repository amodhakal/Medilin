import { describe, expect, test } from "bun:test";
import { SqlError, type SqlClient } from "@/lib/storage";
import { PostgresAppointmentStore } from "./postgres-store";
import type { Appointment } from "./store";
import type { AppointmentRecord } from "../validation/intake";

/**
 * The durable appointment store, against a fake database.
 *
 * There are no credentials in this repository or in CI, so these tests run
 * against a `SqlClient` that records the statements and answers from a table it
 * keeps in the test. That is not a compromise: `SqlClient` is the whole
 * surface, so anything that can answer `query(sql, params)` can be the
 * database, and a test that only exercised the real one would be a test that
 * could not run at all.
 *
 * What is asserted here is the SQL itself -- the parameter bindings, the
 * statements' shape, and what happens when a row comes back wrong -- because
 * that is the part a fake is as good at catching as a real database.
 */

const PATIENT: AppointmentRecord = {
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
};

const CREATED_AT = "2026-09-01T10:00:00.000Z";
const UPDATED_AT = "2026-09-02T11:30:00.000Z";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    patient_info: PATIENT,
    status: "scheduled",
    conversation_ended: false,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  const createdAt = new Date(CREATED_AT);
  return {
    id: "a1",
    patientInfo: PATIENT,
    createdAt,
    updatedAt: new Date(UPDATED_AT),
    conversationEnded: false,
    status: "scheduled",
    ...overrides,
  };
}

type Handler = (sql: string, params: readonly unknown[]) => unknown[];

interface FakeDatabase {
  sql: SqlClient;
  statements: { sql: string; params: readonly unknown[] }[];
}

/**
 * A `SqlClient` that dispatches on the statement and records everything.
 *
 * `handlers` is a list rather than a map because the schema bootstrap and the
 * four operations are all asked for by substring, and a test that wants to
 * assert "the table was created" should not have to enumerate the rest.
 */
function fakeDatabase(handlers: Record<string, Handler>): FakeDatabase {
  const statements: { sql: string; params: readonly unknown[] }[] = [];

  const sql: SqlClient = {
    driver: "fake",
    async query<T = Record<string, unknown>>(
      statement: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      statements.push({ sql: statement, params });

      for (const [fragment, handler] of Object.entries(handlers)) {
        if (statement.includes(fragment)) return handler(statement, params) as T[];
      }

      throw new Error(`Fake database received an unexpected statement: ${statement}`);
    },
  };

  return { sql, statements };
}

const handles = {
  create: (rows: unknown[]) => () => rows,
  get: (rows: unknown[]) => () => rows,
  update: (rows: unknown[]) => () => rows,
  cancel: (rows: unknown[]) => () => rows,
};

describe("PostgresAppointmentStore", () => {
  test("creates the table once, on first use", async () => {
    const { sql, statements } = fakeDatabase({
      "CREATE TABLE": () => [],
      INSERT: handles.create([row()]),
      SELECT: handles.get([row()]),
    });

    const store = new PostgresAppointmentStore(sql);
    await store.create(appointment());
    await store.create(appointment({ id: "a2" }));
    await store.get("a1");

    const schemas = statements.filter((s) => s.sql.includes("CREATE TABLE"));
    expect(schemas).toHaveLength(1);
  });

  test("declares the statuses as a constraint, not only as a default", async () => {
    const { sql, statements } = fakeDatabase({ "CREATE TABLE": () => [] });
    const store = new PostgresAppointmentStore(sql);
    await store.create(appointment()).catch(() => undefined);

    const ddl = statements[0].sql;
    expect(ddl).toContain("CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed'))");
  });

  test("retries the schema after a failure, rather than failing forever", async () => {
    // A database that was unreachable on the first request is reachable on the
    // next one, and a process that cached the failure would be broken until it
    // was redeployed.
    let attempts = 0;
    const statements: string[] = [];
    const sql: SqlClient = {
      driver: "fake",
      async query(statement: string) {
        statements.push(statement);
        if (statement.includes("CREATE TABLE")) {
          attempts += 1;
          if (attempts === 1) throw new SqlError("transport", "The database could not be reached.");
          return [];
        }
        return [row()] as never;
      },
    };

    const store = new PostgresAppointmentStore(sql);
    await expect(store.get("a1")).rejects.toBeInstanceOf(SqlError);
    expect(await store.get("a1")).toEqual(appointment());
    expect(statements.filter((s) => s.includes("CREATE TABLE"))).toHaveLength(2);
  });

  describe("create", () => {
    test("binds the record, the status, and both timestamps", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        INSERT: handles.create([row()]),
      });

      await new PostgresAppointmentStore(sql).create(appointment());

      const insert = statements.find((s) => s.sql.includes("INSERT"))!;
      expect(insert.params).toEqual([
        "a1",
        JSON.stringify(PATIENT),
        "scheduled",
        false,
        CREATED_AT,
        UPDATED_AT,
      ]);
    });

    test("sends the patient record as a jsonb parameter, not as SQL text", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        INSERT: handles.create([row()]),
      });

      await new PostgresAppointmentStore(sql).create(
        appointment({ patientInfo: { ...PATIENT, additionalInfo: "'); DROP TABLE patients;--" } }),
      );

      const insert = statements.find((s) => s.sql.includes("INSERT"))!;
      expect(insert.sql).not.toContain("DROP TABLE");
      expect(insert.sql).toContain("$2::jsonb");
    });

    test("returns the row the database stored", async () => {
      const { sql } = fakeDatabase({
        "CREATE TABLE": () => [],
        INSERT: handles.create([row({ status: "confirmed" })]),
      });

      const created = await new PostgresAppointmentStore(sql).create(appointment());

      expect(created).toEqual(appointment({ status: "confirmed" }));
    });

    test("throws rather than inventing a record the database did not confirm", async () => {
      const { sql } = fakeDatabase({ "CREATE TABLE": () => [], INSERT: handles.create([]) });
      await expect(
        new PostgresAppointmentStore(sql).create(appointment()),
      ).rejects.toBeInstanceOf(SqlError);
    });
  });

  describe("get", () => {
    test("looks the appointment up by id", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        SELECT: handles.get([row()]),
      });

      expect(await new PostgresAppointmentStore(sql).get("a1")).toEqual(appointment());

      const select = statements.find((s) => s.sql.includes("SELECT"))!;
      expect(select.params).toEqual(["a1"]);
      expect(select.sql).toContain("WHERE id = $1");
    });

    test("returns undefined for an id that is not there", async () => {
      const { sql } = fakeDatabase({ "CREATE TABLE": () => [], SELECT: handles.get([]) });
      expect(await new PostgresAppointmentStore(sql).get("missing")).toBeUndefined();
    });

    test("passes an id through as a bound parameter, whatever it looks like", async () => {
      // The column is `text` precisely so this is an ordinary miss and not a
      // cast error. An injection attempt is a lookup that finds nothing.
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        SELECT: handles.get([]),
      });

      const hostile = "a1' OR '1'='1";
      expect(await new PostgresAppointmentStore(sql).get(hostile)).toBeUndefined();

      const select = statements.find((s) => s.sql.includes("SELECT"))!;
      expect(select.params).toEqual([hostile]);
      expect(select.sql).not.toContain("OR '1'='1");
    });

    test("accepts a patient_info column that arrives as a JSON string", async () => {
      const { sql } = fakeDatabase({
        "CREATE TABLE": () => [],
        SELECT: handles.get([row({ patient_info: JSON.stringify(PATIENT) })]),
      });

      expect((await new PostgresAppointmentStore(sql).get("a1"))!.patientInfo).toEqual(PATIENT);
    });

    test.each([
      ["a status outside the set", { status: "CANCELLED" }, /status is not one of/],
      ["a missing status", { status: undefined }, /status is not one of/],
      ["a non-boolean conversation_ended", { conversation_ended: "no" }, /conversation_ended/],
      ["a patient_info that is not an object", { patient_info: "[1,2]" }, /not a JSON object/],
      ["an unparseable timestamp", { created_at: "not a date" }, /created_at/],
    ])("throws rather than reporting a broken row as absent: %s", async (_label, overrides, message) => {
      // Returning undefined here would tell a patient who has an appointment
      // that they do not, and would keep telling them.
      const { sql } = fakeDatabase({
        "CREATE TABLE": () => [],
        SELECT: handles.get([row(overrides)]),
      });

      await expect(new PostgresAppointmentStore(sql).get("a1")).rejects.toThrow(message);
    });
  });

  describe("update", () => {
    test("passes an absent field as NULL so the column is left alone", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        UPDATE: handles.update([row({ status: "confirmed", conversation_ended: true })]),
      });

      const updated = await new PostgresAppointmentStore(sql).update("a1", { status: "confirmed" });

      expect(updated!.status).toBe("confirmed");
      expect(updated!.conversationEnded).toBe(true);

      const update = statements.find((s) => s.sql.includes("UPDATE"))!;
      expect(update.params).toEqual(["a1", null, "confirmed", null]);
    });

    test("never puts a patch value into the statement text", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        UPDATE: handles.update([row()]),
      });

      await new PostgresAppointmentStore(sql).update("a1", {
        patientInfo: { ...PATIENT, additionalInfo: "'; DROP TABLE appointments; --" },
      });

      const update = statements.find((s) => s.sql.includes("UPDATE"))!;
      expect(update.sql).not.toContain("DROP TABLE");
      expect(update.sql).toContain("COALESCE($2::jsonb, patient_info)");
    });

    test("stamps updated_at in the database rather than trusting the caller", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        UPDATE: handles.update([row()]),
      });

      await new PostgresAppointmentStore(sql).update("a1", { status: "confirmed" });

      const update = statements.find((s) => s.sql.includes("UPDATE"))!;
      expect(update.sql).toContain("updated_at         = now()");
    });

    test("returns undefined for an id that is not there", async () => {
      const { sql } = fakeDatabase({ "CREATE TABLE": () => [], UPDATE: handles.update([]) });
      expect(await new PostgresAppointmentStore(sql).update("missing", { status: "confirmed" })).toBeUndefined();
    });
  });

  describe("cancel", () => {
    test("sets the status to cancelled in the statement itself", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        UPDATE: handles.cancel([row({ status: "cancelled" })]),
      });

      const cancelled = await new PostgresAppointmentStore(sql).cancel("a1");

      expect(cancelled!.status).toBe("cancelled");
      const update = statements.find((s) => s.sql.includes("UPDATE"))!;
      expect(update.sql).toContain("SET status = 'cancelled'");
      expect(update.params).toEqual(["a1"]);
    });

    test("is idempotent, because the statement does not test the old status", async () => {
      const { sql } = fakeDatabase({
        "CREATE TABLE": () => [],
        UPDATE: handles.cancel([row({ status: "cancelled" })]),
      });

      const store = new PostgresAppointmentStore(sql);
      expect((await store.cancel("a1"))!.status).toBe("cancelled");
      expect((await store.cancel("a1"))!.status).toBe("cancelled");
    });

    test("returns undefined for an id that is not there", async () => {
      const { sql } = fakeDatabase({ "CREATE TABLE": () => [], UPDATE: handles.cancel([]) });
      expect(await new PostgresAppointmentStore(sql).cancel("missing")).toBeUndefined();
    });
  });
});
