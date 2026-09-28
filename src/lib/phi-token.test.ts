import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  openRecord,
  resolveRecord,
  sealForDelivery,
  sealRecord,
  sealReference,
} from "./phi-token";
import { InMemoryAppointmentStore, PostgresAppointmentStore, setAppointmentStore } from "./appointments";
import { resetServerEnvCache } from "./env";
import type { SqlClient } from "./storage";
import type { AppointmentRecord } from "./validation/intake";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

const saved = process.env.HIPAA_MASTER_KEY;

beforeAll(() => {
  process.env.HIPAA_MASTER_KEY = KEY;
  resetServerEnvCache();
});

// Restored in afterAll rather than in a test: an ordinary test case runs
// before its later siblings, so restoring there would unset the key for the
// rest of the file and fail every seal after it.
afterAll(() => {
  if (saved === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = saved;
  resetServerEnvCache();
});

const record = JSON.stringify({
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  additionalInfo: "headache",
});

const patientRecord: AppointmentRecord = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "headache",
  language: "english",
};

const APPOINTMENT_ID = "3f7c1e2a-9b4d-4c58-8a61-2d0e7b5f9c34";

/**
 * A `SqlClient` holding one row, so the durable token path is exercised through
 * the real store rather than a stand-in for it.
 *
 * There is no database in this repository or in CI, and there is no need for
 * one to prove that a reference resolves: the store's own SQL is covered in
 * ./appointments/postgres-store.test, and what is under test here is which
 * format gets minted and how a token is turned back into a record.
 */
function durableStore(): SqlClient {
  const answer = (sql: string, params: readonly unknown[]): unknown[] => {
    if (sql.includes("CREATE TABLE")) return [];
    if (sql.includes("SELECT") && params[0] === APPOINTMENT_ID) {
      return [
        {
          id: APPOINTMENT_ID,
          patient_info: patientRecord,
          status: "scheduled",
          conversation_ended: false,
          created_at: "2026-09-01T10:00:00.000Z",
          updated_at: "2026-09-01T10:00:00.000Z",
        },
      ];
    }
    return [];
  };

  return {
    driver: "fake",
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return answer(sql, params) as T[];
    },
  };
}

afterEach(() => {
  setAppointmentStore(null);
});

