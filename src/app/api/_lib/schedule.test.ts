import { describe, expect, test } from "bun:test";
import {
  APPOINTMENT_DURATION_MINUTES,
  MAX_SHIFT_MINUTES,
  MIN_LEAD_MS,
  SLOT_MINUTES,
  findAlternativeSlots,
  findConflicts,
  intervalsOverlap,
  isSlotFree,
  negotiateAppointmentTime,
  negotiateSlot,
  type DiaryInterval,
} from "./schedule";

/**
 * The mock clinic's scheduling decision (#19).
 *
 * The bug under test is a single wrong comparison: the agreed time was drawn
 * against `now`, so it ignored the requested slot and could land before it.
 * These tests are mostly about which side of that comparison a value falls on.
 */

/** A fixed clock: Wednesday 2026-03-04T12:00:00Z. */
const NOW = Date.parse("2026-03-04T12:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("negotiateAppointmentTime", () => {
  test("confirms a requested slot that is comfortably in the future", () => {
    // The patient asked for Friday at 09:00 and got Friday at 09:00, rather
    // than the old `now + random(0, 24h)`, which would have said Thursday.
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const agreed = negotiateAppointmentTime(requested, NOW, () => 0);

    expect(Date.parse(agreed)).toBe(Date.parse(requested));
  });

  test("never agrees to a time earlier than the requested slot", () => {
    // The regression. Against any draw, the confirmed time is at or after the
    // slot in the form.
    const requested = new Date(NOW + 2 * HOUR).toISOString().slice(0, 16);

    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => draw));
      expect(agreed).toBeGreaterThanOrEqual(Date.parse(requested));
    }
  });

  test("never agrees to a time in the past", () => {
    // A slot the patient picked has gone by while the form was open. Agreeing
    // to it literally would email someone an appointment that has already
    // elapsed, so the clinic offers the next slot it could actually open.
    const requested = new Date(NOW - 3 * HOUR).toISOString().slice(0, 16);
    const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => 0));

    expect(agreed).toBeGreaterThanOrEqual(NOW);
    expect(agreed).toBe(NOW + MIN_LEAD_MS);
  });

  test("honours a requested slot that is only just far enough ahead", () => {
    // One minute more than the notice period: the requested time wins, because
    // the patient asked for it and it is bookable.
    const requested = new Date(NOW + MIN_LEAD_MS + MINUTE)
      .toISOString()
      .slice(0, 16);

    const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => 0));

    expect(agreed).toBeGreaterThanOrEqual(Date.parse(requested));
  });

  test("only ever moves the appointment forward, in quarter-hour slots", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const base = Date.parse(requested);

    for (let draw = 0; draw < 1; draw += 0.1) {
      const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => draw));
      const shift = agreed - base;

      expect(shift).toBeGreaterThanOrEqual(0);
      expect(shift % (SLOT_MINUTES * MINUTE)).toBe(0);
    }
  });

  test("stays within the clinic's maximum shift", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);

    // Math.random never returns 1, so the ceiling is drawn as the largest
    // representable value below it.
    const agreed = Date.parse(
      negotiateAppointmentTime(requested, NOW, () => 0.999999999),
    );

    expect(agreed - Date.parse(requested)).toBeLessThanOrEqual(
      MAX_SHIFT_MINUTES * MINUTE,
    );
  });

  test("keeps the date the patient asked for when the shift is small", () => {
    // The old bug also lost the date. Friday requested, Friday confirmed.
    const requested = "2026-03-06T09:00";
    const now = Date.parse("2026-03-04T12:00:00.000Z");

    const agreed = new Date(negotiateAppointmentTime(requested, now, () => 0.2));

    expect(agreed.toISOString().slice(0, 10)).toBe(
      new Date(Date.parse(requested)).toISOString().slice(0, 10),
    );
  });

  test("returns an ISO-8601 timestamp", () => {
    // It goes straight into the confirmation email, so the format is part of
    // the contract rather than an implementation detail.
    const agreed = negotiateAppointmentTime("2026-03-06T09:00", NOW, () => 0);

    expect(agreed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(agreed))).toBe(false);
  });

  test("falls back to the next bookable slot for an unparseable request", () => {
    // intakeSchema refuses this before it gets here, so the guard is about not
    // emitting `NaN` into a patient's inbox if that ever stops being true.
    const agreed = Date.parse(negotiateAppointmentTime("not a date", NOW, () => 0));

    expect(agreed).toBe(NOW + MIN_LEAD_MS);
  });

  test("reads the clock by default rather than requiring it", () => {
    const requested = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 16);
    const agreed = Date.parse(negotiateAppointmentTime(requested));

    expect(agreed).toBeGreaterThan(Date.now());
  });
});

