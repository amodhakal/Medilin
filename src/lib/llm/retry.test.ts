import { describe, expect, test } from "bun:test";
import {
  TRANSLATION_RETRY_POLICY,
  backoffDelay,
  isRetryableError,
  statusOf,
  withRetry,
  type RetryPolicy,
} from "./retry";

const policy: RetryPolicy = {
  label: "Test",
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  totalBudgetMs: 60_000,
};

/** A clock the tests advance themselves, so the budget is exact. */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A sleep that records what it was asked to wait for and returns at once. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("backoffDelay", () => {
  test("grows exponentially with the attempt index", () => {
    // random() pinned to 1 so the jitter term is the whole delay.
    expect(backoffDelay(0, policy, () => 1)).toBe(100);
    expect(backoffDelay(1, policy, () => 1)).toBe(200);
    expect(backoffDelay(2, policy, () => 1)).toBe(400);
  });

  test("never exceeds the ceiling", () => {
    expect(backoffDelay(20, policy, () => 1)).toBe(policy.maxDelayMs);
  });

  test("spreads retries so a failing API is not hit by a stampede", () => {
    // Full jitter: two clients failing at the same moment get different delays.
    const low = backoffDelay(3, policy, () => 0.25);
    const high = backoffDelay(3, policy, () => 0.75);
    expect(low).toBe(200);
    expect(high).toBe(600);
  });
});

describe("withRetry", () => {
  test("returns the first success without sleeping", async () => {
    const { delays, sleep } = fakeSleep();
    const operation = async () => "ok";

    expect(await withRetry(operation, policy, { sleep, random: () => 1 })).toBe("ok");
    expect(delays).toEqual([]);
  });

  test("retries until the operation succeeds", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("overloaded");
        return calls;
      },
      policy,
      { sleep, random: () => 1 },
    );

    expect(result).toBe(3);
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test("gives up after maxAttempts and reports the last failure", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;

    const promise = withRetry(
      async () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      },
      policy,
      { sleep, random: () => 1 },
    );

    await expect(promise).rejects.toThrow(
      "Test failed after 3 attempts: failure 3",
    );
    expect(calls).toBe(policy.maxAttempts);
  });

  test("does not sleep after the final attempt", async () => {
    // maxAttempts failures means maxAttempts-1 waits. A trailing sleep would
    // add its duration to every failed request for no reason.
    const { delays, sleep } = fakeSleep();

    await withRetry(
      async () => {
        throw new Error("nope");
      },
      policy,
      { sleep, random: () => 1 },
    ).catch(() => undefined);

    expect(delays).toHaveLength(policy.maxAttempts - 1);
  });

  test("passes the attempt index to the operation", async () => {
    const { sleep } = fakeSleep();
    const seen: number[] = [];

    await withRetry(
      async (attempt) => {
        seen.push(attempt);
        if (attempt < 2) throw new Error("again");
        return "done";
      },
      policy,
      { sleep, random: () => 1 },
    );

    expect(seen).toEqual([0, 1, 2]);
  });

  test("wraps a thrown non-Error so the message survives", async () => {
    const { sleep } = fakeSleep();
    let message = "";

    await withRetry(
      async () => {
        throw "a bare string";
      },
      policy,
      { sleep, random: () => 1 },
    ).catch((error: Error) => {
      message = error.message;
    });

    expect(message).toContain("a bare string");
  });
});

describe("TRANSLATION_RETRY_POLICY", () => {
  test("bounds a request in time, not only in attempts", () => {
    // The numbers from #29, pinned so a change is a deliberate diff. A caller
    // can spend at most totalBudgetMs here, whatever the backoff does, and at
    // most maxAttempts paid calls.
    expect(TRANSLATION_RETRY_POLICY).toEqual({
      label: "Translation",
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      totalBudgetMs: 15_000,
      shouldRetry: isRetryableError,
    });
  });

  test("worst-case sleeping is seconds, not minutes", () => {
    // With jitter pinned to its maximum, the full backoff sequence is the sum
    // of the ceilings below the attempt cap. Before #29 this was ~4 minutes.
    const ceiling = TRANSLATION_RETRY_POLICY;
    let total = 0;
    for (let attempt = 0; attempt < ceiling.maxAttempts - 1; attempt++) {
      total += backoffDelay(attempt, ceiling, () => 1);
    }

    expect(total).toBe(1500);
    expect(total).toBeLessThan(ceiling.totalBudgetMs);
  });
});

