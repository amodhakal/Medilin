import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_REASONS,
  AuditDetailsError,
  assertAuditDetails,
  buildEntry,
  calculateEntryHash,
  verifyChain,
  GENESIS_HASH,
  appointmentResource,
  type AuditLogEntry,
} from "./store";

/**
 * The chain itself, and the closed set of details.
 *
 * These are the two properties the rest of the audit work is built on: a
 * modified entry is detectable, and an entry cannot carry PHI. Both are asserted
 * here as pure functions, with no store and no database, because both have to
 * hold for every implementation and a test that only ran against one of them
 * would not say that.
 */

const entry = (overrides: Partial<Omit<AuditLogEntry, "hash">> = {}): Omit<AuditLogEntry, "hash"> => ({
  id: "e1",
  timestamp: "2026-09-01T10:00:00.000Z",
  actor: AUDIT_ACTORS.patient,
  action: "APPOINTMENT_CREATED",
  resource: appointmentResource("a1"),
  previousHash: GENESIS_HASH,
  ...overrides,
});

describe("the hash chain", () => {
  test("an empty chain is valid", () => {
    expect(verifyChain([])).toBe(true);
  });

  test("the first entry points back to genesis", () => {
    expect(buildEntry(entry()).previousHash).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toHaveLength(64);
  });

  test("each entry points at the hash of the one before it", () => {
    const first = buildEntry(entry({ id: "e1" }));
    const second = buildEntry(entry({ id: "e2", previousHash: first.hash }));
    const third = buildEntry(entry({ id: "e3", previousHash: second.hash }));

    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.previousHash).toBe(first.hash);
    expect(third.previousHash).toBe(second.hash);
    expect(verifyChain([first, second, third])).toBe(true);
  });

  test("hashes are sha256 digests", () => {
    const built = buildEntry(entry());
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("identical events do not collide", () => {
    // The id is part of the hashed payload, so two otherwise identical entries
    // must differ. A trail that deduplicated identical events would be a trail
    // that hid the second access.
    const a = buildEntry(entry({ id: "e1" }));
    const b = buildEntry(entry({ id: "e2" }));

    expect(a.hash).not.toBe(b.hash);
  });

  test("an absent details object and an empty one hash the same way", () => {
    // Otherwise the same event would have two hashes depending on which path
    // created it, and the chain would not be reproducible.
    expect(calculateEntryHash(entry())).toBe(calculateEntryHash(entry({ details: {} })));
  });

  test("details are part of the hashed payload", () => {
    expect(calculateEntryHash(entry({ details: { reason: "intake" } }))).not.toBe(
      calculateEntryHash(entry({ details: { reason: "internal_api" } })),
    );
  });

  test("the hash does not depend on the order the keys arrived in", () => {
    // A jsonb column comes back in the database's own key order, and a chain
    // that broke on a round trip through Postgres would be no chain at all.
    const a = buildEntry(entry({ details: { reason: "intake", status: "scheduled" } }));
    const b = buildEntry(
      entry({ details: { status: "scheduled", reason: "intake" } }),
    );

    expect(b.hash).toBe(a.hash);
  });

  describe("tamper detection", () => {
    test("a modified details payload", () => {
      const first = buildEntry(entry({ id: "e1", details: { reason: "intake" } }));
      const second = buildEntry(entry({ id: "e2", previousHash: first.hash }));
      const tampered: AuditLogEntry = { ...second, details: { reason: "internal_api" } };

      expect(verifyChain([first, tampered])).toBe(false);
    });

    test("a modified actor", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const tampered: AuditLogEntry = { ...first, actor: "someone-else" };

      expect(verifyChain([tampered])).toBe(false);
    });

    test("a modified action", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const tampered: AuditLogEntry = { ...first, action: "PHI_READ" };

      expect(verifyChain([tampered])).toBe(false);
    });

    test("a modified resource", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const tampered: AuditLogEntry = { ...first, resource: appointmentResource("a2") };

      expect(verifyChain([tampered])).toBe(false);
    });

    test("a modified timestamp", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const tampered: AuditLogEntry = { ...first, timestamp: "2020-01-01T00:00:00.000Z" };

      expect(verifyChain([tampered])).toBe(false);
    });

    test("a removed entry", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const second = buildEntry(entry({ id: "e2", previousHash: first.hash }));
      const third = buildEntry(entry({ id: "e3", previousHash: second.hash }));

      // The second entry is gone and the third is left pointing at it.
      expect(verifyChain([first, third])).toBe(false);
    });

    test("a reordered chain", () => {
      const first = buildEntry(entry({ id: "e1" }));
      const second = buildEntry(entry({ id: "e2", previousHash: first.hash }));

      expect(verifyChain([second, first])).toBe(false);
    });

    test("an attacker who can rewrite the whole tail can produce a valid chain", () => {
      // Stated rather than asserted as a protection, because it is the honest
      // limit of a hash chain. Recomputing every hash from the point of
      // tampering onwards yields a chain that verifies, so `verify()` proves the
      // log has not been edited, not that it has not been rewritten. What
      // actually raises the cost is that a head-anchored chain cannot be
      // *shortened* without the retained tail disagreeing, and that the value of
      // the tail is only real once something outside the log holds a copy of it.
      // That anchor is the follow-up noted in verifyChain, and pretending
      // otherwise here would be the one way this test file could mislead someone.
      const first = buildEntry(entry({ id: "e1" }));
      const rewritten = buildEntry(
        entry({ id: "e2", previousHash: first.hash, details: { reason: "intake" } }),
      );
      rewritten.details = { reason: "internal_api" };
      const relinked = buildEntry(
        entry({ id: "e2", previousHash: first.hash, details: { reason: "internal_api" } }),
      );

      expect(rewritten.hash).not.toBe(relinked.hash);
      expect(verifyChain([first, relinked])).toBe(true);
    });
    test("a details field outside the closed set is not covered by the hash", () => {
      // A key the canonicaliser does not know about is dropped before hashing,
      // so the hash alone would not notice it. verifyChain checks the round trip
      // explicitly for exactly this reason, and the store test below asserts it
      // end to end. Here: the dropped key really is invisible to the hash.
      const built = buildEntry(entry({ details: { reason: "intake" } }));
      const withExtra = buildEntry(
        entry({ details: { reason: "intake", notes: "everything" } as never }),
      );

      expect(withExtra.hash).toBe(built.hash);
      expect(verifyChain([withExtra])).toBe(false);
    });
  });
  test("accepts the closed set", () => {
    expect(
      assertAuditDetails({ reason: "intake", status: "scheduled", language: "spanish" }),
    ).toEqual({ reason: "intake", status: "scheduled", language: "spanish" });
  });

  test("accepts no details at all", () => {
    expect(assertAuditDetails(undefined)).toBeUndefined();
  });

  test.each([
    "firstName",
    "lastName",
    "email",
    "phone",
    "dob",
    "insurance",
    "additionalInfo",
    "patientInfo",
    "symptoms",
  ])("refuses a details key that would put PHI in an immutable log: %s", (key) => {
    // A trail cannot be redacted. Anything written to one is written forever, to
    // whoever holds a copy of the database.
    expect(() => assertAuditDetails({ [key]: "anything" })).toThrow(AuditDetailsError);
  });

  test("names the offending key and never the value", () => {
    // This error is about to be handled by a route and a logger.
    let thrown: unknown;
    try {
      assertAuditDetails({ additionalInfo: "chest pain since Tuesday" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as AuditDetailsError).key).toBe("additionalInfo");
    expect((thrown as Error).message).not.toContain("chest pain");
  });

  test("refuses a value of the wrong type", () => {
    expect(() => assertAuditDetails({ reason: 42 })).toThrow(AuditDetailsError);
    expect(() => assertAuditDetails({ status: { nested: true } })).toThrow(AuditDetailsError);
  });

  test("refuses details that are not an object", () => {
    expect(() => assertAuditDetails("intake" as never)).toThrow(AuditDetailsError);
    expect(() => assertAuditDetails(["intake"] as never)).toThrow(AuditDetailsError);
  });

  test("an unknown key is refused even alongside valid ones", () => {
    expect(() => assertAuditDetails({ reason: "intake", notes: "everything" })).toThrow(
      /unrecognised details key/,
    );
  });
});

