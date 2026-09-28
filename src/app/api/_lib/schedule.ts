/**
 * The mock clinic's scheduling decision.
 *
 * The confirmation used to be stamped `now + random(0, 24h)`, which ignores the
 * slot the patient asked for entirely. Two ways that is wrong, and the second is
 * the one that reached a patient:
 *
 *   1. A patient who asked for next Tuesday at 09:00 was told a time within the
 *      next day, i.e. the clinic routinely replies with something earlier than
 *      the appointment being confirmed. An email saying "we have booked you for
 *      14:20 today" under a form that says "requested: Tuesday 09:00" is not a
 *      confirmation, it is a contradiction, and a patient who trusts it turns up
 *      on the wrong day.
 *   2. Because the draw is against `now`, the confirmed time can be in the past
 *      relative to the request, and never carries the date the patient chose.
 *
 * So the negotiation starts from what was asked for. The earliest bookable
 * moment is the later of the requested slot and the clinic's minimum notice
 * period, because a request for a slot that has already gone by is not something
 * a clinic can honour literally -- a patient picking tomorrow morning and
 * submitting at 23:00 asked for a time that no longer exists. From there the
 * mock clinic offers a later slot, never an earlier one: a clinic that can only
 * move you earlier is not scheduling, it is losing your booking.
 *
 * The whole decision is a pure function of the requested slot, the current time,
 * the clinic's diary, and a random draw, which is what makes it testable.
 * Scheduling logic that reads the clock inside a route handler is scheduling
 * logic nobody tests.
 */

const MINUTE = 60_000;

/** Notice a patient needs: a booking made for "now" is not a booking. */
export const MIN_LEAD_MS = 30 * MINUTE;

/** The furthest the mock clinic will move a requested time. */
export const MAX_SHIFT_MINUTES = 105;

/** Slots are whole 15 minutes, because a clinic's diary is. */
export const SLOT_MINUTES = 15;

const MAX_SLOTS = MAX_SHIFT_MINUTES / SLOT_MINUTES;

/**
 * The time the mock clinic agrees to.
 *
 * @param requested `YYYY-MM-DDTHH:mm` from the form, in the server's local zone,
 *   which is what `intakeSchema` validates and what `Date.parse` reads for a
 *   date-time with no offset.
 * @param now Current time in epoch milliseconds. Injected rather than read, so
 *   the decision can be asserted against a fixed clock.
 * @param random Injected for the same reason.
 * @param diary The clinic's diary (#66). Optional, and an absent diary behaves
 *   exactly like an empty one: a slot that is taken is stepped over rather than
 *   confirmed. The existing booking path passes nothing and is unaffected; when
 *   the appointments store lands (#17) it passes the real thing and this becomes
 *   conflict-aware with no change to the signature.
 * @returns An ISO-8601 timestamp, never earlier than the requested slot and
 *   never earlier than `now`.
 */
export function negotiateAppointmentTime(
  requested: string,
  now: number = Date.now(),
  random: () => number = Math.random,
  diary: readonly DiaryInterval[] = [],
): string {
  const requestedAt = Date.parse(requested);

  // An unparseable request cannot be honoured literally, and intakeSchema
  // already refuses one, so this is a guard rather than a path: offer the next
  // bookable slot instead of `NaN`.
  const earliest = Number.isNaN(requestedAt)
    ? now + MIN_LEAD_MS
    : Math.max(requestedAt, now + MIN_LEAD_MS);

  const shiftMs = Math.floor(random() * MAX_SLOTS) * SLOT_MINUTES * MINUTE;
  const drawnMs = earliest + shiftMs;

  // The drawn slot was picked without looking at the diary, so it can be
  // someone's. Move to the nearest free slot rather than confirming a double
  // booking; if the whole horizon is taken, the drawn time is still the closest
  // thing to what was asked for, and negotiateSlot is the API that can say so.
  if (diary.length > 0) {
    const [nearest] = findAlternativeSlots({
      fromMs: drawnMs,
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      diary,
      maxShiftMinutes: MAX_SHIFT_MINUTES - (drawnMs - earliest) / MINUTE,
      limit: 1,
    });
    if (nearest !== undefined) return nearest;
  }

  return new Date(drawnMs).toISOString();
}

