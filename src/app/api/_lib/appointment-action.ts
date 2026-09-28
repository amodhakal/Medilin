import "server-only";

import { z } from "zod";
import { getClinicName } from "@/config";
import {
  cancelAppointment,
  issuePatientActions,
  rescheduleAppointment,
  spendPatientAction,
  type Appointment,
  type PatientAction,
  type PatientActionRefusal,
} from "@/lib/appointments";
import { AUDIT_ACTORS } from "@/lib/audit";
import { logError, logInfo } from "@/lib/logger";
import { negotiateAppointmentTime } from "./schedule";
import { deliverConfirmation } from "./deliver-confirmation";

/**
 * A patient rescheduling or cancelling through their own link (#59).
 *
 * There was no such thing. `POST /api/intake` booked an appointment, and the
 * only other ways to touch one were the internal-secret status lookup and the
 * booking pipeline itself -- so a patient who could not make the time they had
 * asked for had exactly one option, which was to telephone the clinic. The
 * tracks and slots already exist in ./schedule; none of them were reachable.
 *
 * Three decisions worth arguing about.
 *
 * **The time is negotiated, not accepted.** The patient submits the slot they
 * want and `./schedule` decides what the clinic agrees to. It is called exactly
 * as booking calls it and its signature is not extended, because the conflict
 * and alternative machinery of #66 is being built against the same function in
 * another stack. What is written to the record is the time the clinic *agreed*,
 * not the one the patient asked for -- which is what the booking confirmation
 * email has always told them, and which nothing was persisting.
 *
 * `negotiateAppointmentTime` returns an ISO instant and the record holds a
 * zoneless `YYYY-MM-DDTHH:mm`, so the two are converted by `toLocalSlot` rather
 * than stored in a second format. A record holding both would mean two answers
 * to "when is this appointment" depending on which field a caller read.
 *
 * **A reschedule mints a replacement link, and mints it after the write.** The
 * old link is spent the moment it is presented, which is what makes it
 * single-use, and a patient who reschedules and then cannot open their link
 * again is stranded. So the new capability is recorded before the email is
 * attempted and handed back whatever happens to the email -- the same decision
 * `bookAppointment` makes when a confirmation bounces, for the same reason: a
 * partial success the patient can act on beats a complete one they cannot.
 *
 * Minting it *before* the write instead would be wrong in the other direction: a
 * live link to an appointment that was never moved, which is the same class of
 * bug as a confirmation email for a booking that did not happen.
 *
 * **A refusal that arrives after authorisation is still a refusal.** The grant
 * was live and the record was there a moment ago, and then it was not, which is
 * the record disappearing underneath a request that had already been accepted.
 * That is reported as an unusable link rather than as a server error, because the
 * patient's next move is to ask for a fresh one and a 500 sends them nowhere.
 */

/** The same shape `datetime-local` submits, and the same one the record holds. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const rescheduleSchema = z
  .object({
    token: z.string().min(1).max(4096),
    action: z.literal("reschedule"),
    appointmentDateTime: z
      .string()
      .regex(LOCAL_DATE_TIME, "Use YYYY-MM-DDTHH:mm")
      .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a real date and time"),
  })
  .strict();

const cancelSchema = z
  .object({
    token: z.string().min(1).max(4096),
    action: z.literal("cancel"),
  })
  .strict();

/**
 * Strict, and discriminated on `action`.
 *
 * Strict because this is the only body in the application that can change an
 * appointment, and an unknown key in a body like this is either a bug or an
 * attempt at one: there is no optional field here for a caller to get wrong by
 * omitting. Discriminated because the two actions take different fields, and a
 * union where `appointmentDateTime` is optional on both would accept a cancel
 * with a time in it and then ignore the time.
 */
export const patientActionSchema = z.discriminatedUnion("action", [
  rescheduleSchema,
  cancelSchema,
]);

export type PatientActionRequest = z.infer<typeof patientActionSchema>;

/**
 * What the caller is told, and what it is allowed to be told.
 *
 * The mapping lives here rather than at the call site because it is the part that
 * must not drift between the page and the endpoint: a patient shown "this link
 * has already been used" and then told "this link is not valid" has learned
 * nothing and lost the ability to act.
 *
 * Fixed copy throughout. Nothing in it echoes the token, the appointment id, or
 * any field of the record -- these four strings are the whole of what a link that
 * did not work discloses, and a refusal is the response an attacker is most
 * likely to be collecting.
 */
export const REFUSAL_MESSAGES: Record<PatientActionRefusal, string> = {
  link_unusable:
    "This link does not open. It may have expired, or it may not be a link we made.",
  already_used:
    "This link has already been used. Every link works once, and yours has been spent.",
  not_permitted: "This link does not allow that.",
  not_active: "This appointment is no longer active, so there is nothing to change.",
};

