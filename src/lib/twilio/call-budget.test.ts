import { beforeEach, describe, expect, test } from "bun:test";
import { setRateLimitStore } from "@/lib/rate-limit";
import {
  OUTBOUND_CALL_BUDGET,
  OUTBOUND_CALL_BUDGET_WINDOW_MS,
  reserveCallBudget,
} from "./call-budget";

/**
 * What a call costs, before one is made.
 *
 * Every other metered thing in this application -- a Gemini translation, a
 * Resend email, an ElevenLabs signature -- is a fraction of a cent and a failed
 * request costs nothing. A telephony call is billed per minute, in both
 * directions, and it is placed from the booking pipeline: one POST to
 * /api/intake places one call. So this is the one budget in the app where the
 * limit is the feature.
 *
 * It is a fixed window over the same store as every other rate limit here, and
 * it inherits that store's honest limitation: per-instance, in memory, and
 * therefore friction rather than a quota on a serverless deployment with more
 * than one instance. That is stated rather than hidden, and the control that
 * does hold across instances is Twilio's own spend limit in the console -- see
 * the note on the module.
 */

beforeEach(() => {
  setRateLimitStore(null);
});

describe("reserveCallBudget", () => {
  test("allows a call when there is budget", async () => {
    expect(await reserveCallBudget()).toEqual({ allowed: true, remaining: OUTBOUND_CALL_BUDGET - 1 });
  });

  test("allows exactly the budget, and refuses the one after it", async () => {
    for (let attempt = 0; attempt < OUTBOUND_CALL_BUDGET; attempt += 1) {
      expect((await reserveCallBudget()).allowed).toBe(true);
    }

    const refused = await reserveCallBudget();

    expect(refused.allowed).toBe(false);
  });

  test("reports when the next call is possible", async () => {
    for (let attempt = 0; attempt <= OUTBOUND_CALL_BUDGET; attempt += 1) {
      await reserveCallBudget();
    }

    const refused = await reserveCallBudget();

    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("expected the budget to be spent");
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(OUTBOUND_CALL_BUDGET_WINDOW_MS);
  });

  test("counts a call that was never placed", async () => {
    // The reservation is spent before the vendor is asked, because the vendor
    // may have accepted it. Un-spending on a failure would make a retry loop
    // free, and a retry loop is exactly what this budget is here to stop.
    for (let attempt = 0; attempt < OUTBOUND_CALL_BUDGET; attempt += 1) {
      await reserveCallBudget();
    }

    expect((await reserveCallBudget()).allowed).toBe(false);
  });

  test("one budget for the whole deployment, not one per booking", async () => {
    // Two callers arriving together draw on the same window. A budget keyed by
    // anything the caller supplied would be a budget with as many counters as
    // there are callers, which is no budget.
    expect((await Promise.all([reserveCallBudget(), reserveCallBudget()])).every(
      (result) => result.allowed,
    )).toBe(true);
  });
});
