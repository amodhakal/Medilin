import { NextResponse } from "next/server";
import { logError } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation/parse";
import { patientActionSchema, performPatientAction } from "../_lib/appointment-action";

/**
 * The endpoint a patient changes their own appointment through (#59).
 *
 * No such route existed. Booking was `POST /api/intake`; everything else that
 * could touch a record took the internal shared secret, which is a credential for
 * this application's own handlers and not something a patient has. So a patient
 * who could not make the time they asked for had one option: telephone the
 * clinic.
 *
 * Three decisions here, and the first is the one most worth arguing about.
 *
 * **The link travels in the body, not the URL.** Every other surface in this
 * application carries its token in the path -- /track/[token], /spectate/[id] --
 * because a page has nowhere else to put one. An endpoint does not have that
 * constraint, and a token in a path lands in the access log of every proxy and
 * CDN between here and the patient, in the browser's history, and in the
 * `Referer` of anything the response ever links to. The body does not.
 *
 * **It is not guarded by the internal secret.** That secret is deliberately
 * shared-secret-only because its endpoints are not browser endpoints. This one is
 * the opposite: a patient holding a management link *is* a browser client, and
 * the link is the whole of the authorisation. Putting a second credential in
 * front of it would mean nobody could ever use it.
 *
 * **It is rate limited anyway**, keyed on the same `callerKey` the booking routes
 * use, because the link is a bearer credential and a bearer credential in the
 * wrong hands is worth brute-forcing. The budget is small -- this is not a
 * request that costs a Gemini translation per call, but an unbounded loop of
 * cancels is still not something to hand out. Note the limit is friction and not
 * a control: `callerKey` reads a header a client can set, so rotating it defeats
 * it. It exists to make bulk automated use expensive, not to enforce a quota.
 *
 * Status codes, and why a refusal is not always the same one:
 *
 *   400  the body is not a well-formed action
 *   401  nothing, ever -- see above
 *   404  the link does not open, or names nothing. Deliberately the same answer
 *        for a token that is not one of ours, one sealed under another key, one
 *        that expired, and one whose record has gone: four situations, and
 *        distinguishing them tells a prober which they managed.
 *   409  the link opened and the appointment is real, but the action does not
 *        apply -- already used, or not permitted, or the appointment is no longer
 *        active. These are answers about a record the caller already holds a
 *        working link to, so they disclose nothing to anybody else, and they are
 *        the difference between a patient who knows what to do next and one who
 *        is left guessing.
 *
 * Nothing in a response echoes the token, the appointment id, or a field of the
 * record.
 */

const ACTION_LIMIT = 10;
const ACTION_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  const limited = await enforceRateLimit(
    callerKey(request, "appointment-actions"),
    ACTION_LIMIT,
    ACTION_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, patientActionSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const outcome = await performPatientAction(parsed.data);

    if (!outcome.ok) {
      return NextResponse.json(
        { success: false, reason: outcome.reason, error: outcome.message },
        { status: outcome.reason === "link_unusable" ? 404 : 409 },
      );
    }

    return NextResponse.json({
      success: true,
      action: outcome.action,
      // The slot the clinic agreed, in the form the record holds, so the page can
      // render the truth rather than echoing back what the patient submitted.
      appointmentDateTime: outcome.appointmentDateTime,
      // Root-relative. The origin is the caller's, and a server action has no
      // trustworthy absolute one; a relative path resolves against whichever
      // origin the patient is actually on.
      nextPath: outcome.nextPath,
      // Reported alongside a success rather than folded into it. The record
      // changed and the record is durable whether or not the email landed, and a
      // failure flag on the whole response would tell a patient their
      // reschedule did not happen.
      confirmationEmailSent: outcome.confirmationEmailSent,
    });
  } catch (error) {
    // A store that is down, or a translation that threw rather than returned. The
    // patient is told the request failed and nothing about why: the cause is
    // logged with its own redaction and the message is not, because a vendor
    // error can echo the payload it failed on.
    logError("appointment.action_failed", error);

    return NextResponse.json(
      { success: false, error: "We could not make that change. Please try again." },
      { status: 502 },
    );
  }
}

/**
 * Answer liveness without requiring a credential.
 *
 * Deliberately unauthenticated and deliberately uninformative, like the webhook's:
 * it says the process is up and nothing about the environment behind it. There is
 * no GET body to validate, so there is nothing here that could act on a token.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
