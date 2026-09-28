import { logInfo, logWarn } from "@/lib/logger";

/**
 * Retry with exponential backoff and jitter.
 *
 * Both translation modules carried a byte-identical copy of this loop: the same
 * three constants, the same `sleep`, the same `calculateDelayWithJitter`, the
 * same catch-and-log, the same "failed after N attempts" throw. Two copies of a
 * retry policy is two policies, because the next person to change one of them
 * has no reason to find the other -- which is how an intake translation ends up
 * retrying eleven times and an email translation ten, and nobody can say which
 * is intended.
 *
 * The policy is a value and the clock is injectable, so the loop is testable
 * without waiting out real backoff.
 *
 * The delay is full jitter over an exponential ceiling rather than a fixed
 * exponential. Ten clients that all fail at the same moment, as they will when
 * an API is degraded, would otherwise all come back at the same moment, which
 * is the retry stampede the backoff is supposed to prevent.
 *
 * Nothing here decides *whether* a failure is worth retrying. Every failure is
 * retried, as before; see the policy that consumes this.
 */

export interface RetryPolicy {
  /** Used in the exhausted-error message. Never caller-supplied text. */
  label: string;
  /** Total attempts, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const TRANSLATION_RETRY_POLICY: RetryPolicy = {
  label: "Translation",
  maxAttempts: 10,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
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
 * long-running sequence from drifting into minutes, which the policy owner is
 * responsible for: see #29.
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
 * Run `operation`, retrying on failure.
 *
 * Throws once the attempts are exhausted, with the last failure's message
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
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
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

      if (attempt < policy.maxAttempts - 1) {
        const delay = backoffDelay(attempt, policy, random);
        logInfo("llm.retry_scheduled", { durationMs: delay, attempt: attempt + 1 });
        await wait(delay);
      }
    }
  }

  throw new Error(
    `${policy.label} failed after ${policy.maxAttempts} attempts: ${lastError?.message}`,
  );
}
