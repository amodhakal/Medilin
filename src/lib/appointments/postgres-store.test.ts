import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { SqlError, type SqlClient } from "@/lib/storage";
import { encryptPHI, type EncryptedEnvelope } from "@/lib/encryption";
import { PostgresAppointmentStore, toActionGrant } from "./postgres-store";
import {
  REMINDABLE_STATUSES,
  type ActionGrant,
  type Appointment,
  type TranscriptLine,
} from "./store";
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
const EXPIRES_AT = "2026-09-08T10:00:00.000Z";

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    jti: "cap-1",
    appointment_id: "a1",
    actions: ["reschedule", "cancel"],
    expires_at: EXPIRES_AT,
    withdrawn_at: null,
    ...overrides,
  };
}

function grant(overrides: Partial<ActionGrant> = {}): ActionGrant {
  return {
    jti: "cap-1",
    appointmentId: "a1",
    actions: ["reschedule", "cancel"],
    expiresAt: new Date(EXPIRES_AT),
    withdrawnAt: null,
    ...overrides,
  };
}

// Set at module scope because the fixture rows are sealed records: what a row
// holds is ciphertext, and building one needs a key. The "no key" tests below
// delete it and restore it in afterEach.
const KEY = "a".repeat(64);
const savedMasterKey = process.env.HIPAA_MASTER_KEY;
process.env.HIPAA_MASTER_KEY = KEY;

// The "no key" cases below delete it deliberately, and every other test in this
// file needs it back afterwards to build a sealed fixture row.
afterEach(() => {
  process.env.HIPAA_MASTER_KEY = KEY;
});

