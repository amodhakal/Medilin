import type { AppointmentRecord } from "@/lib/validation/intake";
import {
  assertValidAppointmentPatch,
  assertValidTranscriptBatch,
  TRANSCRIPT_LINE_LIMIT,
  type ActionGrant,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
  type TranscriptLine,
} from "./store";

/**
 * The in-memory appointment store.
 *
 * The default, and correct for exactly one situation: a single Node process
 * that outlives the request. It was the only implementation until the durable
 * store landed, and it is what `getAppointmentStore` falls back to when no
 * DATABASE_URL is configured, so a contributor's laptop and CI need no
 * credentials.
 *
 * What it is not is durable. On a serverless platform every cold start, every
 * redeploy and every concurrent instance has its own, so a booking made on one
 * instance is invisible to the next -- which is #17, and which is why
 * `PostgresAppointmentStore` exists and why the selection between them is
 * visible rather than implicit.
 *
 * It hands out copies rather than the stored objects. The `Map` returned the
 * live record, so `getAppointment(id)!.patientInfo.firstName = "x"` rewrote the
 * store from two call sites away, and a caller holding a record could change it
 * after the fact with no write, no audit entry, and no way to tell.
 */
export class InMemoryAppointmentStore implements AppointmentStore {
  private readonly appointments = new Map<string, Appointment>();

  async create(appointment: Appointment): Promise<Appointment> {
    this.appointments.set(appointment.id, clone(appointment));
    return clone(appointment);
  }

  async get(id: string): Promise<Appointment | undefined> {
    const found = this.appointments.get(id);
    return found ? clone(found) : undefined;
  }

  async update(id: string, patch: AppointmentPatch): Promise<Appointment | undefined> {
    const existing = this.appointments.get(id);
    if (!existing) return undefined;

    const next = applyPatch(existing, patch);
    this.appointments.set(id, next);
    return clone(next);
  }

  async cancel(id: string): Promise<Appointment | undefined> {
    return this.update(id, { status: "cancelled" });
  }

  /**
   * The capability grants this process has handed out.
   *
   * A `Map`, and therefore exactly as per-instance as the appointments beside
   * it: a link minted on one serverless instance resolves on none of the
   * others. That is not a shortcut taken here, it is the documented reason
   * `PostgresAppointmentStore` exists, and it applies to the grants identically.
   */
  private readonly grants = new Map<string, ActionGrant>();

  async issueActionGrant(grant: ActionGrant): Promise<ActionGrant> {
    const existing = this.grants.get(grant.jti);
    if (existing) return cloneGrant(existing);

    this.grants.set(grant.jti, cloneGrant(grant));
    return cloneGrant(grant);
  }

  async getActionGrant(jti: string): Promise<ActionGrant | undefined> {
    const found = this.grants.get(jti);
    return found ? cloneGrant(found) : undefined;
  }

  /**
   * Withdraw and return, in one step.
   *
   * The check and the write are adjacent statements inside one synchronous turn
   * of the event loop with no `await` between them, which is what makes this
   * atomic here for the same reason `INSERT ... ON CONFLICT DO NOTHING` is
   * atomic there. Splitting it into a read and a write would leave a gap for
   * two concurrent requests carrying the same link to both act on it.
   */
  async spendActionGrant(jti: string, now: Date): Promise<ActionGrant | undefined> {
    const existing = this.grants.get(jti);
    if (!existing) return undefined;
    if (existing.withdrawnAt !== null) return undefined;
    if (existing.expiresAt.getTime() <= now.getTime()) return undefined;

    const spent: ActionGrant = { ...existing, withdrawnAt: new Date(now.getTime()) };
    this.grants.set(jti, spent);
    return cloneGrant(spent);
  }

