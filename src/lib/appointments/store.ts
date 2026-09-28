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
 * API, the sealed token -- is written against the interface alone, so a second
 * implementation (or a test double) needs to provide these four methods and
 * nothing else.
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
}
