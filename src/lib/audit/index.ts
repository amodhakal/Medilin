import { v4 as uuidv4 } from "uuid";
import { getSqlClient } from "@/lib/storage";
import { InMemoryAuditLogStore } from "./memory-store";
import { PostgresAuditLogStore } from "./postgres-store";
import {
  assertAuditDetails,
  type AuditAction,
  type AuditDetails,
  type AuditLogEntry,
  type AuditLogStore,
} from "./store";

/**
 * The audit trail, as the application writes to it.
 *
 * This was an in-memory `AuditLogManager` that only `POST /api/audit` used, so
 * a booking and a record read both went unrecorded and the trail was an endpoint
 * rather than a control. The chain logic is unchanged; what this layer adds is
 * that the trail is somewhere the booking and record-access paths go through,
 * and that it can be somewhere other than this process.
 *
 * The store is chosen the same way the appointment store is: durable when
 * DATABASE_URL is configured, in memory otherwise, and chosen once.
 */

/**
 * The in-memory chain, and the default.
 *
 * Exported because it is the default configuration: `scripts/verify-hipaa.ts`
 * exercises the encryption and chain checks against this object, so CI is
 * testing the code a database-less deployment actually runs.
 */
export const auditLogger = new InMemoryAuditLogStore();

function selectStore(): AuditLogStore {
  const sql = getSqlClient();
  return sql === null ? auditLogger : new PostgresAuditLogStore(sql);
}

let store: AuditLogStore | null = null;

export function getAuditLogStore(): AuditLogStore {
  if (!store) store = selectStore();
  return store;
}

/** Test seam, and the seam a second implementation installs through. */
export function setAuditLogStore(next: AuditLogStore | null): void {
  store = next;
}

export interface AuditEvent {
  actor: string;
  action: AuditAction;
  resource: string;
  details?: AuditDetails;
}

/**
 * Append an entry to the trail.
 *
 * Throws if it cannot be written, and that is the whole design. A caller that
 * reads a patient record and cannot record having read it must not be allowed to
 * return the record, and a caller that is about to write one must not be allowed
 * to write it. Failing closed is the same posture the encryption key takes when
 * `HIPAA_MASTER_KEY` is missing: absence is an error, and there is no fallback
 * that would quietly produce an unlogged access.
 *
 * Details are validated here, before the entry exists, because the alternative
 * is an immutable log with a symptom description in it.
 */
export async function recordAuditEvent(event: AuditEvent): Promise<AuditLogEntry> {
  // Widened for the runtime check. The parameter is typed, so this is belt and
  // braces -- except for the one caller that is not in this process, the
  // internal write endpoint, whose payload arrives as `Record<string, unknown>`
  // and is refused here if it is not the closed set.
  const details = assertAuditDetails(event.details as Record<string, unknown> | undefined);

  return getAuditLogStore().append({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    actor: event.actor,
    action: event.action,
    resource: event.resource,
    ...(details === undefined ? {} : { details }),
  });
}

/** The trail, oldest first. Bounded by the store so a request cannot be answered with the whole log. */
export async function readAuditLog(limit?: number): Promise<AuditLogEntry[]> {
  return getAuditLogStore().read(limit);
}

/** True when every entry still hashes to the value it was written with. */
export async function verifyAuditChain(): Promise<boolean> {
  return getAuditLogStore().verify();
}

export {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_REASONS,
  GENESIS_HASH,
  AuditDetailsError,
  appointmentResource,
  transcriptResource,
  assertAuditDetails,
  buildEntry,
  calculateEntryHash,
  verifyChain,
} from "./store";
export { InMemoryAuditLogStore } from "./memory-store";
export { PostgresAuditLogStore } from "./postgres-store";
export type {
  AuditAction,
  AuditDetails,
  AuditLogEntry,
  AuditLogStore,
  AuditReason,
} from "./store";