  async withdrawActionGrants(appointmentId: string, now: Date): Promise<number> {
    let withdrawn = 0;

    for (const [jti, grant] of this.grants) {
      if (grant.appointmentId !== appointmentId) continue;
      if (grant.withdrawnAt !== null) continue;

      this.grants.set(jti, { ...grant, withdrawnAt: new Date(now.getTime()) });
      withdrawn += 1;
    }

    return withdrawn;
  }

  /** Test seam. Not part of `AppointmentStore`. */
  get size(): number {
    return this.appointments.size;
  }

  /** Test seam. Not part of `AppointmentStore`. */
  get grantCount(): number {
    return this.grants.size;
  }

  /**
   * Keys already claimed, by scope.
   *
   * A `Map`, so exactly as per-instance as everything else in this class: a
   * reminder claimed on one serverless instance is unknown to the next, and the
   * next run will send it again. That is #17 rather than a new bug, and it is
   * stated here because a reminder job on the in-memory store is a job that
   * quietly double-sends, which is the failure `claimOnce` exists to prevent.
   */
  private readonly claims = new Map<string, Set<string>>();

  async listByStatus(
    statuses: readonly Appointment["status"][],
    limit: number,
  ): Promise<Appointment[]> {
    const wanted = new Set(statuses);

    // Sorted by creation, not by appointment time: the time is encrypted and
    // cannot be compared here, and the caller sorts it after opening the records.
    // Sorting on `createdAt` at least makes a truncated result a prefix of the
    // whole rather than an arbitrary selection.
    return [...this.appointments.values()]
      .filter((appointment) => wanted.has(appointment.status))
      .sort(byBookingOrder)
      .slice(0, Math.max(0, limit))
      .map(clone);
  }

  /**
   * One page of the same window, in the same order.
   *
   * See `listPage` in ./store for why the order carries an id tiebreak and why
   * neither this nor the durable store may sort on the appointment time. The
   * offset is clamped rather than allowed to reach `slice`, because a negative
   * one is a negative index, and `slice(-1, 19)` is the newest record.
   */
  async listPage(
    statuses: readonly Appointment["status"][],
    limit: number,
    offset: number,
  ): Promise<Appointment[]> {
    const wanted = new Set(statuses);
    const start = clampCount(offset);
    const size = clampCount(limit);
    if (size === 0) return [];

    return [...this.appointments.values()]
      .filter((appointment) => wanted.has(appointment.status))
      .sort(byBookingOrder)
      .slice(start, start + size)
      .map(clone);
  }

  async claimOnce(scope: string, key: string): Promise<boolean> {
    const taken = this.claims.get(scope);
    if (!taken) {
      this.claims.set(scope, new Set([key]));
      return true;
    }

    if (taken.has(key)) return false;

    taken.add(key);
    return true;
  }

  /** Test seam. Not part of `AppointmentStore`. */
  get claimCount(): number {
    let total = 0;
    for (const keys of this.claims.values()) total += keys.size;
    return total;
  }

  /* ------------------------------ transcript ----------------------------- */

  /**
   * Each appointment's lines, by position.
   *
   * A `Map` keyed by `seq` rather than an array, because the whole contract is
   * "one line per position": the same `seq` written twice is a correction, and
   * an array would have to be searched to know which element to replace. It is
   * exactly as per-instance as everything else in this class -- a line written
   * on one serverless instance is unknown to the next, and the call's transcript
   * is truncated at the instance boundary. That is #17 rather than a new bug,
   * and `PostgresAppointmentStore` is the answer to it.
   */
  private readonly transcripts = new Map<string, Map<number, TranscriptLine>>();

  async appendTranscript(
    appointmentId: string,
    lines: readonly TranscriptLine[],
  ): Promise<number> {
    // The whole batch, before the first write, so a partly valid batch stores
    // nothing at all. `assertValidAppointmentPatch` is called the same way.
    assertValidTranscriptBatch(lines);

    if (lines.length === 0) return 0;

    // Checked before anything is written, so a refused write leaves no partial
    // transcript behind for an appointment that does not exist.
    if (!this.appointments.has(appointmentId)) return 0;

    let stored = this.transcripts.get(appointmentId);
    if (!stored) {
      stored = new Map<number, TranscriptLine>();
      this.transcripts.set(appointmentId, stored);
    }

    for (const line of lines) {
      stored.set(line.seq, cloneLine(line));
    }

    return lines.length;
  }

