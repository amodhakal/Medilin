import { describe, expect, test } from "bun:test";
import { SqlError, type SqlClient } from "@/lib/storage";
import { PostgresAuditLogStore, toEntry } from "./postgres-store";
import {
  AUDIT_ACTORS,
  GENESIS_HASH,
  appointmentResource,
  buildEntry,
  type AuditLogEntry,
} from "./store";

/**
 * The durable audit chain, against a fake database.
 *
 * There is no database in this repository or in CI, so these run against a
 * `SqlClient` that keeps the table in the test. What is worth asserting here is
 * the part a fake is *better* at than a real one: the statements, the
 * parameters, and -- because the fake is single-threaded and observable -- the
 * behaviour when two instances append at the same time, which is the race the
 * whole design is built around.
 */

const ENTRY_ID = "entry-1";
const RECORDED_AT = "2026-09-01T10:00:00.000Z";

function event(overrides: Partial<Omit<AuditLogEntry, "hash" | "previousHash">> = {}) {
  return {
    id: ENTRY_ID,
    timestamp: RECORDED_AT,
    actor: AUDIT_ACTORS.patient,
    action: "APPOINTMENT_CREATED" as const,
    resource: appointmentResource("a1"),
    details: { reason: "intake" as const },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    entry_id: ENTRY_ID,
    recorded_at: RECORDED_AT,
    actor: AUDIT_ACTORS.patient,
    action: "APPOINTMENT_CREATED",
    resource: appointmentResource("a1"),
    details: { reason: "intake" },
    previous_hash: GENESIS_HASH,
    hash: "a".repeat(64),
    ...overrides,
  };
}

/**
 * A `SqlClient` over a real table, in memory.
 *
 * The `insert` hook is the point of the thing: the unique constraint on `seq` is
 * emulated by having the fake refuse a duplicate, which is how a real
 * `PostgresAuditLogStore` discovers it lost a race.
 */
interface FakeOptions {
  rows?: Record<string, unknown>[];
  /**
   * Emulate losing the race: put another instance's row in the table, then raise
   * the unique violation the real `seq` primary key would raise.
   */
  competitor?: Record<string, unknown>;
  /** Called instead of writing, to emulate a write whose response was lost. */
  onInsert?: () => void;
}

function fakeDatabase(options: FakeOptions = {}) {
  const rows = [...(options.rows ?? [])];
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  let bootstrapped = false;
  let contended = 0;

  const sql: SqlClient = {
    driver: "fake",
    async query<T = Record<string, unknown>>(statement: string, params: readonly unknown[] = []) {
      statements.push({ sql: statement, params });
      const normalised = statement.replace(/\s+/g, " ").trim();

      if (normalised.includes("CREATE TABLE") || normalised.includes("COMMENT ON")) {
        bootstrapped = true;
        return [];
      }

      if (normalised.startsWith("INSERT")) {
        if (!bootstrapped) throw new Error("append before the table exists");
        options.onInsert?.();

        if (options.competitor && contended === 0) {
          contended += 1;
          rows.push(options.competitor);
          throw new SqlError("23505", "duplicate key value violates unique constraint");
        }

        const [id, recordedAt, actor, action, resource, details, previousHash, hash] = params;
        rows.push({
          entry_id: id,
          recorded_at: recordedAt,
          actor,
          action,
          resource,
          details: details === null ? null : JSON.parse(String(details)),
          previous_hash: previousHash,
          hash,
        });
        return [];
      }

      if (normalised.startsWith("SELECT") && normalised.includes("ORDER BY seq DESC")) {
        const limit = params[0] === undefined ? rows.length : Number(params[0]);
        return rows.slice(-limit).reverse() as T[];
      }

      if (normalised.startsWith("SELECT")) {
        return [...rows] as T[];
      }

      throw new Error(`Fake database received an unexpected statement: ${normalised}`);
    },
  };

  return { sql, statements, rows };
}

