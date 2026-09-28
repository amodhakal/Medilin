import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  AUDIT_ACTORS,
  AUDIT_REASONS,
  InMemoryAuditLogStore,
  readAuditLog,
  setAuditLogStore,
  verifyAuditChain,
} from "./audit";
import { openActionToken } from "./action-token";
import { resetSqlClient } from "@/lib/storage";
import {
  InMemoryAppointmentStore,
  PostgresAppointmentStore,
  cancelAppointment,
  createAppointment,
  getAppointment,
  getAppointmentStore,
  isDurableAppointmentStore,
  issuePatientActions,
  rescheduleAppointment,
  setAppointmentStore,
  spendPatientAction,
  updateAppointment,
} from "./appointments";
import type { AppointmentRecord } from "./validation/intake";

/**
 * The appointment facade, and the trail it writes.
 *
 * These are the tests for the default that ships: no DATABASE_URL, so the
 * in-memory stores, so a contributor's `bun test` and CI need no database and no
 * credentials. The stores' own behaviour is covered in ./memory-store.test and
 * ./postgres-store.test; what matters here is that the four functions route to
 * whichever store is selected, that the selection is the thing #17 is about, and
 * that every one of the four leaves an entry behind.
 *
 * The audit assertions are the point of the second half of this file. A trail
 * that only exists in a module nothing calls is a module nothing calls, and this
 * is where it stops being that.
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
let audit: InMemoryAuditLogStore;

// Minting a management link seals a token, which needs the master key. The
// trajectory functions deliberately have none of their own -- they read the
// environment through `getServerEnv` and fail closed without it -- so the key
// lives in the environment for this file and is restored afterwards.
const MASTER_KEY = "a".repeat(64);
const savedMasterKey = process.env.HIPAA_MASTER_KEY;

beforeAll(() => {
  process.env.HIPAA_MASTER_KEY = MASTER_KEY;
});

afterAll(() => {
  if (savedMasterKey === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = savedMasterKey;
});

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  resetSqlClient();
  setAppointmentStore(null);
  setAuditLogStore(audit);
});

/** Install a fresh trail, so each test reads only its own entries. */
function freshAudit() {
  audit = new InMemoryAuditLogStore();
  setAuditLogStore(audit);
  return audit;
}

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
    freshAudit();
    const created = await createAppointment(record());
    const found = await getAppointment(created.id, AUDIT_ACTORS.internalApi);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.patientInfo).toEqual(record());
    expect(found?.conversationEnded).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  test("assigns a unique id per appointment", async () => {
    freshAudit();
    const ids = new Set(
      await Promise.all(
        Array.from({ length: 50 }, async () => (await createAppointment(record())).id),
      ),
    );
    expect(ids.size).toBe(50);
  });

  test("starts scheduled, with createdAt and updatedAt in step", async () => {
    freshAudit();
    const created = await createAppointment(record());

    expect(created.status).toBe("scheduled");
    expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await getAppointment("00000000-0000-0000-0000-000000000000", AUDIT_ACTORS.internalApi)).toBeUndefined();
    expect(await getAppointment("not-a-uuid", AUDIT_ACTORS.internalApi)).toBeUndefined();
    expect(await getAppointment("", AUDIT_ACTORS.internalApi)).toBeUndefined();
  });

  test("a stored appointment survives a read that goes through a fresh reference", async () => {
    // What a durable store has to deliver and the in-memory one only
    // coincidentally does today: the record the booking path stored is the
    // record the read path finds.
    freshAudit();
    const created = await createAppointment(record({ firstName: "Ada" }));
    expect((await getAppointment(created.id, AUDIT_ACTORS.linkBearer))?.patientInfo.firstName).toBe("Ada");
  });
});

describe("updateAppointment", () => {
  test("changes a status", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, { status: "confirmed" });

    expect(updated?.status).toBe("confirmed");
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("confirmed");
  });

  test("changes the patient record", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const updated = await updateAppointment(created.id, {
      patientInfo: record({ appointmentDateTime: "2026-10-02T14:00" }),
    });

    expect(updated?.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await updateAppointment("missing", { status: "confirmed" })).toBeUndefined();
  });

  test("refuses a status outside the closed set, before it reaches a store", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await expect(
      updateAppointment(created.id, { status: "Cancelled" as never }),
    ).rejects.toThrow(/unknown appointment status/);
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("scheduled");
  });

  test("refuses an unknown status without an appointment to reject it against", async () => {
    freshAudit();
    await expect(updateAppointment("missing", { status: "nope" as never })).rejects.toThrow(
      /unknown appointment status/,
    );
  });
});

