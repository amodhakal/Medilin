import { SqlError, type SqlClient } from "@/lib/storage";
import { buildEntry, GENESIS_HASH, verifyChain, type AuditLogEntry, type AuditLogStore } from "./store";

/**
 * The durable audit chain.
 *
 * An audit log is only worth having if it survives the process that wrote it,
 * and on a serverless platform the process is the least durable thing in the
 * request. A gap in the trail is indistinguishable from an access nobody
 * recorded, so this store is the difference between a control and a decoration.
 *
 * The chain is built the same way as the in-memory one -- read the head, hash the
 * new entry against it, insert -- which means the interesting problem is the
 * race between two instances doing that at the same time. Two things resolve it,
 * and neither of them is a lock:
 *
 *   - `seq` is a plain `bigint` primary key that the INSERT computes as
 *     `MAX(seq) + 1` in the same statement, so the database, not the
 *     application, is what makes two appends collide.
 *   - A collision is a `23505`, and the append is retried against the new head.
 *     The entry keeps its identity across retries, so a retry that turns out to
 *     have already succeeded -- the write landed and the response was lost --
 *     is recognised by its own id instead of being written twice.
 *
 * A transaction would be the tidier answer and is not available: the HTTP driver
 * is asked for one prepared statement at a time, and a session-scoped advisory
 * lock would need a session. The retry is a few lines and is correct for any
 * number of concurrent instances, which is the property that matters.
 */
export class PostgresAuditLogStore implements AuditLogStore {
  private schema: Promise<void> | null = null;

  constructor(private readonly sql: SqlClient) {}

  async append(input: {
    id: string;
    timestamp: string;
    actor: string;
    action: AuditLogEntry["action"];
    resource: string;
    details?: AuditLogEntry["details"];
  }): Promise<AuditLogEntry> {
    await this.ready();

    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const head = await this.readHead();
      const entry = buildEntry({ ...input, previousHash: head?.hash ?? GENESIS_HASH });

      try {
        await this.write(entry);
        return entry;
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== UNIQUE_VIOLATION) throw error;

        // Either another instance took this sequence number, or this very write
        // landed and the response was lost. The second case is not a conflict at
        // all, and what has to come back is the entry that is *stored* -- the one
        // built here chains to whatever the head was at the time, which after a
        // lost response is this entry, so returning it would report a hash the
        // database does not hold.
        const after = await this.readHead();
        if (after?.id === entry.id) return after;
      }
    }

    // Failing closed is the point: the caller must not proceed as though the
    // access had been recorded.
    throw new SqlError(
      "conflict",
      `The audit chain could not be extended after ${MAX_APPEND_ATTEMPTS} attempts.`,
    );
  }

  async read(limit?: number): Promise<AuditLogEntry[]> {
    await this.ready();

    // The newest `limit` entries, oldest first, because a trail read newest-last
    // is a trail nobody can read.
    const rows = await this.sql.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT $1`,
      [limit ?? DEFAULT_READ_LIMIT],
    );

    return rows.reverse().map(toEntry);
  }

  async verify(): Promise<boolean> {
    await this.ready();

    const rows = await this.sql.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_log ORDER BY seq ASC`,
    );

    return verifyChain(rows.map(toEntry));
  }

  /**
   * The most recent entry, whole.
   *
   * Read in full rather than as just its hash, so the "this write already
   * landed" path can hand back the entry the database holds without a second
   * round trip -- and so it cannot hand back a different one.
   */
  private async readHead(): Promise<AuditLogEntry | undefined> {
    const rows = await this.sql.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT 1`,
    );

    return rows.length === 0 ? undefined : toEntry(rows[0]);
  }

  private async write(entry: AuditLogEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_log (seq, entry_id, recorded_at, actor, action, resource, details, previous_hash, hash)
       VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_log), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        entry.id,
        entry.timestamp,
        entry.actor,
        entry.action,
        entry.resource,
        entry.details === undefined ? null : JSON.stringify(entry.details),
        entry.previousHash,
        entry.hash,
      ],
    );
  }

  private ready(): Promise<void> {
    if (!this.schema) {
      this.schema = this.bootstrap().catch((error: unknown) => {
        this.schema = null;
        throw error;
      });
    }
    return this.schema;
  }

  private async bootstrap(): Promise<void> {
    await this.sql.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        seq           bigint PRIMARY KEY,
        entry_id      text NOT NULL UNIQUE,
        recorded_at   timestamptz NOT NULL,
        actor         text NOT NULL,
        action        text NOT NULL,
        resource      text NOT NULL,
        details       jsonb,
        previous_hash text NOT NULL,
        hash          text NOT NULL,
        CONSTRAINT audit_log_hash_length CHECK (length(hash) = 64),
        CONSTRAINT audit_log_previous_hash_length CHECK (length(previous_hash) = 64)
      )
    `);

    // The declaration that the chain is the point, recorded where someone
    // reading the schema will see it: this table is append-only by application
    // and append-only by intention, and neither is enforced by a grant here.
    await this.sql.query(`
      COMMENT ON TABLE audit_log IS
        'SHA-256 hash-chained audit trail. Append-only: entries are never updated or deleted, and a modified entry breaks the chain.'
    `);
  }
}

/** Enough to get through a burst of concurrent instances before giving up. */
const MAX_APPEND_ATTEMPTS = 5;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** What `read` answers with when a caller does not say how much it wants. */
const DEFAULT_READ_LIMIT = 200;

const COLUMNS = "entry_id, recorded_at, actor, action, resource, details, previous_hash, hash";

interface AuditRow {
  entry_id: string;
  recorded_at: string;
  actor: string;
  action: AuditLogEntry["action"];
  resource: string;
  details: unknown;
  previous_hash: string;
  hash: string;
}

/**
 * Rebuild the entry from a row.
 *
 * `details` arrives as an object from a `jsonb` column and as a string from a
 * driver that does not deserialise, so both are accepted. A row that parses to
 * nothing throws: an entry that cannot be read cannot be chained to, and
 * skipping it would silently cut the chain in two.
 */
export function toEntry(row: AuditRow): AuditLogEntry {
  if (typeof row.entry_id !== "string" || row.entry_id === "") {
    throw new Error("audit_log row: entry_id is missing or not a string");
  }
  if (typeof row.hash !== "string" || row.hash.length !== 64) {
    throw new Error("audit_log row: hash is not a sha256 digest");
  }
  if (typeof row.previous_hash !== "string" || row.previous_hash.length !== 64) {
    throw new Error("audit_log row: previous_hash is not a sha256 digest");
  }

  return {
    id: row.entry_id,
    timestamp: String(row.recorded_at),
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    details: toDetails(row.details),
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

function toDetails(value: unknown): AuditLogEntry["details"] {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value as AuditLogEntry["details"];

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as AuditLogEntry["details"];
      }
    } catch {
      throw new Error("audit_log row: details is not valid JSON");
    }
  }

  throw new Error("audit_log row: details is not a JSON object");
}
