import "server-only";

import { getClinicName } from "@/config";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { getTwilioMessaging, type TwilioMessageChannel } from "./messaging";

/**
 * One way to notify a patient, however many transports that ends up needing.
 *
 * The confirmation used to be an email or nothing, and it grew a second channel
 * by accident if it grew one at all -- a second `try` block in the same
 * function, a second failure mode that the caller had to learn about, and a
 * second place for patient text to be handled. So the channels are values with
 * one shape, the fan-out is this file, and a new transport is a new value
 * rather than a new branch through the delivery.
 *
 * The other thing this file is for is the rule a text message forces that an
 * email did not. An email is a document the patient asked for, delivered to an
 * address they chose, and it can carry the appointment record the clinic
 * already decided to share. A text message is none of those: it is stored by a
 * carrier, previewed on a lock screen, and read by whoever holds the handset.
 * The minimum necessary for "your appointment is confirmed" is the clinic's
 * name and the time. Everything else in the record is not sent, and -- as with
 * the logger's allowlist -- the mechanism is an allowlist rather than a
 * denylist. A field that has not been thought about cannot leak, because
 * nothing reads it.
 */

export type NotificationChannelId = "email" | "sms" | "whatsapp";

export type ChannelReport =
  | { status: "sent" }
  | { status: "skipped"; reason: "not_configured" | "no_recipient" }
  | { status: "failed"; reason: `${NotificationChannelId}_failed` };

export type ChannelReports = Partial<Record<NotificationChannelId, ChannelReport>>;

export interface NotificationRequest {
  /**
   * The translated confirmation.
   *
   * Only the email channel may use it. A translated body is the appointment
   * record rendered in prose, which is the thing the messaging channels exist
   * to avoid sending.
   */
  email: { to: string; subject: string; body: string };
  /**
   * The booking record, as an object.
   *
   * Untrusted: /api/webhook is behind a shared secret rather than behind
   * anything about the caller, and a record that arrived over it still reaches
   * a patient's handset. Channels read the fields they need by path, so a
   * caller cannot invent a field that gets interpolated.
   */
  record: Record<string, unknown> | null;
  language: "english" | "spanish" | "portuguese";
}

export interface NotificationChannel {
  readonly id: NotificationChannelId;
  /**
   * Whether this channel can run at all here.
   *
   * False for an unconfigured transport, which is reported as skipped rather
   * than as a failure: a deployment with no Twilio variables has no SMS
   * problem, it simply has no SMS.
   */
  isConfigured(): boolean;
  /** Returns its own report. A throw is caught here and reported as a failure. */
  send(request: NotificationRequest): Promise<ChannelReport>;
}

/**
 * Run every configured channel, and report each one separately.
 *
 * Channels run together and cannot affect each other: a rejected message, a
 * timeout, or a channel implementation that throws outright stops at its own
 * boundary. The alternative -- failing the whole notification because one
 * transport is down -- would tell a patient who has already received their
 * email that they have received nothing, which is the same class of lie #20 was
 * about, in the other direction.
 */