describe("PostgresAuditLogStore", () => {
  test("creates the table once, on first use", async () => {
    const { sql, statements } = fakeDatabase();
    const store = new PostgresAuditLogStore(sql);

    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));
    await store.read();

    expect(statements.filter((s) => s.sql.includes("CREATE TABLE"))).toHaveLength(1);
  });

  test("declares the chain constraints and says so in the schema", async () => {
    // The length checks are the database agreeing that these columns hold
    // digests. The comment is for whoever looks at the table and wonders.
    const { sql, statements } = fakeDatabase();
    await new PostgresAuditLogStore(sql).append(event()).catch(() => undefined);

    const ddl = statements.find((s) => s.sql.includes("CREATE TABLE"))!.sql;
    expect(ddl).toContain("CHECK (length(hash) = 64)");
    expect(ddl).toContain("CHECK (length(previous_hash) = 64)");
    expect(ddl).toContain("entry_id      text NOT NULL UNIQUE");
    expect(
      statements.some((s) => s.sql.includes("COMMENT ON TABLE audit_log")),
    ).toBe(true);
  });

  test("the first entry chains to genesis", async () => {
    const { sql } = fakeDatabase();
    const entry = await new PostgresAuditLogStore(sql).append(event());

    expect(entry.previousHash).toBe(GENESIS_HASH);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("each entry chains to the one before it", async () => {
    const { sql } = fakeDatabase();
    const store = new PostgresAuditLogStore(sql);

    const first = await store.append(event({ id: "e1" }));
    const second = await store.append(event({ id: "e2", action: "PHI_READ" }));

    expect(second.previousHash).toBe(first.hash);
    expect(await store.verify()).toBe(true);
  });

  test("binds every field as a parameter and nothing into the statement", async () => {
    const { sql, statements } = fakeDatabase();
    await new PostgresAuditLogStore(sql).append(
      event({ id: "e1", resource: "appointment:a1'; DROP TABLE audit_log; --" }),
    );

    const insert = statements.find((s) => s.sql.startsWith("INSERT"))!;
    expect(insert.sql).not.toContain("DROP TABLE");
    expect(insert.params[0]).toBe("e1");
    expect(insert.params[4]).toBe("appointment:a1'; DROP TABLE audit_log; --");
  });

  test("computes the sequence in the statement, so the database serialises appends", async () => {
    // The application picking its own `seq` would be the application deciding who
    // goes next, which is the race.
    const { sql, statements } = fakeDatabase();
    await new PostgresAuditLogStore(sql).append(event());

    expect(statements.find((s) => s.sql.startsWith("INSERT"))!.sql).toContain(
      "(SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_log)",
    );
  });

  test("retries against the new head when another instance took the sequence", async () => {
    // Two instances reading the same head is normal on a serverless platform.
    // The collision is a unique violation, and the retry is what makes it a
    // non-event rather than a lost audit entry -- and the retried entry has to
    // chain to the entry that actually won, not to the one that was there when
    // this instance read the head.
    const competitor = buildEntry({
      ...event({ id: "other", timestamp: "2026-08-31T09:00:00.000Z" }),
      previousHash: GENESIS_HASH,
    });
    const { sql, statements, rows } = fakeDatabase({
      competitor: {
        entry_id: competitor.id,
        recorded_at: competitor.timestamp,
        actor: competitor.actor,
        action: competitor.action,
        resource: competitor.resource,
        details: competitor.details,
        previous_hash: competitor.previousHash,
        hash: competitor.hash,
      },
    });
    const store = new PostgresAuditLogStore(sql);

    const entry = await store.append(event({ id: "e1" }));

    expect(statements.filter((s) => s.sql.startsWith("INSERT"))).toHaveLength(2);
    expect(entry.previousHash).toBe(competitor.hash);
    expect(entry.previousHash).not.toBe(GENESIS_HASH);
    expect(rows.map((r) => r.entry_id)).toEqual(["other", "e1"]);
    expect(await store.verify()).toBe(true);
  });

  test("a retry that already landed is recognised, not written twice", async () => {
    // The write succeeded and the response was lost. Writing it again would put
    // a duplicate in a log whose value is that it is a faithful record, and
    // returning the locally-rebuilt entry would report a hash the database does
    // not hold -- so what comes back is the row that is actually there.
    let inserts = 0;
    const { sql, rows } = fakeDatabase({
      onInsert: () => {
        inserts += 1;
        if (inserts > 1) {
          throw new SqlError("23505", "duplicate key value violates unique constraint");
        }
      },
    });
    const store = new PostgresAuditLogStore(sql);

    const first = await store.append(event({ id: "e1" }));
    const again = await store.append(event({ id: "e1" }));

    // Two insert attempts, one row: the second was refused, and what came back
    // is the row rather than a second guess at it.
    expect(inserts).toBe(2);
    expect(rows).toHaveLength(1);
    expect(again).toEqual(first);
  });

  test("gives up rather than looping, and fails closed", async () => {
    const { sql } = fakeDatabase({
      onInsert: () => {
        throw new SqlError("23505", "duplicate key value violates unique constraint");
      },
    });

    // Five attempts, then an error. An audit append that cannot complete must not
    // become an unbounded wait in the middle of a request.
    await expect(new PostgresAuditLogStore(sql).append(event())).rejects.toBeInstanceOf(SqlError);
  });

  test("does not retry a failure that is not a collision", async () => {
    let attempts = 0;
    const { sql } = fakeDatabase({
      onInsert: () => {
        attempts += 1;
        throw new SqlError("transport", "The database could not be reached.");
      },
    });

    await expect(new PostgresAuditLogStore(sql).append(event())).rejects.toThrow(/could not be reached/);
    expect(attempts).toBe(1);
  });

  test("retries the schema after a failure, rather than failing forever", async () => {
    let attempts = 0;
    const sql: SqlClient = {
      driver: "fake",
      async query(statement: string) {
        if (statement.includes("CREATE TABLE")) {
          attempts += 1;
          if (attempts === 1) throw new SqlError("transport", "The database could not be reached.");
          return [];
        }
        if (statement.includes("SELECT entry_id, hash")) return [];
        return [row()] as never;
      },
    };

    const store = new PostgresAuditLogStore(sql);
    await expect(store.append(event())).rejects.toBeInstanceOf(SqlError);
    expect(await store.append(event())).toBeDefined();
    expect(attempts).toBe(2);
  });

  test("reads oldest first, bounded", async () => {
    const { sql } = fakeDatabase();
    const store = new PostgresAuditLogStore(sql);
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));
    await store.append(event({ id: "e3" }));

    const all = await store.read();
    expect(all.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);

    const bounded = await store.read(2);
    expect(bounded.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  test("reads through a default limit rather than the whole table", async () => {
    const { sql, statements } = fakeDatabase();
    await new PostgresAuditLogStore(sql).read();

    const select = statements.find((s) => s.sql.startsWith("SELECT"))!;
    expect(select.params[0]).toBe(200);
  });

  test("verify reads the whole chain, unbounded", async () => {
    // A bounded verify would answer a question about the tail and call it a
    // question about the log. Bounded reads are for display, not for checking.
    const { sql, statements } = fakeDatabase();
    await new PostgresAuditLogStore(sql).verify();

    const select = statements.find((s) => s.sql.startsWith("SELECT"))!;
    expect(select.sql).toContain("ORDER BY seq ASC");
    expect(select.params).toEqual([]);
  });

  test("verify reports a chain that was modified behind it", async () => {
    const { sql, rows } = fakeDatabase();
    const store = new PostgresAuditLogStore(sql);
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));
    expect(await store.verify()).toBe(true);

    rows[1].actor = "someone-else";

    expect(await store.verify()).toBe(false);
  });
});

