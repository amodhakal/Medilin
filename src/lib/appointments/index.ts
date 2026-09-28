import { v4 as uuidv4 } from "uuid";
import { ACTION_TOKEN_TTL_MS, mintActionToken, openActionToken } from "@/lib/action-token";
import { AUDIT_ACTORS, appointmentResource, recordAuditEvent } from "@/lib/audit";
import type { AuditReason } from "@/lib/audit";
import { logInfo } from "@/lib/logger";
import { getSqlClient } from "@/lib/storage";
import type { AppointmentRecord } from "@/lib/validation/intake";
import { InMemoryAppointmentStore } from "./memory-store";
import { PostgresAppointmentStore } from "./postgres-store";
import {
  assertValidAppointmentPatch,
  REMINDABLE_STATUSES,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
  type PatientAction,
} from "./store";

/**
 * Appointments, as the rest of the application sees them.
 *
 * This was a `Map` in this file. It is now a selection between two stores,
 * chosen once, and four functions over the interface in ./store -- create, get,
 * update, cancel -- which is the surface a status lookup and a cancel flow need
 * and which only ever had create and get. A fifth family arrived with #59, in
 * patient action links: mint, and spend.
 *
 * Everything above this file depends on the interface, not on either
 * implementation, so swapping a store is one call to `setAppointmentStore` and
 * never a change to booking, to the sealed token, or to a route.
 *
 * Every one of them writes to the audit trail, here rather than at the call
 * sites. That placement is the part worth arguing about: it means a record
 * cannot be created, read, changed or cancelled without leaving an entry, and a
 * reader added later -- a new page, a new route, a new job -- is audited by
 * existing rather than by remembering. The alternative is four call sites that
 * each have to remember, and the fifth one is the one that gets forgotten.
 */

/**
 * The store in use, chosen once per process.
 *
 * Durable when DATABASE_URL is configured, in memory otherwise. The in-memory
 * default is deliberate and is not a claim that the bug is fixed: it is what
 * lets the app run on a laptop and in CI with no credentials, and it is still
 * per-instance, so a serverless deployment that has not configured a database is
 * losing bookings exactly as before. `isDurableAppointmentStore` is how a caller
 * -- the sealed token, in ./phi-token -- finds out which one it has.
 */
function selectStore(): AppointmentStore {
  const sql = getSqlClient();
  return sql === null ? new InMemoryAppointmentStore() : new PostgresAppointmentStore(sql);
}

let store: AppointmentStore | null = null;

export function getAppointmentStore(): AppointmentStore {
  if (!store) store = selectStore();
  return store;
}

/** Test seam, and the seam a test double or a second implementation installs through. */
export function setAppointmentStore(next: AppointmentStore | null): void {
  store = next;
}

/**
 * True when the store in use survives the process.
 *
 * Asked by the token layer, and the honest question behind it is "will the link
 * I just handed a patient still resolve on the next request, on a different
 * instance?" -- which is only yes when the answer is durable. A store installed
 * through `setAppointmentStore` reports what it is, so a test double does not
 * silently change how tokens are minted.
 */
export function isDurableAppointmentStore(): boolean {
  return getAppointmentStore() instanceof PostgresAppointmentStore;
}

/**
 * Record a new appointment, and record having recorded it.
 *
 * The audit entry is written *before* the record, which is the opposite order
 * from the read path and is deliberate. An access that cannot be logged must not
 * happen at all, so the entry goes in first: if the trail cannot be written,
 * `recordAuditEvent` throws and no patient data reaches the database. The cost
 * is that a record write that then fails leaves an entry describing an attempt
 * that did not complete, which for a trail is a false positive rather than a
 * gap -- and a gap is the failure that matters.
 */
export async function createAppointment(patientInfo: AppointmentRecord): Promise<Appointment> {
  const now = new Date();
  const id = uuidv4();

  await recordAuditEvent({
    actor: AUDIT_ACTORS.system,
    action: "APPOINTMENT_CREATED",
    resource: appointmentResource(id),
    details: { reason: "intake", status: "scheduled", language: patientInfo.language },
  });

  return getAppointmentStore().create({
    id,
    patientInfo,
    createdAt: now,
    updatedAt: now,
    conversationEnded: false,
    status: "scheduled",
  });
}