/**
 * Smart conflict handling for negotiated times (#66).
 *
 * The shift added in #19 moves a requested time forward by a random number of
 * slots, which makes the clinic look busy to every patient in proportion to how
 * unlucky the draw was, and can happily confirm a slot another patient already
 * holds. These tests are about the diary: which slots are actually taken, and
 * what the clinic offers when the one that was asked for is not available.
 *
 * Every function here is pure. Reading the clinic's real diary is #17; until
 * then the diary is a parameter, so the rules are assertable without a database
 * and the eventual persistence change is a call site, not a rewrite.
 */

/** A diary entry: 09:00-09:30 on 2026-03-06 is already taken. */
const BUSY_0900: DiaryInterval = {
  startMs: Date.parse("2026-03-06T09:00:00.000Z"),
  endMs: Date.parse("2026-03-06T09:30:00.000Z"),
};

describe("intervalsOverlap", () => {
  test("detects an overlap from the middle", () => {
    expect(
      intervalsOverlap(
        { startMs: 0, endMs: 60 },
        { startMs: 30, endMs: 90 },
      ),
    ).toBe(true);
  });

  test("treats back-to-back appointments as free", () => {
    // The half-open rule: one patient's 09:30 does not conflict with another's
    // 09:00 that finished exactly then. A closed interval would report every
    // clinic with back-to-back patients as double-booked.
    expect(
      intervalsOverlap(
        { startMs: 0, endMs: 30 },
        { startMs: 30, endMs: 60 },
      ),
    ).toBe(false);
  });

  test("detects containment in both directions", () => {
    expect(
      intervalsOverlap(
        { startMs: 0, endMs: 90 },
        { startMs: 30, endMs: 60 },
      ),
    ).toBe(true);
    expect(
      intervalsOverlap(
        { startMs: 30, endMs: 60 },
        { startMs: 0, endMs: 90 },
      ),
    ).toBe(true);
  });

  test("reports disjoint intervals as free", () => {
    expect(
      intervalsOverlap(
        { startMs: 0, endMs: 30 },
        { startMs: 90, endMs: 120 },
      ),
    ).toBe(false);
  });

  test("never reports an empty or inverted interval as overlapping", () => {
    // A zero-length or backwards interval occupies no time, so it cannot clash
    // with anything. Without this, a malformed diary entry would make the
    // clinic permanently unbookable at that hour.
    const empty: DiaryInterval = { startMs: 45, endMs: 45 };
    const inverted: DiaryInterval = { startMs: 90, endMs: 30 };

    expect(intervalsOverlap(empty, { startMs: 0, endMs: 60 })).toBe(false);
    expect(intervalsOverlap({ startMs: 0, endMs: 60 }, empty)).toBe(false);
    expect(intervalsOverlap(inverted, { startMs: 0, endMs: 60 })).toBe(false);
  });
});

