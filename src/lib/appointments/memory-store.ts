import type { AppointmentRecord } from "@/lib/validation/intake";
import {
  assertValidAppointmentPatch,
  type ActionGrant,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
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