export async function notifyChannels(
  channels: readonly NotificationChannel[],
  request: NotificationRequest,
): Promise<ChannelReports> {
  const settled = await Promise.all(
    channels.map(async (channel) => {
      try {
        if (!channel.isConfigured()) {
          return [channel.id, { status: "skipped", reason: "not_configured" }] as const;
        }
        return [channel.id, await channel.send(request)] as const;
      } catch (error) {
        // The backstop. A channel is expected to classify its own failures;
        // this catches the ones it did not, and it is the reason one channel
        // cannot take the delivery down with it.
        logError(`notify.${channel.id}_failed`, error, { status: "failed" });
        return [
          channel.id,
          { status: "failed", reason: `${channel.id}_failed` },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(settled) as ChannelReports;
}

/**
 * The serialised record, or null if it is not a JSON object.
 *
 * The record reaches this module as a string because that is how the booking
 * path and the webhook both carry it. Nothing downstream can tell a parsed
 * object from a string, so the parse happens once, here, and a payload that is
 * not an object is treated as no record rather than coerced into one.
 */
export function parseBookingRecord(info: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(info);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The two values a messaging body is allowed to be built from. */
export interface MessageFacts {
  /** E.164, or null. The address the message goes to. Never in the body. */
  recipient: string | null;
  /** A timestamp label, or null. */
  appointmentTime: string | null;
}

/**
 * Read the minimum out of the booking record.
 *
 * Two paths, and the allowlist is the point:
 *
 *   - `patientInfo.phone` is the address. It is the minimum necessary for a
 *     message to arrive, and it never appears in the body -- a body reading
 *     "your confirmation for +15550100" quotes a part of the patient's record
 *     into a place that keeps it.
 *   - `agreedDateTime` is the one fact the message is about.
 *
 * Nothing else is read. Not the name, not the department, not the symptoms, not
 * the reference number, not even the clinic's name, which comes from the
 * environment instead: a `hospitalName` in a payload would be arbitrary text
 * from a caller, and the clinic name is in every message.
 */
export function readMessageFacts(record: unknown): MessageFacts {
  return {
    recipient: readPhone(readPath(record, ["patientInfo", "phone"])),
    appointmentTime: formatAgreedTime(readPath(record, ["agreedDateTime"])),
  };
}

/** Read a string at an allowlisted path, or undefined if it is not one. */
function readPath(record: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = record;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/** E.164: a country code and up to fifteen digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** Separators a person types into a phone field, and nothing else. */
const PHONE_SEPARATORS = /[\s().-]/g;

/**
 * Normalise a typed phone number, or refuse it.
 *
 * Only separators are stripped, so an extension or a stray word leaves
 * something that fails the E.164 check rather than a number that looks
 * deliverable and is not. A number without a country code is refused instead
 * of being guessed at: guessing wrong means a patient's confirmation, and
 * everything that was in it, arrives on a stranger's handset, and the carrier
 * that receives it counts as having received PHI.
 */
function readPhone(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalised = value.trim().replace(PHONE_SEPARATORS, "");
  return E164.test(normalised) ? normalised : null;
}

/** `2026-10-01T09:30:00.000Z`, the shape the scheduling path produces. */
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?Z$/;

/**
 * The agreed time, as something a patient can read.
 *
 * UTC with the zone stated, because the record stores UTC and there is no
 * clinic-timezone setting to convert it with. "09:30" alone in a message to a
 * patient in another zone is a time they will be an hour wrong about, and the
 * label costs six characters.
 *
 * A value that is not a UTC timestamp -- a prose date, a local time, an
 * impossible day -- is dropped, not repaired. The message then confirms the
 * appointment without a time, which is a worse message rather than a false
 * one.
 */
function formatAgreedTime(value: string | undefined): string | null {
  if (value === undefined) return null;

  const match = ISO_UTC.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;

  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** A timestamp that has already been through `formatAgreedTime`. */
const TIME_LABEL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;

/** Two SMS segments. 160 characters is one, and a second one costs more. */
export const MAX_MESSAGE_LENGTH = 320;

/** A clinic name is a name, not a paragraph. */
const MAX_CLINIC_NAME_LENGTH = 60;

const FALLBACK_CLINIC_NAME = "Your clinic";

/**
 * The message body, and the whole of it.
 *
 * A template and two values, each re-validated here rather than trusted from
 * the caller: a timestamp only if it is a timestamp label, a clinic name with
 * control characters removed and its length capped. There is no path by which
 * a value from the booking record becomes part of this sentence other than the
 * five words of the agreed time, and that is the point of building it here
 * instead of interpolating.
 *
 * Not translated. The translated email body is the appointment record in prose
 * -- it is what the model is given, and it is not something a text message
 * should carry in any language. Sending a short, untranslated confirmation is
 * the lesser of the two problems, and the same two facts are already in the
 * email the patient receives in their own language.
 */
export function buildMinimalBody(facts: {
  clinicName: string;
  appointmentTime: string | null;
}): string {
  const clinic = sanitiseClinicName(facts.clinicName);
  const time =
    facts.appointmentTime !== null && TIME_LABEL.test(facts.appointmentTime)
      ? facts.appointmentTime
      : null;

  const body =
    time === null
      ? `${clinic}: your appointment is confirmed.`
      : `${clinic}: your appointment is confirmed for ${time}.`;

  return body.length > MAX_MESSAGE_LENGTH
    ? `${body.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : body;
}

function sanitiseClinicName(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLINIC_NAME_LENGTH)
    .trim();

  return cleaned === "" ? FALLBACK_CLINIC_NAME : cleaned;
}

/**
 * The messaging channels this deployment can actually use.
 *
 * Empty when the TWILIO_* variables are absent, which is the ordinary case and
 * leaves the confirmation exactly as it was: one email, one code path, no
 * network call to a vendor this app has no credentials for.
 *
 * At most one, because there is one sender: a `whatsapp:`-prefixed
 * `TWILIO_FROM_NUMBER` is a WhatsApp sender, and a number without that prefix
 * is an SMS one. Sending both to the same patient would be twice the
 * disclosure and twice the cost to say the same two facts.
 */
export function messagingChannels(): NotificationChannel[] {
  const messaging = getTwilioMessaging();
  if (!messaging) return [];

  const { channel, client } = messaging;

  return [
    {
      id: channel,
      isConfigured: () => true,
      async send(request: NotificationRequest): Promise<ChannelReport> {
        const facts = readMessageFacts(request.record);
        if (facts.recipient === null) {
          // Not a failure. A booking can reach this path without a phone in its
          // record, and a message with nowhere to go is not a broken vendor.
          logWarn("notify.messaging_no_recipient", { status: "skipped" });
          return { status: "skipped", reason: "no_recipient" };
        }

        const body = buildMinimalBody({
          clinicName: getClinicName(),
          appointmentTime: facts.appointmentTime,
        });

        try {
          const accepted = await client.sendMessage({
            channel: channel as TwilioMessageChannel,
            to: facts.recipient,
            body,
          });
          // The status is Twilio's own word, and it is the only part of the
          // response worth having: the SID is a vendor identifier for a message
          // the patient is receiving, and there is nothing to match it against
          // here. The body and the number are not logged, ever.
          logInfo("notify.messaging_sent", { status: accepted.status });
          return { status: "sent" };
        } catch (error) {
          logError("notify.messaging_failed", error, { status: "failed" });
          return { status: "failed", reason: `${channel}_failed` };
        }
      },
    },
  ];
}