/**
 * Read an appointment, and record the read.
 *
 * The entry is written *after* the read, because there is nothing to log until
 * there is something to have read. What makes it fail closed is what happens
 * next: if the entry cannot be written, this throws and the caller never sees
 * the record. The data was loaded into this process and no further -- it is not
 * returned, not rendered, and not emailed.
 *
 * `actor` is required rather than defaulted. A read of a patient's record is
 * exactly the event the trail exists for, and a default would make the common
 * case -- a new reader that forgets -- look the same as a deliberate one. The
 * closed set is in ../audit.
 */
export async function getAppointment(
  id: string,
  actor: string,
): Promise<Appointment | undefined> {
  const appointment = await getAppointmentStore().get(id);
  if (!appointment) return undefined;

  await recordAuditEvent({
    actor,
    action: "PHI_READ",
    resource: appointmentResource(appointment.id),
    details: { status: appointment.status },
  });

  return appointment;
}

/**
 * Change an appointment, and record having changed it.
 *
 * Audited before the write, for the same reason as create: a modification that
 * cannot be logged must not happen.
 *
 * `actor` is a parameter for the same reason `getAppointment`'s is, and is
 * defaulted rather than required because the callers that predate #59 really are
 * the booking pipeline acting on its own behalf. It stops being the truth the
 * moment a patient changes their own appointment through a link, which is why
 * `rescheduleAppointment` below passes `patient:link` and this only defaults.
 *
 * The audit *reason* follows from the actor rather than being a fifth parameter.
 * A change made by a patient through a management link is `patient_link` and
 * nothing else, so deriving it here means a new caller cannot file their change
 * under `status_change` and lose the distinction #59 exists to draw.
 */
export async function updateAppointment(
  id: string,
  patch: AppointmentPatch,
  actor: string = AUDIT_ACTORS.system,
): Promise<Appointment | undefined> {
  assertValidAppointmentPatch(patch);

  await recordAuditEvent({
    actor,
    action: "APPOINTMENT_UPDATED",
    resource: appointmentResource(id),
    details: {
      reason: reasonFor(actor),
      status: patch.status,
    },
  });

  return getAppointmentStore().update(id, patch);
}

/** Why a change happened, as far as the trail can honestly tell. */
function reasonFor(actor: string): AuditReason {
  return actor === AUDIT_ACTORS.patientLink ? "patient_link" : "status_change";
}

/**
 * Cancel an appointment, and record the cancellation.
 *
 * Cancelling also withdraws every live capability link for the appointment, and
 * that is not a side effect -- it is the invariant. Without it, a patient could
 * cancel through one link and reschedule through an old copy of another, and
 * the clinic would be holding a record that is cancelled and booked at the same
 * time. It is the one place in this file where an audit entry and a store write
 * are not the whole of the operation.
 */
export async function cancelAppointment(
  id: string,
  actor: string = AUDIT_ACTORS.system,
): Promise<Appointment | undefined> {
  await recordAuditEvent({
    actor,
    action: "APPOINTMENT_CANCELLED",
    resource: appointmentResource(id),
    details: { reason: reasonFor(actor), status: "cancelled" },
  });

  const cancelled = await getAppointmentStore().cancel(id);

  // Only for an appointment that exists. Withdrawing grants for an id that is
  // not there would be a write that reports success for nothing.
  if (cancelled) {
    const withdrawn = await getAppointmentStore().withdrawActionGrants(id, new Date());
    if (withdrawn > 0) {
      logInfo("appointment.links_withdrawn", { appointmentId: id, count: withdrawn });
    }
  }

  return cancelled;
}

export {
  APPOINTMENT_STATUSES,
  PATIENT_ACTIONS,
  REMINDABLE_STATUSES,
  isAppointmentStatus,
  isPatientAction,
  type ActionGrant,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
  type PatientAction,
} from "./store";
export { InMemoryAppointmentStore } from "./memory-store";
export { PostgresAppointmentStore } from "./postgres-store";

