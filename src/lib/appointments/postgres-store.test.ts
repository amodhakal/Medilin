import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { SqlError, type SqlClient } from "@/lib/storage";
import { encryptPHI, type EncryptedEnvelope } from "@/lib/encryption";
import { PostgresAppointmentStore, toActionGrant } from "./postgres-store";
import type { ActionGrant, Appointment } from "./store";
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
  describe("toActionGrant", () => {
    test("rebuilds a grant from a row", () => {
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
});
