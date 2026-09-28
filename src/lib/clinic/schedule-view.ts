import type { Appointment, AppointmentStatus } from "@/lib/appointments/store";

/**
 * What the clinic dashboard shows, and the boundary that is the whole feature.
 *
 * There are now two surfaces in this application that read the same patient
 * record, and they are opposites on purpose.
 *
 *   `/track/[token]`  four fields, on a link designed to survive being forwarded
 *   `/dashboard`      everything, for whoever holds the internal shared secret
 *
 * `/track` decrypts the whole record too. Its allowlist is in
 * `src/app/track/[token]/summary.ts` and it is a refusal: date of birth, email,
 * phone, insurance and the patient's own description of their symptoms are all
 * available to that page and none of them are rendered. This module is the
 * opposite list, and the escalation is explicit rather than incidental: a
 * clinician in a consulting room needs the date of birth to confirm who is in
 * front of them, the contact details to call about a change, the insurance
 * answer before billing, the department to know which clinic they are in, the
 * language to know an interpreter is needed, and the patient's own account of
 * their symptoms, which is the single most clinically important field in the
 * record and the one `/track` exists to keep off a shareable page.
 *
 * So: **this module must not be reachable from anything a patient can be handed
 * a link to.** It is not a superset of `toTrackSummary` that someone could reach
 * by accident, it does not import from it, and the tests beside it assert the
 * difference in both directions. The gate is in `src/app/dashboard/route.ts`.
 *
 * The shape of it is an allowlist for the same reason `/track`'s is: the view
 * renders what this function returns and has no other way to reach a field, so a
 * key somebody adds to a record later is not a field that appears on a
 * clinician's screen by accident.
 *
 * The `Appointment` type says the record is an `AppointmentRecord`, and it is --
 * on the way in, through the intake schema. On the way *out* of the durable
 * store it is whatever `JSON.parse` produced, because `open()` in
 * ../appointments/postgres-store validates that a row decrypts and not that the
 * plaintext inside it is well formed. So every field below is read defensively
 * rather than trusted through the type. The cost is a few lines of `text()`; the
 * alternative is a dashboard that throws on one malformed record, and a clinician
 * who cannot see the other nineteen.
 */

/** The person the booking is for, as a clinician needs them. */
export interface ClinicPatient {
  firstName: string;
  lastName: string;
  /** `YYYY-MM-DD`. The strongest identifier on the record, and wanted here. */
  dob: string;
  email: string;
  phone: string;
  insurance: "yes" | "no" | "unknown";
}

/**
 * Somebody else in the same booking (#69).
 *
 * A dependent has no appointment slot and no contact details of their own, so
 * this is deliberately not a `ClinicPatient`: a child brought in by a parent is
 * not contactable at that child's own email address, and a view that offered
 * one would be offering an empty string.
 */
export interface ClinicHouseholdMember {
  firstName: string;
  /** Optional in the schema -- a child is often recorded under the parent's name. */
  lastName: string | null;
  dob: string;
  relationship: string;
  additionalInfo: string;
}

export interface ClinicAppointmentRow {
  /** The store's own id. Not a credential: it is not a sealed token and holds no PHI. */
  id: string;
  status: AppointmentStatus;
  department: string;
  /** The language the patient used, which is an interpreter instruction. */
  language: string;
  /** Exactly as submitted, or `null` if it was never a usable wall-clock time. */
  requestedAt: string | null;
  /** Spelled out for a human. `null` when there was no time to spell out. */
  requestedAtLabel: { date: string; time: string } | null;
  /**
   * True when the time this process can see has already gone by.
   *
   * A derived hint, not a finding, and it is stated as one: the submitted time is
   * a wall clock with no zone, and this compares it against *this process's* wall
   * clock. That is right when the clinic and the server are in the same zone and
   * is a rough signal otherwise, which is why the view says "requested time has
   * passed" rather than "overdue" and shows the time either way. A clinic with
   * sites in more than one zone is the case that has to fix this, and the fix is
   * a stored zone, not a cleverer comparison.
   */
  timeHasPassed: boolean;
  patient: ClinicPatient;
  /**
   * The patient's own account of why they are here. Free text, in the patient's
   * words, and not truncated -- see the test that says so.
   */
  reason: string;
  household: ClinicHouseholdMember[];
  /** When the request was made, ISO. The order the list is paged in. */
  bookedAt: string;
  updatedAt: string;
}

/**
 * Project a page of records into the rows a clinician reads.
 *
 * Sorted by the time the patient asked for, soonest first, with a time that has
 * already gone to the top: the list is a work list, and the work most likely to
 * be forgotten is the appointment nobody came to and nobody marked completed.
 *
 * The order is total -- the id breaks a tie -- for the same reason the store's
 * paging order is: a page whose order is not total shows the same row twice.
 *
 * A record is never dropped for being incomplete. `/track` returns `null` for a
 * record it cannot place in time, because there a page that cannot say when is a
 * page for the wrong person and the link is easy to forward by accident. Here,
 * dropping a row is dropping a patient off a work list, and a visibly incomplete
 * row is something a clinician can act on.
 */
