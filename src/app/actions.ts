"use server";

import {
  intakeFromFormData,
  intakeSchema,
  type IntakeFormData,
} from "@/lib/validation/intake";
import { parseWith, type FieldIssue } from "@/lib/validation/parse";
import { logError } from "@/lib/logger";
import { bookAppointment } from "@/app/api/_lib/book-appointment";

/**
 * The intake server action.
 *
 * This used to `fetch` the application's own `/api/intake`:
 *
 *   const host = headers().get("host") || "localhost:3000";
 *   const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
 *   await fetch(`${protocol}://${host}/api/intake`, { ... })
 *
 * Two functions in one process, talking over HTTP to each other, to reach
 * logic that could have been a function call. Everything wrong with that
 * arrangement is a consequence of the arrangement and not of any one bug in it:
 *
 *   - The destination is built from the `Host` header, which the client
 *     controls. A request arriving with `Host: attacker.test` makes the server
 *     POST the patient's name, date of birth, phone number and symptom text to
 *     an address of the caller's choosing, with the internal request body
 *     intact. Hardening that means deciding which hosts are trustworthy, and
 *     every answer is either a list to keep current or a configuration flag
 *     that is wrong in one environment or the other.
 *   - The protocol is inferred from `NODE_ENV`, which is a build-time constant
 *     standing in for a deployment fact. Behind a TLS-terminating proxy, in a
 *     preview deployment, or on any host that is not the one the flag describes,
 *     it is simply the wrong scheme.
 *   - It costs a second function invocation, a second serialization, and a
 *     second round trip's latency to do work that was already in this process.
 *   - And it is untestable: the action cannot be exercised without a running
 *     server on the other end, which is why the two bugs in the response
 *     handling below survived as long as they did.
 *
 * So the fetch is deleted rather than hardened. The booking pipeline is a
 * function, the action calls it, and there is no URL to get wrong.
 *
 * Closes #21, #43.
 *
 * The spectate URL comes back root-relative, because the action has no
 * trustworthy absolute origin to build one from -- that was the `Host` header.
 * A relative URL is what the caller wants anyway: it is assigned to
 * `window.location.href`, which resolves it against the origin the browser
 * already trusts, so it is also correct behind a proxy or a tunnel.
 */

export type SubmitIntakeResult =
  | { ok: true; spectateUrl: string; appointmentId: string }
  | { ok: false; error: string; issues: FieldIssue[] };

export async function submitIntakeForm(formData: FormData): Promise<SubmitIntakeResult> {
  // Validate before spending anything. The form's `required` attributes are
  // a client-side convenience and are trivially bypassed, so this is the
  // only place a submission is actually checked before it reaches the API.
  const parsed = parseWith(intakeSchema, intakeFromFormData(formData));
  if (!parsed.ok) {
    return {
      ok: false,
      error: "Please check the highlighted fields",
      issues: parsed.issues,
    };
  }

  const data: IntakeFormData = parsed.data;

  try {
    const booking = await bookAppointment(data, "");

    return {
      ok: true,
      spectateUrl: booking.spectateUrl,
      appointmentId: booking.appointmentId,
    };
  } catch (error) {
    // Logged here because this path no longer goes through the route handler,
    // which is where failures used to be recorded. The message is redacted and
    // truncated by the logger, so a vendor error echoing the request payload
    // cannot carry symptom text into a log drain.
    logError("intake.failed", error);

    // Deliberately not the error. A failure here is a translation failure, and
    // a Gemini SDK error message can echo the request payload, which for this
    // app is the symptom text the patient typed. The person in front of the
    // form is told only that it did not work.
    return {
      ok: false,
      error: "We could not book that appointment. Please try again.",
      issues: [],
    };
  }
}
