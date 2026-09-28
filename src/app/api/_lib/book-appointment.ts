import "server-only";

import { getClinicName } from "@/config";
import { createAppointment, issuePatientActions } from "@/lib/appointments";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { translateHousehold } from "@/lib/llm/household";
import { sealForDelivery } from "@/lib/phi-token";
import { translateToEnglish } from "@/lib/translateToEnglish";
import { dialClinic } from "@/lib/twilio/clinic-call";
import type { IntakeFormData } from "@/lib/validation/intake";
import { ConfirmationDeliveryError, deliverConfirmation } from "./deliver-confirmation";
import { negotiateAppointmentTime } from "./schedule";

/**
 * Booking an appointment, with no HTTP in it.
 *
 * There were two endpoints that did this. POST /api/intake translated the
 * submission, stored it, minted a spectate token and asked the internal webhook
 * to email the patient. POST /api/appointments stored it, minted a spectate
 * token, and returned the whole record to the caller. Same job, two
 * implementations, and they had already drifted: the appointments route skipped
 * translation entirely, so a Spanish submission booked through it reached the
 * confirmation email untranslated, and it echoed `patientInfo` back in the
 * response, so the one route with no reason to return PHI was the one that did.
 *
 * Neither of those is a reason to keep two endpoints. The pipeline is here, the
 * HTTP shape is in ./handle-booking, and the two routes are aliases for the same
 * handler.
 *
 * `origin` is a parameter rather than something read from the request, so that
 * every URL this builds comes from one decided value. Pass an empty string for a
 * root-relative spectate URL, which is what a caller in the same process wants:
 * there is no trustworthy absolute origin available inside a server action, and
 * a relative URL resolves against whichever origin the user is actually on.
 *
 * ## Households (#69)
 *
 * A booking may now carry other people. Two things follow from that, and both
 * are here rather than spread across the pipeline.
 *
 * Translation happens twice. `translateToEnglish` handles the account holder and
 * knows about one person; `translateHousehold` then handles everyone else, one
 * call per person. Without the second step a Spanish household would reach a
 * clinician with the child's fever still in Spanish while the parent's is
 * translated.
 *
 * The confirmation names everyone. `translateToEnglish` cannot know about the
 * household, and the email is built from the payload below, so the people are
 * listed there -- reduced to the three fields an email actually needs, because
 * the account holder supplied the rest and an email is forwarded and kept.
 *
 * A single-patient booking adds nothing to any of this: `household` is omitted
 * from the payload rather than sent empty, so the confirmation the model is
 * asked to render is byte-for-byte what it was before.
 *
 * ## The receptionist (#64)
 *
 * One thing in this file used to be a fiction. The clinic's response was
 * assembled here and the negotiation was this application's own, and the only
 * thing that made it look like a clinic had been contacted was a log line saying
 * it had not. That line is now a call: `dialClinic` places a Twilio call to the
 * clinic's line when this deployment has a Twilio account configured, and
 * reports `simulated` -- the same line, the same outcome, no vendor -- when it
 * does not.
 *
 * The schedule decision is untouched and still local, because ./schedule is
 * nobody's business in this branch and a clinic cannot be consulted from a pure
 * function. So the intermediate state is deliberate and stated rather than
 * hidden: a real call rings, and the time in the confirmation email is still one
 * this application made up. The branch stacked on top of this one is where the
 * call becomes a conversation that negotiates the slot.
 */

export interface Booking {
  appointmentId: string;
  spectateUrl: string;
  /**
   * Where the patient can move or cancel this appointment, or null if the link
   * could not be minted (#59).
   *
   * Null is a real outcome and is reported rather than hidden: it means the
   * patient has an appointment and no way to change it without telephoning, and
   * the caller is the only place that can tell anybody. The confirmation email
   * carries the same link when it exists.
   */
  manageUrl: string | null;
}