export function toClinicScheduleView(
  appointments: readonly Appointment[],
  now: Date,
): ClinicAppointmentRow[] {
  return appointments
    .map((appointment) => toRow(appointment, now))
    .sort((a, b) => {
      // Undated rows sort last rather than first: there is no reading of "no time
      // given" under which it is the most urgent thing in a clinic.
      if (a.requestedAt === null || b.requestedAt === null) {
        if (a.requestedAt === null && b.requestedAt === null) return a.id.localeCompare(b.id);
        return a.requestedAt === null ? 1 : -1;
      }
      if (a.requestedAt === b.requestedAt) return a.id.localeCompare(b.id);
      return a.requestedAt < b.requestedAt ? -1 : 1;
    });
}

function toRow(appointment: Appointment, now: Date): ClinicAppointmentRow {
  const source = appointment.patientInfo as unknown as Record<string, unknown>;

  const requestedAt = wallClock(source.appointmentDateTime);
  const dependents = Array.isArray(source.dependents) ? source.dependents : [];

  return {
    id: appointment.id,
    status: appointment.status,
    department: text(source.medical_department, 100) || "the clinic",
    language: text(source.language, 32).toLowerCase(),
    requestedAt,
    requestedAtLabel: requestedAt === null ? null : formatClinicTime(requestedAt),
    timeHasPassed: requestedAt !== null && requestedAt < wallClockNow(now),
    patient: {
      firstName: text(source.firstName, 100),
      lastName: text(source.lastName, 100),
      dob: text(source.dob, 10),
      email: text(source.email, 254),
      phone: text(source.phone, 40),
      insurance: insurance(source.insurance),
    },
    reason: typeof source.additionalInfo === "string" ? source.additionalInfo : "",
    household: dependents.map(toHouseholdMember),
    bookedAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString(),
  };
}

function toHouseholdMember(value: unknown): ClinicHouseholdMember {
  const source = (value ?? {}) as Record<string, unknown>;
  const lastName = text(source.lastName, 100);

  return {
    firstName: text(source.firstName, 100),
    // Null rather than an empty string, so a view can tell "the parent did not
    // give one" from "the field is blank" -- which is the difference between a
    // child recorded under the account holder's surname and a typo.
    lastName: lastName === "" ? null : lastName,
    dob: text(source.dob, 10),
    relationship: text(source.relationship, 32),
    additionalInfo: typeof source.additionalInfo === "string" ? source.additionalInfo : "",
  };
}

/** A field read as text, bounded so one absurd value cannot fill a page. */
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The insurance answer, or `unknown`.
 *
 * A third state rather than a coerced boolean, because "the patient did not say"
 * and "the patient said no" are different facts and a clinic that reads the first
 * as the second bills somebody who has insurance.
 */
function insurance(value: unknown): ClinicPatient["insurance"] {
  return value === "yes" || value === "no" ? value : "unknown";
}

/** A submitted wall-clock time, or `null` if it was not one. */
function wallClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return formatClinicTime(trimmed) ? trimmed : null;
}

/**
 * This process's current wall clock, in the same shape as a submitted one.
 *
 * The comparison in `toRow` is string-to-string and therefore lexicographic,
 * which is the same order as chronological for a zero-padded
 * `YYYY-MM-DDTHH:mm`. There is no `Date` on the patient side of it anywhere,
 * because a wall clock with no zone has no instant to convert.
 */
function wallClockNow(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Spell out a submitted wall-clock time, or refuse it.
 *
 * The components come out of the string and go back into a `Date` in the same
 * zone, which cannot move the calendar date. `new Date("2026-10-01T09:30")` would
 * resolve against whatever zone this process is in, which on Vercel is UTC, and
 * would tell a patient in any other zone -- and a clinician reading any other
 * zone's booking -- that the appointment is on a different day.
 *
 * The month and day names are constants rather than `toLocaleDateString`,
 * because that depends on the server's ICU data and locale, and a day name that
 * differs between the build machine and production is a bug nobody finds.
 *
 * This is deliberately *not* `formatRequestedAt` from `/track`. That module is
 * the patient-facing allowlist this surface is defined against, and two surfaces
 * that are meant to stay independent should not share a module: sharing one is
 * how they come to share an allowlist, one import at a time. The duplication is
 * twenty lines of calendar constants, and it is cheaper than the coupling.
 */
export function formatClinicTime(value: string): { date: string; time: string } | null {
  // Read at its natural length rather than truncated to the accepted width:
  // truncating first would turn "2026-10-01T09:30Z" into an accepted wall-clock
  // time by chopping the suffix off, and a value carrying a zone is exactly the
  // value this must refuse to guess about.
  //
  // The length is checked as well as the shape because `$` in JavaScript matches
  // before a trailing newline: `"2026-10-01T09:30\n"` passes the pattern, and
  // "this process can parse it" is not the same claim as "this is the wall clock
  // a patient submitted".
  if (value.length !== 16 || !WALL_CLOCK.test(value)) return null;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
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