/*
 * ---------------------------------------------------------------------------
 * Patient action links (#59)
 * ---------------------------------------------------------------------------
 *
 * The one surface through which a patient changes their own appointment, and
 * the fifth function family in this file for the reason the other four are here:
 * a reader added later is audited by existing rather than by remembering.
 *
 * The division of labour is the part worth stating, because `phi-token.ts` says
 * in so many words that it could not manage it while tracking links were the
 * only links there were:
 *
 *   the token says what may be done and until when, and is authenticated
 *   the grant says whether that particular token was issued, and is authorised
 *
 * Both are required. A token on its own is a credential that anyone holding the
 * master key could mint, and a grant on its own is a row nobody can present.
 * Together an action needs a token that decrypts *and* a grant that is still
 * live, and the two live in different places, so neither compromise is
 * sufficient on its own.
 */

/** Everything a caller needs to put a link in an email, and nothing that is PHI. */
export interface PatientActionLink {
  /** Root-relative. The caller decides the origin, as `bookAppointment` does. */
  path: string;
  token: string;
  expiresAt: Date;
}

export interface PatientActionLinks {
  reschedule: PatientActionLink;
  cancel: PatientActionLink;
}

/**
 * Mint a management link for an appointment.
 *
 * Two tokens rather than one. A reschedule mints a replacement, so a single link
 * would have to be reissued in place for the patient to keep their access -- and
 * a link that can be reissued is a link whose *old* value is still live until
 * somebody revokes it, which is the failure this whole feature exists to remove.
 * Two independent `jti`s mean withdrawing one leaves the other alone.
 *
 * The grant is recorded *before* the token is handed back. If the store cannot
 * record it, the caller gets an exception instead of a URL that looks live and
 * authorises nothing -- the same fail-closed posture as the audit entry in
 * `createAppointment`.
 *
 * `now` is a parameter so the expiry can be asserted exactly rather than
 * approached.
 */
export async function issuePatientActions(
  appointmentId: string,
  options: { now?: number } = {},
): Promise<PatientActionLinks> {
  const now = options.now ?? Date.now();

  const links: PatientActionLinks = {
    reschedule: await issueOne(appointmentId, "reschedule", now),
    cancel: await issueOne(appointmentId, "cancel", now),
  };

  logInfo("appointment.links_issued", { appointmentId });

  return links;
}

async function issueOne(
  appointmentId: string,
  capability: PatientAction,
  now: number,
): Promise<PatientActionLink> {
  const expiresAt = now + ACTION_TOKEN_TTL_MS;

  const { token } = mintActionToken({
    appointmentId,
    jti: uuidv4(),
    // A grant that carries only the capability it is for, so a link minted to
    // reschedule cannot be used to cancel even if a caller later misroutes it.
    // The check in `spendPatientAction` is what enforces this; minting narrowly
    // means there is nothing to misroute.
    capabilities: [capability],
    issuedAt: now,
    expiresAt,
  });

  // Re-opened rather than carried over from the mint, so the jti written into the
  // row is the one sealed into the token. Carrying the value across would work
  // today and break the moment the format changed; reading it back out of the
  // payload cannot, because the payload is what the token *is*.
  const claims = openActionToken(token, now);
  if (!claims) {
    throw new Error(
      "A patient action link was minted and then refused; refusing to hand out a " +
        "link this process cannot open.",
    );
  }

  await getAppointmentStore().issueActionGrant({
    jti: claims.jti,
    appointmentId,
    actions: claims.capabilities,
    expiresAt: new Date(claims.expiresAt),
    withdrawnAt: null,
  });

  return { path: `/reschedule/${token}`, token, expiresAt: new Date(expiresAt) };
}

/**
 * Why a patient action was refused.
 *
 * A closed set of four, and deliberately smaller than the set of things that can
 * go wrong. Everything cryptographic collapses into `link_unusable`: not a token,
 * sealed under another key, from the other token family, past its expiry, or
 * naming a grant that is not there. Telling those apart tells a prober which of
 * them they managed, and none of it helps the patient.
 *
 * The other three are things the patient is entitled to be told. They are
 * answers about a record they already hold a working link to, so they disclose
 * nothing to anyone else.
 */
export type PatientActionRefusal =
  | "link_unusable"
  | "already_used"
  | "not_permitted"
  | "not_active";

