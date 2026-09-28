/**
 * Hand-rolled iCalendar (.ics) generation for appointment confirmations (#58).
 *
 * No OAuth, no calendar sync: the confirmation email carries a VCALENDAR
 * attachment the patient's mail client can add to their diary. There is no
 * dependency here on purpose -- this is string building against RFC 5545, and
 * pulling in an `ics` package for one VEVENT would trade a stable pure
 * function for a supply chain.
 *
 * Everything is a pure function of its arguments so it can be asserted without
 * a clock, a network, or Resend.
 */

/** Default appointment length when the caller does not say otherwise. */
export const APPOINTMENT_DURATION_MINUTES = 30;

export interface IcsEventOptions {
  /** ISO-8601 start of the appointment, e.g. the negotiated `agreedDateTime`. */
  startIso: string;
  /** Length in minutes. Defaults to {@link APPOINTMENT_DURATION_MINUTES}. */
  durationMinutes?: number;
  /** Short human summary, e.g. "Appointment at <clinic>". */
  summary: string;
  /** Longer description; newlines are escaped per RFC 5545. */
  description?: string;
  /** Where the appointment takes place. */
  location?: string;
  /** Stable event id. Generated from the reference when omitted. */
  uid?: string;
  /** Reference shown to the patient, e.g. "HOSP-<id>". */
  referenceNumber?: string;
  /** DTSTAMP override, for tests. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Escape free text for an RFC 5545 content line: backslash, semicolon, comma,
 * and newlines (CRLF or LF become `\n`).
 */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Format a Date as an RFC 5545 UTC date-time: `YYYYMMDDTHHMMSSZ`.
 */
export function formatIcsDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Fold a content line longer than 75 characters: emit CRLF + single space and
 * continue. Folding on UTF-16 code units rather than octets, which is exact
 * for the ASCII this clinic emits and close enough otherwise.
 */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  let out = "";
  let rest = line;
  out += rest.slice(0, 75);
  rest = rest.slice(75);
  while (rest.length > 0) {
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

function foldJoin(lines: string[]): string {
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * Build a single-event VCALENDAR document.
 *
 * Returns `null` when `startIso` does not parse, so the caller can send the
 * confirmation without an attachment rather than a broken invite. Never
 * throws for bad input: an unparseable date is a missing attachment, not a
 * failed delivery.
 */
export function buildIcsEvent(options: IcsEventOptions): string | null {
  const start = new Date(Date.parse(options.startIso));
  if (Number.isNaN(start.getTime())) return null;

  const durationMinutes =
    options.durationMinutes ?? APPOINTMENT_DURATION_MINUTES;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const stamp = options.now ?? new Date();
  const uid =
    options.uid ??
    `${options.referenceNumber ?? `${start.getTime()}`}-appointment@medilin`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Medilin//Appointment//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatIcsDateTime(stamp)}`,
    `DTSTART:${formatIcsDateTime(start)}`,
    `DTEND:${formatIcsDateTime(end)}`,
    `SUMMARY:${escapeIcsText(options.summary)}`,
  ];

  if (options.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeIcsText(options.description)}`);
  }
  if (options.location !== undefined) {
    lines.push(`LOCATION:${escapeIcsText(options.location)}`);
  }
  if (options.referenceNumber !== undefined) {
    lines.push(`X-MEDILIN-REFERENCE:${escapeIcsText(options.referenceNumber)}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return foldJoin(lines);
}

export interface AppointmentIcsInput {
  /** The negotiated time, straight from the booking response. */
  agreedDateTimeIso: string;
  hospitalName?: string;
  referenceNumber?: string;
  durationMinutes?: number;
  now?: Date;
}

/**
 * Convenience wrapper over {@link buildIcsEvent} for the booking path: the
 * summary names the clinic, the description carries the reference so a
 * patient reading the invite knows which booking it is.
 */
export function buildAppointmentIcs(
  input: AppointmentIcsInput,
): string | null {
  const summary = input.hospitalName
    ? `Appointment at ${input.hospitalName}`
    : "Medical appointment";
  const description = input.referenceNumber
    ? `Reference: ${input.referenceNumber}`
    : undefined;
  return buildIcsEvent({
    startIso: input.agreedDateTimeIso,
    durationMinutes: input.durationMinutes,
    summary,
    description,
    location: input.hospitalName,
    referenceNumber: input.referenceNumber,
    now: input.now,
  });
}

export interface ParsedAppointmentDetails {
  agreedDateTimeIso: string;
  hospitalName?: string;
  referenceNumber?: string;
}

/**
 * Recover the appointment details a confirmation needs from the serialised
 * hospital response.
 *
 * The booking path stores `agreedDateTime`, `hospitalName` and
 * `referenceNumber` in the `info` string it hands the delivery layer, so
 * parsing that response is what lets the invite exist without the caller
 * having to restate the slot it just negotiated -- restating it would be a
 * second source of truth for one time.
 *
 * Returns `null` for anything unusable -- not JSON, not an object, no
 * `agreedDateTime`, or a time that does not parse. The caller then sends the
 * email with no attachment, which is a degraded confirmation rather than a
 * broken one: a patient who gets the email without an invite can still turn
 * up, and a patient who gets no email cannot.
 */
export function parseAppointmentDetails(
  info: string,
): ParsedAppointmentDetails | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(info);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const agreedDateTimeIso = record["agreedDateTime"];
  if (typeof agreedDateTimeIso !== "string") return null;
  if (Number.isNaN(Date.parse(agreedDateTimeIso))) return null;

  const hospitalName = record["hospitalName"];
  const referenceNumber = record["referenceNumber"];
  return {
    agreedDateTimeIso,
    hospitalName: typeof hospitalName === "string" ? hospitalName : undefined,
    referenceNumber:
      typeof referenceNumber === "string" ? referenceNumber : undefined,
  };
}