describe("sealRecord", () => {
  test("round-trips", () => {
    expect(openRecord(sealRecord(record))).toBe(record);
  });

  test("produces no plaintext in the token", () => {
    // The whole point: this string is what lands in a URL, a browser history
    // entry, and an access log.
    const token = sealRecord(record);
    for (const leak of ["Ada", "Lovelace", "ada@example.test", "1985-12-10", "headache"]) {
      expect(token).not.toContain(leak);
      expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain(leak);
    }
  });

  test("is URL-safe", () => {
    const token = sealRecord(record);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  test("is fresh per call", () => {
    expect(sealRecord(record)).not.toBe(sealRecord(record));
  });

  test("is a bearer credential only the server can open", () => {
    const token = sealRecord(record);
    process.env.HIPAA_MASTER_KEY = OTHER;
    resetServerEnvCache();
    expect(openRecord(token)).toBeNull();
    process.env.HIPAA_MASTER_KEY = KEY;
    resetServerEnvCache();
    expect(openRecord(token)).toBe(record);
  });
});

describe("openRecord", () => {
  test("rejects a tampered ciphertext", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[raw.length - 1] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test("rejects a tampered auth tag", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[20] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test("rejects a tampered IV", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[3] ^= 0xff;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test.each([
    ["an empty string", ""],
    ["a short string", "abc"],
    ["not base64 at all", "!!!!"],
    ["random hex", "deadbeef"],
    ["a truncated token", "AAAA"],
  ])("returns null for %s", (_label, token) => {
    expect(openRecord(token)).toBeNull();
  });

  test("rejects an unknown version", () => {
    const raw = Buffer.from(sealRecord(record), "base64url");
    raw[0] = 9;
    expect(openRecord(raw.toString("base64url"))).toBeNull();
  });

  test("does not resolve a reference: it opens sealed tokens, and only those", () => {
    // The dispatch lives in resolveRecord. A function that quietly answered for
    // both formats would need a store lookup inside a function whose whole job
    // is a local decryption.
    expect(openRecord(sealReference(APPOINTMENT_ID))).toBeNull();
  });
});

describe("sealReference", () => {
  test("is the version and the id, and nothing else", () => {
    const token = sealReference(APPOINTMENT_ID);
    expect(token).toBe(`2.${APPOINTMENT_ID}`);
    expect(token).toHaveLength(38);
  });

  test("carries no part of the record", () => {
    // What lands in a URL, a browser history entry, and an access log.
    const token = sealReference(APPOINTMENT_ID);
    for (const leak of ["Ada", "Lovelace", "ada@example.test", "1985-12-10", "headache"]) {
      expect(token).not.toContain(leak);
    }
  });

  test("is URL-safe, and safe as a single path segment", () => {
    const token = sealReference(APPOINTMENT_ID);
    expect(token).toMatch(/^[A-Za-z0-9.-]+$/);
    expect(token).not.toContain("/");
    expect(token).not.toContain("..");
  });

  test("refuses an id it could not resolve back to a record", () => {
    // A reference is not sealed. Nothing in it is self-validating, so a bad id
    // produces a link that fails as "not found" rather than as "bad mint".
    expect(() => sealReference("not-a-uuid")).toThrow(/uuid appointment id/);
    expect(() => sealReference("")).toThrow(/uuid appointment id/);
    expect(() => sealReference("2.deadbeef")).toThrow(/uuid appointment id/);
  });
});

describe("sealForDelivery", () => {
  test("seals the record when the store does not survive the process", () => {
    // A reference to a Map entry only resolves in the process that wrote it, so
    // minting one here would trade a working link for a broken one.
    setAppointmentStore(new InMemoryAppointmentStore());

    const token = sealForDelivery(record, APPOINTMENT_ID);

    expect(token.startsWith("2.")).toBe(false);
    expect(openRecord(token)).toBe(record);
  });

  test("mints a short reference when the store is durable", () => {
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    const token = sealForDelivery(record, APPOINTMENT_ID);

    expect(token).toBe(`2.${APPOINTMENT_ID}`);
    expect(token.length).toBeLessThan(sealRecord(record).length);
  });

  test("asks the store, not the environment", () => {
    // A store installed for a test reports what it is, so swapping it does not
    // silently change which token format the booking path mints.
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));
    expect(sealForDelivery(record, APPOINTMENT_ID).startsWith("2.")).toBe(true);

    setAppointmentStore(new InMemoryAppointmentStore());
    expect(sealForDelivery(record, APPOINTMENT_ID).startsWith("2.")).toBe(false);
  });
});

describe("resolveRecord", () => {
  test("opens a sealed token", async () => {
    expect(await resolveRecord(sealRecord(record))).toBe(record);
  });

  test("resolves a reference to the stored record", async () => {
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    const resolved = JSON.parse((await resolveRecord(sealReference(APPOINTMENT_ID)))!);

    expect(resolved).toEqual(patientRecord);
  });

  test("a sealed link keeps working after the durable store is switched on", async () => {
    // Every link already in a patient's inbox is version 1. The format they
    // were minted in cannot be the reason a deployed link stops resolving.
    const sealed = sealRecord(record);
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    expect(await resolveRecord(sealed)).toBe(record);
  });

  test("returns null for a reference to a record that is not there", async () => {
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    expect(
      await resolveRecord(sealReference("00000000-0000-0000-0000-000000000000")),
    ).toBeNull();
  });

  test("returns null for a reference that is not a uuid, without asking the store", async () => {
    // The one string here that is not ciphertext is the one string that must not
    // reach a query unchecked.
    let asked = 0;
    setAppointmentStore(
      new PostgresAppointmentStore({
        driver: "fake",
        async query(sql: string) {
          if (sql.includes("CREATE TABLE")) return [];
          asked += 1;
          return [];
        },
      }),
    );

    expect(await resolveRecord("2.not-a-uuid")).toBeNull();
    expect(await resolveRecord("2.")).toBeNull();
    expect(await resolveRecord("2....")).toBeNull();
    expect(asked).toBe(0);
  });

  test("a tampered reference is a miss, not a forged record", async () => {
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    const tampered = `2.${APPOINTMENT_ID.slice(0, -1)}${APPOINTMENT_ID.endsWith("4") ? "5" : "4"}`;

    expect(await resolveRecord(tampered)).toBeNull();
  });

  test("a sealed token and a reference are told apart by their prefix", async () => {
    // base64url of a leading 0x01 byte is always "AQ", so a sealed token can
    // never begin "2." and the dispatch cannot be tricked by one.
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));

    expect(sealRecord(record).startsWith("2.")).toBe(false);
    expect(await resolveRecord(sealRecord(record))).toBe(record);
  });

  test.each([
    ["an empty string", ""],
    ["a short string", "abc"],
    ["not base64 at all", "!!!!"],
    ["random hex", "deadbeef"],
    ["a truncated token", "AAAA"],
  ])("returns null for %s, from either format", async (_label, token) => {
    setAppointmentStore(new PostgresAppointmentStore(durableStore()));
    expect(await resolveRecord(token)).toBeNull();
  });
});