/**
 * The clinic's diary, as data (#66).
 *
 * Everything above is about *how far* to move a requested time. None of it is
 * about whether the time it lands on is actually free, so the shift added in
 * #19 can land squarely on a slot another patient holds and email them a
 * confirmation of a double booking. The patient finds out by turning up.
 *
 * So the clinic needs a diary. This deliberately does not have one: the real
 * appointments store is #17, and wiring persistence in here would put a
 * database behind a function that has no business reaching for one. The diary
 * is a parameter and these are pure functions over it, so when the store lands
 * the call site changes and none of the rules below do.
 */

/** How long a slot is held for. The scheduling default, not the email's. */
export const APPOINTMENT_DURATION_MINUTES = 30;

/**
 * A stretch of the clinic's diary, as epoch milliseconds.
 *
 * Half-open: `startMs` is inclusive and `endMs` exclusive, so back-to-back
 * appointments share a boundary without overlapping. An interval whose end is
 * not after its start holds no time at all and never collides with anything.
 */
export interface DiaryInterval {
  startMs: number;
  endMs: number;
}

function isEmpty(interval: DiaryInterval): boolean {
  return !(interval.endMs > interval.startMs);
}

/**
 * Whether two diary intervals claim any of the same time.
 *
 * Half-open on purpose. A closed comparison would report a 09:00-09:30 patient
 * as clashing with a 09:30-10:00 one, which would make every clinic with
 * back-to-back patients look permanently double-booked and push real
 * appointments out of the diary.
 */
export function intervalsOverlap(
  a: DiaryInterval,
  b: DiaryInterval,
): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * The diary entries a candidate appointment would collide with.
 *
 * Returns all of them, not just the first: the clinic needs the whole picture
 * to explain the clash, and a caller that only wants a yes/no can use
 * {@link isSlotFree}.
 */
export function findConflicts(
  startMs: number,
  durationMinutes: number,
  diary: readonly DiaryInterval[],
): DiaryInterval[] {
  const candidate: DiaryInterval = {
    startMs,
    endMs: startMs + durationMinutes * MINUTE,
  };
  return diary.filter((busy) => intervalsOverlap(candidate, busy));
}

/** Whether a slot at `startMs` can be given out. */
export function isSlotFree(
  startMs: number,
  durationMinutes: number,
  diary: readonly DiaryInterval[],
): boolean {
  return findConflicts(startMs, durationMinutes, diary).length === 0;
}

export interface AlternativeSlotsOptions {
  /** Where to look from. A slot at or after this moment. */
  fromMs: number;
  /** Length of the appointment. Defaults to {@link APPOINTMENT_DURATION_MINUTES}. */
  durationMinutes?: number;
  /** The clinic's diary. Empty means everything is free. */
  diary?: readonly DiaryInterval[];
  /** How far past `fromMs` the clinic will consider moving. */
  maxShiftMinutes?: number;
  /** How many to return. Defaults to 3. */
  limit?: number;
  /** Slot granularity. Defaults to {@link SLOT_MINUTES}. */
  slotMinutes?: number;
}

/**
 * Free slots after `fromMs`, nearest first.
 *
 * Every returned time is a whole slot, is not occupied, and is no more than
 * `maxShiftMinutes` past `fromMs`. An empty result is the important case: it
 * means the clinic has to go back to the patient rather than invent a time.
 */
export function findAlternativeSlots(
  options: AlternativeSlotsOptions,
): string[] {
  const {
    fromMs,
    durationMinutes = APPOINTMENT_DURATION_MINUTES,
    diary = [],
    maxShiftMinutes = MAX_SHIFT_MINUTES,
    slotMinutes = SLOT_MINUTES,
  } = options;
  const limit = options.limit ?? 3;

  // Offers are only credible if they are bookable times, so the search snaps
  // up to the next slot boundary rather than quoting :07.
  const stepMs = slotMinutes * MINUTE;
  const firstSlot = Math.ceil(fromMs / stepMs) * stepMs;

  const found: string[] = [];
  for (
    let startMs = firstSlot;
    startMs <= fromMs + maxShiftMinutes * MINUTE;
    startMs += stepMs
  ) {
    if (isSlotFree(startMs, durationMinutes, diary)) {
      found.push(new Date(startMs).toISOString());
      if (found.length >= limit) break;
    }
  }
  return found;
}

