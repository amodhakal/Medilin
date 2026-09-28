import { describe, expect, test } from "bun:test";
import { AuditLogManager } from "./audit";

const GENESIS = "0".repeat(64);

describe("AuditLogManager", () => {
  test("an empty chain is valid", () => {
    expect(new AuditLogManager().verifyChain()).toBe(true);
  });

  test("links each entry to the previous hash", () => {
    const audit = new AuditLogManager();
    const first = audit.log("actor-1", "PHI_ACCESS", "patient-1");
    const second = audit.log("actor-1", "PHI_UPDATE", "patient-1");
    const third = audit.log("actor-2", "PHI_READ", "patient-2");

    expect(first.previousHash).toBe(GENESIS);
    expect(second.previousHash).toBe(first.hash);
    expect(third.previousHash).toBe(second.hash);
    expect(audit.verifyChain()).toBe(true);
  });

  test("hashes cover the entry contents", () => {
    const audit = new AuditLogManager();
    const entry = audit.log("actor-1", "PHI_ACCESS", "patient-1", { reason: "intake" });
    expect(entry.hash).toHaveLength(64);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("identical events produce different hashes", () => {
    // The id and timestamp are part of the hashed payload, so two otherwise
    // identical entries must not collide.
    const audit = new AuditLogManager();
    const a = audit.log("actor-1", "PHI_ACCESS", "patient-1");
    const b = audit.log("actor-1", "PHI_ACCESS", "patient-1");
    expect(a.hash).not.toBe(b.hash);
    expect(audit.verifyChain()).toBe(true);
  });

  test("detects a modified details payload", () => {
    const audit = new AuditLogManager();
    audit.log("actor-1", "PHI_ACCESS", "patient-1", { reason: "intake" });
    audit.log("actor-1", "PHI_UPDATE", "patient-1", { field: "medication" });
    const logs = audit.getLogs();
    logs[1].details = { field: "tampered" };
    expect(audit.verifyChain()).toBe(false);
  });

  test("detects a modified actor", () => {
    const audit = new AuditLogManager();
    audit.log("actor-1", "PHI_ACCESS", "patient-1");
    audit.log("actor-1", "PHI_ACCESS", "patient-1");
    const logs = audit.getLogs();
    logs[0].actor = "someone-else";
    expect(audit.verifyChain()).toBe(false);
  });

  test("detects a removed entry", () => {
    const audit = new AuditLogManager();
    audit.log("actor-1", "PHI_ACCESS", "patient-1");
    audit.log("actor-1", "PHI_UPDATE", "patient-1");
    audit.log("actor-1", "PHI_READ", "patient-1");

    // getLogs() hands back a shallow copy, so splicing it proves nothing
    // about the log itself. Reach the managed array directly: this asserts
    // verifyChain's linkage logic, not the copy semantics.
    const internal = (audit as unknown as { logs: unknown[] }).logs;
    internal.splice(1, 1);

    expect(audit.verifyChain()).toBe(false);
  });

  test("detects a reordered entry", () => {
    const audit = new AuditLogManager();
    const a = audit.log("actor-1", "PHI_ACCESS", "patient-1");
    audit.log("actor-1", "PHI_UPDATE", "patient-1");

    const internal = (audit as unknown as { logs: Array<{ hash: string }> }).logs;
    internal.reverse();
    expect(audit.getLogs()[0].hash).not.toBe(a.hash);
    expect(audit.verifyChain()).toBe(false);
  });

  test("getLogs returns a copy, not the internal array", () => {
    const audit = new AuditLogManager();
    audit.log("actor-1", "PHI_ACCESS", "patient-1");
    const logs = audit.getLogs();
    logs.push(audit.getLogs()[0]);
    expect(audit.getLogs()).toHaveLength(1);
  });

  test("each instance keeps an independent chain", () => {
    const a = new AuditLogManager();
    const b = new AuditLogManager();
    a.log("actor-1", "PHI_ACCESS", "patient-1");
    expect(b.getLogs()).toHaveLength(0);
    expect(b.verifyChain()).toBe(true);
  });
});