  async getTranscript(appointmentId: string, limit?: number): Promise<TranscriptLine[]> {
    const stored = this.transcripts.get(appointmentId);
    if (!stored) return [];

    // A negative cap is clamped to nothing rather than to everything. `slice`
    // with a negative number counts from the end, which would turn a bug into
    // "here is the whole conversation" -- the opposite of what a negative limit
    // means anywhere else.
    const cap = limit === undefined ? TRANSCRIPT_LINE_LIMIT : Math.max(0, limit);

    const ordered = [...stored.values()].sort((a, b) => a.seq - b.seq);

    // The tail, in order: see `getTranscript` on the interface for why a cap
    // keeps the end of the conversation.
    return (cap >= ordered.length ? ordered : ordered.slice(ordered.length - cap)).map(cloneLine);
  }

  /** Test seam. Not part of `AppointmentStore`. */
  get transcriptCount(): number {
    let total = 0;
    for (const lines of this.transcripts.values()) total += lines.size;
    return total;
  }
}

/**
 * Booking order: when the request was made, with the id as the tiebreak.
 *
 * Total, which is the property that makes offset paging correct -- see
 * `listPage` in ./store. `localeCompare` rather than `<` because the ids are
 * strings, and a comparison that disagrees with Postgres's `ORDER BY id` on
 * anything outside ASCII would give the two implementations different pages for
 * the same question.
 */
function byBookingOrder(a: Appointment, b: Appointment): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

/**
 * A page window as a non-negative whole number of rows.
 *
 * A caller cannot be trusted with an index, and `NaN` reaching `slice` would
 * quietly produce an empty page rather than the error that would be more
 * honest -- so the invalid value is normalised to zero here, in the store,
 * rather than at each call site that forgets.
 */
function clampCount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Apply a patch and stamp `updatedAt`.
 *
 * Shared with nothing -- the durable store does this in SQL, where the
 * equivalent is `now()` -- but kept here rather than inlined so the two
 * implementations can be read side by side and compared.
 */
export function applyPatch(existing: Appointment, patch: AppointmentPatch): Appointment {
  assertValidAppointmentPatch(patch);

  return {
    ...existing,
    ...patch,
    patientInfo: patch.patientInfo
      ? ({ ...existing.patientInfo, ...patch.patientInfo } as AppointmentRecord)
      : existing.patientInfo,
    updatedAt: new Date(),
  };
}

/** A deep-enough copy: the record is flat except for the patient payload. */
export function clone(appointment: Appointment): Appointment {
  return {
    ...appointment,
    patientInfo: { ...appointment.patientInfo },
    createdAt: new Date(appointment.createdAt.getTime()),
    updatedAt: new Date(appointment.updatedAt.getTime()),
  };
}

/** The same for a grant: hand out a copy so a caller cannot withdraw it in place. */
export function cloneGrant(grant: ActionGrant): ActionGrant {
  return {
    ...grant,
    actions: [...grant.actions],
    expiresAt: new Date(grant.expiresAt.getTime()),
    withdrawnAt: grant.withdrawnAt === null ? null : new Date(grant.withdrawnAt.getTime()),
  };
}

/**
 * The same for a transcript line.
 *
 * A separate function rather than a generic deep copy because this is the one
 * record in this file that is a long, patient-authored string: handing out the
 * stored object would let a caller holding a replayed line rewrite the stored
 * one, which is the whole defect `clone` above was written to remove.
 */
export function cloneLine(line: TranscriptLine): TranscriptLine {
  return { ...line, at: new Date(line.at.getTime()) };
}