describe("toEntry", () => {
  test("rebuilds an entry from a row", () => {
    expect(toEntry(row() as never)).toEqual({
      id: ENTRY_ID,
      timestamp: RECORDED_AT,
      actor: AUDIT_ACTORS.patient,
      action: "APPOINTMENT_CREATED",
      resource: appointmentResource("a1"),
      details: { reason: "intake" },
      previousHash: GENESIS_HASH,
      hash: "a".repeat(64),
    });
  });

  test("accepts details that arrive as a JSON string", () => {
    // A driver that does not deserialise jsonb is a real configuration, and it
    // must not read as tampering.
    expect(toEntry(row({ details: JSON.stringify({ reason: "intake" }) }) as never).details).toEqual({
      reason: "intake",
    });
  });

  test("an absent details column is absent details", () => {
    expect(toEntry(row({ details: null }) as never).details).toBeUndefined();
  });

  test.each([
    ["a missing entry id", { entry_id: undefined }, /entry_id/],
    ["a hash that is not a digest", { hash: "abc" }, /hash/],
    ["a previous hash that is not a digest", { previous_hash: "abc" }, /previous_hash/],
    ["details that are not an object", { details: "[1]" }, /details/],
    ["details that are not valid JSON", { details: "{" }, /not valid JSON/],
  ])("throws rather than dropping an entry it cannot read: %s", (_label, overrides, message) => {
    // Skipping an unreadable entry would cut the chain in two and report the
    // remainder as valid, which is worse than failing.
    expect(() => toEntry(row(overrides) as never)).toThrow(message);
  });
});