describe("findConflicts", () => {
  test("finds the busy intervals a candidate slot collides with", () => {
    const conflicts = findConflicts(
      Date.parse("2026-03-06T09:15:00.000Z"),
      APPOINTMENT_DURATION_MINUTES,
      [BUSY_0900],
    );

    expect(conflicts).toEqual([BUSY_0900]);
  });

  test("is empty for a free slot", () => {
    expect(
      findConflicts(
        Date.parse("2026-03-06T09:30:00.000Z"),
        APPOINTMENT_DURATION_MINUTES,
        [BUSY_0900],
      ),
    ).toEqual([]);
  });

  test("measures the candidate by its real duration", () => {
    // A 15-minute appointment at 09:30 fits in the gap the 30-minute booking
    // left; a 60-minute one at the same moment runs into the 10:00 booking.
    const busy: DiaryInterval[] = [
      BUSY_0900,
      {
        startMs: Date.parse("2026-03-06T10:00:00.000Z"),
        endMs: Date.parse("2026-03-06T10:30:00.000Z"),
      },
    ];
    const at0930 = Date.parse("2026-03-06T09:30:00.000Z");

    expect(findConflicts(at0930, SLOT_MINUTES, busy)).toEqual([]);
    // Running to 10:30 reaches the later booking but not the one that ended
    // exactly at 09:30, so only the later one is reported.
    expect(findConflicts(at0930, 60, busy)).toEqual([busy[1]]);
  });

  test("returns every colliding interval, not just the first", () => {
    // The clinic needs the whole picture to explain the clash to the patient.
    const busy: DiaryInterval[] = [
      BUSY_0900,
      {
        startMs: Date.parse("2026-03-06T10:00:00.000Z"),
        endMs: Date.parse("2026-03-06T10:30:00.000Z"),
      },
    ];

    expect(
      findConflicts(
        Date.parse("2026-03-06T09:00:00.000Z"),
        90,
        busy,
      ),
    ).toEqual(busy);
  });

  test("treats an empty diary as everything being free", () => {
    expect(
      findConflicts(Date.parse("2026-03-06T09:00:00.000Z"), 30, []),
    ).toEqual([]);
  });
});

describe("isSlotFree", () => {
  test("is the boolean form of findConflicts", () => {
    const at0930 = Date.parse("2026-03-06T09:30:00.000Z");

    expect(isSlotFree(at0930, APPOINTMENT_DURATION_MINUTES, [BUSY_0900])).toBe(
      true,
    );
    expect(
      isSlotFree(
        Date.parse("2026-03-06T09:15:00.000Z"),
        APPOINTMENT_DURATION_MINUTES,
        [BUSY_0900],
      ),
    ).toBe(false);
  });
});

