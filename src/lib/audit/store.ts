import * as crypto from "crypto";
import type { AppointmentStatus } from "@/lib/appointments/store";
import type { SupportedLanguage } from "@/lib/validation/intake";

/**
 * The audit trail, and the chain that makes it worth having.
 *
 * `AuditLogManager` existed and was correct, and nothing used it. The only
 * caller was the internal `POST /api/audit`, so a booking wrote no entry and a
 * record read wrote none either -- the trail was an endpoint, not a control.
 * The primitives are the same ones that were already here; what changed is that
 * the store is an interface, that it survives a cold start, and that the
 * booking and record-access paths go through it.
 *
 * Two properties are load-bearing and both are enforced here rather than at the
 * call sites.
 *
 * **Details cannot carry PHI.** `AuditDetails` is a closed set of three
 * non-identifying fields, checked at runtime as well as by the type, because
 * the one caller that cannot be trusted to comply -- the internal write
 * endpoint, whose payload comes from outside this process -- is exactly the one
 * that must not be able to put a symptom description into an immutable log
 * nobody can redact. A trail that cannot be redacted is a permanent copy.
 *
 * **A write that cannot be recorded does not happen.** `recordAuditEvent` throws
 * rather than swallowing, so the paths that call it fail instead of proceeding
 * unlogged. That is the same posture as the encryption key: absence is an
 * error, not a fallback.
 */

/** The hash the first entry in a chain points back to. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * What can be in a trail entry.
 *
 * A closed set, and a small one. Every field is non-identifying by
 * construction, which is what makes the closed set worth having: an allowlist
 * cannot be satisfied by a new field, only by a deliberate change to this type,
 * and that change arrives in a diff someone reads.
 */
export const AUDIT_REASONS = [
  "intake",
  "track_link",
  "internal_api",
  "status_change",
  // #59. A patient changing their own appointment through a scoped, expiring,
  // revocable link. Distinct from `track_link` on purpose: that is a read of a
  // record, and this is a write to one, made by whoever holds the link. An
  // auditor asking "who cancelled this?" should not have to answer "someone
  // with a bearer token, and the trail does not say which kind".
  "patient_link",
  // #63. Somebody with the internal shared secret opened the clinic dashboard
  // and every record on the page came back. Its own reason because `internal_api`
  // is what the webhook, the audit log and the status lookup all say, and a
  // dashboard read is the one access in this application that is a *bulk* read:
  // twenty patients' records at once, none of them individually requested. An
  // auditor asking who pulled up forty accounts cannot be answered by a trail
  // where those reads are filed as forty unrelated webhook calls.
  //
  // It names the surface and not a person, because there is no person to name --
  // the gate is one shared secret. That limitation is the point of this entry
  // existing: it makes the access visible even though the access cannot be
  // attributed.
  "clinician_dashboard",
] as const;

export type AuditReason = (typeof AUDIT_REASONS)[number];

export interface AuditDetails {
  /** Why the access happened, in the words of this file rather than a caller's. */
  reason?: AuditReason;
  /** The state the appointment ended up in. */
  status?: AppointmentStatus;
  /**
   * The language the patient used. Not identifying on its own, and it is the
   * one intake field with no value to anyone reading the trail.
   */
  language?: SupportedLanguage;
}

const DETAIL_KEYS = ["reason", "status", "language"] as const;

/** The actions the application itself records. */
export const AUDIT_ACTIONS = [
  "APPOINTMENT_CREATED",
  "APPOINTMENT_UPDATED",
  "APPOINTMENT_CANCELLED",
  "PHI_READ",
  // #59. A patient action through a management link that was refused: expired,
  // already used, withdrawn by a cancellation, or asking for something the link
  // does not grant. Its own action rather than a note on another one, because a
  // trail is append-only and calling a refused attempt an update would put a
  // change into the log that never happened. Most requests carrying a
  // management link are refusals, and a trail with only the successes answers
  // "who cancelled this?" with no account of the twenty failed attempts on the
  // same record that week.
  "APPOINTMENT_ACTION_REFUSED",
  // #63. One page of the clinic dashboard. Its own action for the same reason
  // `patient_link` is its own reason: a trail is append-only, and a read that
  // happened twenty times over cannot honestly be filed as a `PHI_READ` that a
  // reader has to reconstruct. The page is the unit an auditor would ask about
  // -- "who looked at a list of accounts on Tuesday" -- so it is the unit
  // recorded.
  "CLINIC_SCHEDULE_READ",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Who did it.
 *
 * Closed, because `actor` is the field the trail exists to get right, and a
 * free-text actor is a caller writing "Dr. Smith" on behalf of whoever actually
 * opened the record. The clinic has no clinician accounts in this application,
 * so every actor here is a role the request really had.
 */
export const AUDIT_ACTORS = {
  /** A patient submitting the intake form. */
  patient: "patient:web",
  /** Whoever holds a link to a record, with no account behind it. */
  linkBearer: "link-bearer",
  /**
   * A patient acting on their own record through a management link (#59).
   *
   * Separate from `linkBearer` because the trail can now tell them apart, and
   * that is the whole point of #59: the management link is scoped, expiring and
   * revocable, so an entry that says `patient:link` is a *write* by whoever
   * holds that link, where `link-bearer` is a *read* by whoever holds the
   * tracking one. It is still a bearer credential -- there is no account behind
   * either -- and the actor says which link, not who the person is.
   */
  patientLink: "patient:link",
  /** A caller holding the internal shared secret. */
  internalApi: "internal-api",
  /** The booking pipeline recording on its own behalf. */
  system: "system",
} as const;

/** A rejected details payload. Carries the key, never the value. */
export class AuditDetailsError extends Error {
  constructor(readonly key: string) {
    super(
      `Refusing to write an audit entry with an unrecognised details key: ${key}. ` +
        "Audit details are a closed set of non-identifying fields; see " +
        "src/lib/audit/store.ts.",
    );
    this.name = "AuditDetailsError";
  }
}

/**
 * Reject details that are not the closed set.
 *
 * A key is named in the error and the value is not, for the same reason the
 * closed set exists: this error is about to be handled by a route and a logger,
 * and a value quoted there is a value in a log.
 */
export function assertAuditDetails(details?: Record<string, unknown>): AuditDetails | undefined {
  if (details === undefined) return undefined;

  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new AuditDetailsError("<not an object>");
  }

  const allowed = new Set<string>(DETAIL_KEYS);
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.has(key)) throw new AuditDetailsError(key);
    // Every field in the closed set is a string, so anything else is a caller
    // that has found a way past the type.
    if (value !== undefined && typeof value !== "string") throw new AuditDetailsError(key);
  }

  return details as AuditDetails;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  resource: string;
  details?: AuditDetails;
  previousHash: string;
  hash: string;
}

