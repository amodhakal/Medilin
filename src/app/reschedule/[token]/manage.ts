/**
 * What a management page is allowed to show.
 *
 * The security boundary of `/reschedule`, and kept apart from the page for the
 * same reason `src/app/track/[token]/summary.ts` is: it is pure, it has no
 * `server-only` and no Next import, and it can be unit tested without a render.
 *
 * A management link is strictly more powerful than a tracking link -- it can move
 * or cancel the appointment -- so the temptation to show more on this page than on
 * the tracking one is stronger, not weaker. It is resisted by construction: this
 * is an allowlist, and the object it returns is the only thing the page works
 * from. There is no path by which the wider record reaches the markup.
 *
 * Shown: the first name, so the page can be recognised as the right person's; the
 * department; the language, so the page could be translated; the time on the
 * record; and the state, which is the one thing a person opening this page
 * actually came to find out.
 *
 * Not shown: date of birth, email, phone, insurance, and the description of the
 * patient's symptoms. None of them are needed to change a time, and every one of
 * them is on a page whose URL is a working credential for changing or cancelling
 * the appointment. The symptom description is the worst of them: this link is
 * forwarded, screenshotted and opened on shared machines, and a page that renders
 * "chest pain since Tuesday" next to a cancel button is a page that will end up
 * somewhere it should not.
 */

export interface ManageSummary {
  firstName: string;
  department: string;
  language: string;
  /** Exactly as the record holds it: `YYYY-MM-DDTHH:mm`, no zone. */
  appointmentDateTime: string;
  status: string;
}

const MAX_FIRST_NAME = 100;
const MAX_DEPARTMENT = 100;
const MAX_LANGUAGE = 32;
const MAX_STATUS = 32;

const REQUESTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Narrow an appointment to what this page renders.
 *
 * An allowlist rather than a cast, and validated rather than truncated into
 * shape: the record arrives from a store that decrypts it, and the caller must not
 * be able to reach a field this module never intended to expose.
 *
 * The time is read at its natural length rather than truncated to the accepted
 * width. Truncating first would quietly turn "2026-10-01T09:30Z" into an accepted
 * wall-clock time by chopping the suffix off, and a value carrying a zone is
 * exactly the value this page must refuse to guess about.
 */
export function toManageSummary(appointment: unknown): ManageSummary | null {
  if (typeof appointment !== "object" || appointment === null) return null;

  const source = appointment as Record<string, unknown>;
  const patient = source.patientInfo;
  if (typeof patient !== "object" || patient === null || Array.isArray(patient)) return null;

  const record = patient as Record<string, unknown>;

  const text = (source: Record<string, unknown>, key: string, max: number): string => {
    const value = source[key];
    return typeof value === "string" ? value.slice(0, max) : "";
  };

  const firstName = text(record, "firstName", MAX_FIRST_NAME).trim();
  const appointmentDateTime = text(record, "appointmentDateTime", 40).trim();

  // Two requirements, both about the link being for something. Without a name a
  // page gets forwarded by mistake and shown to the wrong person; without a time
  // there is nothing to reschedule, and rendering an empty appointment is worse
  // than saying the link is not usable.
  if (!firstName) return null;
  if (!REQUESTED_AT.test(appointmentDateTime)) return null;

  return {
    firstName,
    department: text(record, "medical_department", MAX_DEPARTMENT) || "the clinic",
    language: text(record, "language", MAX_LANGUAGE).toLowerCase(),
    appointmentDateTime,
    status: text(source, "status", MAX_STATUS),
  };
}

/**
 * Whether there is anything left for this page to do.
 *
 * A terminal status gets the same page as everything else rather than a redirect:
 * a patient who cancelled three weeks ago and clicked a link from an old email
 * should be told what happened, not sent somewhere that looks like a mistake.
 * The form is what goes away.
 */
export function isManageable(status: string): boolean {
  return status === "scheduled" || status === "confirmed";
}

/**
 * The earliest slot a patient may ask for, in the `datetime-local` format.
 *
 * Injected rather than read so the boundary can be asserted, and floored to the
 * minute because that is the granularity the input has: without the floor a
 * patient in the minute before their own earliest slot would be shown a control
 * whose value the server refuses.
 *
 * The clinic's own minimum notice is applied a second time by
 * `negotiateAppointmentTime`, which is the one that decides. This is only there so
 * the form does not offer a time that is guaranteed to be moved.
 */
export function earliestSelectableSlot(
  now: number,
  leadMs: number,
): string {
  const floored = Math.floor((now + leadMs) / 60_000) * 60_000;
  const date = new Date(floored);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
