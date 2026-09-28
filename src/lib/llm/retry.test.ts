import { describe, expect, test } from "bun:test";
import {
  TRANSLATION_RETRY_POLICY,
  backoffDelay,
  withRetry,
  type RetryPolicy,
} from "./retry";

const policy: RetryPolicy = {
  label: "Test",
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
};

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
  test("is the policy the translation calls actually use", () => {
    // Pinned here so a change to the policy is a deliberate diff rather than a
    // silent one. See #29 for what the numbers should be.
    expect(TRANSLATION_RETRY_POLICY).toEqual({
      label: "Translation",
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });
  });
});