describe("statusOf", () => {
  test("reads the status an SDK error carries", () => {
    expect(statusOf({ status: 401 })).toBe(401);
  });

  test("reads a numeric fetch error code", () => {
    expect(statusOf({ code: 503 })).toBe(503);
  });

  test("reports nothing for an error with no status", () => {
    expect(statusOf(new Error("socket hang up"))).toBeUndefined();
    expect(statusOf("nope")).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf({ code: "ENOTFOUND" })).toBeUndefined();
  });
});

describe("isRetryableError", () => {
  test.each([
    ["a bad credential", 401],
    ["a forbidden key", 403],
    ["a malformed request", 400],
    ["an unknown model", 404],
    ["an unprocessable request", 422],
  ])("gives up immediately on %s", (_label, status) => {
    // The case #29 is about. A revoked key produces exactly this response
    // every time, so the old policy bought ten identical rejections and a
    // four-minute delay before saying so.
    expect(isRetryableError({ status })).toBe(false);
  });

  test.each([
    ["a rate limit", 429],
    ["a request timeout", 408],
    ["a conflict", 409],
    ["a server error", 500],
    ["a bad gateway", 502],
    ["an unavailable API", 503],
  ])("retries %s", (_label, status) => {
    expect(isRetryableError({ status })).toBe(true);
  });

  test("retries a failure with no status at all", () => {
    // DNS, a reset connection, a truncated body: transport, not policy.
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  test("retries an unparseable model reply", () => {
    // Not an HTTP failure at all, and worth one more try: a reply cut off
    // mid-document is a symptom of a truncated generation, which may not repeat.
    expect(isRetryableError(new Error("Model returned a response that is not valid JSON"))).toBe(
      true,
    );
  });
});

describe("withRetry, budgets and classification", () => {
  test("stops at the first non-retryable failure", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        const error = new Error("API key not valid") as Error & { status: number };
        error.status = 400;
        throw error;
      },
      policy,
      { sleep, random: () => 1 },
    ).catch(() => undefined);

    expect(calls).toBe(1);
  });

  test("reports the attempt count it actually made", async () => {
    const { sleep } = fakeSleep();

    const promise = withRetry(
      async () => {
        throw new Error("nope");
      },
      policy,
      { sleep, random: () => 1 },
    );

    await expect(promise).rejects.toThrow("Test failed after 3 attempts: nope");
  });

  test("uses the singular when it stops after one attempt", async () => {
    const { sleep } = fakeSleep();

    const promise = withRetry(
      async () => {
        const error = new Error("API key not valid") as Error & { status: number };
        error.status = 401;
        throw error;
      },
      policy,
      { sleep, random: () => 1 },
    );

    await expect(promise).rejects.toThrow("Test failed after 1 attempt: API key not valid");
  });

  test("gives up when the next delay would land past the time budget", async () => {
    // The bound the old policy lacked. With one attempt left and no room to
    // wait, the answer is reported now rather than after a sleep the caller
    // would have already stopped waiting for.
    const { delays, sleep } = fakeSleep();
    const clock = fakeClock();
    let calls = 0;

    const impatient: RetryPolicy = {
      label: "Test",
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      totalBudgetMs: 5000,
    };

    await withRetry(
      async () => {
        calls += 1;
        clock.advance(2000);
        throw new Error("overloaded");
      },
      impatient,
      { sleep, random: () => 1, now: clock.now },
    ).catch(() => undefined);

    expect(calls).toBe(2);
    expect(delays).toEqual([1000]);
  });

  test("never sleeps past the budget even on a fast clock", async () => {
    const { delays, sleep } = fakeSleep();
    const clock = fakeClock();
    const zeroBudget: RetryPolicy = {
      label: "Test",
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      totalBudgetMs: 0,
    };

    await withRetry(
      async () => {
        throw new Error("overloaded");
      },
      zeroBudget,
      { sleep, random: () => 1, now: clock.now },
    ).catch(() => undefined);

    expect(delays).toEqual([]);
  });

  test("still succeeds inside the budget", async () => {
    // The budget must not turn a request that would have worked into a failure.
    const { delays, sleep } = fakeSleep();
    const clock = fakeClock();
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("overloaded");
        return "ok";
      },
      { ...policy, totalBudgetMs: 500 },
      { sleep, random: () => 1, now: clock.now },
    );

    expect(result).toBe("ok");
    expect(delays).toEqual([100]);
  });
});
