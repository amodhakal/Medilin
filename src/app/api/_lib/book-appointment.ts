import "server-only";

import { getClinicName } from "@/config";
import { createAppointment } from "@/lib/appointments";
import { logInfo } from "@/lib/logger";
import { sealRecord } from "@/lib/phi-token";
import { translateToEnglish } from "@/lib/translateToEnglish";
import type { IntakeFormData } from "@/lib/validation/intake";
import { deliverConfirmation } from "./deliver-confirmation";
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

  const appointment = createAppointment(translatedData);

  // Was `?patientInfo=${encodeURIComponent(JSON.stringify(translatedData))}`,
  // which put the whole record in the URL. The token is the record,
  // encrypted: opaque in a log or a history entry, and openable only with
  // the server-side key.
  const token = sealRecord(JSON.stringify(translatedData));
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
  // is a function call now, for the same reasons as #43 in the server action,
  // and its result is available to be checked rather than discarded.
  await deliverConfirmation({
    email: translatedData.email,
    language: sourceLanguage,
    info: JSON.stringify(mockHospitalResponse),
  });

  return { appointmentId: appointment.id, spectateUrl };
}