export type SpentPatientAction =
  | { ok: true; appointment: Appointment; jti: string }
  | { ok: false; reason: PatientActionRefusal };

/** An appointment a patient may still change. Anything else is finished. */
const TERMINAL_STATUSES = new Set<Appointment["status"]>(["cancelled", "completed"]);

/**
 * Authenticate a management link and claim it.
 *
 * Five checks, ordered to leak least. The token is opened first, because that is
 * a local decryption and tells a caller nothing about the database. The grant is
 * spent before the record is read, so a record is loaded only for a link that is
 * about to be acted on. The appointment's status is checked last, after the
 * audited read, because a patient asking about a cancelled appointment is a
 * legitimate question and refusing to answer it would be worse than answering.
 *
 * The spend is one call and it is the whole of the anti-replay story. Two
 * requests carrying the same link both get through `openActionToken`, both get
 * through `getActionGrant`, and then exactly one gets a grant back out of
 * `spendActionGrant`; the other is told the link has been used. Reading and
 * writing in two calls would let both through, and the patient would be
 * rescheduled twice for one click.
 *
 * The read is audited as `patient:link` rather than `link-bearer`, which is the
 * difference #59 buys in the trail: this is a *write* by whoever holds a
 * management link, where the tracking page is a *read* by whoever holds a
 * tracking link. It is still not an identity -- there is no account behind
 * either -- and `patient:link` claims nothing beyond that.
 */
export async function spendPatientAction(
  token: string,
  capability: PatientAction,
  options: { now?: number } = {},
): Promise<SpentPatientAction> {
  const now = options.now ?? Date.now();

  const claims = openActionToken(token, now);
  if (!claims) return refuse("link_unusable");

  const spent = await getAppointmentStore().spendActionGrant(claims.jti, new Date(now));
  // Unknown, already spent, already withdrawn, or expired: one answer, because
  // the four are the same answer to a caller who holds a link.
  if (!spent) return refuse("already_used");

  // A token may only be spent against the appointment it names. Checked even
  // though the grant carries the same id, because a grant that had somehow been
  // re-pointed must not become usable against a different record.
  if (spent.appointmentId !== claims.appointmentId) return refuse("link_unusable");

  if (!spent.actions.includes(capability)) return refuse("not_permitted");

  const appointment = await getAppointment(claims.appointmentId, AUDIT_ACTORS.patientLink);
  if (!appointment) return refuse("link_unusable");

  // A cancelled appointment stays readable forever -- `resolveRecord` says so on
  // purpose, so that a patient whose appointment vanished can still see that it
  // did -- but it is no longer something to reschedule. Resurrecting it from an
  // old link is precisely what the withdrawal in `cancelAppointment` exists to
  // prevent, and this is the second line of it.
  if (TERMINAL_STATUSES.has(appointment.status)) return refuse("not_active");

  return { ok: true, appointment, jti: spent.jti };
}

/**
 * Record a refusal, log it, and answer with the reason.
 *
 * A refusal is worth recording and is the easiest thing to forget to record,
 * because the code path that produces one is early and returns. The action is
 * its own rather than a note on another, because a trail is append-only: calling
 * a refused attempt an update would put a change into an immutable log that
 * never happened.
 *
 * The appointment id is logged and the token never is. A bearer credential in a
 * log is a bearer credential in whichever aggregator receives the log, and this
 * is the path where a token is most likely to be captured by someone who did not
 * write it.
 */
async function refuse(
  reason: PatientActionRefusal,
  appointmentId?: string,
): Promise<{ ok: false; reason: PatientActionRefusal }> {
  await recordAuditEvent({
    actor: AUDIT_ACTORS.patientLink,
    action: "APPOINTMENT_ACTION_REFUSED",
    resource: appointmentResource(appointmentId ?? "unresolved"),
    details: { reason: "patient_link" },
  });

  logInfo("appointment.action_refused", { reason, appointmentId });

  return { ok: false, reason };
}