describe("cancelAppointment", () => {
  test("cancels an appointment", async () => {
    freshAudit();
    const created = await createAppointment(record());

    const cancelled = await cancelAppointment(created.id);

    expect(cancelled?.status).toBe("cancelled");
    expect((await getAppointment(created.id, AUDIT_ACTORS.internalApi))?.status).toBe("cancelled");
  });

  test("is idempotent", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await cancelAppointment(created.id);
    expect((await cancelAppointment(created.id))?.status).toBe("cancelled");
  });

  test("returns undefined for an unknown id", async () => {
    freshAudit();
    expect(await cancelAppointment("missing")).toBeUndefined();
  });
});

describe("the audit trail", () => {
  test("a booking is in the trail before the record is written", async () => {
    // Intent first, then the write. If the trail cannot be written the booking
    // does not happen, which is the only ordering in which an access cannot
    // occur unrecorded.
    const trail = freshAudit();
    const created = await createAppointment(record({ language: "spanish" }));

    const logs = await readAuditLog();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("APPOINTMENT_CREATED");
    expect(logs[0].resource).toBe(`appointment:${created.id}`);
    expect(logs[0].details).toEqual({ reason: "intake", status: "scheduled", language: "spanish" });
    expect(trail.size).toBe(1);
  });

  test("a record read is in the trail, attributed to whoever read it", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);
    await getAppointment(created.id, AUDIT_ACTORS.internalApi);

    const reads = (await readAuditLog()).filter((entry) => entry.action === "PHI_READ");
    expect(reads.map((entry) => entry.actor)).toEqual([
      AUDIT_ACTORS.linkBearer,
      AUDIT_ACTORS.internalApi,
    ]);
    expect(reads[0].resource).toBe(`appointment:${created.id}`);
  });

  test("a read of an appointment that is not there is not an access", async () => {
    // Nothing was read, so there is nothing to record. Logging it anyway would
    // fill the trail with misses and make the real accesses harder to find.
    freshAudit();
    await getAppointment("missing", AUDIT_ACTORS.internalApi);

    expect(await readAuditLog()).toEqual([]);
  });

  test("an update and a cancellation are in the trail", async () => {
    freshAudit();
    const created = await createAppointment(record());

    await updateAppointment(created.id, { status: "confirmed" });
    await cancelAppointment(created.id);

    const actions = (await readAuditLog()).map((entry) => entry.action);
    expect(actions).toEqual([
      "APPOINTMENT_CREATED",
      "APPOINTMENT_UPDATED",
      "APPOINTMENT_CANCELLED",
    ]);
  });

  test("no entry carries a field of the patient record", async () => {
    // The trail cannot be redacted and cannot be dropped, so what goes in it has
    // to be the three non-identifying fields and nothing else.
    freshAudit();
    const created = await createAppointment(
      record({ firstName: "Ada", additionalInfo: "chest pain", phone: "+1 555 0100" }),
    );
    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);

    const serialised = JSON.stringify(await readAuditLog());
    for (const leak of ["Ada", "chest pain", "+1 555 0100", "1985-12-10", "REDACTED"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  test("the chain covers the whole booking and read sequence", async () => {
    freshAudit();
    const created = await createAppointment(record());
    await getAppointment(created.id, AUDIT_ACTORS.linkBearer);
    await updateAppointment(created.id, { status: "confirmed" });

    expect(await verifyAuditChain()).toBe(true);
  });

  test("a booking fails, and no record is written, when the trail cannot be", async () => {
    // The fail-closed property, and the reason it is worth the extra round trip.
    setAuditLogStore({
      async append() {
        throw new Error("the database could not be reached");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    const store = new InMemoryAppointmentStore();
    setAppointmentStore(store);

    await expect(createAppointment(record())).rejects.toThrow(/could not be reached/);
    expect(store.size).toBe(0);
  });

  test("a read is not disclosed when the trail cannot record it", async () => {
    freshAudit();
    const created = await createAppointment(record());

    setAuditLogStore({
      async append() {
        throw new Error("the database could not be reached");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    // The record was loaded into this process and goes no further: not returned,
    // not rendered, not emailed.
    await expect(getAppointment(created.id, AUDIT_ACTORS.linkBearer)).rejects.toThrow(
      /could not be reached/,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Patient action links (#59)
 * ---------------------------------------------------------------------------
 *
 * The facade half of the reschedule/cancel flow. What is asserted is the
 * division of labour the whole design rests on: the token says what may be done
 * and until when, the grant says whether that token was issued, and an action
 * needs both. Each of those is asserted from both directions -- that a live
 * token works, and that every way of defeating the grant does not -- because a
 * feature that only tests the happy path has tested nothing about authorisation.
 *
 * The cryptography itself is in ./action-token.test, and the grant lifecycle is
 * in ./appointments/memory-store.test.
 */

const NOW = Date.parse("2026-09-01T10:00:00.000Z");

/** A created appointment plus the two links minted for it. */
async function booked() {
  const created = await createAppointment(record());
  const links = await issuePatientActions(created.id, { now: NOW });

  return { created, links };
}

describe("issuePatientActions", () => {
  test("mints a reschedule link and a cancel link", async () => {
    freshAudit();
    const { links } = await booked();

    expect(links.reschedule.path).toBe(`/reschedule/${links.reschedule.token}`);
    expect(links.cancel.path).toBe(`/reschedule/${links.cancel.token}`);
    expect(links.reschedule.token).not.toBe(links.cancel.token);
    expect(links.reschedule.expiresAt).toEqual(links.cancel.expiresAt);
  });

  test("records a grant for each link, in the store rather than in the token", async () => {
    freshAudit();
    const created = await createAppointment(record());
    const links = await issuePatientActions(created.id, { now: NOW });

    const reschedule = openActionToken(links.reschedule.token, NOW)!;
    const cancel = openActionToken(links.cancel.token, NOW)!;

    expect(await getAppointmentStore().getActionGrant(reschedule.jti)).toMatchObject({
      appointmentId: created.id,
      actions: ["reschedule"],
      withdrawnAt: null,
    });
    expect(await getAppointmentStore().getActionGrant(cancel.jti)).toMatchObject({
      actions: ["cancel"],
    });
  });

  test("each link carries only the capability it is for", async () => {
    // Narrow at mint time rather than narrowly-checked at use time, so there is
    // nothing to get wrong later.
    freshAudit();
    const { links } = await booked();

    expect(openActionToken(links.reschedule.token, NOW)!.capabilities).toEqual(["reschedule"]);
    expect(openActionToken(links.cancel.token, NOW)!.capabilities).toEqual(["cancel"]);
  });

  test("expires in a week, so a link in an inbox goes inert", async () => {
    freshAudit();
    const { links } = await booked();

    const week = 7 * 24 * 60 * 60_000;
    expect(links.reschedule.expiresAt.getTime() - NOW).toBe(week);
  });

  test("never puts a part of the record in the link", async () => {
    freshAudit();
    const created = await createAppointment(
      record({ firstName: "Ada", additionalInfo: "chest pain" }),
    );
    const links = await issuePatientActions(created.id, { now: NOW });

    for (const leak of ["Ada", "chest pain", "patient@example.test", "1985-12-10", "+1 555 0100"]) {
      expect(links.reschedule.token).not.toContain(leak);
      expect(links.cancel.token).not.toContain(leak);
    }
  });

  test("hands out no link when the store cannot record the grant", async () => {
    // Fail closed, for the same reason a booking fails when the trail cannot be
    // written: a URL that looks live and authorises nothing is worse than an
    // exception, because it goes into a patient's inbox and fails later, in
    // front of them, as "not found".
    freshAudit();
    const created = await createAppointment(record());
    // Shadowed on the instance rather than spread onto a literal: a class's
    // methods live on its prototype, so `{ ...new InMemoryAppointmentStore() }` is
    // an object with no `create` on it at all.
    const broken = new InMemoryAppointmentStore();
    broken.issueActionGrant = async () => {
      throw new Error("the database could not be reached");
    };
    setAppointmentStore(broken);

    await expect(issuePatientActions(created.id, { now: NOW })).rejects.toThrow(
      /could not be reached/,
    );
  });
});

describe("spendPatientAction", () => {
  test("accepts a live link and hands back the appointment", async () => {
    freshAudit();
    const { created, links } = await booked();

    const spent = await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });

    expect(spent.ok).toBe(true);
    expect(spent.ok && spent.appointment.id).toBe(created.id);
  });

  test("accepts a link just inside its window and refuses one just outside", async () => {
    freshAudit();
    const { links } = await booked();
    const expiry = links.reschedule.expiresAt.getTime();

    expect(
      (await spendPatientAction(links.reschedule.token, "reschedule", { now: expiry - 1 })).ok,
    ).toBe(true);

    const second = await booked();
    expect(
      (await spendPatientAction(second.links.reschedule.token, "reschedule", { now: expiry })).ok,
    ).toBe(false);
  });

  test("a second request carrying the same link gets nothing", async () => {
    // The patient pressed the button twice, or the network retried. One of them
    // may act on it.
    freshAudit();
    const { links } = await booked();

    expect((await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW })).ok).toBe(
      true,
    );

    const second = await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });

    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  test("concurrent requests on one link: exactly one wins", async () => {
    freshAudit();
    const { links } = await booked();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        spendPatientAction(links.reschedule.token, "reschedule", { now: NOW }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });

  test("refuses a link that asks for something it does not grant", async () => {
    // A reschedule link is not a cancel link, and it is not a master key.
    freshAudit();
    const { links } = await booked();

    expect(await spendPatientAction(links.reschedule.token, "cancel", { now: NOW })).toEqual({
      ok: false,
      reason: "not_permitted",
    });
  });

  test.each([
    ["an empty string", ""],
    ["a random string", "not-a-token"],
    ["a tracking reference", "2.00000000-0000-4000-8000-000000000000"],
    ["a tampered token", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("refuses %s as link_unusable, without saying which", async (_label, token) => {
    // Everything cryptographic collapses to one reason. Distinguishing them tells
    // a prober what they managed and helps nobody else.
    freshAudit();

    expect(await spendPatientAction(token, "reschedule", { now: NOW })).toEqual({
      ok: false,
      reason: "link_unusable",
    });
  });

  test("refuses a link whose grant was never recorded", async () => {
    // The distinction that the store exists for: a token sealed under a key on a
    // developer's laptop decrypts perfectly and is still not a grant.
    freshAudit();
    const { links } = await booked();
    const claims = openActionToken(links.reschedule.token, NOW)!;

    setAppointmentStore({
      ...getAppointmentStore(),
      spendActionGrant: async () => undefined,
    } as never);

    expect(await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW })).toEqual({
      ok: false,
      reason: "already_used",
    });
    expect(claims.jti).toBeTruthy();
  });

  test("refuses to act on a cancelled appointment", async () => {
    // The second line of the revocation. `cancelAppointment` withdraws the grants,
    // so in practice this is unreachable -- which is the point of asserting it:
    // if the withdrawal ever stopped working, this is what would be left.
    freshAudit();
    const { created, links } = await booked();
    await updateAppointment(created.id, { status: "cancelled" });

    expect(await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW })).toEqual({
      ok: false,
      reason: "not_active",
    });
  });

  test("refuses to act on a completed appointment", async () => {
    freshAudit();
    const { created, links } = await booked();
    await updateAppointment(created.id, { status: "completed" });

    expect(await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW })).toEqual({
      ok: false,
      reason: "not_active",
    });
  });

  test("cancelling an appointment withdraws every link to it", async () => {
    // The invariant, and the reason a patient cannot cancel through one link and
    // reschedule through an old copy of another. Without it the clinic is
    // holding a record that is cancelled and booked at the same time.
    freshAudit();
    const { links } = await booked();

    const stored = getAppointmentStore();
    const claims = openActionToken(links.reschedule.token, NOW)!;

    await cancelAppointment(claims.appointmentId, AUDIT_ACTORS.patientLink);

    expect((await stored.getActionGrant(claims.jti))!.withdrawnAt).not.toBeNull();
    expect(await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW })).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  test("cancelling one appointment leaves another patient's links alone", async () => {
    freshAudit();
    const mine = await booked();
    const theirs = await booked();

    await cancelAppointment(mine.created.id, AUDIT_ACTORS.patientLink);

    expect(
      (await spendPatientAction(theirs.links.reschedule.token, "reschedule", { now: NOW })).ok,
    ).toBe(true);
  });
});

describe("rescheduleAppointment", () => {
  test("writes the new time onto the record and confirms it", async () => {
    freshAudit();
    const { created, links } = await booked();
    const spent = await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });
    if (!spent.ok) throw new Error("the link should have been accepted");

    const updated = await rescheduleAppointment(spent.appointment, "2026-10-02T14:00");

    expect(updated!.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
    expect(updated!.status).toBe("confirmed");
    // Everything else about the patient is untouched.
    expect(updated!.patientInfo.firstName).toBe(created.patientInfo.firstName);
    expect(updated!.id).toBe(created.id);
  });

  test("is attributed to the patient, not to the system", async () => {
    // The difference #59 buys in the trail: a write by whoever holds a
    // management link, distinguishable from one the pipeline made.
    freshAudit();
    const { links } = await booked();
    const spent = await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });
    if (!spent.ok) throw new Error("the link should have been accepted");

    await rescheduleAppointment(spent.appointment, "2026-10-02T14:00");

    const updates = (await readAuditLog()).filter((e) => e.action === "APPOINTMENT_UPDATED");
    expect(updates.at(-1)!.actor).toBe(AUDIT_ACTORS.patientLink);
    expect(updates.at(-1)!.details?.reason).toBe("patient_link");
  });
});

describe("the trail of a patient action", () => {
  test("a successful action reads the record and changes it, both attributed", async () => {
    freshAudit();
    const { created, links } = await booked();
    const spent = await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });
    if (!spent.ok) throw new Error("the link should have been accepted");
    await rescheduleAppointment(spent.appointment, "2026-10-02T14:00");

    const trail = await readAuditLog();
    expect(trail.every((entry) => entry.resource === `appointment:${created.id}`)).toBe(true);

    const reads = trail.filter((entry) => entry.action === "PHI_READ");
    expect(reads).toHaveLength(1);
    // `patient:link`, not `link-bearer`: this is a write through a management
    // link, and the tracking page is a read through a different one.
    expect(reads[0].actor).toBe(AUDIT_ACTORS.patientLink);

    expect(await verifyAuditChain()).toBe(true);
  });

  test("a refusal is in the trail too", async () => {
    // Most requests bearing a management link are refusals. A trail with only
    // the successes answers "who cancelled this?" with no account of the twenty
    // failed attempts on the same record that week.
    freshAudit();
    await spendPatientAction("not-a-token", "reschedule", { now: NOW });

    const refusals = (await readAuditLog()).filter(
      (entry) => entry.action === "APPOINTMENT_ACTION_REFUSED",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe(AUDIT_ACTORS.patientLink);
    expect(refusals[0].details?.reason).toBe("patient_link");
  });

  test("a reused link is recorded as a refusal, not as a second change", async () => {
    freshAudit();
    const { links } = await booked();
    await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });
    await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });

    const trail = await readAuditLog();
    expect(trail.filter((e) => e.action === "APPOINTMENT_UPDATED")).toHaveLength(0);
    expect(trail.filter((e) => e.action === "APPOINTMENT_ACTION_REFUSED")).toHaveLength(1);
  });

  test("no entry in a patient-action sequence carries a field of the record", async () => {
    freshAudit();
    const created = await createAppointment(
      record({ firstName: "Ada", additionalInfo: "chest pain", phone: "+1 555 0100" }),
    );
    const links = await issuePatientActions(created.id, { now: NOW });
    await spendPatientAction(links.reschedule.token, "reschedule", { now: NOW });
    await spendPatientAction(links.cancel.token, "cancel", { now: NOW });

    const serialised = JSON.stringify(await readAuditLog());
    for (const leak of ["Ada", "chest pain", "+1 555 0100", "1985-12-10", "REDACTED"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  test("the refusal reason is one of the closed set, and it is in the audit vocabulary", async () => {
    // Two closed sets, and the refusal reason travels between them, so a
    // misspelling would be a type error rather than a trail that cannot be
    // verified against the closed set `assertAuditDetails` enforces.
    expect(AUDIT_REASONS).toContain("patient_link");
  });
});
