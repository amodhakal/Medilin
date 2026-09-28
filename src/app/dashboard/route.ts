import { NextResponse } from "next/server";

import { getClinicName } from "@/config";
import { CLINIC_MAX_OFFSET, listClinicSchedule } from "@/lib/appointments";
import { AUDIT_ACTORS } from "@/lib/audit";
import { requireInternalSecret } from "@/lib/auth/internal";
import { toClinicScheduleView } from "@/lib/clinic/schedule-view";
import { logError } from "@/lib/logger";
import { DASHBOARD_STYLES, renderScheduleView } from "./ScheduleView";

/**
 * GET /dashboard -- the clinic's list of appointments (#63).
 *
 * The one surface in this application that shows a clinician everything a patient
 * record holds: the symptoms, the date of birth, the contact details, the
 * insurance answer. `/track/[token]` decrypts the same record and renders four
 * fields, on purpose, because that link is designed to survive being forwarded.
 * The two are not variants of each other, and the code that decides which is
 * which is the allowlist in `src/lib/clinic/schedule-view.ts` -- read it before
 * changing what appears on this page. It is written as an explicit list so that
 * the boundary is reviewable in a diff rather than argued at every call site.
 *
 * **It is a route handler behind the internal shared secret, and not a page.**
 * The reasoning is the one `api/intake-summary` gives, and it is a constraint
 * rather than a preference: a page cannot carry a custom request header, so a
 * page behind this gate would need the secret in the query string, and a shared
 * secret in a URL is in every access log, browser history entry and Referer
 * header on the path. A route handler is what the mechanism in
 * `src/lib/auth/internal.ts` actually supports. The cost is worth stating rather
 * than hiding: a browser typing `/dashboard` gets a 401, because a browser cannot
 * present the credential this application has. The surface is therefore for the
 * clinic's own tooling and terminals:
 *
 *   curl -H "x-internal-secret: $INTERNAL_API_SECRET" https://the-clinic/dashboard
 *
 * **The shared secret is not a clinician identity, and this route does not pretend
 * it is one.** There is no user system in this application: no accounts, no
 * sessions, no clinician records. The secret says "this caller is part of this
 * deployment" and nothing more. It cannot say which member of staff asked, it
 * cannot be revoked for one person without breaking it for all of them, and
 * whoever holds it sees every patient rather than one clinic's own list. The
 * audit entry this route produces is `CLINIC_SCHEDULE_READ` attributed to
 * `internal-api`, which is exactly as far as the trail can honestly reach. That
 * is a real gap in a real control, and the PR says so in as many words: this is
 * the best gate the codebase has and it is not authentication.
 *
 * **Bounded.** One page, `CLINIC_PAGE_SIZE` records, and an offset the store will
 * not page past `CLINIC_MAX_OFFSET`. A clinic with more live appointments than
 * that gets a notice on the page rather than a list that stops without saying so,
 * because a list that stops quietly is indistinguishable from a clinic whose last
 * booking was this morning.
 *
 * **Nothing is cached, anywhere.** The body is PHI, so every response carries
 * `Cache-Control: private, no-store` -- refusals included -- and `X-Robots-Tag`,
 * so that a crawler never gets hold of a page full of patient records. The
 * `Referrer-Policy`, `X-Frame-Options` and `X-Content-Type-Options` headers are
 * set for every route in next.config.ts and are not repeated here.
 *
 * **The trail is written by the facade, not here.** `listClinicSchedule` opens the
 * page, records an entry per record and throws if it cannot, so this route cannot
 * serve a page it was unable to log -- and a caller cannot get the same records by
 * some other route and lose the entry.
 */

/** Rendered per request. A page of PHI is never prerendered and never cached. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  // In front of everything, including the query string: a refused caller learns
  // nothing about the clinic, and a wrong guess costs no database round trip.
  const guard = requireInternalSecret(request);
  if (!guard.ok) return withHeaders(guard.response);

  const offset = parseOffset(new URL(request.url).searchParams.get("offset"));
  if (offset === null) {
    return withHeaders(
      new NextResponse("The offset is not a page number.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  let page: Awaited<ReturnType<typeof listClinicSchedule>>;
  let body: string;

  try {
    // The actor is the guard's finding and nothing more: whoever holds the shared
    // secret. See the note above -- a role, not a person.
    page = await listClinicSchedule(AUDIT_ACTORS.internalApi, { offset });
    body = renderScheduleView({
      clinicName: getClinicName(),
      rows: toClinicScheduleView(page.appointments, new Date()),
      offset: page.offset,
      limit: page.limit,
      nextOffset: page.nextOffset,
      truncated: page.truncated,
      furthestOffset: CLINIC_MAX_OFFSET,
    });
  } catch (error) {
    // A store that is down and a trail that cannot be written arrive here, and
    // from a clinician's side they are the same failure: no page, rather than a
    // page nobody recorded. The error goes to the redacting logger and nothing of
    // its message reaches the response, because a store or driver error can quote
    // what it was reading.
    logError("dashboard.failed", error);

    return withHeaders(
      new NextResponse("The appointment list could not be loaded.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  return withHeaders(
    new Response(document(body), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
}

/**
 * The page number asked for, or `null` if that is not one.
 *
 * A 400 rather than a silent clamp, and the difference is the point: this value
 * is caller-supplied, and a "helpful" fallback would be an attacker's string
 * echoed back into the markup. A number is a number; anything else is refused
 * before a single record is opened. The upper bound is not checked here because
 * the store clamps that, and reports the clamp as `truncated` -- which is a fact
 * about the clinic's size rather than a mistake in the request.
 */
function parseOffset(value: string | null): number | null {
  if (value === null || value === "") return 0;
  // Nine digits, digits only. No sign, no exponent, no whitespace, nothing a
  // `Number()` would quietly accept and turn into a number nobody asked for.
  if (!/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/**
 * Wrap rendered markup in a document.
 *
 * Hand-built because a route handler is not the App Router: it has no layout, no
 * metadata export and no hashed stylesheet to link. The only untrusted string that
 * reaches this function is `body`, and React has already escaped every field in
 * it on the way out of `ScheduleView`. The stylesheet is a constant in the
 * repository, and no request can reach it.
 */
function document(body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    // No index, no archive, no snippet: this is a page of protected health
    // information, and a search result or a cache is a copy of it somewhere
    // nobody chose.
    '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet" />',
    "<title>Appointments</title>",
    `<style>${DASHBOARD_STYLES}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("");
}

/**
 * The same headers on every response this route gives.
 *
 * Including the refusals. A cacheable 401 is a durable answer to "is this
 * endpoint there", and a route that says `no-store` on its 200 should not leave
 * that to the 401 by accident.
 */
function withHeaders(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  return response;
}
