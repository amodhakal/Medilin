/**
 * What a tracking link is allowed to reveal.
 *
 * Kept apart from the page, and free of `server-only` and of any Next import,
 * so it can be unit tested. It is the security boundary of `/track`, so it is
 * also the part most worth reading.
 *
 * The token decrypts to the whole patient record: name, email, phone, date of
 * birth, insurance, and the patient's own description of their symptoms. A
 * tracking page is a link anyone might forward, screenshot, or open on a
 * shared machine, so it renders the four fields a person needs to answer "is
 * my appointment in, and when", and nothing else.
 *
 * Not rendered here, deliberately, even though the page could decrypt them:
 *
 *   date of birth   a strong identifier, and no use for a status page
 *   email, phone    the page has no way to act on them, so they would be
 *                   decoration that only adds exposure
 *   insurance       not needed to know when the appointment is
 *   additionalInfo  the patient's description of their symptoms. Putting a
 *                   symptom description on a page designed to be shared is
 *                   the single worst thing this page could do.
 *
 * A list of omissions is only useful if it is enforced, so
 * `toTrackSummary` is an allowlist and the object it returns is the only
 * thing the page has to work from. There is no path by which the wider record
 * reaches the markup.
 */

export interface TrackSummary {
  /** Used to greet, so the page can be recognised as the right person's. */
  firstName: string;
  department: string;
  language: string;
  /** Exactly as the patient submitted it: `YYYY-MM-DDTHH:mm`, no zone. */
  requestedAt: string;
}

const MAX_FIRST_NAME = 100;
const MAX_DEPARTMENT = 100;
const MAX_LANGUAGE = 32;

const REQUESTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Narrow a decrypted record to what this page renders.
 *
 * An explicit allowlist rather than a cast, for the same reason the spectate
 * page does it: a token decrypts to whatever was sealed, and the caller must
 * not be able to reach a field this module never intended to expose.
 */
export function toTrackSummary(record: unknown): TrackSummary | null {
  if (typeof record !== "object" || record === null) return null;

  const source = record as Record<string, unknown>;

  const text = (key: string, max: number): string => {
    const value = source[key];
    return typeof value === "string" ? value.slice(0, max) : "";
  };

  const firstName = text("firstName", MAX_FIRST_NAME).trim();

  // Read at its natural length rather than truncated to the accepted width.
  // Truncating first would quietly turn "2026-10-01T09:30Z" into an accepted
  // wall-clock time by chopping the suffix off, and a value carrying a zone is
  // exactly the value this page must refuse to guess about.
  const requestedAt = text("appointmentDateTime", 40).trim();

  // Two requirements, both about the link being for something.
  //
  // `firstName` because a status page that does not say whose appointment it
  // is gets forwarded by mistake and then shown to the wrong person.
  // `appointmentDateTime` because without it the page has no status to give,
  // and rendering an empty appointment is worse than saying the link is not
  // valid.
  if (!firstName) return null;
  if (!REQUESTED_AT.test(requestedAt)) return null;

  return {
    firstName,
    department: text("medical_department", MAX_DEPARTMENT) || "the clinic",
    language: text("language", MAX_LANGUAGE).toLowerCase(),
    requestedAt,
  };
}

/**
 * Spell out a submitted appointment time.
 *
 * The intake form submits `datetime-local`, which is a wall-clock time with no
 * zone: the patient picked nine thirty in the morning where they were. Parsing
 * that with `new Date()` on the server resolves it against the *server's*
 * zone, which on Vercel is UTC, so a patient in any other zone would be told
 * their appointment is at the wrong hour. Worse, it moves the *date* too for
 * anyone east or west of Greenwich, which reads as a wrong day.
 *
 * So the components are read out of the string and the calendar date is built
 * and read back in the same zone, which cannot shift it. The number is
 * formatted by hand for the same reason: `toLocaleDateString` depends on the
 * server's ICU data and locale, and a day name that differs between the build
 * machine and production is a bug nobody finds.
 *
 * What this deliberately does not do is compute a countdown or a
 * "today/tomorrow". Both need to know which zone "today" is in, and the only
 * honest answer to that is the viewer's, which the server does not have.
 * `TimeUntil` renders that in the browser instead, from the same string.
 */
export function formatRequestedAt(value: string): { date: string; time: string } | null {
  const match = REQUESTED_AT.exec(value);
  if (!match) return null;

  const year = Number(match[0].slice(0, 4));
  const month = Number(match[0].slice(5, 7));
  const day = Number(match[0].slice(8, 10));
  const hour = Number(match[0].slice(11, 13));
  const minute = Number(match[0].slice(14, 16));

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  // Constructed and read in the same zone, so the calendar date is preserved
  // exactly. `Date.UTC` plus `getUTC*` would work identically and is clearer
  // about why the zone does not matter, but a leap second in the past is the
  // only way these two disagree.
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return {
    date: `${WEEKDAYS[date.getDay()]} ${day} ${MONTHS[month - 1]} ${year}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * "in about 3 hours", "in about 25 minutes", or nothing.
 *
 * Only safe in the browser, and only when it reads the *viewer's* clock: the
 * string is the viewer's own wall-clock time, so interpreting it in the
 * viewer's zone is the one reading that is certainly right.
 */
export function timeUntilDescription(
  requestedAt: string,
  now: Date,
): { text: string; imminent: boolean } | null {
  const match = REQUESTED_AT.exec(requestedAt);
  if (!match) return null;

  const target = new Date(
    Number(match[0].slice(0, 4)),
    Number(match[0].slice(5, 7)) - 1,
    Number(match[0].slice(8, 10)),
    Number(match[0].slice(11, 13)),
    Number(match[0].slice(14, 16)),
  );

  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return null;

  if (minutes < 60) {
    return { text: `in about ${minutes} minute${minutes === 1 ? "" : "s"}`, imminent: true };
  }
  if (minutes < 60 * 24) {
    const hours = Math.round(minutes / 60);
    return { text: `in about ${hours} hour${hours === 1 ? "" : "s"}`, imminent: hours <= 3 };
  }
  const days = Math.round(minutes / (60 * 24));
  return { text: `in about ${days} day${days === 1 ? "" : "s"}`, imminent: false };
}
