import type { AppointmentRecord } from "@/lib/validation/intake";
import {
  assertValidAppointmentPatch,
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

  /** Test seam. Not part of `AppointmentStore`. */
  get size(): number {
    return this.appointments.size;
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