describe("findAlternativeSlots", () => {
  test("offers the nearest free slot first", () => {
    // 09:00 is taken, so the next genuinely free slot is 09:30.
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T09:00:00.000Z"),
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      diary: [BUSY_0900],
      limit: 1,
    });

    expect(alternatives).toEqual(["2026-03-06T09:30:00.000Z"]);
  });

  test("skips a run of bookings rather than stopping at the first", () => {
    const busy: DiaryInterval[] = [
      BUSY_0900,
      {
        startMs: Date.parse("2026-03-06T09:30:00.000Z"),
        endMs: Date.parse("2026-03-06T10:00:00.000Z"),
      },
    ];

    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T09:00:00.000Z"),
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      diary: busy,
      limit: 1,
    });

    expect(alternatives).toEqual(["2026-03-06T10:00:00.000Z"]);
  });

  test("returns the requested slot itself when it is free", () => {
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T11:00:00.000Z"),
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      diary: [BUSY_0900],
      limit: 1,
    });

    expect(alternatives).toEqual(["2026-03-06T11:00:00.000Z"]);
  });

  test("offers several, nearest first, up to the limit", () => {
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T09:00:00.000Z"),
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      diary: [BUSY_0900],
      limit: 3,
    });

    expect(alternatives).toEqual([
      "2026-03-06T09:30:00.000Z",
      "2026-03-06T09:45:00.000Z",
      "2026-03-06T10:00:00.000Z",
    ]);
  });

  test("stays inside the clinic's maximum shift", () => {
    // Beyond the horizon the clinic would be moving the patient further than it
    // has said it ever will, so those slots are not offered as a "nearby"
    // alternative.
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T09:00:00.000Z"),
      maxShiftMinutes: 30,
      diary: [BUSY_0900],
      limit: 10,
    });

    expect(alternatives).toEqual([
      "2026-03-06T09:30:00.000Z",
      // 09:45 would end at 10:15, which is 105 minutes after 09:00.
    ]);
  });

  test("returns nothing when the whole horizon is booked", () => {
    // This is the signal that the clinic has to go back to the patient rather
    // than invent a time.
    const busy: DiaryInterval[] = [
      {
        startMs: Date.parse("2026-03-06T09:00:00.000Z"),
        endMs: Date.parse("2026-03-06T23:00:00.000Z"),
      },
    ];

    expect(
      findAlternativeSlots({
        fromMs: Date.parse("2026-03-06T09:00:00.000Z"),
        durationMinutes: APPOINTMENT_DURATION_MINUTES,
        diary: busy,
        limit: 5,
      }),
    ).toEqual([]);
  });

  test("only offers whole slots", () => {
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T09:07:00.000Z"),
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      limit: 2,
    });

    for (const iso of alternatives) {
      const minutes = new Date(iso).getUTCMinutes();
      expect(minutes % SLOT_MINUTES).toBe(0);
    }
  });

  test("never offers a slot earlier than the one asked for", () => {
    const alternatives = findAlternativeSlots({
      fromMs: Date.parse("2026-03-06T11:00:00.000Z"),
      diary: [],
      limit: 3,
    });

    for (const iso of alternatives) {
      expect(Date.parse(iso)).toBeGreaterThanOrEqual(
        Date.parse("2026-03-06T11:00:00.000Z"),
      );
    }
  });
});

describe("negotiateAppointmentTime with a diary", () => {
  test("keeps the requested slot when it is free", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const agreed = negotiateAppointmentTime(requested, NOW, () => 0, []);

    expect(Date.parse(agreed)).toBe(Date.parse(requested));
  });

  test("never confirms a slot the diary already holds", () => {
    // The bug under test: a forward shift that lands on top of another
    // patient's appointment and is emailed to the patient as a confirmation.
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const requestedMs = Date.parse(requested);
    const busy: DiaryInterval[] = [
      {
        startMs: requestedMs,
        endMs: requestedMs + APPOINTMENT_DURATION_MINUTES * MINUTE,
      },
    ];

    const agreed = Date.parse(
      negotiateAppointmentTime(requested, NOW, () => 0, busy),
    );

    expect(
      isSlotFree(agreed, APPOINTMENT_DURATION_MINUTES, busy),
    ).toBe(true);
  });

  test("stays within the maximum shift while avoiding the diary", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const requestedMs = Date.parse(requested);
    const busy: DiaryInterval[] = [
      {
        startMs: requestedMs,
        endMs: requestedMs + APPOINTMENT_DURATION_MINUTES * MINUTE,
      },
    ];

    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const agreed = Date.parse(
        negotiateAppointmentTime(requested, NOW, () => draw, busy),
      );
      expect(isSlotFree(agreed, APPOINTMENT_DURATION_MINUTES, busy)).toBe(true);
      expect(agreed - requestedMs).toBeLessThanOrEqual(
        MAX_SHIFT_MINUTES * MINUTE,
      );
    }
  });

  test("behaves exactly as before when no diary is supplied", () => {
    // The diary is optional so the existing booking path keeps working; an
    // absent diary must not shift a single slot.
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);

    for (const draw of [0, 0.3, 0.6, 0.9]) {
      expect(negotiateAppointmentTime(requested, NOW, () => draw)).toBe(
        negotiateAppointmentTime(requested, NOW, () => draw, []),
      );
    }
  });
});

