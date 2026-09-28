import { buildEntry, GENESIS_HASH, verifyChain, type AuditLogEntry, type AuditLogStore } from "./store";

/**
 * The in-memory audit chain.
 *
 * The default, and correct for a single Node process that has not restarted.
 * It was the only implementation until the durable store landed, and it is what
 * the trail falls back to when no DATABASE_URL is configured -- which is also
 * what `bun scripts/verify-hipaa.ts` exercises, so the encryption and chain
 * checks in CI run against the same code a database-less deployment runs.
 *
 * What it is not is durable: on a serverless platform a cold start takes the
 * trail with it, which for an immutable audit log is a worse failure than for
 * the appointments themselves, because a gap in the trail is indistinguishable
 * from an access nobody recorded. That is the strongest argument in this change
 * for configuring a database.
 */
export class InMemoryAuditLogStore implements AuditLogStore {
  private entries: AuditLogEntry[] = [];

  async append(input: {
    id: string;
    timestamp: string;
    actor: string;
    action: AuditLogEntry["action"];
    resource: string;
    details?: AuditLogEntry["details"];
  }): Promise<AuditLogEntry> {
    return this.write(input);
  }

  async read(limit?: number): Promise<AuditLogEntry[]> {
    return this.entries.slice(-(limit ?? this.entries.length)).map(copy);
  }

  async verify(): Promise<boolean> {
    return verifyChain(this.entries);
  }

  /** The synchronous append, for the chain logic to be reachable without a promise. */
  write(input: {
    id: string;
    timestamp: string;
    actor: string;
    action: AuditLogEntry["action"];
    resource: string;
    details?: AuditLogEntry["details"];
  }): AuditLogEntry {
    const previousHash = this.entries.length > 0 ? this.entries[this.entries.length - 1].hash : GENESIS_HASH;

    const entry = buildEntry({ ...input, previousHash });
    this.entries.push(entry);
    return entry;
  }

  /** The chain itself, so a test can tamper with it as an attacker would. */
  get size(): number {
    return this.entries.length;
  }
}

function copy(entry: AuditLogEntry): AuditLogEntry {
  return { ...entry, details: entry.details ? { ...entry.details } : undefined };
}
