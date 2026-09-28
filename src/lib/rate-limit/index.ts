import { NextResponse } from "next/server";

/**
 * Fixed-window rate limiting.
 *
 * /api/intake triggers a paid Gemini call and a Resend email per request, and
 * both translation helpers retry up to ten times on failure. There was no
 * limit, so a single client could exhaust the API budget in a loop.
 *
 * A fixed window is chosen over a sliding one deliberately: it needs no
 * per-request ordering, so the semantics are easy to reason about, and the
 * counter is a single increment. The cost is a boundary burst of up to 2x the
 * limit, which is acceptable for abuse control.
 *
 * The store is an interface. The in-memory implementation is correct for a
 * single process and useless across serverless instances, so production needs
 * the shared implementation; see getRateLimitStore.
 */

export interface RateLimitStore {
  /** Record a hit and return the count within the current window. */
  increment(key: string, windowMs: number): Promise<number>;
  /** Milliseconds until the current window resets. */
  ttl(key: string, windowMs: number): Promise<number>;
  reset(): void;
}

class InMemoryRateLimitStore implements RateLimitStore {
  private windows = new Map<string, { count: number; resetsAt: number }>();

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || existing.resetsAt <= now) {
      this.windows.set(key, { count: 1, resetsAt: now + windowMs });
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  async ttl(key: string, windowMs: number): Promise<number> {
    const existing = this.windows.get(key);
    if (!existing) return 0;
    return Math.max(0, existing.resetsAt - Date.now());
  }

  reset(): void {
    this.windows.clear();
  }

  /**
   * Drop windows that have already elapsed.
   *
   * Without this the map grows one entry per distinct caller key for the
   * lifetime of the process, which on a long-lived server is a slow memory
   * leak and, being unbounded, a denial-of-service surface of its own.
   */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (window.resetsAt <= now) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

let store: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (!store) store = new InMemoryRateLimitStore();
  return store;
}

/** Test seam, and the hook a shared store would be installed through. */
export function setRateLimitStore(next: RateLimitStore | null): void {
  store = next;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function consume(
  key: string,
  limit: number,
  windowMs: number,
  rateLimitStore: RateLimitStore = getRateLimitStore(),
): Promise<RateLimitResult> {
  const count = await rateLimitStore.increment(key, windowMs);

  if (count <= limit) {
    return { allowed: true, remaining: limit - count, retryAfterMs: 0 };
  }

  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: await rateLimitStore.ttl(key, windowMs),
  };
}

/** Answer 429 with Retry-After when the caller is over budget. */
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const result = await consume(key, limit, windowMs);
  if (result.allowed) return null;

  return NextResponse.json(
    {
      error: "Too many requests. Please try again shortly.",
      retryAfterMs: result.retryAfterMs,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)),
      },
    },
  );
}

/**
 * Identify the caller.
 *
 * On Vercel the connecting address arrives in x-forwarded-for, which a client
 * can also set, so this is abuse friction rather than a hard control: rotating
 * the header defeats it. It is here to make bulk automated use expensive, not
 * to enforce a quota.
 *
 * The key stays in the in-memory store for the length of a window and is never
 * logged or forwarded, so it is not worth hashing to avoid a round trip to
 * plain text. If the store ever moves to Redis, hash it there.
 */
export function callerKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const address = forwarded?.split(",")[0]?.trim() || "unknown";
  return `${scope}:${address}`;
}
