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
 *
 * A third pair arrived with #57, for the call transcript: `appendTranscript` and
 * `getTranscript`. They are here for a sharper version of the same reason. The
 * transcript used to be a `useState` array in a client component, which is not
 * merely a cold-start bug -- a patient's own account of why they called, held
 * nowhere, written by nobody, and gone on reload. It is the most sensitive thing
 * this application holds after the record itself, and it is the one thing that
 * was never persisted.
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
   * One page of the same window, starting at `offset`, in booking order.
   *
   * Arrived with the clinic dashboard (#63), and it exists only because
   * `listByStatus` has no way to say "and now the next twenty".
   *
   * The awkward options were all worse. Scanning the prefix again and dropping
   * `offset` rows would decrypt the same records on every page, so paging would
   * cost more the further in you went. Growing `listByStatus` with an offset
   * parameter would change the signature the reminder job already calls, for a
   * method whose whole job is "everything due, bounded", and a reminder run
   * does not page. A second data source -- a search index, a second table -- was
   * never on the table, because the record is the record.
   *
   * **The order is booking order, total and stable, and that is a requirement
   * rather than a detail.** `created_at ASC, id ASC`: the id tiebreak is what
   * makes the order total. Offset paging over an order that is not total skips
   * and repeats rows -- two appointments created in the same millisecond have
   * no defined order, so page two can begin with a row page one already showed,
   * and a clinician reading a day list sees a patient appear twice and another
   * vanish. Both implementations have to agree on the tiebreak for that to hold,
   * which is why it is spelled out here rather than left to each sort.
   *
   * **Still not ordered by appointment time**, and `listByStatus` says why: the
   * time is inside the ciphertext, so there is no column to range-scan and no
   * ordering key to sort on. A clinic sees booking order, and the caller sorts
   * the page it was given by the time the patient asked for. The fix at scale is
   * the same named one as on `listByStatus`: a plaintext `starts_at` column
   * written alongside the record, which this repository has decided not to add.
   *
   * `limit` and `offset` are clamped rather than trusted, and both
   * implementations clamp them the same way. A negative offset must never become
   * a negative array index -- in JavaScript that is counted from the end of the
   * list, and the store would answer with the newest records for a caller that
   * asked for none.
   */
  listPage(
    statuses: readonly AppointmentStatus[],
    limit: number,
    offset: number,
  ): Promise<Appointment[]>;

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

  /**
   * Add lines to an appointment's transcript, and report that they are there.
   *
   * Returns how many lines the batch wrote -- which is the size of the batch, or
   * zero when there is no such appointment. It is not a count of the transcript:
   * `getTranscript` is what answers "how many lines are there", and a caller
   * that wanted a running total should not get it as a side effect of a write
   * that may have corrected a line rather than added one.
   *
   * Append, and the shape of it is the interesting part.
   *
   * A transcript arrives one line at a time, out of a live call, over a network,
   * in whatever order the two agents happen to finish talking. So the unit is
   * not "the transcript" -- nothing ever hands over the whole of it -- it is a
   * **line at a position**, and the position is the caller's. `seq` is the
   * relay's own entry id: monotonic within a session, assigned where the
   * conversation is, and meaningful nowhere else.
   *
   * **A line is corrected in place; the transcript is not replaced.** A voice
   * agent streams an utterance as a run of partial frames and then a final one,
   * and a store that appended each frame separately would replay the call as
   * "how how how are you are are are you". The partial and the final that
   * completes it are one turn, so a second write for a `seq` that is already
   * there updates that line and nothing else. That is also what makes the method
   * safe to retry: a batch whose response a client never saw can be sent again
   * without duplicating a word of the call.
   *
   * What a caller still cannot do is reorder or delete. `seq` is a position, a
   * position is assigned by whoever observed the conversation, and no write
   * moves a line off its position. A caller with a valid link can therefore
   * rewrite the words of *its own* transcript -- which is a capability it
   * already has, since it can append anything at all to it -- and cannot touch
   * another appointment's, or erase one. That is the whole of the blast radius,
   * and it is why this is a store method and not a `replaceTranscript`.
   *
   * Zero when there is no such appointment, which is a miss rather than a
   * failure: a write for a record that is not there has nothing to store, and
   * the caller above it decides what to say about that. It never creates a
   * transcript for an appointment that does not exist, because an orphan
   * transcript is a patient's conversation with no record behind it and nothing
   * that would ever let it be deleted with the record.
   *
   * The whole batch is validated before any of it is written, so a partly valid
   * batch stores nothing: half a call is not a call. A batch that names the same
   * position twice is refused for the same reason -- one statement cannot write
   * one line twice, and the durable store would reject it with an error about
   * cardinality that means nothing to whoever sent it.
   */
  appendTranscript(appointmentId: string, lines: readonly TranscriptLine[]): Promise<number>;

  /**
   * An appointment's transcript, in the order it was said.
   *
   * Lines whose turn never finished are included. A stream the vendor stopped
   * mid-utterance is closed by the relay, so in practice `finalized` is almost
   * always true -- but "the agent was interrupted" is something a transcript
   * should be able to show rather than a sentence to quietly drop, so the flag
   * travels with the line instead of being used to filter one.
   *
   * Bounded, and the bound keeps the *tail*, because a cap that returned the
   * first N lines would replay a long call as its opening pleasantries and drop
   * the booking, which is the only part anyone wants. Bounded at all, because a
   * store method that can return a whole appointment's transcript is a store
   * method that eventually will return a whole table.
   */
  getTranscript(appointmentId: string, limit?: number): Promise<TranscriptLine[]>;
}

