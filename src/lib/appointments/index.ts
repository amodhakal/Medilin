import { v4 as uuidv4 } from "uuid";
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
 * Record a new appointment.
 *
 * The id is minted here rather than in the store so that the same value is
 * returned, stored, emailed as the reference number, and put in the audit
 * entry -- one identifier, one source.
 */
export async function createAppointment(patientInfo: AppointmentRecord): Promise<Appointment> {
  const now = new Date();

  return getAppointmentStore().create({
    id: uuidv4(),
    patientInfo,
    createdAt: now,
    updatedAt: now,
    conversationEnded: false,
    status: "scheduled",
  });
}

export async function getAppointment(id: string): Promise<Appointment | undefined> {
  return getAppointmentStore().get(id);
}

/**
 * Change an appointment, or return `undefined` if there is no such id.
 *
 * Validated before it is dispatched so that a caller gets the same refusal, and
 * the same message, whichever store is in use.
 */
export async function updateAppointment(
  id: string,
  patch: AppointmentPatch,
): Promise<Appointment | undefined> {
  assertValidAppointmentPatch(patch);
  return getAppointmentStore().update(id, patch);
}

export async function cancelAppointment(id: string): Promise<Appointment | undefined> {
  return getAppointmentStore().cancel(id);
}

export {
  APPOINTMENT_STATUSES,
  isAppointmentStatus,
  type Appointment,
  type AppointmentPatch,
  type AppointmentStatus,
  type AppointmentStore,
} from "./store";
export { InMemoryAppointmentStore } from "./memory-store";
export { PostgresAppointmentStore } from "./postgres-store";
