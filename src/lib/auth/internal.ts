import "server-only";

import * as crypto from "crypto";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";

/**
 * Shared-secret authentication for internal service-to-service calls.
 *
 * The endpoints this guards take no browser session, because they are not
 * browser endpoints: they are called by this app's own handlers. A session
 * cookie would be the wrong tool, and the previous state, where the endpoints
 * took no credential at all, meant anyone on the internet could reach them.
 *
 * The secret is compared in constant time. A plain `===` leaks the length of
 * the matching prefix through timing, which is enough to recover a short
 * secret one character at a time.
 */

export const INTERNAL_SECRET_HEADER = "x-internal-secret";

export function verifyInternalSecret(provided: string | null): boolean {
  const expected = getServerEnv().INTERNAL_API_SECRET;

  if (!expected) {
    // Fail closed. An unset secret must not mean "no secret required",
    // because the failure mode is an open relay rather than a broken deploy.
    return false;
  }

  if (!provided) return false;

  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

type Guarded<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

/** Answer 401 unless the request carries the internal shared secret. */
export function requireInternalSecret(request: Request): Guarded<true> {
  if (verifyInternalSecret(request.headers.get(INTERNAL_SECRET_HEADER))) {
    return { ok: true, value: true };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    ),
  };
}

/** Attach the secret to an outgoing internal request. */
export function internalHeaders(): Record<string, string> {
  const secret = getServerEnv().INTERNAL_API_SECRET;
  if (!secret) {
    throw new Error(
      "INTERNAL_API_SECRET is not set, so internal calls cannot be authenticated.",
    );
  }
  return { "Content-Type": "application/json", [INTERNAL_SECRET_HEADER]: secret };
}
