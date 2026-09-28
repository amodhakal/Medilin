import "server-only";

import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import {
  messagingChannels,
  notifyChannels,
  parseBookingRecord,
  type ChannelReports,
  type NotificationChannel,
  type NotificationRequest,
} from "@/lib/twilio/notification";
import type { SupportedLanguage } from "@/lib/validation/intake";
import { buildAppointmentIcs, buildIcsEvent, parseAppointmentDetails } from "./ics";

/**
 * Sending the patient their confirmation.
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
 *
 * The channels are values, not branches (#60). Sending by SMS and WhatsApp too
 * is the same call the booking path already makes, with the transports behind
 * @/lib/twilio/notification; what that module contributes here is a per-channel
 * report, and the guarantee that a text message carries none of the appointment
 * record the email carries.
 *
 * What has not changed is the promise. The email is still the channel whose
 * failure means the patient was not told, and `ok` still answers to the email
 * alone: a deployment with no TWILIO_* variables sends exactly one message
 * through exactly one code path, and one that is refused a text is a delivery
 * that succeeded.
 */

export interface ConfirmationRequest {
  email: string;
  language: SupportedLanguage;
  /** The hospital's response, serialised. Translated into `language`. */
  info: string;
  /**
   * Explicit appointment details for the calendar invite.
   *
   * When omitted, the invite is derived from `info` (which carries the
   * negotiated `agreedDateTime`): the booking path needs no changes to get
   * the attachment, and callers that already know the slot can pass it
   * directly instead.
   */
  appointment?: {
    startIso: string;
    summary?: string;
    description?: string;
    durationMinutes?: number;
  };
}

export type DeliveryResult =
  | { ok: true; subject: string; channels: ChannelReports }
  | { ok: false; reason: DeliveryFailure; channels: ChannelReports };

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

/** A file sent alongside the email, as Resend's attachment shape. */
interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/**
 * The calendar invite (#58), built outside the channel and handed in.
 *
 * A hand-rolled VCALENDAR attached as `appointment.ics`, so the patient can add
 * the negotiated slot to their diary straight from the email. Built after
 * translation so a broken invite can never fail the delivery: no invite means
 * "send without the attachment", never "do not send".
 */
function buildConfirmationAttachments(
  request: ConfirmationRequest,
): EmailAttachment[] | undefined {
  try {
    const ics = request.appointment
      ? buildIcsEvent({
          startIso: request.appointment.startIso,
          durationMinutes: request.appointment.durationMinutes,
          summary: request.appointment.summary ?? "Medical appointment",
          description: request.appointment.description,
        })
      : (() => {
          const details = parseAppointmentDetails(request.info);
          return details ? buildAppointmentIcs(details) : null;
        })();

    if (!ics) return undefined;

    return [
      {
        filename: "appointment.ics",
        content: Buffer.from(ics, "utf-8"),
        contentType: "text/calendar; method=PUBLISH",
      },
    ];
  } catch (error) {
    logError("webhook.ics_failed", error, { language: request.language });
    return undefined;
  }
}

/**
 * The email, as a channel.
 *
 * A value rather than a `try` block in the middle of a function, so that
 * adding a transport is adding a line to a list. The reporting is the old
 * reporting, unchanged: Resend returns failures as values and throws for the
 * rest, and both are "not sent" with the same reason and the same log line.
 */
function emailChannel(attachments?: EmailAttachment[]): NotificationChannel {
  return {
    id: "email",
    isConfigured: () => true,
    async send({ email, language }: NotificationRequest) {
      const subject = email.subject;
      const body = email.body;

      try {
        const resend = new Resend(getServerEnv().RESEND_KEY);

        const { error } = await resend.emails.send({
          from: getEmailFrom(),
          to: [email.to],
          subject,
          html: body,
          ...(attachments ? { attachments } : {}),
        });

        if (error) {
          logError("webhook.resend_failed", error, { language });
          return { status: "failed", reason: "email_failed" };
        }
      } catch (error) {
        // A thrown SDK error rather than a returned one: a missing key, or the
        // network being gone. Resend returns failures as values and throws for
        // the rest, and both are "not sent".
        logError("webhook.resend_threw", error, { language });
        return { status: "failed", reason: "email_failed" };
      }

      return { status: "sent" };
    },
  };
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
    return { ok: false, reason: "translation_failed", channels: {} };
  }

  const channels = await notifyChannels(
    [emailChannel(buildConfirmationAttachments(request)), ...messagingChannels()],
    {
      email: { to: request.email, subject, body },
      // Read once, here, so that every channel is reading the same parse of
      // the same string. A record that is not an object is passed on as null
      // and the messaging channels have nothing to address, rather than a
      // channel inventing its own reading of it.
      record: parseBookingRecord(request.info),
      language: request.language,
    },
  );

  // The email decides, as it always has. A text message is a second way to
  // reach a patient who has already been reached, so its failure is reported
  // and logged rather than escalated into "the confirmation did not go out" --
  // the booking path would throw on that, and a patient holding the email would
  // be told to contact the clinic about an appointment that was confirmed.
  if (channels.email?.status !== "sent") {
    return { ok: false, reason: "email_failed", channels };
  }

  logInfo("webhook.sent", { language: request.language });

  return { ok: true, subject, channels };
}
