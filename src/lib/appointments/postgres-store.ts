import { SqlError, type SqlClient } from "@/lib/storage";
import { decryptPHI, encryptPHI, type EncryptedEnvelope } from "@/lib/encryption";
import { isAppointmentStatus, type Appointment, type AppointmentPatch, type AppointmentStore } from "./store";
import type { AppointmentRecord } from "@/lib/validation/intake";

/**
 * The durable appointment store.
 *
 * The bug this exists for: appointments lived in a `Map` in the module, so a
 * serverless cold start, a redeploy, or a request landing on a second instance
 * erased every booking that instance had not personally taken. The patient's
 * link stopped resolving, and the clinic had a booking it could not find.
 *
 * Design notes that a reviewer should not have to reverse-engineer.
 *
 * **The record is envelope-encrypted on the way in and opened on the way out.**
 * The `AppointmentStore` interface is in plaintext -- booking, the status API and
 * the sealed token all work with a record, not with ciphertext -- and this class
 * is the one place that knows the difference. Encrypting here rather than in the
 * booking path means no caller can forget: a new caller gets encryption by
 * calling `create`, exactly as it gets persistence by calling `create`.
 *
 * `encryptPHI` is the envelope in ../encryption -- a fresh DEK per record, the
 * plaintext under the DEK, the DEK wrapped under `HIPAA_MASTER_KEY` -- and it
 * fails closed. A deployment with a database and no master key cannot book, and
 * that is the correct outcome: the alternative is a table of plaintext records
 * that nobody was warned about.
 *
 * The in-memory store does not encrypt, and neither should it. Process memory is
 * not "at rest", the key would be in the same process as the plaintext, and the
 * default configuration has to work with no database and no ceremony. Encrypting
 * there would be the appearance of a control rather than one.
 *
 * **The identifier column is `text`, not `uuid`.** It is tempting to type it
 * `uuid`, and against a `uuid` column a lookup for `"not-a-uuid"` is a cast
 * error rather than a miss -- a 500 where the caller is entitled to "no such
 * appointment". The store contract says an id that does not exist returns
 * `undefined`, and that has to hold for every id-shaped string, not only the
 * well-formed ones. Identifiers are still minted with `uuidv4`; the column just
 * stops second-guessing them.
 *
 * **`update` is one fixed statement, not SQL assembled from the patch.** Every
 * patchable column is `COALESCE($n, column)`, so an absent field arrives as
 * NULL and leaves the column alone. The alternative builds a statement string
 * per patch, which is more code and puts a patient record one escaping mistake
 * away from becoming syntax. This way no caller-controlled value ever reaches
 * the statement text -- only bound parameters.
 *
 * **A malformed row throws rather than reading as absent.** The alternative --
 * returning `undefined` for a row whose columns do not parse -- answers "you
 * have no appointment" to a patient who has one, and does it silently, forever.
 *
 * The schema is created on first use, as a single idempotent statement, so the
 * store works against a fresh database with no migration step to forget. It
 * stops working the day this table has a second version, which is when it
 * becomes a migration and stops being a `CREATE TABLE IF NOT EXISTS`.
 */
export class PostgresAppointmentStore implements AppointmentStore {
  private schema: Promise<void> | null = null;

  constructor(private readonly sql: SqlClient) {}

  async create(appointment: Appointment): Promise<Appointment> {
    await this.ready();

    const rows = await this.sql.query<AppointmentRow>(
      `INSERT INTO appointments (id, patient_info, status, conversation_ended, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        appointment.id,
        seal(appointment.patientInfo),
        appointment.status,
        appointment.conversationEnded,
        appointment.createdAt.toISOString(),
        appointment.updatedAt.toISOString(),
      ],
    );

    // RETURNING on an INSERT always produces the row, so an empty result is a
    // driver that is not behaving and not a caller that did something odd.
    if (rows.length !== 1) {
      throw new SqlError(
        "unexpected",
        "The database reported no row for an appointment it had just accepted.",
      );
    }

    return toAppointment(rows[0]);
  }

  async get(id: string): Promise<Appointment | undefined> {
    await this.ready();

    const rows = await this.sql.query<AppointmentRow>(
      `SELECT ${COLUMNS} FROM appointments WHERE id = $1`,
      [id],
    );

    return rows.length === 0 ? undefined : toAppointment(rows[0]);
  }

  async update(id: string, patch: AppointmentPatch): Promise<Appointment | undefined> {
    await this.ready();

    // A `null` parameter leaves its column alone; anything else overwrites it.
    // Every patchable field is passed unconditionally so the statement is the
    // same one every time.
    const rows = await this.sql.query<AppointmentRow>(
      `UPDATE appointments
          SET patient_info       = COALESCE($2::jsonb, patient_info),
              status             = COALESCE($3::text, status),
              conversation_ended = COALESCE($4::boolean, conversation_ended),
              updated_at         = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [
        id,
        patch.patientInfo === undefined ? null : seal(patch.patientInfo),
        patch.status ?? null,
        patch.conversationEnded ?? null,
      ],
    );

    return rows.length === 0 ? undefined : toAppointment(rows[0]);
  }

