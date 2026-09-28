import "server-only";

import * as crypto from "crypto";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";

/**
 * Authentication for a scheduled job.
 *
 * `INTERNAL_API_SECRET` in ./internal guards the endpoints this application's own
 * handlers call. This guards the ones a *platform* calls, and the credential is a
 * different one for a different reason: the internal secret is deliberately not a
 * browser credential, whereas a cron endpoint that anyone on the internet can reach
 * needs one that is.
 *
 * `CRON_SECRET` was declared in src/lib/env.ts and had no reader, which is the
 * state this exists to fix. It was already optional there, and that is honoured
 * rather than changed: absent, the endpoint refuses every caller. The alternative
 * -- absent meaning "no credential required" -- makes an unset variable into an
 * open relay that sends email to patients in bulk, and the failure mode is
 * "someone else's appointment list" rather than "the job does not run".
 *
 * **The header is `Authorization: Bearer`, not `x-internal-secret`.** That is what
 * Vercel sends for a cron request when `CRON_SECRET` is configured, so a custom
 * header name here would mean the job authenticating as nobody and being refused,
 * which looks identical to "the job is not running" from the outside.
 *
 * Compared in constant time, for the reason ./internal gives: a plain `===` leaks
 * the length of the matching prefix through timing.
 */

export const CRON_BEARER_PREFIX = "Bearer ";

export function verifyCronSecret(authorization: string | null): boolean {
  const expected = getServerEnv().CRON_SECRET;

  if (!expected) return false;
  if (!authorization) return false;

  const provided = authorization.startsWith(CRON_BEARER_PREFIX)
    ? authorization.slice(CRON_BEARER_PREFIX.length)
    : "";

  // A missing or malformed header becomes an empty string and is compared anyway,
  // rather than short-circuited. `timingSafeEqual` requires equal lengths, so the
  // digests are compared: that keeps the comparison constant-time whether the
  // caller's guess was 1 character or 4000.
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

type Guarded = { ok: true } | { ok: false; response: NextResponse };

/**
 * Answer 401 unless the request carries the cron shared secret.
 *
 * 401 rather than 403, and a fixed body. The caller is a scheduler: it wants to
 * know the request was not accepted, and it does not need to be told whether the
 * secret was absent, wrong, or the wrong shape.
 */
export function requireCronSecret(request: Request): Guarded {
  if (verifyCronSecret(request.headers.get("authorization"))) return { ok: true };

  return {
    ok: false,
    response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
}
