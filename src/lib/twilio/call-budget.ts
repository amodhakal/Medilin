import "server-only";

import { consume, getRateLimitStore, type RateLimitStore } from "@/lib/rate-limit";

/**
 * What a call costs, decided before one is made.
 *
 * Every other meter in this application is a rounding error. A Gemini
 * translation and a Resend email cost fractions of a cent, and a request that
 * fails costs nothing at all. A telephony call is billed per minute in both
 * directions, and it is placed from the booking pipeline: one POST to
 * /api/intake is one call to a real clinic's real line. So this is the one place
 * in the app where a missing limit is an invoice rather than an annoyance.
 *
 * Two bounds, and both are here rather than in the call site:
 *
 *   1. This one, in-process. It is the same fixed window and the same store as
 *      every other rate limit in this repository (./rate-limit), which means it
 *      is correct for one process and worthless across several -- the
 *      in-memory store is per-instance and does not survive a cold start. It is
 *      friction against a loop in a single instance, not a quota.
 *   2. Twilio's own spend limits, in the console, which are the control that
 *      actually holds. This module cannot be that: it has no view of the other
 *      instances, of the retry Twilio does on its own behalf, or of a call that
 *      is still running when the instance that placed it is gone.
 *
 * The honest way to ship a money feature without a durable store is to make the
 * cheap control present, name the expensive one, and say in the README-style
 * comment above that a deployment placing real calls must set it. Setting a
 * Twilio spend limit is a thirty-second job in the console and it is the only
 * part of this that bounds the damage when everything else is wrong.
 *
 * ## Why the reservation is taken before the call
 *
 * The alternative reads better -- charge the budget only for a call that
 * Twilio accepted -- and is wrong. Between reserving and the vendor's answer
 * there is a window in which the call exists, and a caller who can reach that
 * window repeatedly has an unbounded number of them. A reservation that is not
 * refunded is the pessimistic reading of an ambiguous state, and the cost of
 * being wrong in this direction is one booking whose receptionist is not
 * telephoned; the cost of being wrong in the other is an invoice.
 */

/**
 * Calls per window, for the whole deployment.
 *
 * Five an hour. A clinic taking bookings at a realistic rate does not come
 * close: the intake form books one appointment per submission, and a clinic
 * with several hundred bookings a day is unusual for a service whose current
 * scheduling is a mock anyway. The number is low deliberately -- this is the
 * setting to raise once a durable store exists and the limit is doing something
 * other than catching a loop, and a limit that is too low costs a receptionist
 * a phone call, which is the recoverable direction.
 */
export const OUTBOUND_CALL_BUDGET = 5;

/** An hour, which is long enough that a retry is not the reason for a refusal. */
export const OUTBOUND_CALL_BUDGET_WINDOW_MS = 60 * 60_000;

/**
 * One key for every outbound call.
 *
 * Not scoped by caller, by appointment, or by destination, for the reason the
 * store is fixed: a counter per key is a counter per thing that key is derived
 * from, and every one of those is something a caller influences. The budget has
 * to be a property of the deployment or it is not a budget.
 */
const BUDGET_KEY = "twilio:outbound_clinic_call";

export type CallBudget =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number };

export async function reserveCallBudget(
  store: RateLimitStore = getRateLimitStore(),
): Promise<CallBudget> {
  const result = await consume(BUDGET_KEY, OUTBOUND_CALL_BUDGET, OUTBOUND_CALL_BUDGET_WINDOW_MS, store);

  return result.allowed
    ? { allowed: true, remaining: result.remaining }
    : { allowed: false, retryAfterMs: result.retryAfterMs };
}