describe("appointmentResource", () => {
  test("has one format, so entries about an appointment can be joined", () => {
    expect(appointmentResource("abc")).toBe("appointment:abc");
  });
});

// The two members the clinic dashboard (#63) added to the closed sets.
//
// Both are additions rather than a reuse, and the reuse is what had to be argued
// against: a dashboard read could be filed as `PHI_READ` / `internal_api`, which
// is what every other caller holding the secret does. That would be accurate and
// useless -- a dashboard is a *bulk* read of many patients' records at once, and
// an auditor asking "who pulled up a list of forty accounts, and when?" cannot
// be answered by a trail in which those forty reads are interleaved with the
// webhook's.
//
// The cost of growing a closed set is that it has to be argued for in a diff,
// which is exactly what these two lines are.
describe("the closed sets, extended for the clinic dashboard", () => {
  test("a dashboard read is its own action rather than a generic PHI_READ", () => {
    expect(AUDIT_ACTIONS).toContain("CLINIC_SCHEDULE_READ");
  });

  test("and its own reason", () => {
    expect(AUDIT_REASONS).toContain("clinician_dashboard");
  });

  test("the reason survives the details check, so the entry can actually be written", () => {
    // The runtime check in `assertAuditDetails` is the one that would refuse it,
    // and `recordAuditEvent` throws on a refused reason -- so a reason that is
    // not in `DETAIL_KEYS`'s value set is a dashboard that cannot be audited,
    // which is a dashboard that fails closed on every request.
    expect(
      assertAuditDetails({ reason: "clinician_dashboard", status: "scheduled" }),
    ).toEqual({ reason: "clinician_dashboard", status: "scheduled" });
  });

  test("still carries no PHI: the set of keys has not grown", () => {
    // The reason says which surface; it must never carry who looked, because
    // there is no clinician identity in this application to carry.
    expect(() =>
      assertAuditDetails({ reason: "clinician_dashboard", clinician: "Dr Smith" } as never),
    ).toThrow(AuditDetailsError);
  });
});
