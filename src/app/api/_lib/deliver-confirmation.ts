import "server-only";

import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import type { SupportedLanguage } from "@/lib/validation/intake";

/**
 * Sending the patient's confirmation email.
 *
 * The booking path used to reach this by `fetch`ing its own `/api/webhook`,
 * with the origin built from the request. That is the same self-call #43 removed
 * from the server action, with the same two problems: the destination came from
 * a client-controllable `Host` header, and a request that fails was never
 * looked at, so the booking reported success for an email that was never sent.
 *
 * So the delivery is a function and both callers use it: the booking path calls
 * it in-process, and the route handler -- which keeps its shared-secret guard,
 * because it is still an HTTP surface -- calls the same function.
 *
 * It returns a result rather than throwing. The caller needs to be able to say
 * "the email did not go out", and a function that signals that by throwing
 * pushes every caller into a try/catch that mostly forgets to check, which is
 * how the status of this call went unchecked in the first place.
 */

export interface ConfirmationRequest {
  email: string;
  language: SupportedLanguage;
  /** The hospital's response, serialised. Translated into `language`. */
  info: string;
}

export type DeliveryResult =
  | { ok: true; subject: string }
  | { ok: false; reason: DeliveryFailure };

export type DeliveryFailure = "translation_failed" | "email_failed";

/**
 * A booking whose confirmation did not go out.
 *
 * Thrown by the booking path, not by the delivery itself: the delivery reports,
 * the orchestrator decides. The reason is a closed union, never a message,
 * because this crosses into a response body and a vendor error string can
 * contain the payload it failed on.
 */
export class ConfirmationDeliveryError extends Error {
  constructor(
    readonly reason: DeliveryFailure,
    /**
     * The booking that exists without its confirmation.
     *
     * The record is stored before the email is sent, so at the point this is
     * thrown the patient genuinely has an appointment. Carrying the reference
     * means the caller can hand them the link to it instead of only a warning,
     * which is the difference between a partial success the patient can act on
     * and one that strands them.
     */
    readonly booking?: { appointmentId: string; spectateUrl: string },
  ) {
    super(`Confirmation email was not delivered: ${reason}`);
    this.name = "ConfirmationDeliveryError";
  }
}

/**
 * Translate the confirmation and send it.
 *
 * Never throws: every failure comes back as `{ ok: false }`, with a reason
 * rather than a message. A Resend or Gemini error string can echo the payload,
 * and this value is on its way to a caller that renders it.
 */
export async function deliverConfirmation(
  request: ConfirmationRequest,
): Promise<DeliveryResult> {
  let subject: string;
  let body: string;

  try {
    ({ subject, body } = await translateFromEnglish(
      request.info,
      request.language,
    ));
  } catch (error) {
    logError("webhook.translation_failed", error, { language: request.language });
    return { ok: false, reason: "translation_failed" };
  }

  try {
    const resend = new Resend(getServerEnv().RESEND_KEY);

    const { error } = await resend.emails.send({
      from: getEmailFrom(),
      to: [request.email],
      subject,
      html: body,
    });

    if (error) {
      logError("webhook.resend_failed", error, { language: request.language });
      return { ok: false, reason: "email_failed" };
    }
  } catch (error) {
    // A thrown SDK error rather than a returned one: a missing key, or the
    // network being gone. Resend returns failures as values and throws for the
    // rest, and both are "not sent".
    logError("webhook.resend_threw", error, { language: request.language });
    return { ok: false, reason: "email_failed" };
  }

  logInfo("webhook.sent", { language: request.language });

  return { ok: true, subject };
}