export async function bookAppointment(
  data: IntakeFormData,
  origin: string,
): Promise<Booking> {
  const sourceLanguage = data.language;
  logInfo("intake.received", { language: sourceLanguage });

  const translatedData = await translateToEnglish(data, sourceLanguage);
  logInfo("intake.translated", { language: sourceLanguage });

  // Everyone else in the booking, in the account holder's own language first and
  // then in English. A no-op, and costs nothing, for a one-person booking.
  const record = await translateHousehold(translatedData);
  const dependents = record.dependents ?? [];

  if (dependents.length > 0) {
    logInfo("intake.household_translated", { householdSize: dependents.length });
  }

  const appointment = await createAppointment(record);

  // Was `?patientInfo=${encodeURIComponent(JSON.stringify(translatedData))}`,
  // which put the whole record in the URL. Neither of the two tokens that
  // replaced it puts a record in a URL: with a durable store the link carries a
  // short reference and the record is read back server-side, and without one it
  // carries the record sealed under a single key, which is what keeps the link
  // working across serverless instances. Which of the two depends on the store,
  // and the decision belongs to sealForDelivery rather than to this call site.
  const token = sealForDelivery(JSON.stringify(record), appointment.id);
  const spectateUrl = `${origin}/spectate/${token}`;

  logInfo("intake.session_url_created", { appointmentId: appointment.id });

  // #59. The link a patient uses to move or cancel what they have just booked,
  // minted here because this is the only moment at which there is a record to
  // mint one for and an inbox to put it in. Every other route that could mint it
  // would have to be a link somebody chose to click twice.
  //
  // A failure to mint is logged and swallowed rather than failing the booking. The
  // appointment exists and the confirmation is on its way; the cost of not having
  // the link is a patient who telephones to move the appointment, which is what
  // happened to every patient before this branch existed. Failing the booking
  // instead would trade a working appointment for a working link, which is the
  // wrong way round.
  let managePath: string | null = null;
  try {
    const links = await issuePatientActions(appointment.id);
    managePath = `${origin}${links.reschedule.path}`;
  } catch (error) {
    logError("intake.manage_link_failed", error, { appointmentId: appointment.id });
  }

  const mockHospitalResponse: Record<string, unknown> = {
    patientInfo: record,
    // The clinic negotiates forward from the requested slot rather than
    // stamping `now + random(0, 24h)`; see ./schedule.
    agreedDateTime: negotiateAppointmentTime(record.appointmentDateTime),
    confirmed: true,
    hospitalName: getClinicName(),
    referenceNumber: `HOSP-${appointment.id}`,
    // Only when there is one. A payload field that is `null` in the email is a
    // broken link in an inbox; a field that is absent is not there to click.
    ...(managePath ? { manageUrl: managePath } : {}),
  };

  // Omitted entirely for a one-person booking, so the email the model is asked
  // to write does not change for anybody who is not using the new feature. The
  // three fields are the ones a confirmation needs and no more: a child's date
  // of birth is not needed to say "we have booked an appointment for Maya", and
  // this payload becomes the body of an email that gets forwarded and filed.
  if (dependents.length > 0) {
    mockHospitalResponse.household = dependents.map((person) => ({
      firstName: person.firstName,
      relationship: person.relationship,
      additionalInfo: person.additionalInfo,
    }));
  }

  // The receptionist, or the log line that stood in for one (#64).
  //
  // This was `logInfo("intake.booking_simulated")` and nothing else, which meant
  // a clinic's line was never telephoned: a patient was told their appointment
  // was confirmed by a system that had spoken to nobody. `dialClinic` places a
  // real Twilio call when the deployment has the credentials for one, and
  // returns `simulated` -- the same log line, the same outcome, no network call
  // -- when it does not, which is every deployment without a Twilio account
  // including this repository's CI.
  //
  // Awaited, and the report is deliberately not part of `Booking`. Two reasons,
  // and both of them are about what a throw here would cost. The record is
  // already stored, so a failed call would fail a booking that had happened; and
  // a caller reading only the success case would claim a call that was never
  // placed, which is #20's failure in a new place. So the call reports and this
  // function carries on to the confirmation, and the report lives in the log
  // rather than in a value that reaches a page a patient is looking at.
  //
  // The negotiated time above is still this application's own decision, made in
  // ./schedule, and no human has seen it. That is the state this branch is
  // honest about rather than fixing here: the call rings, and the branch stacked
  // on top is what the call negotiates.
  const clinicCall = await dialClinic({ appointmentId: appointment.id });
  if (clinicCall.status === "failed") {
    // Already logged with its reason by dialClinic. Recorded here as a decision
    // rather than a surprise for whoever reads the log after an incident: a
    // booking went out and the clinic was not telephoned.
    logWarn("intake.clinic_not_reached", { appointmentId: appointment.id });
  }

  // Was `fetch(`${origin}/api/webhook`, { headers: internalHeaders(), ... })`:
  // an HTTP round trip to this same process, to a URL derived from the
  // request's own Host header, whose response was never inspected. The delivery
  // is a function call now, for the same reasons as #43 in the server action.
  const delivery = await deliverConfirmation({
    email: record.email,
    language: sourceLanguage,
    info: JSON.stringify(mockHospitalResponse),
  });

  // Awaited and checked, which is the whole of #20. This used to be a
  // fire-and-forget `fetch` whose status nobody read, so a patient whose
  // confirmation email bounced was told their appointment was confirmed. The
  // appointment does exist by this point -- the record is stored above -- so
  // this throws rather than pretending otherwise, and the caller reports the
  // email as undelivered instead of claiming a booking went through cleanly.
  if (!delivery.ok) {
    logError("intake.confirmation_failed", undefined, { language: sourceLanguage });
    throw new ConfirmationDeliveryError(delivery.reason, {
      appointmentId: appointment.id,
      spectateUrl,
    });
  }

  logInfo("intake.confirmation_sent", { language: sourceLanguage });

  return { appointmentId: appointment.id, spectateUrl, manageUrl: managePath };
}
