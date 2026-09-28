import { describe, expect, test } from "bun:test";
import { InMemoryAuditLogStore } from "./memory-store";
import { AUDIT_ACTORS, GENESIS_HASH, appointmentResource, type AuditLogEntry } from "./store";

/**
 * The in-memory audit chain: the default configuration.
 *
 * These are the assertions `scripts/verify-hipaa.ts` also depends on, plus the
 * ones it cannot make -- that a caller cannot edit the log through the value
 * `read` hands back, which is the property that script had to give up in order
 * to test tampering honestly.
 */

function event(overrides: Partial<Omit<AuditLogEntry, "hash" | "previousHash">> = {}) {
  return {
    id: "e1",
    timestamp: "2026-09-01T10:00:00.000Z",
    actor: AUDIT_ACTORS.patient,
    action: "APPOINTMENT_CREATED" as const,
    resource: appointmentResource("a1"),
    details: { reason: "intake" as const },
    ...overrides,
  };
}

describe("InMemoryAuditLogStore", () => {
  test("an empty chain verifies", async () => {
    const store = new InMemoryAuditLogStore();
    expect(await store.read()).toEqual([]);
    expect(await store.verify()).toBe(true);
  });

  test("links each entry to the previous hash", async () => {
    const store = new InMemoryAuditLogStore();
    const first = await store.append(event({ id: "e1" }));
    const second = await store.append(event({ id: "e2", action: "PHI_READ" }));
    const third = await store.append(event({ id: "e3", actor: AUDIT_ACTORS.internalApi }));

    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.previousHash).toBe(first.hash);
    expect(third.previousHash).toBe(second.hash);
    expect(await store.verify()).toBe(true);
  });

  test("returns the entry it wrote", async () => {
    const store = new InMemoryAuditLogStore();
    const entry = await store.append(event());

    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.action).toBe("APPOINTMENT_CREATED");
    expect(entry.details).toEqual({ reason: "intake" });
  });

  test("reads oldest first", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));
    await store.append(event({ id: "e3" }));

    expect((await store.read()).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("a bounded read answers with the most recent entries, still oldest first", async () => {
    // A trail read newest-last is a trail nobody can read, and an unbounded one
    // is a request that returns the whole database.
    const store = new InMemoryAuditLogStore();
    for (const id of ["e1", "e2", "e3", "e4"]) await store.append(event({ id }));

    expect((await store.read(2)).map((e) => e.id)).toEqual(["e3", "e4"]);
  });

  test("read hands back copies, so a caller cannot edit the log it was shown", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));

    const logs = await store.read();
    logs[1].actor = "someone-else";
    logs[1].details = { reason: "internal_api" };

    // The old implementation returned the live entry objects, so a script
    // tampering with what it read was tampering with the store -- convenient for
    // demonstrating tamper detection, and a way to rewrite an audit trail from
    // any code that can call read().
    expect((await store.read())[1].actor).toBe(AUDIT_ACTORS.patient);
    expect(await store.verify()).toBe(true);
  });

  test("detects a modified entry", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));

    // Reaching the managed array directly: this asserts the chain's linkage
    // logic, which is the thing an attacker would be attacking.
    const internal = (store as unknown as { entries: AuditLogEntry[] }).entries;
    internal[1].actor = "someone-else";

    expect(await store.verify()).toBe(false);
  });

  test("detects a removed entry", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));
    await store.append(event({ id: "e3" }));

    const internal = (store as unknown as { entries: AuditLogEntry[] }).entries;
    internal.splice(1, 1);

    expect(await store.verify()).toBe(false);
  });

  test("detects a reordered chain", async () => {
    const store = new InMemoryAuditLogStore();
    const first = await store.append(event({ id: "e1" }));
    await store.append(event({ id: "e2" }));

    const internal = (store as unknown as { entries: AuditLogEntry[] }).entries;
    internal.reverse();

    expect((await store.read())[0].hash).not.toBe(first.hash);
    expect(await store.verify()).toBe(false);
  });

  test("each instance keeps its own chain", async () => {
    const a = new InMemoryAuditLogStore();
    const b = new InMemoryAuditLogStore();

    await a.append(event({ id: "e1" }));

    expect(await b.read()).toEqual([]);
    expect(await b.verify()).toBe(true);
  });

  test("an entry with no details and one with empty details are the same event", async () => {
    // The same event arriving through two paths has to hash the same way, or the
    // chain is not reproducible. Two stores, because within one chain the second
    // entry legitimately points at the first.
    const without = new InMemoryAuditLogStore();
    const empty = new InMemoryAuditLogStore();

    const a = await without.append(event({ id: "e1", details: undefined }));
    const b = await empty.append(event({ id: "e1", details: {} }));

    expect(b.hash).toBe(a.hash);
  });

  test("a details object read back in a different key order still verifies", async () => {
    // What a `jsonb` column does to an object on its way through Postgres, and
    // the reason the hash is computed over a canonical key order.
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1", details: { reason: "intake", status: "scheduled" } }));

    const internal = (store as unknown as { entries: AuditLogEntry[] }).entries;
    internal[0].details = { status: "scheduled", reason: "intake" };

    expect(await store.verify()).toBe(true);
  });

  test("a details key outside the closed set is treated as tampering", async () => {
    // A row written by hand with an extra field must not verify: the hash does
    // not cover fields nothing decided should be there.
    const store = new InMemoryAuditLogStore();
    await store.append(event({ id: "e1", details: { reason: "intake" } }));

    const internal = (store as unknown as { entries: AuditLogEntry[] }).entries;
    (internal[0].details as Record<string, unknown>).notes = "everything";

    expect(await store.verify()).toBe(false);
  });
});