export type SlotNegotiation =
  | {
      ok: true;
      /** The time the clinic can confirm. */
      agreedDateTimeIso: string;
      /** Whether the clinic had to move the patient off the requested slot. */
      shifted: boolean;
      /** What the requested slot collided with. Empty when it was free. */
      conflicts: DiaryInterval[];
    }
  | {
      ok: false;
      /**
       * Nothing free inside the clinic's shift policy. `alternatives` are real
       * bookable slots further out, nearest first, for the patient to choose
       * from.
       */
      reason: "no_availability";
      alternatives: string[];
    };

export interface NegotiateSlotOptions {
  /** `YYYY-MM-DDTHH:mm` from the form, as the server parses it. */
  requested: string;
  now?: number;
  random?: () => number;
  /** The clinic's diary. Omit for an empty one. */
  diary?: readonly DiaryInterval[];
  durationMinutes?: number;
  /** How far the clinic will move a requested time. */
  maxShiftMinutes?: number;
  slotMinutes?: number;
  /** How many alternatives to offer when nothing is free. */
  alternativeLimit?: number;
  /** How far past the shift horizon to look for alternatives. */
  alternativeLookaheadMinutes?: number;
}

/**
 * Negotiate a time against the clinic's diary, and say what happened.
 *
 * {@link negotiateAppointmentTime} returns a timestamp and nothing else, so a
 * caller cannot tell "you got the slot you asked for" from "we had to move you
 * because the clinic was full". Both are the same string, and the patient only
 * finds out which one happened on the day. This returns the reason alongside
 * the time, and the alternatives when there is no time to give.
 */
export function negotiateSlot(
  options: NegotiateSlotOptions,
): SlotNegotiation {
  const {
    requested,
    now = Date.now(),
    random = Math.random,
    diary = [],
    durationMinutes = APPOINTMENT_DURATION_MINUTES,
    slotMinutes = SLOT_MINUTES,
  } = options;
  const maxShiftMinutes = options.maxShiftMinutes ?? MAX_SHIFT_MINUTES;

  const requestedAt = Date.parse(requested);
  // As in negotiateAppointmentTime: an unparseable request is a guard rather
  // than a path, since intakeSchema refuses one.
  const earliest = Number.isNaN(requestedAt)
    ? now + MIN_LEAD_MS
    : Math.max(requestedAt, now + MIN_LEAD_MS);

  const shiftMs =
    Math.floor(random() * (maxShiftMinutes / slotMinutes)) *
    slotMinutes *
    MINUTE;
  const drawnMs = earliest + shiftMs;
  const conflicts = findConflicts(drawnMs, durationMinutes, diary);

  if (conflicts.length === 0) {
    return {
      ok: true,
      agreedDateTimeIso: new Date(drawnMs).toISOString(),
      shifted: drawnMs !== requestedAt,
      conflicts,
    };
  }

  // The drawn slot is taken. Offer the nearest one that is not, but never
  // further than the clinic has said it will move anyone.
  const [nearest] = findAlternativeSlots({
    fromMs: earliest,
    durationMinutes,
    diary,
    maxShiftMinutes,
    slotMinutes,
    limit: 1,
  });

  if (nearest !== undefined) {
    return {
      ok: true,
      agreedDateTimeIso: nearest,
      shifted: true,
      conflicts,
    };
  }

  // Nothing free inside the policy, so the clinic cannot honestly confirm
  // anything. Hand back real options further out instead of a slot that is
  // already someone else's.
  return {
    ok: false,
    reason: "no_availability",
    alternatives: findAlternativeSlots({
      fromMs: earliest,
      durationMinutes,
      diary,
      maxShiftMinutes: options.alternativeLookaheadMinutes ?? maxShiftMinutes,
      slotMinutes,
      limit: options.alternativeLimit ?? 3,
    }),
  };
}
