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
  CLINIC_MAX_OFFSET,
  CLINIC_PAGE_SIZE,
  InMemoryAppointmentStore,
  PostgresAppointmentStore,
  appendTranscript,
  cancelAppointment,
  claimReminder,
  createAppointment,
  getAppointment,
  getAppointmentStore,
  isDurableAppointmentStore,
  issuePatientActions,
  listClinicSchedule,
  listReminderCandidates,
  readTranscript,
  rescheduleAppointment,
  setAppointmentStore,
  spendPatientAction,
  updateAppointment,
} from "./appointments";
import type { TranscriptLine } from "./appointments";
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

/*
 * ---------------------------------------------------------------------------
 * The reminder job's two questions (#67)
 * ---------------------------------------------------------------------------
 *
 * `runReminderPass` in ./reminders.test is the job; this is what it asks the
 * store, and the assertions here are about the two properties the whole design
 * rests on -- cancelled appointments never appear as candidates, and a claim is
 * exactly one.
 */

describe("listReminderCandidates", () => {
  test("never offers a cancelled or completed appointment", async () => {
    freshAudit();
    await createAppointment(record());
    const cancelled = await createAppointment(record());
    const completed = await createAppointment(record());
    await updateAppointment(cancelled.id, { status: "cancelled" });
    await updateAppointment(completed.id, { status: "completed" });

    const { appointments } = await listReminderCandidates();

    expect(appointments).toHaveLength(1);
    expect(appointments[0].status).toBe("scheduled");
  });

  test("says so when there were more than one run will look at", async () => {
    // A capped scan that looks like a complete one produces a job that quietly
    // stops reminding anybody past the cap, and the only symptom is silence.
    freshAudit();
    const store = new InMemoryAppointmentStore();
    setAppointmentStore(store);
    for (let index = 0; index < 5; index += 1) {
      await createAppointment(record());
    }

    const complete = await listReminderCandidates(10);
    expect(complete.truncated).toBe(false);
    expect(complete.appointments).toHaveLength(5);

    const capped = await listReminderCandidates(3);
    expect(capped.truncated).toBe(true);
    expect(capped.appointments).toHaveLength(3);
  });

  test("reads the records, so the caller can see a time that is encrypted at rest", async () => {
    freshAudit();
    const created = await createAppointment(record({ appointmentDateTime: "2026-10-02T14:00" }));

    const { appointments } = await listReminderCandidates();

    // The store cannot filter on this in SQL, which is why the job decrypts.
    expect(appointments[0].patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
    expect(appointments[0].id).toBe(created.id);
  });
});

describe("claimReminder", () => {
  test("is won once per appointment, whoever asks", async () => {
    // The claim does not include the window, and that is deliberate: with a window
    // wider than the schedule, two consecutive runs overlap and both will decide
    // to remind. One claim per appointment is what makes that overlap safe.
    freshAudit();
    const created = await createAppointment(record());

    expect(await claimReminder(created.id)).toBe(true);
    expect(await claimReminder(created.id)).toBe(false);
  });

  test("is per appointment, so a clinic full of patients still gets a full round", async () => {
    freshAudit();
    const first = await createAppointment(record());
    const second = await createAppointment(record());

    expect(await claimReminder(first.id)).toBe(true);
    expect(await claimReminder(second.id)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The clinic dashboard (#63)
 * ---------------------------------------------------------------------------
 *
 * The only reader in this application that shows a clinician everything the
 * record holds. `/track` is the opposite: a link anyone might forward, rendering
 * four fields. Both exist now, and the tests below are as much about the
 * difference as about the feature -- the boundary between those two surfaces is
 * the security property of this feature, and it is a property of the code
 * rather than of a policy document.
 *
 * What is asserted here and not here: these are the store questions (which
 * records, how many, in what order) and the trail. The projection into the shape
 * a clinician reads is ./clinic/schedule-view.test.ts, and the route that gates
 * it is src/app/dashboard/route.test.ts.
 */

describe("listClinicSchedule", () => {
  /**
   * n appointments, written straight to the store a minute apart.
   *
   * Straight to the store rather than through `createAppointment`, because the
   * clock would decide the order under test: two records created inside the same
   * millisecond have no defined booking order, and a test whose expected order
   * depends on how fast the machine runs is a test that fails on a busy one.
   */
  async function booked(count: number) {
    const store = new InMemoryAppointmentStore();
    setAppointmentStore(store);

    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const createdAt = new Date(Date.UTC(2026, 8, 1, 9, index));
      const id = `a${String(index).padStart(2, "0")}`;
      await store.create({
        id,
        patientInfo: record(),
        createdAt,
        updatedAt: createdAt,
        conversationEnded: false,
        status: "scheduled",
      });
      ids.push(id);
    }
    return ids;
  }

  test("never offers a cancelled or completed appointment", async () => {
    // The clinic is a working list. An appointment on it that the patient
    // cancelled on Sunday is not work, and a dashboard that shows it next to the
    // live ones is a dashboard nobody trusts.
    freshAudit();
    const live = await createAppointment(record());
    const cancelled = await createAppointment(record());
    const completed = await createAppointment(record());
    await updateAppointment(cancelled.id, { status: "cancelled" });
    await updateAppointment(completed.id, { status: "completed" });

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi);

    expect(page.appointments.map((entry) => entry.id)).toEqual([live.id]);
  });

  test("shows a bounded page rather than the whole clinic", async () => {
    // The requirement of #63 and the reason `listPage` exists. A dashboard that
    // loads everything is a page that decrypts every patient record in the
    // building to render the twenty a clinician is looking at.
    freshAudit();
    await booked(CLINIC_PAGE_SIZE + 15);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi);

    expect(page.appointments).toHaveLength(CLINIC_PAGE_SIZE);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).toBe(CLINIC_PAGE_SIZE);
  });

  test("says so when the page is the whole clinic", async () => {
    freshAudit();
    await booked(3);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi);

    expect(page.appointments).toHaveLength(3);
    expect(page.truncated).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  test("pages without repeating or skipping a record", async () => {
    // The whole point of the total order in `listPage`. Page two has to start
    // where page one stopped, or a clinician reading a day's list sees a patient
    // twice and another one disappear.
    freshAudit();
    const ids = await booked(5);

    const first = await listClinicSchedule(AUDIT_ACTORS.internalApi, { limit: 2 });
    const second = await listClinicSchedule(AUDIT_ACTORS.internalApi, {
      limit: 2,
      offset: first.nextOffset!,
    });
    const third = await listClinicSchedule(AUDIT_ACTORS.internalApi, {
      limit: 2,
      offset: second.nextOffset!,
    });

    const seen = [first, second, third].flatMap((page) => page.appointments.map((a) => a.id));
    expect(seen).toEqual(ids);
  });

  test("clamps a limit above the page size, so the query string cannot ask for everything", async () => {
    freshAudit();
    await booked(CLINIC_PAGE_SIZE + 5);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi, { limit: 10_000 });

    expect(page.appointments).toHaveLength(CLINIC_PAGE_SIZE);
    expect(page.limit).toBe(CLINIC_PAGE_SIZE);
  });

  test("stops paging at the ceiling, and admits the list goes on", async () => {
    // A deep offset in Postgres is a scan that discards everything before it, and
    // this application is not going to grow an index to make a dashboard's
    // thousandth page fast. The ceiling is reported rather than absorbed: a
    // dashboard that silently ends at record 200 looks exactly like a clinic
    // whose last booking was this morning.
    freshAudit();
    await booked(3);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi, {
      offset: CLINIC_MAX_OFFSET + 5_000,
    });

    expect(page.offset + page.limit).toBeLessThanOrEqual(CLINIC_MAX_OFFSET);
    expect(page.truncated).toBe(true);
  });

  test("the last page it will serve offers no next page, rather than looping", async () => {
    // A Next link to an offset this function clamps back to the current page is a
    // pager that shows the same twenty patients for ever. The clinic is told the
    // list goes on; it is not sent round again.
    freshAudit();
    await booked(3);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi, {
      offset: CLINIC_MAX_OFFSET - CLINIC_PAGE_SIZE,
    });

    expect(page.nextOffset).toBeNull();
    expect(page.truncated).toBe(true);
  });

  test("never points at a page it would refuse to serve", async () => {
    freshAudit();
    await booked(3);

    for (const offset of [0, 40, CLINIC_MAX_OFFSET - CLINIC_PAGE_SIZE, CLINIC_MAX_OFFSET]) {
      const page = await listClinicSchedule(AUDIT_ACTORS.internalApi, { offset });
      if (page.nextOffset === null) continue;

      const next = await listClinicSchedule(AUDIT_ACTORS.internalApi, {
        offset: page.nextOffset,
      });
      expect(next.offset).toBe(page.nextOffset);
    }
  });

  test("reads the records, because the time a clinician needs is encrypted at rest", async () => {
    freshAudit();
    const created = await createAppointment(record({ appointmentDateTime: "2026-10-02T14:00" }));

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi);

    expect(page.appointments[0].patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
    expect(page.appointments[0].id).toBe(created.id);
  });

  test("records every record it opened, as a dashboard read of its own", async () => {
    freshAudit();
    await booked(3);

    await listClinicSchedule(AUDIT_ACTORS.internalApi);

    const entries = await readAuditLog();
    const reads = entries.filter((entry) => entry.action === "CLINIC_SCHEDULE_READ");
    // One per record, because "who read this patient's record" is a question with
    // one record in it -- and filing twenty of them as the webhook's
    // `internal_api` reads would answer it with no.
    expect(reads).toHaveLength(3);
    expect(reads.every((entry) => entry.actor === AUDIT_ACTORS.internalApi)).toBe(true);
    expect(reads.every((entry) => entry.details?.reason === "clinician_dashboard")).toBe(true);
    expect(reads.every((entry) => entry.resource.startsWith("appointment:"))).toBe(true);
  });

  test("the trail says the surface and not a person, because there is no person to name", async () => {
    // This application has no clinician accounts. The actor is whoever holds the
    // shared secret, which is a role and not an identity, and the audit entry
    // added for the dashboard does not pretend otherwise: the details are the
    // closed set's two fields, and neither of them could hold a name.
    freshAudit();
    const appointment = await createAppointment(record({ firstName: "REDACTED" }));

    await listClinicSchedule(AUDIT_ACTORS.internalApi);

    const reads = (await readAuditLog()).filter((e) => e.action === "CLINIC_SCHEDULE_READ");
    expect(reads[0].actor).toBe(AUDIT_ACTORS.internalApi);
    expect(reads[0].resource).toBe(`appointment:${appointment.id}`);
    expect(reads[0].details).toEqual({ reason: "clinician_dashboard", status: "scheduled" });
    expect(JSON.stringify(reads)).not.toContain("REDACTED");
  });

  test("hands back no records at all when the trail cannot be written", async () => {
    // The same fail-closed posture as `getAppointment`, and it matters more here:
    // a dashboard is a bulk read, so the failure being guarded is a bulk
    // disclosure. A caller that caught the error and re-read without auditing
    // would have every record in the building.
    freshAudit();
    await booked(3);
    setAuditLogStore({
      async append() {
        throw new Error("the audit store is down");
      },
      async read() {
        return [];
      },
      async verify() {
        return false;
      },
    });

    await expect(listClinicSchedule(AUDIT_ACTORS.internalApi)).rejects.toThrow(
      /audit store is down/,
    );
  });

  test("a page past the end is empty, and reads nothing", async () => {
    freshAudit();
    await booked(1);

    const page = await listClinicSchedule(AUDIT_ACTORS.internalApi, { offset: 500 });

    expect(page.appointments).toEqual([]);
    // An empty page is not an access. Recording one would put a read of a
    // patient's record in the trail for a request that never opened one, which is
    // the same sin as logging a refused attempt as a change.
    const reads = (await readAuditLog()).filter((e) => e.action === "CLINIC_SCHEDULE_READ");
    expect(reads).toEqual([]);
  });
});

/** A trail that is down, which is what a durable store being unreachable looks like. */
function brokenTrail() {
  return {
    async append(): Promise<never> {
      throw new Error("the trail is unavailable");
    },
    async read() {
      return [];
    },
    async verify() {
      return false;
    },
  };
}

describe("the call transcript", () => {
  function line(overrides: Partial<TranscriptLine> = {}): TranscriptLine {
    return {
      seq: 0,
      role: "patient",
      text: "My left eye has been painful since Tuesday.",
      at: new Date("2026-09-01T10:00:01.000Z"),
      finalized: true,
      ...overrides,
    };
  }

  async function withAppointment(): Promise<{ store: InMemoryAppointmentStore; id: string }> {
    const store = new InMemoryAppointmentStore();
    setAppointmentStore(store);
    const created = await createAppointment(record());
    return { store, id: created.id };
  }

  test("persists a line and reads it back in order", async () => {
    freshAudit();
    const { id } = await withAppointment();

    expect(await appendTranscript(id, [line({ seq: 0 }), line({ seq: 1, role: "receptionist" })])).toBe(2);

    const read = await readTranscript(id, AUDIT_ACTORS.linkBearer);
    expect(read.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(read[0].text).toBe("My left eye has been painful since Tuesday.");
  });

  test("leaves an entry behind for the append, and one for the read", async () => {
    // The reason the audit call is in this file rather than at the call sites: a
    // transcript is PHI, and a surface that reads one and forgets to say so is
    // the failure the whole facade exists to make impossible.
    const trail = freshAudit();
    const { id } = await withAppointment();

    await appendTranscript(id, [line()]);
    await readTranscript(id, AUDIT_ACTORS.linkBearer);

    const entries = await readAuditLog();
    expect(entries.map((entry) => entry.action)).toEqual([
      "APPOINTMENT_CREATED",
      "TRANSCRIPT_APPENDED",
      "PHI_READ",
    ]);
    // Filed as its own resource rather than under the appointment, so "who read
    // this patient's record?" is not answered with a demo session mixed in.
    expect(entries[1].resource).toBe(`transcript:${id}`);
    expect(entries[2].resource).toBe(`transcript:${id}`);
    expect(entries[2].actor).toBe(AUDIT_ACTORS.linkBearer);
    expect(verifyAuditChain()).resolves.toBe(true);
  });

  test("does not log an append for a batch with nothing in it", async () => {
    // A trail entry for a write that did not happen is the kind of thing that
    // makes a trail untrustworthy, and the browser sends an empty batch every
    // time it flushes with nothing new.
    const trail = freshAudit();
    const { id } = await withAppointment();

    expect(await appendTranscript(id, [])).toBe(0);

    const entries = await readAuditLog();
    expect(entries.map((entry) => entry.action)).toEqual(["APPOINTMENT_CREATED"]);
  });

  test("refuses a line the store could not hold, before anything is written", async () => {
    freshAudit();
    const { store, id } = await withAppointment();

    await expect(appendTranscript(id, [line({ role: "operator" as TranscriptLine["role"] })])).rejects.toThrow(
      /role/i,
    );
    expect(store.transcriptCount).toBe(0);
  });

  test("stores nothing, and says so, for an appointment that is not there", async () => {
    freshAudit();
    await withAppointment();

    expect(await appendTranscript("not-an-appointment", [line()])).toBe(0);
  });

  test("a read that cannot be recorded does not hand back the transcript", async () => {
    // The same fail-closed posture as `getAppointment`, and for the same reason:
    // the data is loaded into this process and no further -- not rendered, not
    // exported, not logged. This is a patient's account of their own symptoms.
    const trail = freshAudit();
    const { id } = await withAppointment();
    await appendTranscript(id, [line()]);

    // A trail that cannot be written.
    setAuditLogStore(brokenTrail());

    await expect(readTranscript(id, AUDIT_ACTORS.linkBearer)).rejects.toThrow(/unavailable/);
  });

  test("an append that cannot be recorded does not store the line", async () => {
    // The write side of the same posture: an access that cannot be logged must
    // not happen at all, so the entry goes in first and the data does not.
    freshAudit();
    const { store, id } = await withAppointment();

    setAuditLogStore(brokenTrail());

    await expect(appendTranscript(id, [line()])).rejects.toThrow(/unavailable/);
    expect(store.transcriptCount).toBe(0);
  });

  test("an empty transcript is an empty array, not an error", async () => {
    // A patient whose call never got started has a booking and no conversation.
    // That is a real state, and the replay page has to render it rather than
    // crash.
    freshAudit();
    const { id } = await withAppointment();

    expect(await readTranscript(id, AUDIT_ACTORS.linkBearer)).toEqual([]);
  });

  test("passes the cap through to the store", async () => {
    freshAudit();
    const { id } = await withAppointment();
    for (let seq = 0; seq < 5; seq += 1) await appendTranscript(id, [line({ seq })]);

    const read = await readTranscript(id, AUDIT_ACTORS.linkBearer, { limit: 2 });

    expect(read.map((entry) => entry.seq)).toEqual([3, 4]);
  });
});