/**
 * The hash of one entry, chained to the one before it.
 *
 * The payload is built by hand rather than stringified from the entry, because
 * `JSON.stringify` is only canonical for as long as nobody reorders the fields
 * -- and something does. A `jsonb` column does not preserve key order: Postgres
 * normalises and re-sorts on the way in, so an entry read back out of the
 * durable store has its details in a different order from the one that was
 * written, and a hash computed over the object's own key order would disagree
 * with itself the moment the trail was read back. Details are therefore emitted
 * in `DETAIL_KEYS` order, always.
 *
 * `details` is normalised to `{}` when absent so that an entry with no details
 * and an entry with an empty object hash the same way -- otherwise the same
 * event would have two hashes depending on which path created it.
 */
export function calculateEntryHash(entry: Omit<AuditLogEntry, "hash">): string {
  const dataToHash = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    details: canonicalDetails(entry.details),
    previousHash: entry.previousHash,
  });

  return crypto.createHash("sha256").update(dataToHash).digest("hex");
}

/**
 * Details in a fixed order, with absent fields absent.
 *
 * A key outside the closed set is dropped, which on its own would make a
 * hand-written row carrying an extra field verify as valid. So it is not enough
 * on its own, and `verifyChain` checks the round trip explicitly: a field the
 * hash does not cover is a field nothing can vouch for, and an audit entry is
 * not the place to leave one.
 */
function canonicalDetails(details?: AuditDetails): Record<string, string> {
  const out: Record<string, string> = {};

  for (const key of DETAIL_KEYS) {
    const value = details?.[key];
    if (value !== undefined) out[key] = value;
  }

  return out;
}

/** True when details are exactly the closed set: no extra key, no wrong-typed value. */
function detailsAreCanonical(details?: AuditDetails): boolean {
  if (details === undefined) return true;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return false;

  for (const [key, value] of Object.entries(details)) {
    if (!(DETAIL_KEYS as readonly string[]).includes(key)) return false;
    if (value !== undefined && typeof value !== "string") return false;
  }

  return true;
}

/** Build the entry, given the hash it has to point back to. */
export function buildEntry(input: {
  id: string;
  timestamp: string;
  actor: string;
  action: AuditAction;
  resource: string;
  details?: AuditDetails;
  previousHash: string;
}): AuditLogEntry {
  const partial: Omit<AuditLogEntry, "hash"> = {
    id: input.id,
    timestamp: input.timestamp,
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    details: input.details,
    previousHash: input.previousHash,
  };

  return { ...partial, hash: calculateEntryHash(partial) };
}

/**
 * Check a chain from its genesis entry.
 *
 * Pure, and shared by both stores, so an entry hashed by one and verified by the
 * other cannot disagree about the algorithm.
 *
 * What this cannot detect is a chain truncated at the head: removing the first
 * entries leaves a shorter chain that is internally consistent. Closing that
 * needs an anchor outside the log -- a periodic hash published somewhere the
 * log cannot reach, or a signed checkpoint -- and there isn't one. It is noted
 * here rather than left to be discovered during an incident.
 */
export function verifyChain(entries: readonly AuditLogEntry[]): boolean {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedPreviousHash =
      index === 0 ? GENESIS_HASH : entries[index - 1].hash;

    if (entry.previousHash !== expectedPreviousHash) return false;

    // A field the hash does not cover cannot be vouched for, so a details object
    // that is not exactly the closed set fails here rather than being quietly
    // normalised away.
    if (!detailsAreCanonical(entry.details)) return false;

    const { hash, ...partial } = entry;
    if (calculateEntryHash(partial) !== hash) return false;
  }

  return true;
}

/** The resource string for an appointment. One format, so entries are joinable. */
export function appointmentResource(id: string): string {
  return `appointment:${id}`;
}

/**
 * Append-only audit storage.
 *
 * `append` returns the entry that was written, including the hash it was given,
 * because the caller may need to be able to point at it and because a durable
 * append can be asked twice for the same thing.
 */
export interface AuditLogStore {
  append(input: {
    id: string;
    timestamp: string;
    actor: string;
    action: AuditAction;
    resource: string;
    details?: AuditDetails;
  }): Promise<AuditLogEntry>;

  /** Oldest first, bounded, so a growing trail cannot answer a request with itself. */
  read(limit?: number): Promise<AuditLogEntry[]>;

  /** Verify the whole chain. Linear, and it re-reads everything. */
  verify(): Promise<boolean>;
}
