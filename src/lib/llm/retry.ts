import { logInfo, logWarn } from "@/lib/logger";

/**
 * Retry with exponential backoff, jitter, and a wall-clock budget.
 *
 * Both translation modules used to carry a byte-identical copy of this loop, and
 * both configured it as MAX_RETRIES = 10 with a 30s ceiling. That is not a
 * cautious retry policy, it is an outage amplifier:
 *
 *   - The worst case was roughly four minutes of sleeping inside one request.
 *     A serverless function has a hard wall-clock limit well below that, so a
 *     user submitting the form got a platform timeout, not an error message,
 *     and the translation had already consumed ten paid calls to earn it.
 *   - Every failure was retried, including the ones that cannot change. A
 *     revoked API key, a malformed request, a model the key cannot access:
 *     ten identical rejections, ten identical round trips, and an error that
 *     arrives four minutes late pointing at nothing in particular.
 *   - The rate limiter counts requests, not attempts, so none of this was
 *     visible as abuse. One client could keep ten calls in flight per
 *     submission for as long as the budget lasted.
 *
 * So the policy is now three things: a small number of attempts, a total time
 * budget that bounds the request regardless of how the backoff lands, and a
 * classification that refuses to retry a deterministic failure. Ten retries
 * only helps if failures are independent and transient, and an API key being
 * wrong is neither.
 *
 * The policy is a value and the clock is injectable, so the loop is testable
 * without waiting out real backoff.
 *
 * The delay is full jitter over an exponential ceiling rather than a fixed
 * exponential. Several clients that fail at the same moment, as they will when
 * an API is degraded, would otherwise all come back at the same moment, which
 * is the retry stampede the backoff is supposed to prevent.
 */

export interface RetryPolicy {
  /** Used in the exhausted-error message. Never caller-supplied text. */
  label: string;
  /** Total attempts, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Wall-clock ceiling for the whole sequence, sleeping included.
   *
   * Not a timeout on a single attempt -- the HTTP client has that -- but a
   * bound on how long a request can spend failing before it reports the
   * failure. Without it, the attempt count is only a bound if the backoff is
   * predictable, and the backoff is deliberately random.
   */
  totalBudgetMs: number;
  /** Defaults to `isRetryableError`. */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

export const TRANSLATION_RETRY_POLICY: RetryPolicy = {
  label: "Translation",
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
  // Comfortably inside a serverless function's limit and inside a patient's
  // patience: a booking that cannot be translated within this is a booking that
  // should fail fast and be retried by the user, not by us for four minutes.
  totalBudgetMs: 15_000,
  shouldRetry: isRetryableError,
};

/** Test seam: the clock and the randomness, so backoff is not real time. */
export interface RetryHooks {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay before the next attempt, for a zero-based attempt index.
 *
 * Jitter is `random() * exponential`, capped at `maxDelayMs`. The cap keeps a
 * long-running sequence from drifting upward without limit; the total budget is
 * what actually bounds the request.
 */
export function backoffDelay(
  attempt: number,
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const ceiling = policy.baseDelayMs * Math.pow(2, attempt);
  return Math.min(random() * ceiling, policy.maxDelayMs);
}

/**
 * The HTTP status on an SDK or fetch error, if it carries one.
 *
 * `@google/genai` throws `ApiError` with a numeric `status`; a raw `fetch`
 * failure has no status but does have a numeric `code` for some conditions. An
 * error with neither is treated as "status unknown", which is a transport
 * problem and therefore retryable.
 */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;

  return undefined;
}

/** Statuses in the 4xx range that are worth trying again. */
const RETRYABLE_CLIENT_STATUSES = new Set([
  408, // Request Timeout
  409, // Conflict: a transient resource conflict
  425, // Too Early
  429, // Rate Limited
]);

/**
 * Is this failure worth another attempt?
 *
 * Retryable: anything with no status (DNS, connection reset, timeout, a
 * truncated body, an unparseable reply) and any 5xx, plus 408/409/425/429.
 * Those are conditions that can be true of the next call.
 *
 * Not retryable: the remaining 4xx. 401 and 403 mean the credential is wrong,
 * 400 means the request is wrong, 404 means the model or endpoint is not there.
 * Retrying any of them produces the same answer every time, so the only effect
 * of retrying is to delay the error and spend the budget. This is the case that
 * used to cost four minutes to report a revoked key.
 *
 * A 5xx is ambiguous -- a bad gateway is transient, a 501 is not -- so the
 * whole class is retried, capped by the attempt count and the budget rather
 * than by a finer classification than the error supports.
 */
export function isRetryableError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined) return true;
  if (status >= 500) return true;
  if (RETRYABLE_CLIENT_STATUSES.has(status)) return true;
  return false;
}

/**
 * Run `operation`, retrying the failures worth retrying.
 *
 * Throws once the attempts are exhausted, once the time budget is spent, or as
 * soon as a non-retryable failure arrives, with the last failure's message
 * included. Callers surface a generic message to the user; this string is for
 * the logs, where the logger redacts and truncates it.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks = {},
): Promise<T> {
  const wait = hooks.sleep ?? sleep;
  const random = hooks.random ?? Math.random;
  const now = hooks.now ?? Date.now;
  const shouldRetry = policy.shouldRetry ?? isRetryableError;

  const startedAt = now();
  let lastError: Error | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    attempts = attempt + 1;

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // The message is redacted and truncated by the logger: a Gemini SDK
      // error can echo the request payload, which here is the symptom text
      // that was sent for translation.
      logWarn("llm.attempt_failed", {
        cause: lastError,
        attempt: attempt + 1,
        limit: policy.maxAttempts,
      });

      if (!shouldRetry(lastError, attempt)) {
        logInfo("llm.attempt_abandoned", {
          status: statusOf(lastError) ?? "unknown",
          limit: policy.maxAttempts,
        });
        break;
      }

      if (attempt >= policy.maxAttempts - 1) break;

      const delay = backoffDelay(attempt, policy, random);
      const elapsedMs = now() - startedAt;

      // Checked before sleeping, not after: a delay that would land past the
      // budget is time the caller would spend waiting for an outcome that
      // arrives after they have already given up.
      if (elapsedMs + delay > policy.totalBudgetMs) {
        logInfo("llm.budget_exhausted", {
          durationMs: elapsedMs,
          limit: policy.totalBudgetMs,
        });
        break;
      }

      logInfo("llm.retry_scheduled", { durationMs: delay, attempt: attempt + 1 });
      await wait(delay);
    }
  }

  throw new Error(
    `${policy.label} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError?.message}`,
  );
}
