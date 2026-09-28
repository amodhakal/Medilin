import "server-only";

import { logError, logInfo, logWarn } from "@/lib/logger";
import { reserveCallBudget } from "./call-budget";
import { getTwilioVoice } from "./voice";

/**
 * Ringing the clinic, from a booking.
 *
 * The simulated receptionist used to be a log line: `intake.booking_simulated`,
 * printed between storing the record and sending the confirmation. The clinic
 * was not telephoned, so nothing about a booking ever reached a human who could
 * act on it, and the confirmation email told a patient their appointment was
 * confirmed by a system that had spoken to nobody. This is the seam that
 * replaces that line, and the branch above this one is what the call negotiates.
 *
 * ## Four answers, and none of them is an exception
 *
 * `ClinicCallReport` is a closed set, and the booking pipeline reads all of it.
 * By the time this runs the record is stored and the confirmation is about to
 * be sent, so a throw here would take down a booking that already happened, and
 * a caller that only caught the success case would report a call that was never
 * placed. Both are the failure #20 was about, in a new place:
 *
 *   - `simulated`   the deployment has no voice configured. The ordinary case,
 *                   and the one that must behave exactly as it did before this
 *                   branch existed.
 *   - `dialed`      Twilio accepted the call. The SID is its own.
 *   - `skipped`     the call was not made, and there is a stated reason: either
 *                   the budget is spent (./call-budget) or the configured
 *                   callback base is not one this app will dial through.
 *   - `failed`      Twilio refused, or the request never reached it.
 *
 * ## What is not said on the call
 *
 * The TwiML document this URL fetches is built by ./twiml and says three
 * things: the clinic's name, that the call is automated, and please pick up. No
 * patient name, no symptoms, no appointment time, no reference number -- not in
 * the speech and not in the URL, so there is nothing here for a log, a
 * proxy or a referrer to keep. A clinic line is a speakerphone in a waiting
 * room, and this call is placed while a patient's record is in scope.
 *
 * ## The part that is still a lie, and where it is fixed
 *
 * The time the patient is told was not agreed with anybody. It is the local mock
 * negotiation in ../_lib/schedule, which this branch does not touch, and it is
 * still what the confirmation says. So after this branch a real clinic line
 * rings for a booking whose time no human has seen.
 *
 * The branch stacked on this one makes the call a conversation -- the TwiML
 * fetched at the answer URL becomes a media stream into the receptionist agent
 * -- which is most of the way there, and not all of it: the agent negotiates a
 * slot out loud and the result is not yet written back onto the appointment, so
 * the email still carries the locally-negotiated time. That gap is named in
 * @/lib/twilio/media-stream and is the next piece of #3, not something this
 * module pretends to have solved.
 */

/** The route Twilio fetches its instructions from. */
export const CLINIC_CALL_ANSWER_PATH = "/api/twilio/voice/answer";

/**
 * The route Twilio posts what happened to the call to (#3).
 *
 * Two events are requested of Twilio -- `initiated` and `completed` -- rather
 * than all four, because a call this application cannot influence is not four
 * more requests to store. `initiated` is the record that a call exists;
 * `completed` is the record that the bill has stopped.
 */
export const CLINIC_CALL_STATUS_PATH = "/api/twilio/voice/status";

export type ClinicCallReport =
  | { status: "dialed"; sid: string; callStatus: string }
  | { status: "simulated" }
  | { status: "skipped"; reason: "not_configured" | "budget_exhausted" }
  | { status: "failed"; reason: "call_failed" };

/**
 * Place the call, if this deployment has the configuration for one.
 *
 * Order matters and is the argument for the whole function. The budget is
 * reserved *after* the configuration check, so an unconfigured deployment does
 * not spend the window it would need later, and *before* the vendor request,
 * because between reserving and the vendor's answer there is a call that exists
 * (./call-budget has the longer argument for why a reservation is not refunded).
 */
export async function dialClinic({
  appointmentId,
}: {
  appointmentId: string;
}): Promise<ClinicCallReport> {
  const voice = getTwilioVoice();

  if (!voice) {
    // The log line the simulated receptionist used to be, kept verbatim so
    // anything grepping for it still finds the same thing it always did.
    logInfo("intake.booking_simulated", { appointmentId });
    return { status: "simulated" };
  }

  const answerUrl = `${voice.callbackBaseUrl}${CLINIC_CALL_ANSWER_PATH}`;
  if (!isSafeCallbackUrl(answerUrl)) {
    logWarn("twilio.call_unsafe_callback_url", { appointmentId, status: "skipped" });
    return { status: "skipped", reason: "not_configured" };
  }

  const statusUrl = `${voice.callbackBaseUrl}${CLINIC_CALL_STATUS_PATH}`;

  const budget = await reserveCallBudget();
  if (!budget.allowed) {
    logWarn("twilio.call_budget_exhausted", {
      appointmentId,
      status: "skipped",
      retryAfterMs: budget.retryAfterMs,
    });
    return { status: "skipped", reason: "budget_exhausted" };
  }

  try {
    const placed = await voice.client.placeCall({
      to: voice.to,
      from: voice.from,
      twimlUrl: answerUrl,
      // Without this the only honest statement this application can make about
      // its own telephony is the one it made before the call. Omitted when the
      // status route's URL is not one it will dial, which is the same rule the
      // answer URL follows and for the same reason.
      statusCallback: isSafeCallbackUrl(statusUrl)
        ? statusUrl
        : undefined,
    });

    // The status is Twilio's own word, which is the part worth having: `queued`
    // means the call exists and is waiting, which is not the same claim as
    // "answered" and is not reported as one. The SID is a vendor identifier for
    // a call to a clinic's line; neither it nor the numbers are logged.
    logInfo("intake.booking_dialled", { appointmentId, status: placed.status });
    return { status: "dialed", sid: placed.sid, callStatus: placed.status };
  } catch (error) {
    // Twilio's own words are not in the log: its body quotes the two numbers
    // the call was between.
    logError("twilio.call_failed", error, { appointmentId, status: "failed" });
    return { status: "failed", reason: "call_failed" };
  }
}

/**
 * Is this something Twilio should fetch instructions from?
 *
 * Absolute, `https:`, and with a host. The scheme is the one that matters:
 * Twilio fetches this document and executes it on a real call, so an `http:`
 * URL is a document delivered to anyone on the path. `getTwilioVoice` already
 * refuses a plaintext base, and this is that same rule applied to the URL that
 * actually goes on the wire -- the one property that matters is a property of
 * the outgoing request, not of a variable that happened to produce it.
 */
export function isSafeCallbackUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname !== "";
}
