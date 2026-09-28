import { describe, expect, test } from "bun:test";
import { InMemoryAppointmentStore } from "./memory-store";
import {
  REMINDABLE_STATUSES,
  type ActionGrant,
  type Appointment,
  type TranscriptLine,
} from "./store";
import type { AppointmentRecord } from "../validation/intake";

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

function appointment(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const createdAt = new Date("2026-09-01T10:00:00.000Z");
  return {
    id,
    patientInfo: record(),
    createdAt,
    updatedAt: createdAt,
    conversationEnded: false,
    status: "scheduled",
    ...overrides,
  };
}

const EXPIRES = new Date("2026-09-08T10:00:00.000Z");

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

function grant(overrides: Partial<ActionGrant> = {}): ActionGrant {
  return {
    jti: "cap-1",
    appointmentId: "a1",
    actions: ["reschedule", "cancel"],
    expiresAt: EXPIRES,
    withdrawnAt: null,
    ...overrides,
  };
}

describe("InMemoryAppointmentStore", () => {
  test("persists and returns an appointment", async () => {
    const store = new InMemoryAppointmentStore();
    const created = appointment("a1");

    expect(await store.create(created)).toEqual(created);
    expect(await store.get("a1")).toEqual(created);
  });

  test("assigns nothing itself: the id is the caller's", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("chosen-id"));
    expect((await store.get("chosen-id"))?.id).toBe("chosen-id");
  });

  test("returns undefined for an unknown id", async () => {
    const store = new InMemoryAppointmentStore();
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.get("")).toBeUndefined();
  });

  test("hands out copies, not the stored record", async () => {
    // The `Map` returned the live object, so a caller could rewrite the store
    // from two call sites away with no write and no trace.
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));

    const first = await store.get("a1");
    first!.patientInfo.firstName = "Mallory";
    first!.status = "cancelled";
    first!.createdAt.setUTCFullYear(1999);

    const second = await store.get("a1");
    expect(second!.patientInfo.firstName).toBe("Ada");
    expect(second!.status).toBe("scheduled");
    expect(second!.createdAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  test("stores a copy of what it was given", async () => {
    const store = new InMemoryAppointmentStore();
    const created = appointment("a1", { patientInfo: record({ firstName: "Ada" }) });
    await store.create(created);

    created.patientInfo.firstName = "Mallory";

    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Ada");
  });

  test("keeps separate ids apart", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));
    await store.create(appointment("a2", { patientInfo: record({ firstName: "Grace" }) }));

    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Ada");
    expect((await store.get("a2"))!.patientInfo.firstName).toBe("Grace");
  });

  test("replaces the id on a second create with the same id", async () => {
    const store = new InMemoryAppointmentStore();
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));
    await store.create(appointment("a1", { patientInfo: record({ firstName: "Grace" }) }));

    expect(store.size).toBe(1);
    expect((await store.get("a1"))!.patientInfo.firstName).toBe("Grace");
  });

  describe("update", () => {
    test("changes a status and stamps updatedAt", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { status: "confirmed" });

      expect(updated!.status).toBe("confirmed");
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(
        appointment("a1").updatedAt.getTime(),
      );
      expect((await store.get("a1"))!.status).toBe("confirmed");
    });

    test("changes conversationEnded without touching the status", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { conversationEnded: true });

      expect(updated!.conversationEnded).toBe(true);
      expect(updated!.status).toBe("scheduled");
    });

    test("merges into the patient record", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", {
        patientInfo: record({ appointmentDateTime: "2026-10-02T14:00" }),
      });

      expect(updated!.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
      expect(updated!.patientInfo.firstName).toBe("REDACTED");
    });

    test("leaves the identity alone", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", { status: "confirmed" });

      expect(updated!.id).toBe("a1");
      expect(updated!.createdAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    });

    test("an empty patch changes nothing but updatedAt", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const updated = await store.update("a1", {});

      expect(updated!.patientInfo).toEqual(record());
      expect(updated!.status).toBe("scheduled");
    });

    test("returns undefined and stores nothing for an unknown id", async () => {
      const store = new InMemoryAppointmentStore();
      expect(await store.update("missing", { status: "confirmed" })).toBeUndefined();
      expect(store.size).toBe(0);
    });

    test("refuses a status outside the closed set", async () => {
      // A record in a state nothing can compare against is worse than a failed
      // request: every later status lookup silently misses it.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await expect(
        store.update("a1", { status: "CANCELLED" as never }),
      ).rejects.toThrow(/unknown appointment status/);
      expect((await store.get("a1"))!.status).toBe("scheduled");
    });
  });

  describe("cancel", () => {
    test("moves the appointment to cancelled", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const cancelled = await store.cancel("a1");

      expect(cancelled!.status).toBe("cancelled");
      expect((await store.get("a1"))!.status).toBe("cancelled");
    });

    test("is idempotent", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await store.cancel("a1");
      const again = await store.cancel("a1");

      expect(again!.status).toBe("cancelled");
    });

    test("returns undefined for an unknown id", async () => {
      const store = new InMemoryAppointmentStore();
      expect(await store.cancel("missing")).toBeUndefined();
    });

    test("keeps the patient record", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));

      expect((await store.cancel("a1"))!.patientInfo.firstName).toBe("Ada");
    });
  });

  // The capability grants of #59. These are what make a patient link revocable,
  // and the in-memory store is where the semantics are easiest to read: the
  // durable one has to express the same three rules in SQL, and
  // ./postgres-store.test is where those statements are asserted.
  describe("action grants", () => {
    test("remembers a grant and hands it back", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(await store.getActionGrant("cap-1")).toEqual(grant());
    });

    test("returns undefined for a jti that was never issued", async () => {
      // Which is how a token sealed under a stolen key is caught: authentic, and
      // with nothing behind it.
      const store = new InMemoryAppointmentStore();

      expect(await store.getActionGrant("cap-1")).toBeUndefined();
    });

    test("issuing the same jti twice is one live grant, not two", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"));

      await store.issueActionGrant(grant());

      expect(store.grantCount).toBe(1);
      // The re-issue did not un-spend it, which an upsert would have done.
      expect(await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"))).toBeUndefined();
    });

    test("hands out copies, so a caller cannot withdraw a grant in place", async () => {
      const store = new InMemoryAppointmentStore();
      const issued = await store.issueActionGrant(grant());

      issued.withdrawnAt = new Date("2000-01-01T00:00:00.000Z");
      issued.actions.push("cancel", "cancel");

      const stored = await store.getActionGrant("cap-1");
      expect(stored!.withdrawnAt).toBeNull();
      expect(stored!.actions).toEqual(["reschedule", "cancel"]);
    });

    test("spends a live grant once, and returns it marked", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      const spent = await store.spendActionGrant("cap-1", now);

      expect(spent!.withdrawnAt).toEqual(now);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(now);
    });

    test("a second spend of the same link gets nothing", async () => {
      // The patient clicked once, the button was pressed twice, the network
      // retried. Exactly one of them may act on it.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.spendActionGrant("cap-1", now)).toBeDefined();
      expect(await store.spendActionGrant("cap-1", now)).toBeUndefined();
    });

    test("concurrent spends of one link: exactly one wins", async () => {
      // Without the check and the write being adjacent, both would read a live
      // grant and both would act.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => store.spendActionGrant("cap-1", now)),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    test("spends a grant one millisecond before it expires", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(
        await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() - 1)),
      ).toBeDefined();
    });

    test("will not spend one that has already expired", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());

      expect(await store.spendActionGrant("cap-1", EXPIRES)).toBeUndefined();
      expect(
        await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() + 1_000)),
      ).toBeUndefined();
      // Expiry is a refusal, not a withdrawal: the row is untouched, so a
      // clock that disagrees would still be given the same answer.
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toBeNull();
    });

    test("will not spend one that was never issued", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.spendActionGrant("cap-1", new Date(EXPIRES.getTime() - 1))).toBeUndefined();
    });

    test("withdraws every live grant for an appointment, and counts them", async () => {
      // What a cancellation does, and the reason a patient cannot cancel through
      // one link and then reschedule through an old copy of another.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant({ jti: "cap-1" }));
      await store.issueActionGrant(grant({ jti: "cap-2" }));
      await store.issueActionGrant(grant({ jti: "other", appointmentId: "a2" }));
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.withdrawActionGrants("a1", now)).toBe(2);

      expect(await store.spendActionGrant("cap-1", now)).toBeUndefined();
      expect(await store.spendActionGrant("cap-2", now)).toBeUndefined();
      // Another patient's link is untouched.
      expect(await store.spendActionGrant("other", now)).toBeDefined();
    });

    test("withdrawing twice counts once and changes nothing the second time", async () => {
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      const now = new Date("2026-09-02T10:00:00.000Z");

      expect(await store.withdrawActionGrants("a1", now)).toBe(1);
      expect(await store.withdrawActionGrants("a1", now)).toBe(0);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(now);
    });

    test("withdrawing for an appointment with no grants is zero, not an error", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.withdrawActionGrants("nobody", new Date())).toBe(0);
    });

    test("keeps a spent grant reportable as spent", async () => {
      // Withdrawal is not deletion: a capability that has been used should still
      // be findable as used, which is what makes the trail worth having.
      const store = new InMemoryAppointmentStore();
      await store.issueActionGrant(grant());
      await store.spendActionGrant("cap-1", new Date("2026-09-02T10:00:00.000Z"));
      await store.withdrawActionGrants("a1", new Date("2026-09-03T10:00:00.000Z"));

      expect(store.grantCount).toBe(1);
      expect((await store.getActionGrant("cap-1"))!.withdrawnAt).toEqual(
        new Date("2026-09-02T10:00:00.000Z"),
      );
    });
  });

  // The reminder job's two needs (#67): the candidate records, and a way to say
  // "already done" that two overlapping runs cannot both say no to.
  describe("listByStatus", () => {
    test("returns only the statuses asked for", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { status: "scheduled" }));
      await store.create(appointment("a2", { status: "confirmed" }));
      await store.create(appointment("a3", { status: "cancelled" }));
      await store.create(appointment("a4", { status: "completed" }));

      const listed = await store.listByStatus(REMINDABLE_STATUSES, 100);

      expect(listed.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    });

    test("excludes a cancelled appointment, which is the whole point", async () => {
      // Telling somebody to turn up for something they cancelled is worse than
      // telling them nothing.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { status: "cancelled" }));

      expect(await store.listByStatus(REMINDABLE_STATUSES, 100)).toEqual([]);
    });

    test("orders oldest first, and a truncated result is a prefix", async () => {
      // Not ordered by appointment time -- that is encrypted and incomparable
      // here -- but ordered at all, so a capped result is the beginning of the
      // list rather than whatever the Map happened to iterate.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("new", { createdAt: new Date("2026-09-03T00:00:00Z") }));
      await store.create(appointment("old", { createdAt: new Date("2026-09-01T00:00:00Z") }));
      await store.create(appointment("mid", { createdAt: new Date("2026-09-02T00:00:00Z") }));

      expect((await store.listByStatus(REMINDABLE_STATUSES, 100)).map((a) => a.id)).toEqual([
        "old",
        "mid",
        "new",
      ]);
      expect((await store.listByStatus(REMINDABLE_STATUSES, 2)).map((a) => a.id)).toEqual([
        "old",
        "mid",
      ]);
    });

    test("a limit of zero returns nothing rather than everything", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      expect(await store.listByStatus(REMINDABLE_STATUSES, 0)).toEqual([]);
      expect(await store.listByStatus(REMINDABLE_STATUSES, -5)).toEqual([]);
    });

    test("hands out copies", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { status: "scheduled" }));

      const [first] = await store.listByStatus(REMINDABLE_STATUSES, 10);
      first!.status = "cancelled";
      first!.patientInfo.firstName = "Mallory";

      expect((await store.get("a1"))!.status).toBe("scheduled");
      expect((await store.get("a1"))!.patientInfo.firstName).toBe("REDACTED");
    });
  });

  // The clinic dashboard's query (#63). Same window as `listByStatus` and the
  // same reason it cannot be by appointment time -- the time is encrypted -- but
  // with a page on it, because a clinic has more appointments than fit on one
  // screen and a method that returns the whole list is a method that eventually
  // will return the whole list.
  describe("listPage", () => {
    /** A minute apart, so `createdAt` order is unambiguous. */
    function at(minute: number) {
      return new Date(Date.UTC(2026, 8, 1, 10, minute));
    }

    async function seeded() {
      const store = new InMemoryAppointmentStore();
      // Inserted out of order on purpose: the method's job is to order, not to
      // report whatever the Map happened to iterate.
      await store.create(appointment("third", { createdAt: at(3) }));
      await store.create(appointment("first", { createdAt: at(1) }));
      await store.create(appointment("second", { createdAt: at(2) }));
      await store.create(appointment("cancelled", { createdAt: at(0), status: "cancelled" }));
      return store;
    }

    test("returns the window at an offset, oldest booking first", async () => {
      const store = await seeded();

      expect((await store.listPage(REMINDABLE_STATUSES, 2, 0)).map((a) => a.id)).toEqual([
        "first",
        "second",
      ]);
      expect((await store.listPage(REMINDABLE_STATUSES, 2, 2)).map((a) => a.id)).toEqual([
        "third",
      ]);
    });

    test("excludes a cancelled appointment, which is the whole point", async () => {
      const store = await seeded();

      // `cancelled` was booked first of all, so a status leak would be the very
      // first row a clinic saw.
      expect((await store.listPage(REMINDABLE_STATUSES, 10, 0))[0]!.id).toBe("first");
    });

    test("breaks a tie on created_at, so one page boundary is one row", async () => {
      // Offset paging over an order that is not total is a pagination scheme
      // that skips and repeats rows: two appointments created in the same
      // millisecond have no defined order, so the second page can start with a
      // row the first page already showed.
      const store = new InMemoryAppointmentStore();
      const same = at(5);
      await store.create(appointment("b", { createdAt: same }));
      await store.create(appointment("a", { createdAt: same }));

      expect((await store.listPage(REMINDABLE_STATUSES, 1, 0)).map((a) => a.id)).toEqual(["a"]);
      expect((await store.listPage(REMINDABLE_STATUSES, 1, 1)).map((a) => a.id)).toEqual(["b"]);
    });

    test("an offset past the end is an empty page, not an error", async () => {
      const store = await seeded();

      expect(await store.listPage(REMINDABLE_STATUSES, 20, 99)).toEqual([]);
    });

    test("clamps a negative or fractional page rather than returning everything", async () => {
      const store = await seeded();

      expect(await store.listPage(REMINDABLE_STATUSES, -5, 0)).toEqual([]);
      // A negative offset must not be a negative array index, which in
      // JavaScript is counted from the end of the list.
      expect((await store.listPage(REMINDABLE_STATUSES, 1, -1)).map((a) => a.id)).toEqual([
        "first",
      ]);
    });

    test("hands out copies", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1", { patientInfo: record({ firstName: "Ada" }) }));

      const [first] = await store.listPage(REMINDABLE_STATUSES, 10, 0);
      first!.patientInfo.firstName = "Mallory";

      expect((await store.get("a1"))!.patientInfo.firstName).toBe("Ada");
    });
  });

  describe("claimOnce", () => {
    test("the first caller wins and the second does not", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(true);
      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(false);
    });

    test("concurrent claims of one key: exactly one wins", async () => {
      // Two cron invocations overlapping a window boundary -- a retry, a redeploy
      // mid-run, a platform double-fire -- would both read "not yet sent" and both
      // send. The claim is the thing that stops it.
      const store = new InMemoryAppointmentStore();

      const outcomes = await Promise.all(
        Array.from({ length: 16 }, () => store.claimOnce("reminder", "a1:2026-09-02")),
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
    });

    test("different keys are different claims", async () => {
      const store = new InMemoryAppointmentStore();

      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(true);
      expect(await store.claimOnce("reminder", "a2:2026-09-02")).toBe(true);
      expect(await store.claimOnce("reminder", "a1:2026-09-03")).toBe(true);
    });

    test("the same key under another scope is another claim", async () => {
      // Scoping is what stops two unrelated jobs from competing for one namespace.
      const store = new InMemoryAppointmentStore();

      expect(await store.claimOnce("reminder", "shared")).toBe(true);
      expect(await store.claimOnce("something-else", "shared")).toBe(true);
    });

    test("a claim is never released", async () => {
      // A reminder that failed should not be retried by the same window. A caller
      // that wants a different answer asks with a different key.
      const store = new InMemoryAppointmentStore();
      await store.claimOnce("reminder", "a1:2026-09-02");

      expect(await store.claimOnce("reminder", "a1:2026-09-02")).toBe(false);
      expect(store.claimCount).toBe(1);
    });
  });

  describe("appendTranscript", () => {
    test("appends a line to an appointment that exists", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      expect(await store.appendTranscript("a1", [line()])).toBe(1);
      expect(await store.getTranscript("a1")).toEqual([line()]);
    });

    test("refuses to write against an appointment that is not there", async () => {
      // Zero rather than a throw, and the reason is the same as `claimOnce`'s
      // boolean rather than an exception: a write for a record nobody has has
      // nothing to store, and the caller above it is the only thing that can
      // turn that into a 404. Inventing an orphan transcript would be a patient
      // record with no appointment behind it.
      const store = new InMemoryAppointmentStore();
      expect(await store.appendTranscript("missing", [line()])).toBe(0);
    });

    test("an empty batch is a no-op, not a write", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      expect(await store.appendTranscript("a1", [])).toBe(0);
      expect(await store.getTranscript("a1")).toEqual([]);
    });

    test("returns the lines in seq order, however they arrived", async () => {
      // The writer batches and batches interleave: a line that was streaming for
      // four seconds finalises after a shorter line from the other agent. Order
      // is the caller's `seq`, not the order the writes landed in, because the
      // conversation has an order and the network does not.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await store.appendTranscript("a1", [line({ seq: 2, text: "third" })]);
      await store.appendTranscript("a1", [line({ seq: 0, text: "first" })]);
      await store.appendTranscript("a1", [line({ seq: 1, text: "second" })]);

      expect((await store.getTranscript("a1")).map((entry) => entry.text)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    test("a second write for the same seq corrects the line, not the transcript", async () => {
      // The streaming case, and the reason this is not a plain append. A voice
      // agent sends an utterance as a run of partial frames and then a final; a
      // store that appended each one would replay a call as "how how how are
      // you are are are you". A partial and the final that completes it are the
      // same turn, so the later write replaces the line in place -- and nothing
      // else about it moves.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await store.appendTranscript("a1", [line({ seq: 0, text: "how are", finalized: false })]);
      await store.appendTranscript("a1", [line({ seq: 0, text: "how are you today" })]);

      const stored = await store.getTranscript("a1");
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual(line({ seq: 0, text: "how are you today" }));
    });

    test("re-sending a line that has not changed is a no-op, not a second line", async () => {
      // Idempotence, and the reason a client may retry a batch whose response it
      // never saw. Without it, one lost response would double every line the
      // batch carried.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await store.appendTranscript("a1", [line()]);
      expect(await store.appendTranscript("a1", [line()])).toBe(1);
      expect(await store.getTranscript("a1")).toHaveLength(1);
    });

    test("keeps each appointment's lines apart", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));
      await store.create(appointment("a2"));

      await store.appendTranscript("a1", [line({ seq: 0, text: "mine" })]);
      await store.appendTranscript("a2", [line({ seq: 0, text: "theirs" })]);

      expect((await store.getTranscript("a1")).map((entry) => entry.text)).toEqual(["mine"]);
      expect((await store.getTranscript("a2")).map((entry) => entry.text)).toEqual(["theirs"]);
    });

    test("hands out copies, so a caller cannot rewrite a stored line", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));
      await store.appendTranscript("a1", [line()]);

      const [first] = await store.getTranscript("a1");
      first!.text = "something else entirely";
      first!.at.setUTCFullYear(1999);

      expect((await store.getTranscript("a1"))[0]!.text).toBe("I need to see a doctor about my eye.");
      expect((await store.getTranscript("a1"))[0]!.at.toISOString()).toBe(
        "2026-09-01T10:00:01.000Z",
      );
    });

    test("stores a copy of what it was given", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      const sent = line();
      await store.appendTranscript("a1", [sent]);
      sent.text = "rewritten after the fact";

      expect((await store.getTranscript("a1"))[0]!.text).toBe("I need to see a doctor about my eye.");
    });

    test("refuses a line it could not store honestly", async () => {
      // Validated before the Map is touched, for the reason
      // `assertValidAppointmentPatch` is: a line in a state nothing can compare
      // against is a transcript that replays wrong, silently, forever.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await expect(
        store.appendTranscript("a1", [line({ seq: -1 })]),
      ).rejects.toThrow(/position/i);
      await expect(
        store.appendTranscript("a1", [line({ seq: 1.5 })]),
      ).rejects.toThrow(/position/i);
      await expect(
        store.appendTranscript("a1", [line({ role: "operator" as TranscriptLine["role"] })]),
      ).rejects.toThrow(/role/i);
      await expect(
        store.appendTranscript("a1", [line({ text: "" })]),
      ).rejects.toThrow(/text/i);
      await expect(
        store.appendTranscript("a1", [line({ at: new Date("nonsense") })]),
      ).rejects.toThrow(/timestamp/i);
    });

    test("nothing is stored when a batch is partly invalid", async () => {
      // Validated as a batch, before any write. Half a call is not a call.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await expect(
        store.appendTranscript("a1", [line({ seq: 0 }), line({ seq: -2 })]),
      ).rejects.toThrow();
      expect(await store.getTranscript("a1")).toEqual([]);
    });

    test("refuses a batch that names one position twice", async () => {
      // Which of two texts is the record is the caller's decision to make
      // explicitly, in two batches, not something a single write resolves for
      // them. The durable store cannot express it either way.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      await expect(
        store.appendTranscript("a1", [line({ seq: 0, text: "first" }), line({ seq: 0, text: "second" })]),
      ).rejects.toThrow(/same position/i);
      expect(await store.getTranscript("a1")).toEqual([]);
    });
  });

  describe("getTranscript", () => {
    test("is empty for an appointment that has one, and for one that has not", async () => {
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      expect(await store.getTranscript("a1")).toEqual([]);
      expect(await store.getTranscript("missing")).toEqual([]);
    });

    test("keeps the most recent lines when it has to cap, oldest first", async () => {
      // A cap that returned the *first* N lines would replay a call as its
      // opening pleasantries and drop the booking, which is the part anyone
      // actually wants. So the tail is what survives, returned in order.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));

      for (let seq = 0; seq < 10; seq += 1) {
        await store.appendTranscript("a1", [line({ seq, text: `line ${seq}` })]);
      }

      expect((await store.getTranscript("a1", 3)).map((entry) => entry.text)).toEqual([
        "line 7",
        "line 8",
        "line 9",
      ]);
    });

    test("refuses a cap nobody asked for", async () => {
      // Negative limits are a bug, and a bug that silently returns zero lines
      // reads as a patient who said nothing.
      const store = new InMemoryAppointmentStore();
      await store.create(appointment("a1"));
      await store.appendTranscript("a1", [line()]);

      expect(await store.getTranscript("a1", 0)).toEqual([]);
      expect(await store.getTranscript("a1", -1)).toEqual([]);
    });
  });
});

