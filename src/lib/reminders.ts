import "server-only";

import { getClinicName } from "@/config";
import {
  claimReminder,
  listReminderCandidates,
  type Appointment,
} from "@/lib/appointments";
import { logInfo, logWarn } from "@/lib/logger";
import { deliverConfirmation } from "@/app/api/_lib/deliver-confirmation";

/**
 * Reminding patients about an appointment they are going to (#67).
 *
 * There was no reminder and no cron. `CRON_SECRET` was declared in
 * src/lib/env.ts, commented "Authenticates scheduled jobs hitting /api/cron/*",
 * and had no route, no vercel.json and no reader -- a capability described in a
 * comment and implemented nowhere. A patient who booked an appointment and then
 * forgot about it simply did not turn up.
 *
 * Two decisions carry the whole design, and both are about what happens when a run
 * does not happen.
 *
 * **The window is wider than the schedule interval, deliberately.**
 *
 * The cron runs daily (see vercel.json) and this looks at the next
 * `LOOKAHEAD_MS` = 48 hours. Twice the interval is not arbitrary and not
 * generous: with a 24-hour window and a 24-hour schedule, an appointment at 10:00
 * tomorrow is inside today's window and outside tomorrow's, so a single missed
 * run drops that reminder *permanently* -- not delayed, dropped, because no future
 * run will ever include it again. Widening the window past the interval is what
 * makes a missed run recoverable by the next one. Every missed run costs one
 * additional interval of lateness; every narrow window costs appointments forever.
 *
 * **Idempotency is keyed on the appointment, and the claim is taken before the
 * send.**
 *
 * The claim key is the appointment id and nothing else, and that is the opposite
 * of what it looks like it should be. Because the window is wider than the
 * schedule, consecutive runs overlap by almost a day: an appointment at 15:00
 * today is inside today's window and tomorrow's, so two runs will both decide to
 * remind about it. A key of `<id>:<window name>` would hand those two runs two
 * different keys and let both through. The overlap is created on purpose -- it is
 * what makes a missed run recoverable -- so the defence has to live in something
 * the window does not take part in. One claim per appointment, ever, is also what
 * a patient would call correct.
 *
 * And the claim is taken *before* the send. A run that is retried, or that crashes
 * between claiming and sending, does not send twice -- it skips once, which is the
 * right direction to fail for a courtesy email.
 *
 * What is *not* claimed: this does not survive a process dying mid-send with any
 * certainty. Claim-then-send can drop a reminder; send-then-claim can duplicate
 * one. There is no way to do both without a transactional outbox and a delivery
 * receipt, and a patient who gets no reminder and telephones is a better outcome
 * than a patient who gets two and telephones anyway.
 *
 * The consequence of the per-appointment key, stated rather than left to be found:
 * a rescheduled appointment does not get a second reminder. It has already been
 * emailed the new time, so it has been told; and re-arming the claim on
 * `updatedAt` would mean any future write to an appointment silently
 * re-notifies the patient, which is a worse property to own.
 */

const DAY_MS = 24 * 60 * 60_000;

/** How far ahead a run looks. Must stay greater than the cron interval. */
export const LOOKAHEAD_MS = 2 * DAY_MS;

/** How close a run looks. Negative, and zero on purpose -- see `isDue`. */
export const LOOKBEHIND_MS = -30 * 60_000;

/**
 * The `datetime-local` shape, and the only thing a reminder can compare.
 *
 * The record holds a wall-clock time with no zone. The job runs on a server whose
 * zone is UTC, and it has to compare that wall-clock time against a clock to know
 * whether the appointment is soon. There is an honest version of that and a
 * dishonest one, and the honest one is: interpret the slot in the server's own
 * zone, which is the same interpretation `./schedule` and `formatRequestedAt` both
 * use, and be explicit that a clinic running in one zone is the case this is
 * correct for.
 *
 * The day boundary below is the same assumption made once more. A reminder is a
 * courtesy, so being a few hours early about one is survivable and being a few
 * hours silent about it is not.
 */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The moment an appointment is for, read the way the rest of the app reads it. */