/**
 * Move an appointment to a new agreed time, as a patient asked.
 *
 * Thin on purpose. The authentication, the anti-replay spend and the audited
 * read all happened in `spendPatientAction`; what is left is a decision about
 * which status a rescheduled appointment lands in and a write that goes through
 * `updateAppointment`, so the entry in the trail is written by the same code
 * that writes it for every other change.
 *
 * `status` is set to `confirmed` rather than left at `scheduled`, because a
 * patient who has just chosen the new time has confirmed it. That is a real
 * semantic claim about the mock clinic's workflow and it is the one judgement
 * here a reviewer should look at hardest: nothing else in this repository moves
 * an appointment to `confirmed`, so `createAppointment` is now the only path that
 * produces `scheduled` records.
 */
export async function rescheduleAppointment(
  appointment: Appointment,
  agreedDateTime: string,
): Promise<Appointment | undefined> {
  return updateAppointment(
    appointment.id,
    {
      patientInfo: { ...appointment.patientInfo, appointmentDateTime: agreedDateTime },
      status: "confirmed",
    },
    AUDIT_ACTORS.patientLink,
  );
}

/*
 * ---------------------------------------------------------------------------
 * Scheduled reminders (#67)
 * ---------------------------------------------------------------------------
 *
 * Two functions, and neither of them sends anything. The sending is a job's
 * business and lives in ../reminders; what belongs here is the two questions the
 * job asks the store, asked the same way every time so that the audit trail and
 * the exactly-once ledger cannot disagree about what was read and what was
 * claimed.
 */

/** How many appointments one run will consider. See `listByStatus`. */
export const REMINDER_SCAN_LIMIT = 500;

export interface ReminderCandidates {
  /** Every appointment in a state a reminder is for. Opened records. */
  appointments: Appointment[];
  /**
   * True when the store had more than this, so the run is knowingly partial.
   *
   * Reported rather than silently absorbed. A capped scan that looks like a
   * complete one produces a job that quietly stops reminding anybody past the
   * cap, and the only symptom is silence.
   */
  truncated: boolean;
}

/**
 * The appointments a reminder run should consider, and whether it saw them all.
 *
 * Cancelled and completed appointments are excluded by the store, in SQL, rather
 * than filtered out here: a patient who cancelled must not be told to turn up,
 * and that decision belongs somewhere it can be read once rather than in a job
 * that re-derives it on every run.
 *
 * The limit is fetched one over the cap so that `truncated` is a fact rather than
 * an inference. That is one extra row decrypted to answer a question that
 * matters.
 */
export async function listReminderCandidates(
  limit: number = REMINDER_SCAN_LIMIT,
): Promise<ReminderCandidates> {
  const appointments = await getAppointmentStore().listByStatus(REMINDABLE_STATUSES, limit + 1);

  return { appointments: appointments.slice(0, limit), truncated: appointments.length > limit };
}

/**
 * Claim the right to send one appointment's reminder, for good.
 *
 * The key is the appointment id and nothing else. That is the whole design, and
 * it is the opposite of what it looks like it should be: the window is
 * deliberately **not** part of the key.
 *
 * With a 48-hour look-ahead on a daily schedule, consecutive runs overlap by
 * almost a day. An appointment at 15:00 today is inside today's window and
 * tomorrow's, so two runs will both decide to remind about it -- and a claim key
 * of `<id>:<window name>` would give those two runs two different keys and let both
 * through. The overlap is created on purpose (it is what makes a missed run
 * recoverable), so the defence has to live in something the window does not
 * participate in. One claim per appointment, ever, is also the thing a patient
 * would describe as correct: exactly one reminder.
 *
 * The consequence, stated rather than left to be discovered: a rescheduled
 * appointment does not get a second reminder. That is acceptable because a
 * reschedule already emails the patient the new time, so they have been told; and
 * re-arming the reminder by keying on `updatedAt` would mean any future write to
 * an appointment silently re-notifies the patient, which is a worse property to
 * own than the one being given up here.
 *
 * Call it *after* deciding to send and *before* calling the mailer. The other
 * order sends twice on a crash between them; this order skips once on a crash
 * between them, which is the direction to err in for a courtesy email.
 */
export async function claimReminder(appointmentId: string): Promise<boolean> {
  return getAppointmentStore().claimOnce("reminder", appointmentId);
}