afterAll(() => {
  if (savedMasterKey === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = savedMasterKey;
});

/** The shape a stored record has: an envelope, not a record. */
function sealed(patientInfo: AppointmentRecord): EncryptedEnvelope {
  return encryptPHI(JSON.stringify(patientInfo));
}

/** The same for a transcript line, which stores a bare string under the same envelope. */
function sealedText(text: string): EncryptedEnvelope {
  return encryptPHI(text);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    patient_info: sealed(PATIENT),
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

/** What a transcript line is as the store hands it over. */
function line(overrides: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    seq: 0,
    role: "patient",
    text: "I need to see a doctor about my eye.",
    at: new Date("2026-09-01T10:00:01.000Z"),
    finalized: true,
    ...overrides,
  };
}

/** What a transcript line looks like coming back out of a `jsonb` column. */
function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    seq: 0,
    role: "patient",
    line: sealedText("I need to see a doctor about my eye."),
    said_at: "2026-09-01T10:00:01.000Z",
    finalized: true,
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

      // Schema bootstrap: answered for every test so that adding a DDL statement
      // does not mean editing twenty handler maps.
      if (
        statement.includes("CREATE TABLE") ||
        statement.includes("CREATE INDEX") ||
        statement.includes("COMMENT ON")
      ) {
        return [];
      }

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
  issueGrant: (rows: unknown[]) => () => rows,
  getGrant: (rows: unknown[]) => () => rows,
  spendGrant: (rows: unknown[]) => () => rows,
  withdrawGrants: (rows: unknown[]) => () => rows,
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

    // Matched on the table name rather than on "CREATE TABLE", because the grants
    // table added in #59 is created by the same one-shot bootstrap and would
    // otherwise be counted as a second schema attempt.
    const schemas = statements.filter((s) => s.sql.includes("CREATE TABLE IF NOT EXISTS appointments"));
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
    expect(
      statements.filter((s) => s.includes("CREATE TABLE IF NOT EXISTS appointments")),
    ).toHaveLength(2);
  });

  describe("create", () => {
    test("binds the record, the status, and both timestamps", async () => {
      const { sql, statements } = fakeDatabase({
        "CREATE TABLE": () => [],
        INSERT: handles.create([row()]),
      });

      await new PostgresAppointmentStore(sql).create(appointment());

      const insert = statements.find((s) => s.sql.includes("INSERT"))!;
      // The second parameter is the envelope, not the record: see "PHI at rest".
      expect(insert.params[0]).toBe("a1");
      expect(insert.params[2]).toBe("scheduled");
      expect(insert.params[3]).toBe(false);
      expect(insert.params.slice(4)).toEqual([CREATED_AT, UPDATED_AT]);
      expect(Object.keys(JSON.parse(String(insert.params[1]))).sort()).toEqual([
        "authTag",
        "ciphertext",
        "dekAuthTag",
        "dekIv",
        "encryptedDEK",
        "iv",
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

describe("PHI at rest", () => {
  test("what reaches the database is ciphertext, not the record", async () => {
    // Issue #4: patient data encrypted at rest. The interface is in plaintext,
    // so the only place this can be true is here.
    process.env.HIPAA_MASTER_KEY = KEY;
    const { sql, statements } = fakeDatabase({
      "CREATE TABLE": () => [],
      INSERT: handles.create([row({ patient_info: sealed(PATIENT) })]),
    });

    await new PostgresAppointmentStore(sql).create(appointment());

    const stored = JSON.parse(String(statements.find((s) => s.sql.includes("INSERT"))!.params[1]));
    for (const leak of ["REDACTED", "patient@example.test", "1985-12-10", "+1 555 0100"]) {
      expect(JSON.stringify(stored)).not.toContain(leak);
    }
    expect(Object.keys(stored).sort()).toEqual([
      "authTag",
      "ciphertext",
      "dekAuthTag",
      "dekIv",
      "encryptedDEK",
      "iv",
    ]);
  });

  test("round-trips the record through the envelope", async () => {
    process.env.HIPAA_MASTER_KEY = KEY;
    const { sql } = fakeDatabase({
      "CREATE TABLE": () => [],
      INSERT: handles.create([row({ patient_info: sealed(PATIENT) })]),
    });

    const created = await new PostgresAppointmentStore(sql).create(appointment());

    expect(created.patientInfo).toEqual(PATIENT);
  });

  test("each record gets its own data key", async () => {
    // A DEK reused across records means one recovered key opens every one of
    // them, and the point of the envelope is that it does not.
    process.env.HIPAA_MASTER_KEY = KEY;
    const a = encryptPHI(JSON.stringify(PATIENT));
    const b = encryptPHI(JSON.stringify(PATIENT));

    expect(a.encryptedDEK).not.toBe(b.encryptedDEK);
  });

  test("declares in the schema that the column is ciphertext", async () => {
    process.env.HIPAA_MASTER_KEY = KEY;
    const { sql, statements } = fakeDatabase({
      "CREATE TABLE": () => [],
      INSERT: handles.create([row({ patient_info: sealed(PATIENT) })]),
    });

    await new PostgresAppointmentStore(sql).create(appointment());

    // Someone reading the schema, or querying the table directly, should not have
    // to know which writer put what in it.
    expect(
      statements.some((s) => s.sql.includes("COMMENT ON COLUMN appointments.patient_info")),
    ).toBe(true);
  });

  test("fails closed when there is no master key to encrypt with", async () => {
    // The same posture as before: a database without a key must not quietly hold
    // plaintext records that nobody was warned about.
    const { sql, statements } = fakeDatabase({ INSERT: handles.create([row()]) });
    delete process.env.HIPAA_MASTER_KEY;

    await expect(new PostgresAppointmentStore(sql).create(appointment())).rejects.toThrow(
      /HIPAA_MASTER_KEY is not set/,
    );
    expect(statements.some((s) => s.sql.includes("INSERT"))).toBe(false);
  });

  test("fails closed when the stored record cannot be opened", async () => {
    process.env.HIPAA_MASTER_KEY = KEY;
    const { sql } = fakeDatabase({
      "CREATE TABLE": () => [],
      SELECT: handles.get([row({ patient_info: sealed(PATIENT) })]),
    });

    process.env.HIPAA_MASTER_KEY = "b".repeat(64);

    await expect(new PostgresAppointmentStore(sql).get("a1")).rejects.toThrow();
  });

  test.each([
    ["a plaintext record written before encryption was added", PATIENT],
    ["a column that is not an object", "[1,2]"],
    ["an envelope missing its auth tag", { ...sealed(PATIENT), authTag: undefined }],
  ])("refuses to return a record it cannot open: %s", async (_label, stored) => {
    // The alternative is answering "you have no appointment" to a patient who has
    // one, silently, forever.
    const { sql } = fakeDatabase({ SELECT: handles.get([row({ patient_info: stored })]) });

    await expect(new PostgresAppointmentStore(sql).get("a1")).rejects.toThrow();
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
        SELECT: handles.get([row({ patient_info: JSON.stringify(sealed(PATIENT)) })]),
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

  // The capability grants of #59. The in-memory store in ./memory-store.test
  // says what the rules are; these assert that the durable one expresses the
  // same rules in SQL rather than in a comment.
  describe("action grants", () => {
    test("creates the grants table and its index alongside the appointments table", async () => {
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql)
        .getActionGrant("cap-1")
        .catch(() => undefined);

      const ddl = statements.filter((s) => s.sql.includes("CREATE")).map((s) => s.sql).join("\n");
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS appointment_action_grants");
      expect(ddl).toContain("appointment_action_grants_actions_check");
      expect(ddl).toContain("CREATE INDEX IF NOT EXISTS appointment_action_grants_live_idx");
    });

    test("declares the capability check against the same closed set as the application", async () => {
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql).issueActionGrant(grant()).catch(() => undefined);

      const ddl = statements.find((s) => s.sql.includes("appointment_action_grants"))!.sql;
      // The database is the second line of defence for PATIENT_ACTIONS, exactly
      // as appointments_status_check is for APPOINTMENT_STATUSES: an
      // authorisation that can be bypassed with psql is not one.
      expect(ddl).toContain("CHECK (actions <@ ARRAY['reschedule', 'cancel']::text[])");
      expect(ddl).toContain("ON DELETE CASCADE");
    });

    test("binds every value, and puts no part of the grant into the statement text", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_action_grants": handles.issueGrant([grantRow()]),
      });

      await new PostgresAppointmentStore(sql).issueActionGrant(grant({ jti: "cap-1' OR '1'='1" }));

      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_action_grants"))!;
      expect(insert.params).toEqual(["cap-1' OR '1'='1", "a1", "{reschedule,cancel}", EXPIRES_AT]);
      expect(insert.sql).not.toContain("OR '1'='1");
    });

    test("conflicts rather than overwrites, so a re-mint cannot un-spend a grant", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_action_grants": handles.issueGrant([]),
        "FROM appointment_action_grants": handles.getGrant([
          grantRow({ withdrawn_at: "2026-09-02T10:00:00.000Z" }),
        ]),
      });
      const store = new PostgresAppointmentStore(sql);

      const reissued = await store.issueActionGrant(grant());

      expect(reissued.withdrawnAt).toEqual(new Date("2026-09-02T10:00:00.000Z"));
      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_action_grants"))!;
      expect(insert.sql).toContain("ON CONFLICT (jti) DO NOTHING");
      expect(insert.sql).not.toContain("DO UPDATE");
    });

    test("throws rather than inventing a grant that conflicts with nothing readable", async () => {
      // The row was deleted between the conflict and the follow-up read, which is
      // what deleting an appointment does. A phantom grant would authorise a
      // capability nobody issued.
      const { sql } = fakeDatabase({
        "INSERT INTO appointment_action_grants": handles.issueGrant([]),
        "FROM appointment_action_grants": handles.getGrant([]),
      });

      await expect(new PostgresAppointmentStore(sql).issueActionGrant(grant())).rejects.toBeInstanceOf(
        SqlError,
      );
    });

    test("gets a grant by jti", async () => {
      const { sql, statements } = fakeDatabase({
        "FROM appointment_action_grants": handles.getGrant([grantRow()]),
      });

      expect(await new PostgresAppointmentStore(sql).getActionGrant("cap-1")).toEqual(grant());

      const select = statements.find((s) => s.sql.includes("FROM appointment_action_grants"))!;
      expect(select.params).toEqual(["cap-1"]);
    });

    test("returns undefined for a jti that was never issued", async () => {
      const { sql } = fakeDatabase({ "FROM appointment_action_grants": handles.getGrant([]) });

      expect(await new PostgresAppointmentStore(sql).getActionGrant("cap-1")).toBeUndefined();
    });

    describe("spendActionGrant", () => {
      test("tests and sets in one statement, which is where the atomicity lives", async () => {
        // Two requests carrying the same link must not both match this row.
        // `UPDATE ... WHERE withdrawn_at IS NULL AND expires_at > $2 RETURNING`
        // is a single compare-and-set: the loser blocks on the row lock and then
        // finds the column already set. A read followed by a write would have a
        // window in it.
        const { sql, statements } = fakeDatabase({
          "SET withdrawn_at = $3": handles.spendGrant([
            grantRow({ withdrawn_at: "2026-09-02T10:00:00.000Z" }),
          ]),
        });
        const now = new Date("2026-09-02T10:00:00.000Z");

        const spent = await new PostgresAppointmentStore(sql).spendActionGrant("cap-1", now);

        expect(spent!.withdrawnAt).toEqual(now);
        const update = statements.find((s) => s.sql.includes("SET withdrawn_at = $3"))!;
        expect(update.sql).toContain("WHERE jti = $1");
        expect(update.sql).toContain("AND withdrawn_at IS NULL");
        expect(update.sql).toContain("AND expires_at > $2");
        expect(update.sql).toContain("RETURNING");
        expect(update.params).toEqual(["cap-1", now.toISOString(), now.toISOString()]);
      });

      test("refuses an expired grant in the same statement", async () => {
        const { sql } = fakeDatabase({ "SET withdrawn_at = $3": handles.spendGrant([]) });
        const store = new PostgresAppointmentStore(sql);

        expect(
          await store.spendActionGrant("cap-1", new Date(EXPIRES_AT)),
        ).toBeUndefined();
        expect(
          await store.spendActionGrant("cap-1", new Date("2026-09-09T00:00:00.000Z")),
        ).toBeUndefined();
      });

      test("refuses one that was never issued, and one already spent, identically", async () => {
        const { sql } = fakeDatabase({ "SET withdrawn_at = $3": handles.spendGrant([]) });

        expect(await new PostgresAppointmentStore(sql).spendActionGrant("cap-1", new Date())).toBeUndefined();
      });
    });

    test("withdraws every live grant for an appointment and counts the rows it touched", async () => {
      const { sql, statements } = fakeDatabase({
        "SET withdrawn_at = $2": handles.withdrawGrants([{ jti: "cap-1" }, { jti: "cap-2" }]),
      });
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await new PostgresAppointmentStore(sql).withdrawActionGrants("a1", now)).toBe(2);

      const update = statements.find((s) => s.sql.includes("SET withdrawn_at = $2"))!;
      // Only live rows, so a second cancellation counts zero and does not move
      // the timestamp of a grant that was spent yesterday.
      expect(update.sql).toContain("WHERE appointment_id = $1");
      expect(update.sql).toContain("AND withdrawn_at IS NULL");
      expect(update.params).toEqual(["a1", now.toISOString()]);
    });

    test("returns zero for an appointment with no live grants", async () => {
      const { sql } = fakeDatabase({ "SET withdrawn_at = $2": handles.withdrawGrants([]) });

      expect(await new PostgresAppointmentStore(sql).withdrawActionGrants("a1", new Date())).toBe(0);
    });
  });

  // A grant row that does not parse must not be handed to a caller as one that
  // permits something. `toActionGrant` is the only place a stored capability
  // becomes a live one.
  describe("toActionGrant", () => {    test("rebuilds a grant from a row", () => {
      expect(toActionGrant(grantRow())).toEqual(grant());
    });

    test("rebuilds one that has been withdrawn", () => {
      expect(
        toActionGrant(grantRow({ withdrawn_at: "2026-09-02T10:00:00.000Z" })).withdrawnAt,
      ).toEqual(new Date("2026-09-02T10:00:00.000Z"));
    });

    test("copies the capability array rather than aliasing the row's", () => {
      const row = grantRow();
      const rebuilt = toActionGrant(row);

      rebuilt.actions.push("cancel");

      expect(row.actions).toEqual(["reschedule", "cancel"]);
    });

    test.each([
      ["a capability outside the closed set", { actions: ["delete_everything"] }, /not one of the known actions/],
      ["an empty capability set", { actions: [] }, /non-empty array/],
      ["a capability list that is not an array", { actions: "reschedule" }, /non-empty array/],
      ["a missing jti", { jti: "" }, /jti is missing/],
      ["a missing appointment id", { appointment_id: "" }, /appointment_id is missing/],
      ["an unparseable expiry", { expires_at: "not a date" }, /expires_at is not a timestamp/],
      ["an unparseable withdrawal", { withdrawn_at: "not a date" }, /withdrawn_at is not a timestamp/],
    ])("throws rather than returning a grant it cannot vouch for: %s", (_label, overrides, message) => {
      // The whole point of this table: a capability that comes back wrong is a
      // capability that authorises something the issuing side never agreed to.
      expect(() => toActionGrant(grantRow(overrides))).toThrow(message);
    });
  });

  // The reminder job's two needs (#67). The interesting assertion here is one
  // about a statement that is *absent*: there is no query by appointment time, and
  // `listByStatus` explains why it cannot be written.
  describe("listByStatus", () => {
    test("filters by status, orders oldest first, and is bounded", async () => {
      const { sql, statements } = fakeDatabase({
        SELECT: handles.get([row(), row({ id: "a2" })]),
      });

      const listed = await new PostgresAppointmentStore(sql).listByStatus(
        ["scheduled", "confirmed"],
        500,
      );

      expect(listed.map((entry) => entry.id)).toEqual(["a1", "a2"]);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!;
      expect(select.params).toEqual(["{scheduled,confirmed}", 500]);
      expect(select.sql).toContain("ORDER BY created_at ASC");
      expect(select.sql).toContain("LIMIT $2");
    });

    test("binds the statuses as an array, and the statement never varies", async () => {
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      const store = new PostgresAppointmentStore(sql);
      await store.listByStatus(["scheduled"], 10);
      await store.listByStatus(["'; DROP TABLE appointments; --" as never], 10);

      const selects = statements.filter((s) => s.sql.includes("status = ANY"));
      expect(selects).toHaveLength(2);
      // A hostile status could only ever become an element of a bound array.
      expect(selects[0].sql).toBe(selects[1].sql);
      expect(selects[1].sql).not.toContain("DROP TABLE");
      expect(selects[1].params[0]).toBe("{'; DROP TABLE appointments; --}");
    });

    test("clamps a negative limit rather than passing it to Postgres", async () => {
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listByStatus(REMINDABLE_STATUSES, -1);

      expect(statements.find((s) => s.sql.includes("status = ANY"))!.params[1]).toBe(0);
    });

    test("throws rather than skipping a row that does not parse", async () => {
      // A job that quietly dropped a malformed row would report a reminder as sent
      // to a patient who was never told.
      const { sql } = fakeDatabase({
        SELECT: handles.get([row(), row({ id: "a2", status: "CANCELLED" })]),
      });

      await expect(
        new PostgresAppointmentStore(sql).listByStatus(REMINDABLE_STATUSES, 10),
      ).rejects.toThrow(/status is not one of/);
    });

    test("has no predicate against the appointment time, because there cannot be one", async () => {
      // An assertion about a constraint rather than a behaviour. The time is inside
      // `patient_info`, which is ciphertext, so a range predicate against it
      // cannot be written -- and a statement that looked like it filtered and did
      // not would be worse than not having the method at all.
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listByStatus(REMINDABLE_STATUSES, 10);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!.sql;
      expect(select).not.toContain("appointment_date_time");
      expect(select).not.toMatch(/patient_info\s*[<>=]/);
    });

    test("declares the index its own query needs", async () => {
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listByStatus(REMINDABLE_STATUSES, 10);

      expect(
        statements.some((s) => s.sql.includes("appointments_status_created_idx")),
      ).toBe(true);
    });
  });

  describe("listPage", () => {
    // The clinic dashboard's query (#63). The in-memory version in
    // ./memory-store.test says what the rules are; these assert the durable one
    // expresses them in SQL rather than in a comment, and in particular that the
    // order it pages in is the same total order the other one pages in.
    test("binds the limit and the offset, and orders by a total key", async () => {
      const { sql, statements } = fakeDatabase({
        SELECT: handles.get([row(), row({ id: "a2" })]),
      });

      const listed = await new PostgresAppointmentStore(sql).listPage(
        ["scheduled", "confirmed"],
        20,
        40,
      );

      expect(listed.map((entry) => entry.id)).toEqual(["a1", "a2"]);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!;
      expect(select.params).toEqual(["{scheduled,confirmed}", 20, 40]);
      expect(select.sql).toContain("ORDER BY created_at ASC, id ASC");
      expect(select.sql).toContain("LIMIT $2");
      expect(select.sql).toContain("OFFSET $3");
    });

    test("the offset is a bound parameter, not text in the statement", async () => {
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listPage(["scheduled"], 10, 20);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!;
      expect(select.sql).not.toContain("OFFSET 20");
      expect(select.params[2]).toBe(20);
    });

    test("clamps a negative window rather than passing it to Postgres", async () => {
      // `LIMIT -1` is an error and `OFFSET -1` is a syntax error, so an
      // unclamped value is a 500 on the dashboard rather than an empty page.
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listPage(["scheduled"], -1, -5);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!;
      expect(select.params.slice(1)).toEqual([0, 0]);
    });

    test("has no predicate against the appointment time, for the same reason as listByStatus", async () => {
      // The clinic wants the next appointments, and there is no column that can
      // answer that. See `listPage` in ./store: the time is ciphertext.
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).listPage(["scheduled"], 10, 0);

      const select = statements.find((s) => s.sql.includes("status = ANY"))!.sql;
      expect(select).not.toContain("appointment_date_time");
      expect(select).not.toMatch(/patient_info\s*[<>=]/);
    });

    test("throws rather than skipping a row that does not parse", async () => {
      // A page that quietly dropped a broken row would tell a clinician a
      // patient is not booked when they are.
      const { sql } = fakeDatabase({
        SELECT: handles.get([row(), row({ id: "a2", status: "CANCELLED" })]),
      });

      await expect(
        new PostgresAppointmentStore(sql).listPage(["scheduled"], 10, 0),
      ).rejects.toThrow(/status is not one of/);
    });

    test("an offset past the end is an empty page", async () => {
      const { sql } = fakeDatabase({ SELECT: handles.get([]) });

      expect(await new PostgresAppointmentStore(sql).listPage(["scheduled"], 20, 900)).toEqual([]);
    });
  });

  describe("claimOnce", () => {
    test("reports the winner and the loser by whether a row came back", async () => {
      // The whole of the exactly-once property: one insert, and the answer is
      // whether this caller is the one that put the row there.
      let first = true;
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_claims": () => {
          const rows = first ? [{ scope: "reminder" }] : [];
          first = false;
          return rows;
        },
      });
      const store = new PostgresAppointmentStore(sql);

      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(true);
      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(false);

      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_claims"))!;
      expect(insert.sql).toContain("ON CONFLICT (scope, key) DO NOTHING");
      expect(insert.sql).toContain("RETURNING scope");
      expect(insert.params).toEqual(["reminder", "a1:2026-09-02"]);
    });

    test("never updates on conflict, so the loser cannot also proceed", async () => {
      // `DO UPDATE` would report success to the second caller as well, and the
      // second caller is the one that would then send the reminder twice.
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_claims": handles.create([{ scope: "reminder" }]),
      });

      await new PostgresAppointmentStore(sql).claimOnce("reminder", "a1:2026-09-02");

      expect(statements.find((s) => s.sql.includes("INSERT INTO appointment_claims"))!.sql).not.toContain("DO UPDATE");
    });

    test("binds both values, whatever they look like", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_claims": handles.create([{ scope: "reminder" }]),
      });

      await new PostgresAppointmentStore(sql).claimOnce("reminder", "a1'); DROP TABLE x; --");

      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_claims"))!;
      expect(insert.sql).not.toContain("DROP TABLE");
      expect(insert.params).toEqual(["reminder", "a1'); DROP TABLE x; --"]);
    });

    test("declares the scope as a constraint, not only as a type", async () => {
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql).claimOnce("reminder", "k").catch(() => undefined);

      expect(
        statements.some((s) => s.sql.includes("CHECK (scope IN ('reminder'))")),
      ).toBe(true);
    });
  });

  // The call transcript (#57). A line is a patient's own account of why they
  // telephoned, so what matters here is the encryption at rest, the correction
  // semantics, and that nothing reaches SQL as text.
  describe("transcript", () => {
    test("binds the text as an envelope, never as SQL text", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([{ seq: 0 }]),
      });

      await new PostgresAppointmentStore(sql).appendTranscript("a1", [
        line({ text: "); DROP TABLE appointments; --" }),
      ]);

      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_transcripts"))!;
      expect(insert.sql).not.toContain("DROP TABLE");
      const stored = JSON.parse(String((insert.params[3] as unknown[])[0]));
      expect(Object.keys(stored).sort()).toEqual([
        "authTag",
        "ciphertext",
        "dekAuthTag",
        "dekIv",
        "encryptedDEK",
        "iv",
      ]);
      expect(JSON.stringify(stored)).not.toContain("DROP TABLE");
    });

    test("a hostile transcript never reaches the statement text", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([{ seq: 0 }]),
      });

      await new PostgresAppointmentStore(sql).appendTranscript("a1', 'b')", [
        line({ text: "x", role: "operator" as TranscriptLine["role"] }),
      ]).catch(() => undefined);

      // The role is validated before the write, so the batch is refused and no
      // statement carrying it is ever assembled.
      expect(statements.filter((s) => s.sql.includes("appointment_transcripts") && s.sql.includes("INSERT"))).toHaveLength(0);
    });

    test("reports zero, and writes nothing, for an appointment that is not there", async () => {
      // The insert selects its rows `FROM appointments WHERE id = $1`, so a
      // missing appointment produces no rows at all rather than a foreign key
      // error. A transcript with no appointment behind it is a patient's words
      // that nothing would ever delete with the record.
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([]),
      });

      expect(await new PostgresAppointmentStore(sql).appendTranscript("gone", [line()])).toBe(0);
      expect(statements.some((s) => s.sql.includes("FROM appointments WHERE id = $1"))).toBe(true);
    });

    test("writes a whole batch in one statement", async () => {
      // A call is a stream of small increments; a round trip per line would make
      // the transcript cost more than the call did. `unnest` over parallel arrays
      // keeps the statement fixed -- no statement is assembled from the batch --
      // which is the same property `update` has.
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([{ seq: 0 }, { seq: 1 }, { seq: 2 }]),
      });

      const written = await new PostgresAppointmentStore(sql).appendTranscript("a1", [
        line({ seq: 0 }),
        line({ seq: 1, role: "receptionist" }),
        line({ seq: 2 }),
      ]);

      expect(written).toBe(3);
      const inserts = statements.filter((s) => s.sql.includes("INSERT INTO appointment_transcripts"));
      expect(inserts).toHaveLength(1);
      expect(inserts[0].sql).toContain("unnest(");
      expect(inserts[0].params[0]).toBe("a1");
      expect(inserts[0].params[1]).toEqual([0, 1, 2]);
      expect(inserts[0].params[2]).toEqual(["patient", "receptionist", "patient"]);
    });

    test("corrects a line that is already there rather than appending it again", async () => {
      // The streaming case: a partial frame, then the final that completes it.
      // `DO UPDATE` is the whole of it, and the update is scoped to the four
      // mutable columns so nothing about the line's position can move.
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([{ seq: 0 }]),
      });

      await new PostgresAppointmentStore(sql).appendTranscript("a1", [line()]);

      const insert = statements.find((s) => s.sql.includes("INSERT INTO appointment_transcripts"))!;
      expect(insert.sql).toContain("ON CONFLICT (appointment_id, seq) DO UPDATE");
      expect(insert.sql).not.toMatch(/DO UPDATE SET[^;]*\bseq\s*=/);
    });

    test("reads a transcript back in position order, bounded to the tail", async () => {
      // The fake answers in the order the statement would really return: newest
      // first, because that is what `ORDER BY seq DESC LIMIT n` is. The store
      // reverses, so a caller gets the call the way it happened.
      const { sql, statements } = fakeDatabase({
        SELECT: handles.get([lineRow({ seq: 1 }), lineRow({ seq: 0 })]),
      });

      const read = await new PostgresAppointmentStore(sql).getTranscript("a1", 50);

      expect(read.map((entry) => entry.seq)).toEqual([0, 1]);
      const select = statements.find((s) => s.sql.includes("FROM appointment_transcripts"))!;
      // Descending and bounded, then reversed here: a cap that kept the opening
      // lines would replay a long call as its pleasantries.
      expect(select.sql).toContain("ORDER BY seq DESC");
      expect(select.sql).toContain("LIMIT $2");
      expect(select.params).toEqual(["a1", 50]);
    });

    test("clamps a negative cap rather than passing it to Postgres", async () => {
      const { sql, statements } = fakeDatabase({ SELECT: handles.get([]) });

      await new PostgresAppointmentStore(sql).getTranscript("a1", -1);

      expect(statements.find((s) => s.sql.includes("FROM appointment_transcripts"))!.params[1]).toBe(0);
    });

    test("opens the stored text, and throws rather than skipping a line that is not one", async () => {
      // A transcript that silently loses a line is a call that appears to have
      // gone differently than it did. Throwing is what makes that visible.
      const { sql } = fakeDatabase({
        SELECT: handles.get([lineRow(), lineRow({ line: "not an envelope" })]),
      });

      await expect(new PostgresAppointmentStore(sql).getTranscript("a1")).rejects.toThrow(
        /line is not a JSON object/,
      );
    });

    test("throws rather than replaying a line whose role is outside the closed set", async () => {
      const { sql } = fakeDatabase({
        SELECT: handles.get([lineRow({ role: "operator" })]),
      });

      await expect(new PostgresAppointmentStore(sql).getTranscript("a1")).rejects.toThrow(
        /role is not one of/,
      );
    });

    test("declares the role and the position as constraints, not only as types", async () => {
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql).getTranscript("a1").catch(() => undefined);

      expect(
        statements.some((s) => s.sql.includes("CHECK (role IN ('patient', 'receptionist'))")),
      ).toBe(true);
      expect(statements.some((s) => s.sql.includes("CHECK (seq >= 0)"))).toBe(true);
    });

    test("cascades from the appointment, so deleting a record deletes the call", async () => {
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql).getTranscript("a1").catch(() => undefined);

      const ddl = statements.find((s) => s.sql.includes("CREATE TABLE IF NOT EXISTS appointment_transcripts"))!;
      expect(ddl.sql).toContain("REFERENCES appointments (id) ON DELETE CASCADE");
    });

    test("says in the schema that the text is ciphertext", async () => {
      // The column comment is what somebody reading the table -- with psql, or
      // from a `SELECT *` -- needs to be told. `patient_info` has one; the text
      // of a patient's conversation is the same kind of column and has to be as
      // explicit.
      const { sql, statements } = fakeDatabase({});

      await new PostgresAppointmentStore(sql).getTranscript("a1").catch(() => undefined);

      const comment = statements.find((s) => s.sql.includes("COMMENT ON COLUMN appointment_transcripts"))!;
      expect(comment.sql).toContain("Ciphertext, not plaintext");
    });

    test("refuses a batch that names one position twice, before it is written", async () => {
      const { sql, statements } = fakeDatabase({
        "INSERT INTO appointment_transcripts": handles.create([{ seq: 0 }]),
      });

      await expect(
        new PostgresAppointmentStore(sql).appendTranscript("a1", [line({ seq: 0 }), line({ seq: 0 })]),
      ).rejects.toThrow(/same position/i);
      expect(statements.some((s) => s.sql.includes("INSERT INTO appointment_transcripts"))).toBe(false);
    });
  });
});
