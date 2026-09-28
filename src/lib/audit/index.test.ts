import { afterEach, describe, expect, test } from "bun:test";
import { SqlError, resetSqlClient, type SqlClient } from "@/lib/storage";
import {
  AUDIT_ACTORS,
  AuditDetailsError,
  InMemoryAuditLogStore,
  PostgresAuditLogStore,
  auditLogger,
  getAuditLogStore,
  readAuditLog,
  recordAuditEvent,
  setAuditLogStore,
  verifyAuditChain,
} from "./index";

/**
 * The audit facade.
 *
 * The default that ships has no DATABASE_URL, so the trail is in memory -- and
 * that is exactly what makes the fail-closed assertions here possible without a
 * database: a store that throws stands in for one that is unreachable, and the
 * property under test is that the caller does not proceed.
 */

const savedDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  resetSqlClient();
  setAuditLogStore(null);
});

const event = {
  actor: AUDIT_ACTORS.patient,
  action: "APPOINTMENT_CREATED" as const,
  resource: "appointment:a1",
  details: { reason: "intake" as const },
};

/** A `SqlClient` that reaches the durable store without a database. */
function countingClient(): { sql: SqlClient; statements: string[] } {
  const statements: string[] = [];

  return {
    sql: {
      driver: "fake",
      async query<T = Record<string, unknown>>(statement: string) {
        statements.push(statement);
        return [] as T[];
      },
    },
    statements,
  };
}

describe("audit store selection", () => {
  test("uses the in-memory chain when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    resetSqlClient();
    setAuditLogStore(null);
    expect(getAuditLogStore()).toBe(auditLogger);
  });

  test("uses the durable chain when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = "https://db.example.test/neon";
    resetSqlClient();
    setAuditLogStore(null);
    expect(getAuditLogStore()).toBeInstanceOf(PostgresAuditLogStore);
  });

  test("chooses once and keeps the choice", () => {
    delete process.env.DATABASE_URL;
    resetSqlClient();
    setAuditLogStore(null);
    expect(getAuditLogStore()).toBe(getAuditLogStore());
  });

  test("a store installed through the seam is the one that is used", () => {
    const installed = new InMemoryAuditLogStore();
    setAuditLogStore(installed);
    expect(getAuditLogStore()).toBe(installed);
  });
});

describe("recordAuditEvent", () => {
  test("appends a chained entry", async () => {
    setAuditLogStore(new InMemoryAuditLogStore());

    const first = await recordAuditEvent(event);
    const second = await recordAuditEvent({ ...event, action: "PHI_READ" });

    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.previousHash).toBe(first.hash);
    expect(await verifyAuditChain()).toBe(true);
  });

  test("gives every entry its own id and timestamp", async () => {
    setAuditLogStore(new InMemoryAuditLogStore());

    const first = await recordAuditEvent(event);
    const second = await recordAuditEvent(event);

    expect(second.id).not.toBe(first.id);
    expect(await verifyAuditChain()).toBe(true);
  });

  test("refuses details outside the closed set, and writes nothing", async () => {
    const store = new InMemoryAuditLogStore();
    setAuditLogStore(store);

    await expect(
      recordAuditEvent({ ...event, details: { symptoms: "chest pain" } as never }),
    ).rejects.toBeInstanceOf(AuditDetailsError);
    expect(store.size).toBe(0);
  });

  test("throws rather than swallowing when the store cannot write", async () => {
    // An access that cannot be recorded must not look recorded. The callers turn
    // this into a failed request, which is the whole point of it.
    setAuditLogStore({
      async append() {
        throw new SqlError("transport", "The database could not be reached.");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    await expect(recordAuditEvent(event)).rejects.toBeInstanceOf(SqlError);
  });
});

describe("readAuditLog and verifyAuditChain", () => {
  test("read is bounded, oldest first", async () => {
    setAuditLogStore(new InMemoryAuditLogStore());
    for (const action of ["APPOINTMENT_CREATED", "PHI_READ", "APPOINTMENT_CANCELLED"] as const) {
      await recordAuditEvent({ ...event, action });
    }

    expect((await readAuditLog()).map((e) => e.action)).toEqual([
      "APPOINTMENT_CREATED",
      "PHI_READ",
      "APPOINTMENT_CANCELLED",
    ]);
    expect((await readAuditLog(1)).map((e) => e.action)).toEqual(["APPOINTMENT_CANCELLED"]);
  });

  test("verify reports a chain that no longer holds", async () => {
    const store = new InMemoryAuditLogStore();
    setAuditLogStore(store);
    await recordAuditEvent(event);
    await recordAuditEvent({ ...event, action: "PHI_READ" });

    (store as unknown as { entries: { actor: string }[] }).entries[1].actor = "someone-else";

    expect(await verifyAuditChain()).toBe(false);
  });

  test("the durable chain is verified through the facade, not around it", async () => {
    const { sql, statements } = countingClient();
    setAuditLogStore(new PostgresAuditLogStore(sql));

    await recordAuditEvent(event);

    // A read of the whole chain, unbounded: a check over the last N entries would
    // answer a question about the tail and call it a question about the log.
    expect(await verifyAuditChain()).toBe(true);
    expect(statements.some((s) => s.includes("ORDER BY seq ASC"))).toBe(true);
  });
});

describe("the exported default chain", () => {
  test("is an in-memory store, and is what a database-less deployment uses", () => {
    // `scripts/verify-hipaa.ts` exercises this object, so CI is checking the code
    // that actually runs when there is no database.
    expect(auditLogger).toBeInstanceOf(InMemoryAuditLogStore);
  });
});
