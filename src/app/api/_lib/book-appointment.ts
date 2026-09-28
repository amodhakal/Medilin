import "server-only";

import { getClinicName } from "@/config";
import { createAppointment } from "@/lib/appointments";
import { logError, logInfo } from "@/lib/logger";
import { sealForDelivery } from "@/lib/phi-token";
import { translateToEnglish } from "@/lib/translateToEnglish";
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
 */

export interface Booking {
  appointmentId: string;
  spectateUrl: string;
}

export async function bookAppointment(
  data: IntakeFormData,
  origin: string,
): Promise<Booking> {
  const sourceLanguage = data.language;
  logInfo("intake.received", { language: sourceLanguage });

  const translatedData = await translateToEnglish(data, sourceLanguage);
  logInfo("intake.translated", { language: sourceLanguage });

  const appointment = await createAppointment(translatedData);

  // Was `?patientInfo=${encodeURIComponent(JSON.stringify(translatedData))}`,
  // which put the whole record in the URL. Neither of the two tokens that
  // replaced it puts a record in a URL: with a durable store the link carries a
  // short reference and the record is read back server-side, and without one it
  // carries the record sealed under a single key, which is what keeps the link
  // working across serverless instances. Which of the two depends on the store,
  // and the decision belongs to sealForDelivery rather than to this call site.
  const token = sealForDelivery(JSON.stringify(translatedData), appointment.id);
  const spectateUrl = `${origin}/spectate/${token}`;

  logInfo("intake.session_url_created", { appointmentId: appointment.id });

  const mockHospitalResponse = {
    patientInfo: translatedData,
    // The clinic negotiates forward from the requested slot rather than
    // stamping `now + random(0, 24h)`; see ./schedule.
    agreedDateTime: negotiateAppointmentTime(translatedData.appointmentDateTime),
    confirmed: true,
    hospitalName: getClinicName(),
    referenceNumber: `HOSP-${appointment.id}`,
  };

  logInfo("intake.booking_simulated", { appointmentId: appointment.id });

  // Was `fetch(`${origin}/api/webhook`, { headers: internalHeaders(), ... })`:
  // an HTTP round trip to this same process, to a URL derived from the
  // request's own Host header, whose response was never inspected. The delivery
  // is a function call now, for the same reasons as #43 in the server action.
  const delivery = await deliverConfirmation({
    email: translatedData.email,
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

  return { appointmentId: appointment.id, spectateUrl };
}
