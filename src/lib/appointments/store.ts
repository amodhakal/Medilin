import type { AppointmentRecord } from "@/lib/validation/intake";

/**
 * What an appointment is, and what can be done to one.
 *
 * The store used to be a `Map` and this interface did not exist, which meant
 * every caller depended on a module-level singleton with no way to inspect,
 * substitute, or reason about what it was. The interface is the whole of the
 * change: the persistence behind it is now a decision rather than a fact.
 *
 * `get`, `update` and `cancel` are the surface a status lookup needs, and they
 * are all asynchronous. That is not incidental tidiness -- a durable store is a
 * network round trip, and a synchronous signature over one would either block
 * the event loop or hide the await behind a promise nobody checks.
 *
 * Four more arrived with #59 and are about a different thing: `issueActionGrant`
 * and friends. They are not about appointments, they are about the capabilities
 * a patient is handed a link for, and they are on the same interface because
 * they have the same durability requirement. A capability kept anywhere else
 * -- a cookie, an in-process `Set`, a signed token alone -- is a capability that
 * a cold start silently invalidates, which is the bug #17 was.
 *
 * Two more arrived with #67, for the reminder job: `listByStatus` and
 * `claimOnce`. Both are here for the same reason, and both have comments on them
 * that are longer than their signatures, because the shape of `listByStatus` is
 * the result of the record being encrypted rather than of how reminders work.
 */

/**
 * Where an appointment is in its life.
 *
 * A closed set, because this value is what a status lookup renders and what a
 * cancel flow branches on, and a free-text column would quietly admit
 * "Cancelled", "CANCELLED" and "cancelled " as three different states.
 */
