import { v4 as uuidv4 } from "uuid";
import { AUDIT_ACTORS, appointmentResource, recordAuditEvent } from "@/lib/audit";
import { getSqlClient } from "@/lib/storage";
import type { AppointmentRecord } from "@/lib/validation/intake";
import { InMemoryAppointmentStore } from "./memory-store";
import { PostgresAppointmentStore } from "./postgres-store";
import {
  assertValidAppointmentPatch,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
} from "./store";

/**
 * Appointments, as the rest of the application sees them.
 *
 * This was a `Map` in this file. It is now a selection between two stores,
 * chosen once, and four functions over the interface in ./store -- create, get,
 * update, cancel -- which is the surface a status lookup and a cancel flow need
 * and which only ever had create and get.
 *
 * Everything above this file depends on the interface, not on either
 * implementation, so swapping a store is one call to `setAppointmentStore` and
 * never a change to booking, to the sealed token, or to a route.
 *
 * Every one of the four also writes to the audit trail, here rather than at the
 * call sites. That placement is the part worth arguing about: it means a record
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
 */
export async function updateAppointment(
  id: string,
  patch: AppointmentPatch,
): Promise<Appointment | undefined> {
  assertValidAppointmentPatch(patch);

  await recordAuditEvent({
    actor: AUDIT_ACTORS.system,
    action: "APPOINTMENT_UPDATED",
    resource: appointmentResource(id),
    details: { reason: "status_change", status: patch.status },
  });

  return getAppointmentStore().update(id, patch);
}

/** Cancel an appointment, and record the cancellation. */
export async function cancelAppointment(id: string): Promise<Appointment | undefined> {
  await recordAuditEvent({
    actor: AUDIT_ACTORS.system,
    action: "APPOINTMENT_CANCELLED",
    resource: appointmentResource(id),
    details: { reason: "status_change", status: "cancelled" },
  });

  return getAppointmentStore().cancel(id);
}

export {
  APPOINTMENT_STATUSES,
  isAppointmentStatus,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStore,
} from "./store";
export { InMemoryAppointmentStore } from "./memory-store";
export { PostgresAppointmentStore } from "./postgres-store";