  async cancel(id: string): Promise<Appointment | undefined> {
    await this.ready();

    const rows = await this.sql.query<AppointmentRow>(
      `UPDATE appointments
          SET status = 'cancelled', updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id],
    );

    return rows.length === 0 ? undefined : toAppointment(rows[0]);
  }

  /**
   * Create the table if it is not there yet, once per process.
   *
   * The promise is dropped on failure rather than cached, so a database that was
   * unreachable when the first request arrived is retried on the next one
   * instead of being a permanent, invisible failure for the life of the process.
   */
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
      CREATE TABLE IF NOT EXISTS appointments (
        id                 text PRIMARY KEY,
        patient_info       jsonb NOT NULL,
        status             text NOT NULL DEFAULT 'scheduled',
        conversation_ended boolean NOT NULL DEFAULT false,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        -- The second line of defence for APPOINTMENT_STATUSES. The application
        -- validates before it writes; the constraint is what makes that
        -- validation impossible to forget, or to bypass with psql.
        CONSTRAINT appointments_status_check
          CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed'))
      )
    `);

    // Declared rather than left to be inferred, because the column name says what
    // it holds and not how. Anyone reading the schema, or querying the table
    // directly, should not have to know which writer put what in it.
    await this.sql.query(`
      COMMENT ON COLUMN appointments.patient_info IS
        'Envelope-encrypted patient record (AES-256-GCM under a per-record DEK wrapped by HIPAA_MASTER_KEY). Ciphertext, not plaintext.'
    `);
  }
}

/**
 * Encrypt a record for storage.
 *
 * The envelope is stored as a single jsonb object rather than spread over six
 * columns: it is one value with one lifecycle, a round trip through Postgres
 * cannot leave half of it behind, and a `SELECT *` cannot accidentally select
 * the ciphertext without its auth tag.
 */
function seal(patientInfo: AppointmentRecord): string {
  return JSON.stringify(encryptPHI(JSON.stringify(patientInfo)));
}

/** Open a stored record. Throws rather than returning a partial record. */
function open(sealed: unknown): AppointmentRecord {
  return JSON.parse(decryptPHI(toEnvelope(sealed))) as AppointmentRecord;
}

/**
 * Narrow the stored jsonb to an envelope.
 *
 * Every field is checked, because `decryptPHI` reads all six and would fail on a
 * missing one with a `Buffer.from(undefined)` that says nothing about which
 * column is wrong. A row that is not an envelope is a record this code cannot
 * read, and the honest answer is to say so rather than to return `undefined` and
 * let a patient be told they have no appointment.
 */
function toEnvelope(value: unknown): EncryptedEnvelope {
  const parsed = typeof value === "string" ? safeParse(value) : value;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("appointments row: patient_info is not a JSON object");
  }

  const source = parsed as Record<string, unknown>;
  const fields = [
    "ciphertext",
    "encryptedDEK",
    "iv",
    "dekIv",
    "authTag",
    "dekAuthTag",
  ] as const;

  for (const field of fields) {
    if (typeof source[field] !== "string" || source[field] === "") {
      throw new Error(`appointments row: patient_info is missing ${field}`);
    }
  }

  return source as unknown as EncryptedEnvelope;
}

const COLUMNS =
  "id, patient_info, status, conversation_ended, created_at, updated_at";

interface AppointmentRow {
  id: string;
  patient_info: unknown;
  status: string;
  conversation_ended: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Rebuild the domain object from a database row.
 *
 * Every field is checked rather than cast, and a row that does not parse throws
 * naming the column. `patient_info` arrives as an object from a `jsonb` column
 * and as a string from a driver that does not deserialise, so both are
 * accepted; a record that is neither is a bug, not a patient without a record.
 */
export function toAppointment(row: AppointmentRow): Appointment {
  if (typeof row.id !== "string" || row.id === "") {
    throw new Error("appointments row: id is missing or not a string");
  }

  if (!isAppointmentStatus(row.status)) {
    throw new Error(
      `appointments row: status is not one of the known statuses (got ${JSON.stringify(row.status)})`,
    );
  }

  if (typeof row.conversation_ended !== "boolean") {
    throw new Error("appointments row: conversation_ended is not a boolean");
  }

  return {
    id: row.id,
    patientInfo: open(row.patient_info),
    status: row.status,
    conversationEnded: row.conversation_ended,
    createdAt: toDate(row.created_at, "created_at"),
    updatedAt: toDate(row.updated_at, "updated_at"),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toDate(value: unknown, column: string): Date {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`appointments row: ${column} is not a timestamp`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`appointments row: ${column} is not a timestamp`);
  }

  return date;
}