export const APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "cancelled",
  "completed",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return (
    typeof value === "string" &&
    (APPOINTMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The statuses a reminder job cares about, and the only reason
 * `listByStatus` takes a list.
 *
 * `cancelled` and `completed` are not in it and never should be: telling somebody
 * to turn up for an appointment they cancelled three days ago is worse than
 * telling them nothing, and it is not a judgement the reminder job gets to make
 * per record. It is made once, here, where it can be read.
 */
export const REMINDABLE_STATUSES: readonly AppointmentStatus[] = ["scheduled", "confirmed"];

export interface Appointment {
  id: string;
  /**
   * The patient record.
   *
   * Previously typed `Record<string, unknown>`, which meant no field access
   * anywhere downstream was checked and `patientInfo.firstName` was `unknown`
   * even though the intake form guarantees it. The shape now comes from the
   * validation schema, so the store and the form cannot drift apart.
   */
  patientInfo: AppointmentRecord;
  createdAt: Date;
  /** When the record last changed. Absent from the original in-memory shape. */
  updatedAt: Date;
  conversationEnded: boolean;
  status: AppointmentStatus;
}

/**
 * The mutable part of an appointment.
 *
 * `id` and `createdAt` are not patchable: an appointment's identity and when it
 * was requested are facts about the request, and a caller that can rewrite them
 * can make a record that was never made.
 *
 * `patientInfo` is replaced wholesale rather than merged field by field. A
 * partial merge is a rule about which fields may change and what happens to the
 * rest, and that rule belongs to the caller, which already holds the whole
 * record because it read it first. The intake schema is `.strict()`, so a
 * caller cannot smuggle an extra field in through the object it hands over.
 */
export type AppointmentPatch = Partial<
  Pick<Appointment, "patientInfo" | "conversationEnded" | "status">
>;

/**
 * What a patient may do to their own appointment through a link (#59).
 *
 * A closed set of two, and closed for the same reason `APPOINTMENT_STATUSES` is:
 * every caller that acts on one has to branch on it, and a free-text action
 * would admit "Cancel", "CANCELLED" and "cancel " as three capabilities that
 * all serialise into a sealed token nobody can inspect.
 *
 * It lives here rather than beside the token that carries it, because the store
 * has to be able to check a grant without parsing anything: the token module
 * depends on the store's vocabulary, never the other way round.
 *
 * `read` is absent on purpose. Opening the appointment is what the tracking
 * link in ../phi-token already does, and a management link that could also read
 * would be a second, wider way in for no added capability.
 */
export const PATIENT_ACTIONS = ["reschedule", "cancel"] as const;

export type PatientAction = (typeof PATIENT_ACTIONS)[number];

export function isPatientAction(value: unknown): value is PatientAction {
  return (
    typeof value === "string" &&
    (PATIENT_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * A capability a patient was handed, as the store remembers it.
 *
 * Everything here is also inside the sealed token. The duplication is the
 * point: the token is authenticated, this is authorised. A payload sealed with
 * the right key by anything else in the process would pass the AEAD check and
 * still have no row here.
 */
export interface ActionGrant {
  /**
   * The token's own id, minted per token.
   *
   * The only key a grant can be looked up or withdrawn by, so it must be
   * unique per mint rather than per appointment: two links to the same
   * appointment are two capabilities, and revoking one must not revoke the
   * other.
   */
  jti: string;
  appointmentId: string;
  actions: PatientAction[];
  /** After this the grant is refused whatever the row says. */
  expiresAt: Date;
  /** Null while the grant is live. Stamped when it is spent or withdrawn. */
  withdrawnAt: Date | null;
}

/**
 * Reject a patch the store could not honour, before it reaches a store.
 *
 * Called by the facade so that both implementations fail the same way and with
 * the same message, and by the in-memory store so that it cannot be written to
 * directly. A record in a state nothing can compare against is worse than a
 * failed request: every later status lookup silently misses it.
 */
export function assertValidAppointmentPatch(patch: AppointmentPatch): void {
  if (patch.status !== undefined && !isAppointmentStatus(patch.status)) {
    throw new Error(
      `Refusing to store an unknown appointment status: ${JSON.stringify(patch.status)}`,
    );
  }
}

/**
 * Persistence for appointments.
 *
 * Implementations are expected to be safe to share across concurrent requests
 * and across processes. Everything above this interface -- booking, the status
 * API, the sealed token, the patient action link -- is written against the
 * interface alone, so a second implementation (or a test double) needs to
 * provide these methods and nothing else.
 *
 * The store is a durability layer, not a workflow engine. It enforces that a
 * status is one of `APPOINTMENT_STATUSES` and that an identifier is immutable,
 * and it makes no other promises about which transition is allowed -- who may
 * move an appointment from `cancelled` back to `scheduled` is a policy
 * question, and a policy question does not belong in a table.
 *
 * `get`, `update` and `cancel` return `undefined` for an identifier that does
 * not exist. A store that is reachable and holding a record whose columns do
 * not parse throws instead, because returning `undefined` there would report
 * "no such appointment" for a patient who has one.
 */
export interface AppointmentStore {
  /** Persist a new appointment. The id is decided by the caller. */
  create(appointment: Appointment): Promise<Appointment>;

  /** The appointment, or `undefined` if there is no such id. */
  get(id: string): Promise<Appointment | undefined>;

  /** Apply a patch, or `undefined` if there is no such id. */
  update(id: string, patch: AppointmentPatch): Promise<Appointment | undefined>;

  /**
   * Move an appointment to `cancelled`, or `undefined` if there is no such id.
   *
   * Idempotent, and separate from `update` because it is the operation the
   * cancel flow calls and because it is the one that will grow an invariant --
   * refusing to cancel a completed appointment, recording who cancelled it --
   * and it should not have to be reconstructed at every call site.
   */
  cancel(id: string): Promise<Appointment | undefined>;

  /**
   * Remember a capability a patient was handed a link for.
   *
   * A grant is the durable half of a link. The token carries what may be done
   * and until when; the grant carries the fact that *this* token was really
   * issued by us, which nothing inside the token can prove -- it is only
   * authenticated, not authorised. Without this, a token sealed under a stolen
   * master key would be as good as one we minted.
   *
   * Idempotent on `jti`, so re-issuing a grant is a no-op rather than a second
   * live capability for the same token.
   */
  issueActionGrant(grant: ActionGrant): Promise<ActionGrant>;

  /** The grant, or `undefined` if no such capability was ever issued. */
  getActionGrant(jti: string): Promise<ActionGrant | undefined>;

  /**
   * Spend a grant: withdraw it and hand it back, or `undefined` if it is
   * unknown, already withdrawn, or past `now`.
   *
   * Atomic, and that is the entire reason it is not `getActionGrant` followed
   * by `issueActionGrant`. Two requests carrying the same link would both read
   * a live grant, both decide they may act, and both act; the patient gets two
   * reschedules for one click. Whoever wins the compare-and-set is the one that
   * proceeds, and the other is told the link has been used.
   *
   * `now` is a parameter because expiry is decided here, once, rather than in
   * whichever caller happened to remember to check.
   */
  spendActionGrant(jti: string, now: Date): Promise<ActionGrant | undefined>;

  /**
   * Withdraw every live grant for an appointment, and report how many.
   *
   * This is what makes a link revocable in the way a patient expects: once an
   * appointment is cancelled, no outstanding link may bring it back. Without it
   * a patient could cancel through one link and then reschedule through an old
   * copy of it, which is a record that is cancelled and booked at the same
   * time.
   *
   * Idempotent, and it deliberately does not prune the withdrawn rows: a
   * capability that has been spent should still be reportable as spent.
   */
  withdrawActionGrants(appointmentId: string, now: Date): Promise<number>;

  /**
   * Appointments in any of `statuses`, oldest first, up to `limit`.
   *
   * For the reminder job (#67), and the reason it is shaped this way is the most
   * interesting thing in this interface.
   *
   * The obvious method is "everything due in the next day", and it cannot be
   * written. The time an appointment is for lives inside `patientInfo`, which is
   * envelope-encrypted on the way into the database and unreadable to SQL. So
   * there is no column to range-filter on: any such query would either decrypt
   * records in the database, which is not something a database can do, or match
   * against ciphertext, which is not a date comparison.
   *
   * So the store filters on what *is* queryable -- the status, which is why the
   * method takes a list rather than a date range -- and the job filters on the
   * time after opening the records. That is O(n) envelope decrypts per run, which
   * is fine at clinic volumes and is the wrong shape at scale.
   *
   * The fix at scale is a separate, non-encrypted scheduling column written
   * alongside the record -- `starts_at timestamptz` -- and this method becoming a
   * range scan on it. That trades a plaintext appointment time in the table for a
   * query that does not have to open every record, which is a real trade and not
   * one to make silently. It is left as the named next step rather than taken
   * here, because this repository's position is that `patient_info` is ciphertext
   * and a second plaintext copy of a patient's schedule would undo that.
   *
   * Bounded, because a store method that can return every appointment is a store
   * method that eventually will.
   */
  listByStatus(statuses: readonly AppointmentStatus[], limit: number): Promise<Appointment[]>;

  /**
   * Claim a one-shot key, and report whether this caller won it.
   *
   * The primitive behind "do not send this twice", and it is a claim rather than
   * a read followed by a write for the reason `spendActionGrant` is: two cron
   * invocations overlapping a window boundary -- which is what a retry, a redeploy
   * mid-run, or a platform double-fire all look like -- would both read "not yet
   * sent" and both send. The claim is decided in one atomic step, so exactly one
   * of them proceeds.
   *
   * A key is scoped by `scope`, so a reminder and anything else that needs
   * exactly-once are not competing for one namespace. `key` is the caller's
   * identity for the thing being claimed; the same key under a different scope is
   * a different claim.
   *
   * Claims are never released. A reminder that failed should not be retried by the
   * same window, and a caller that wants a different answer asks with a different
   * key.
   */
  claimOnce(scope: ClaimScope, key: string): Promise<boolean>;
}

/**
 * What an exactly-once claim is for.
 *
 * A closed set, so a typo in a scope string is a type error rather than a claim
 * in a namespace nobody has ever read. It is small because a scope that nobody
 * enumerated is a scope nobody will ever audit.
 */
export const CLAIM_SCOPES = ["reminder"] as const;

export type ClaimScope = (typeof CLAIM_SCOPES)[number];
