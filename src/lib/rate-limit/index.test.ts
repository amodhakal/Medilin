import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  callerKey,
  consume,
  enforceRateLimit,
  getRateLimitStore,
  setRateLimitStore,
  type RateLimitStore,
} from "./index";

const WINDOW = 60_000;

beforeEach(() => {
  setRateLimitStore(null);
});

afterEach(() => {
  setRateLimitStore(null);
});

function freshStore(): RateLimitStore & { sweep(n?: number): number } {
  setRateLimitStore(null);
  return getRateLimitStore() as RateLimitStore & { sweep(n?: number): number };
}

describe("consume", () => {
  test("allows up to the limit and reports remaining", async () => {
    const store = freshStore();
    expect(await consume("k", 3, WINDOW, store)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(await consume("k", 3, WINDOW, store)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(await consume("k", 3, WINDOW, store)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  test("blocks beyond the limit and reports a retry delay", async () => {
    const store = freshStore();
    for (let i = 0; i < 3; i += 1) await consume("k", 3, WINDOW, store);

    const blocked = await consume("k", 3, WINDOW, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(WINDOW);
  });

  test("keys are independent", async () => {
    const store = freshStore();
    for (let i = 0; i < 3; i += 1) await consume("a", 3, WINDOW, store);
    expect((await consume("a", 3, WINDOW, store)).allowed).toBe(false);
    expect((await consume("b", 3, WINDOW, store)).allowed).toBe(true);
  });

  test("resets once the window elapses", async () => {
    const store = freshStore();
    for (let i = 0; i < 3; i += 1) await consume("k", 2, WINDOW, store);
    expect((await consume("k", 2, WINDOW, store)).allowed).toBe(false);

    // A window that has already passed is treated as a fresh one.
    const expired = freshStore();
    for (let i = 0; i < 3; i += 1) await consume("k", 2, 1, expired);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await consume("k", 2, 1, expired)).allowed).toBe(true);
  });

  test("a key with no window reports no retry delay", async () => {
    const store = freshStore();
    expect(await store.ttl("never-seen", WINDOW)).toBe(0);
  });
});

describe("in-memory store bookkeeping", () => {
  test("sweep drops elapsed windows so the map cannot grow forever", async () => {
    const store = freshStore();
    for (let i = 0; i < 100; i += 1) {
      await consume(`k${i}`, 1, 1, store);
    }
    expect(store.sweep(Date.now() + 1000)).toBe(100);
    expect(store.sweep(Date.now() + 1000)).toBe(0);
  });
});

describe("enforceRateLimit", () => {
  test("returns null while under the limit", async () => {
    expect(await enforceRateLimit("k", 5, WINDOW)).toBeNull();
  });

  test("returns 429 with Retry-After once over", async () => {
    const store = freshStore();
    for (let i = 0; i < 5; i += 1) await consume("k", 5, WINDOW, store);

    const response = await enforceRateLimit("k", 5, WINDOW);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
    expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("callerKey", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("http://localhost/", { headers });
  }

  test("scopes the key so endpoints do not share a budget", () => {
    expect(callerKey(request({}), "intake")).toBe("intake:unknown");
    expect(callerKey(request({}), "appointments")).toBe("appointments:unknown");
  });

  test("uses the first forwarded address", () => {
    const key = callerKey(
      request({ "x-forwarded-for": "203.0.113.7, 198.51.100.2" }),
      "intake",
    );
    expect(key).toBe("intake:203.0.113.7");
  });

  test("is stable for the same address within a window", () => {
    const req = request({ "x-forwarded-for": "203.0.113.7" });
    expect(callerKey(req, "intake")).toBe(callerKey(req, "intake"));
  });
});