export function slotToInstant(slot: string): number | null {
  const match = LOCAL_DATE_TIME.exec(slot);
  if (!match) return null;

  const date = new Date(
    Number(slot.slice(0, 4)),
    Number(slot.slice(5, 7)) - 1,
    Number(slot.slice(8, 10)),
    Number(slot.slice(11, 13)),
    Number(slot.slice(14, 16)),
  );

  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/**
 * The window a run at `now` is covering, and the name it is claimed under.
 *
 * The name is the UTC calendar day the run started on, not the bounds. It has to
 * be something two independent runs can agree on without talking to each other,
 * and a day is the coarsest thing that satisfies that while still being different
 * for each daily run.
 *
 * Bounds are half-open: `[now + lookbehind, now + lookahead)`. A run at exactly
 * the lookahead boundary does not send, so an appointment cannot be picked up by
 * two consecutive runs.
 */
export function reminderWindow(
  now: number,
  lookbehindMs: number = LOOKBEHIND_MS,
  lookaheadMs: number = LOOKAHEAD_MS,
): { name: string; from: number; to: number } {
  const from = now + lookbehindMs;
  const to = now + lookaheadMs;

  return { name: new Date(now).toISOString().slice(0, 10), from, to };
}

/** True when this appointment falls inside the window. */
export function isDue(appointment: Appointment, window: { from: number; to: number }): boolean {
  const at = slotToInstant(appointment.patientInfo.appointmentDateTime);
  if (at === null) return false;

  return at >= window.from && at < window.to;
}

export interface ReminderSummary {
  /** The window this run covered, for the response and the log. */
  window: string;
  /** Appointments in the window before any claim was taken. */
  due: number;
  /** Claims won, and therefore sends attempted. */
  attempted: number;
  sent: number;
  /** Attempts where the delivery reported a failure. */
  failed: number;
  /** Already claimed, by an earlier run or an overlapping one. */
  skippedAlreadyClaimed: number;
  /** The store had more appointments than one run will consider. */
  truncated: boolean;
}

/**
 * Run one reminder pass.
 *
 * Never throws for a delivery failure: one bounced email must not stop the other
 * forty-one patients being reminded. It does throw for a store that is down,
 * because that is not a partial success -- nothing was found, so nothing was sent,
 * and a caller that reported 200 would have no way to know.
 *
 * `now` is injected so the window and its boundary can be asserted exactly. A
 * default of `Date.now()` is what a route passes and what a test does not.
 */
export async function runReminderPass(options: { now?: number } = {}): Promise<ReminderSummary> {
  const now = options.now ?? Date.now();
  const window = reminderWindow(now);

  const { appointments, truncated } = await listReminderCandidates();
  const due = appointments.filter((appointment) => isDue(appointment, window));

  const summary: ReminderSummary = {
    window: window.name,
    due: due.length,
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedAlreadyClaimed: 0,
    truncated,
  };

  if (truncated) {
    // Warned, not merely reported. A run that quietly stopped covering everybody
    // past the cap has no symptom anybody would otherwise notice.
    logWarn("reminders.truncated", { count: due.length });
  }

  for (const appointment of due) {
    // The claim, before the send. See the header: claim-then-send drops once on a
    // crash, send-then-claim duplicates. It is keyed on the appointment alone, so
    // the two consecutive runs that overlap by design cannot both win it.
    if (!(await claimReminder(appointment.id))) {
      summary.skippedAlreadyClaimed += 1;
      continue;
    }

    summary.attempted += 1;

    const delivery = await deliverConfirmation({
      email: appointment.patientInfo.email,
      // In the language they booked in, because that is the language the
      // confirmation was in and the language they read the form in.
      language: appointment.patientInfo.language,
      info: reminderText(appointment, getClinicName()),
    });

    if (delivery.ok) summary.sent += 1;
    else summary.failed += 1;
  }

  logInfo("reminders.completed", {
    window: summary.window,
    count: summary.sent,
    failed: summary.failed,
  });

  return summary;
}

/**
 * What the patient is told, as the serialised response `deliverConfirmation`
 * translates.
 *
 * The same shape as every other message this application sends, deliberately: one
 * translator, one inbox, one thing this clinic knows how to render. The symptom
 * description is emptied for the same reason it is in the reschedule
 * confirmation -- a reminder is an email that will sit in an inbox for years, and
 * "you have chest pain since Tuesday at 10:00" is not a thing to put in one.
 */
export function reminderText(appointment: Appointment, clinicName: string): string {
  return JSON.stringify({
    patientInfo: { ...appointment.patientInfo, additionalInfo: "" },
    // The agreed time is what the reminder is about, and it is the one thing that
    // has to match the record: the clinic moves times, and a patient told the
    // wrong hour by a reminder is worse off than one told nothing.
    appointmentDateTime: appointment.patientInfo.appointmentDateTime,
    confirmed: true,
    reminder: true,
    hospitalName: clinicName,
    referenceNumber: `HOSP-${appointment.id}`,
  });
}