describe("negotiateSlot", () => {
  test("confirms the requested slot when the clinic is free", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);

    const result = negotiateSlot({
      requested,
      now: NOW,
      random: () => 0,
      diary: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agreedDateTimeIso).toBe(new Date(Date.parse(requested)).toISOString());
      expect(result.shifted).toBe(false);
      expect(result.conflicts).toEqual([]);
    }
  });

  test("reports the clash and moves to the nearest free slot", () => {
    // The requested slot is taken, so the clinic says so rather than quietly
    // sending a different time and leaving the patient to notice.
    const requested = "2026-03-06T09:00";
    const result = negotiateSlot({
      requested,
      now: Date.parse("2026-03-04T12:00:00.000Z"),
      random: () => 0,
      diary: [BUSY_0900],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agreedDateTimeIso).toBe("2026-03-06T09:30:00.000Z");
      expect(result.shifted).toBe(true);
      expect(result.conflicts).toEqual([BUSY_0900]);
    }
  });

  test("offers alternatives instead of inventing a time", () => {
    // The horizon is fully booked. The old code would have shifted the patient
    // into an occupied slot; the useful answer is a menu of real options.
    const requested = "2026-03-06T09:00";
    const busy: DiaryInterval[] = [
      {
        startMs: Date.parse("2026-03-06T09:00:00.000Z"),
        endMs: Date.parse("2026-03-06T14:00:00.000Z"),
      },
    ];

    const result = negotiateSlot({
      requested,
      now: Date.parse("2026-03-04T12:00:00.000Z"),
      random: () => 0,
      diary: busy,
      maxShiftMinutes: 30,
      alternativeLimit: 3,
      alternativeLookaheadMinutes: 6 * 60,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_availability");
      expect(result.alternatives).toEqual([
        "2026-03-06T14:00:00.000Z",
        "2026-03-06T14:15:00.000Z",
        "2026-03-06T14:30:00.000Z",
      ]);
    }
  });

  test("never confirms anything in the past", () => {
    // The requested slot has already gone by while the form was open.
    const requested = new Date(NOW - 3 * HOUR).toISOString().slice(0, 16);

    const result = negotiateSlot({
      requested,
      now: NOW,
      random: () => 0,
      diary: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Date.parse(result.agreedDateTimeIso)).toBeGreaterThanOrEqual(
        NOW + MIN_LEAD_MS,
      );
    }
  });

  test("respects the minimum notice period when looking for alternatives", () => {
    // Every option has to be bookable, so the first is not the requested slot
    // itself once the notice period has moved it forward.
    const result = negotiateSlot({
      requested: new Date(NOW).toISOString().slice(0, 16),
      now: NOW,
      random: () => 0,
      diary: [],
      alternativeLookaheadMinutes: 60,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Date.parse(result.agreedDateTimeIso)).toBeGreaterThanOrEqual(
        NOW + MIN_LEAD_MS,
      );
    }
  });

  test("returns alternatives that do not collide with the diary", () => {
    const busy: DiaryInterval[] = [
      {
        startMs: Date.parse("2026-03-06T09:00:00.000Z"),
        endMs: Date.parse("2026-03-06T12:00:00.000Z"),
      },
    ];

    const result = negotiateSlot({
      requested: "2026-03-06T09:00",
      now: Date.parse("2026-03-04T12:00:00.000Z"),
      random: () => 0,
      diary: busy,
      maxShiftMinutes: 30,
      alternativeLimit: 5,
      alternativeLookaheadMinutes: 6 * 60,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.alternatives.length).toBeGreaterThan(0);
      for (const iso of result.alternatives) {
        expect(
          isSlotFree(Date.parse(iso), APPOINTMENT_DURATION_MINUTES, busy),
        ).toBe(true);
      }
    }
  });

  test("is deterministic for a fixed draw and diary", () => {
    const options = {
      requested: "2026-03-06T09:00",
      now: Date.parse("2026-03-04T12:00:00.000Z"),
      random: () => 0.5,
      diary: [BUSY_0900],
    };

    expect(negotiateSlot(options)).toEqual(negotiateSlot(options));
  });
});