/**
 * Who said a line.
 *
 * The same closed-set reasoning as `APPOINTMENT_STATUSES`, and for the same
 * reason: a free-text role would admit "Patient", "PATIENT" and "patient " as
 * three speakers, and this value is what a replay page groups by and what a PDF
 * prints beside a sentence of a patient's medical history.
 *
 * Deliberately the two agents rather than a person. There is no clinician account
 * in this application, and naming a role here that nothing can authenticate
 * would be a fiction in the one place where the words are the record.
 */
export const TRANSCRIPT_ROLES = ["patient", "receptionist"] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export function isTranscriptRole(value: unknown): value is TranscriptRole {
  return (
    typeof value === "string" && (TRANSCRIPT_ROLES as readonly string[]).includes(value)
  );
}

/**
 * One turn of a call, as the store remembers it.
 *
 * `at` is when the line was completed, not when the request that carried it
 * arrived, and it is what a replay orders by and what a PDF prints beside the
 * words.
 */
export interface TranscriptLine {
  /**
   * Position in the conversation. The caller's, and the only key a line has.
   *
   * Not a database sequence and not a uuid: it has to mean the same thing to
   * the browser that produced the line and to the store that keeps it, or
   * ordering is impossible. Monotonic within one session, from zero.
   */
  seq: number;
  role: TranscriptRole;
  /** What was said. PHI, and the reason the durable store encrypts it. */
  text: string;
  at: Date;
  /** False while the line is still being streamed; see the interface comment. */
  finalized: boolean;
}

/** How many lines `getTranscript` returns when the caller does not say. */
export const TRANSCRIPT_LINE_LIMIT = 500;

/**
 * How long a line of speech may be, in characters.
 *
 * A bound rather than a validation of content: the point is that a caller
 * cannot turn the transcript endpoint into somewhere to put an unbounded body,
 * and a booking call's longest utterance is a sentence or two. A line longer
 * than this is a caller that is not writing a transcript.
 */
export const MAX_TRANSCRIPT_TEXT_LENGTH = 4_000;

/**
 * Reject a line the store could not store honestly.
 *
 * Called by the facade so both implementations fail the same way with the same
 * message, and by the in-memory store so it cannot be written to directly. The
 * reasoning is `assertValidAppointmentPatch`'s: a record in a state nothing can
 * compare against is worse than a failed request, because every later lookup
 * silently misreads it.
 *
 * The messages name the field and never the value. A line's text is a patient
 * describing their symptoms, and this error is about to be logged.
 */
export function assertValidTranscriptLine(line: TranscriptLine): void {
  if (
    typeof line.seq !== "number" ||
    !Number.isInteger(line.seq) ||
    line.seq < 0
  ) {
    throw new Error(
      `Refusing to store a transcript line whose position is not a non-negative integer: ${JSON.stringify(line.seq)}`,
    );
  }

  if (!isTranscriptRole(line.role)) {
    throw new Error(
      `Refusing to store a transcript line from an unknown role: ${JSON.stringify(line.role)}`,
    );
  }

  if (typeof line.text !== "string" || line.text.length === 0) {
    throw new Error("Refusing to store a transcript line with no text in it");
  }

  if (line.text.length > MAX_TRANSCRIPT_TEXT_LENGTH) {
    throw new Error(
      `Refusing to store a transcript line longer than ${MAX_TRANSCRIPT_TEXT_LENGTH} characters`,
    );
  }

  if (!(line.at instanceof Date) || Number.isNaN(line.at.getTime())) {
    throw new Error("Refusing to store a transcript line whose timestamp is not a date");
  }
}

/** Validate a whole batch before any of it is written. Half a call is not a call. */
export function assertValidTranscriptBatch(lines: readonly TranscriptLine[]): void {
  for (const line of lines) assertValidTranscriptLine(line);

  // One position, one line. Two lines at the same `seq` in one batch is either a
  // bug in the batching or a caller trying to decide which of two texts is the
  // record, and the durable store answers that with "ON CONFLICT DO UPDATE
  // command cannot affect row a second time" -- a message about SQL internals,
  // surfaced to somebody who was only trying to save a conversation.
  const positions = new Set<number>();
  for (const line of lines) {
    if (positions.has(line.seq)) {
      throw new Error(
        `Refusing to store two transcript lines at the same position (${line.seq})`,
      );
    }
    positions.add(line.seq);
  }
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