export type PatientActionOutcome =
  | {
      ok: true;
      action: PatientAction;
      /** The slot now on the record, in the form the record holds. */
      appointmentDateTime: string;
      /** Where to send the patient next. Root-relative. Null after a cancel. */
      nextPath: string | null;
      confirmationEmailSent: boolean;
    }
  | { ok: false; reason: PatientActionRefusal; message: string };

/**
 * Apply a patient action.
 *
 * `now` and `random` are injected so the negotiated time can be asserted exactly.
 * Both default to the real clock and the real generator, which is what a route
 * passes and what a test does not.
 */
export async function performPatientAction(
  request: PatientActionRequest,
  options: { now?: number; random?: () => number } = {},
): Promise<PatientActionOutcome> {
  const now = options.now ?? Date.now();

  const spent = await spendPatientAction(request.token, request.action, { now });
  if (!spent.ok) {
    // The refusal is already in the trail and already logged by
    // `spendPatientAction`; nothing is added here, and in particular the token is
    // not logged.
    return { ok: false, reason: spent.reason, message: REFUSAL_MESSAGES[spent.reason] };
  }

  const appointment = spent.appointment;
  const clinic = getClinicName();

  const updated =
    request.action === "reschedule"
      ? await rescheduleAppointment(
          appointment,
          toLocalSlot(
            negotiateAppointmentTime(request.appointmentDateTime, now, options.random),
          ),
        )
      : await cancelAppointment(appointment.id, AUDIT_ACTORS.patientLink);

  if (!updated) {
    return {
      ok: false,
      reason: "link_unusable",
      message: REFUSAL_MESSAGES.link_unusable,
    };
  }

  const nextPath =
    request.action === "reschedule" ? await mintNextLink(updated.id, now) : null;

  const delivery = await deliverConfirmation({
    email: updated.patientInfo.email,
    // The language the patient used on the form, which is the one their
    // confirmation is in. Rescheduling does not translate anything: the record's
    // fields are already in English and the delivery step translates the response,
    // exactly as booking does.
    language: updated.patientInfo.language,
    info: confirmationText(updated, request.action, clinic),
  });

  logInfo("appointment.action_applied", {
    appointmentId: updated.id,
    action: request.action,
    status: updated.status,
  });

  // The outcome is a success whether or not the email landed. The record changed,
  // the record is durable, and the patient has a page that shows them so. The
  // email flag travels alongside rather than rolling anything back, because there
  // is nothing to roll back to: an appointment that was rescheduled and not
  // emailed is a state the clinic can see and fix, and an appointment reported as
  // failed after it was written is one the patient may book a second time on top
  // of.
  return {
    ok: true,
    action: request.action,
    appointmentDateTime: updated.patientInfo.appointmentDateTime,
    nextPath,
    confirmationEmailSent: delivery.ok,
  };
}

/**
 * Mint the replacement link for a rescheduled appointment.
 *
 * Null rather than a thrown error, and the reason is the ordering in
 * `performPatientAction`: this runs after the appointment has already moved, and
 * failing the whole request over the convenience link would report a reschedule
 * that happened as one that did not. The caller is told, and the page falls back
 * to asking for a fresh link.
 */
async function mintNextLink(appointmentId: string, now: number): Promise<string | null> {
  try {
    const links = await issuePatientActions(appointmentId, { now });
    return links.reschedule.path;
  } catch (error) {
    logError("appointment.next_link_failed", error, { appointmentId });
    return null;
  }
}

/**
 * An agreed instant, in the form the record holds.
 *
 * `negotiateAppointmentTime` returns an ISO-8601 instant; the record holds a
 * wall-clock time with no zone, which is what `intakeSchema` validates, what
 * ./schedule parses, and what the tracking page renders. Read out and rebuilt in
 * the server's own zone -- the inverse of what `formatRequestedAt` does on the
 * way out, and the only conversion that cannot move the calendar date.
 */
export function toLocalSlot(agreed: string): string {
  const date = new Date(agreed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "The clinic agreed a time that is not a date. Refusing to write it to a record.",
    );
  }

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * What the patient is told, as the serialised response `deliverConfirmation`
 * translates.
 *
 * Deliberately the same shape the booking confirmation already sends: it is the
 * same inbox, the same recipient, and there is one thing this clinic knows how to
 * render. `additionalInfo` is emptied rather than omitted, so the shape stays the
 * one the translation prompt already handles.
 */
function confirmationText(
  appointment: Appointment,
  action: PatientAction,
  clinicName: string,
): string {
  return JSON.stringify({
    patientInfo: { ...appointment.patientInfo, additionalInfo: "" },
    confirmed: action === "reschedule",
    ...(action === "cancel" ? { cancelled: true } : { rescheduled: true }),
    hospitalName: clinicName,
    referenceNumber: `HOSP-${appointment.id}`,
  });
}
