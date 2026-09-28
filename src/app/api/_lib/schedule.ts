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
 * and a random draw, which is what makes it testable. Scheduling logic that
 * reads the clock inside a route handler is scheduling logic nobody tests.
 */

/** Notice a patient needs: a booking made for "now" is not a booking. */
export const MIN_LEAD_MS = 30 * 60_000;

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
 * @returns An ISO-8601 timestamp, never earlier than the requested slot and
 *   never earlier than `now`.
 */
export function negotiateAppointmentTime(
  requested: string,
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const requestedAt = Date.parse(requested);

  // An unparseable request cannot be honoured literally, and intakeSchema
  // already refuses one, so this is a guard rather than a path: offer the next
  // bookable slot instead of `NaN`.
  const earliest = Number.isNaN(requestedAt)
    ? now + MIN_LEAD_MS
    : Math.max(requestedAt, now + MIN_LEAD_MS);

  const shiftMs = Math.floor(random() * MAX_SLOTS) * SLOT_MINUTES * 60_000;

  return new Date(earliest + shiftMs).toISOString();
}
