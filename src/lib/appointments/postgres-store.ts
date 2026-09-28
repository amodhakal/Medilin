import { SqlError, type SqlClient } from "@/lib/storage";
import { decryptPHI, encryptPHI, type EncryptedEnvelope } from "@/lib/encryption";
import { isPatientAction, isAppointmentStatus, type ActionGrant, type Appointment, type AppointmentPatch, type AppointmentStore, type PatientAction } from "./store";
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
   * Record a capability, once.
   *
   * `ON CONFLICT (jti) DO NOTHING` rather than an upsert, so a `jti` that is
   * already present keeps the row it was issued with -- including a
   * `withdrawn_at` somebody already set. An upsert would let a re-mint un-spend
   * a capability by rewriting the row.
   */
  async issueActionGrant(grant: ActionGrant): Promise<ActionGrant> {
    await this.ready();

    const rows = await this.sql.query<ActionGrantRow>(
      `INSERT INTO appointment_action_grants
         (jti, appointment_id, actions, expires_at, withdrawn_at)
       VALUES ($1, $2, $3::text[], $4, NULL)
       ON CONFLICT (jti) DO NOTHING
       RETURNING ${GRANT_COLUMNS}`,
      [
        grant.jti,
        grant.appointmentId,
        // A Postgres array literal rather than JSON: the database can compare
        // and index it, and it is not a place a caller-supplied string could
        // become anything but an element of a text array.
        `{${grant.actions.join(",")}}`,
        grant.expiresAt.toISOString(),
      ],
    );

    // Nothing returned means this `jti` was already issued, and the row that is
    // there is the one that was issued first. Returning the existing grant is
    // what makes `issueActionGrant` idempotent: re-minting the same capability
    // cannot produce a second live one.
    if (rows.length === 0) {
      const existing = await this.getActionGrant(grant.jti);
      if (existing) return existing;

      // The row was deleted between the conflict and this read -- which is what
      // deleting an appointment does, since the grant cascades. Throwing rather
      // than returning a phantom grant: `rows[0]` is not there, and inventing a
      // capability would authorise something nobody issued.
      throw new SqlError(
        "unexpected",
        "A capability conflicted with a row that then could not be read.",
      );
    }

    return toActionGrant(rows[0]);
  }

  async getActionGrant(jti: string): Promise<ActionGrant | undefined> {
    await this.ready();

    const rows = await this.sql.query<ActionGrantRow>(
      `SELECT ${GRANT_COLUMNS} FROM appointment_action_grants WHERE jti = $1`,
      [jti],
    );

    return rows.length === 0 ? undefined : toActionGrant(rows[0]);
  }

  /**
   * `UPDATE ... WHERE withdrawn_at IS NULL AND expires_at > $2 RETURNING`.
   *
   * The whole of the atomicity is in that predicate: two concurrent callers
   * both match the row or neither does, never both, because the second one
   * blocks on the row lock and then finds `withdrawn_at` already set. Reading
   * the row first and writing it back in a second statement would have a window
   * in between, and this is the one place in the store where a window is not a
   * correctness detail but a patient being rescheduled twice for one click.
   *
   * A row that cannot be found, has already been withdrawn, or has expired is
   * simply not returned -- the three are the same answer to a caller, because
   * telling them apart tells a prober which they managed.
   */
  async spendActionGrant(jti: string, now: Date): Promise<ActionGrant | undefined> {
    await this.ready();

    const rows = await this.sql.query<ActionGrantRow>(
      `UPDATE appointment_action_grants
          SET withdrawn_at = $3
        WHERE jti = $1
          AND withdrawn_at IS NULL
          AND expires_at > $2
        RETURNING ${GRANT_COLUMNS}`,
      [jti, now.toISOString(), now.toISOString()],
    );

    return rows.length === 0 ? undefined : toActionGrant(rows[0]);
  }

  async withdrawActionGrants(appointmentId: string, now: Date): Promise<number> {
    await this.ready();

    const rows = await this.sql.query<{ jti: string }>(
      `UPDATE appointment_action_grants
          SET withdrawn_at = $2
        WHERE appointment_id = $1
          AND withdrawn_at IS NULL
        RETURNING jti`,
      [appointmentId, now.toISOString()],
    );

    return rows.length;
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

    // The durable half of a patient action link (#59). Nothing here is PHI: it
    // is a capability id, the appointment it applies to, the closed set of
    // actions it permits, and two timestamps. There is deliberately no column
    // for "who", because there is nobody -- the holder of the link is whoever
    // has the link, and inventing an identity for them would be the kind of
    // fiction an audit trail should not contain.
    await this.sql.query(`
      CREATE TABLE IF NOT EXISTS appointment_action_grants (
        jti            text PRIMARY KEY,
        appointment_id text NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
        actions        text[] NOT NULL,
        expires_at     timestamptz NOT NULL,
        withdrawn_at   timestamptz,
        CONSTRAINT appointment_action_grants_actions_check
          CHECK (actions <@ ARRAY['reschedule', 'cancel']::text[])
      )
    `);

    // `withdrawActionGrants` filters on exactly this, on every cancellation,
    // and it is the statement that must not fall back to a scan once a clinic
    // has issued a few thousand links.
    await this.sql.query(`
      CREATE INDEX IF NOT EXISTS appointment_action_grants_live_idx
        ON appointment_action_grants (appointment_id)
        WHERE withdrawn_at IS NULL
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

const GRANT_COLUMNS =
  "jti, appointment_id, actions, expires_at, withdrawn_at";

interface ActionGrantRow {
  jti: string;
  appointment_id: string;
  actions: string[];
  expires_at: string;
  withdrawn_at: string | null;
}

/**
 * Rebuild a grant from a database row.
 *
 * Checked rather than cast, for the reason `toAppointment` checks its row: a
 * capability row that does not parse must not be handed to a caller as a
 * capability that permits something. In particular `actions` is validated
 * against the closed set, because this is the row that *authorises* -- a
 * capability list that had somehow been widened in the database would otherwise
 * be honoured silently, which is the one direction of error this table exists
 * to make impossible.
 */
export function toActionGrant(row: ActionGrantRow): ActionGrant {
  if (typeof row.jti !== "string" || row.jti === "") {
    throw new Error("appointment_action_grants row: jti is missing or not a string");
  }

  if (typeof row.appointment_id !== "string" || row.appointment_id === "") {
    throw new Error("appointment_action_grants row: appointment_id is missing or not a string");
  }

  if (!Array.isArray(row.actions) || row.actions.length === 0) {
    throw new Error("appointment_action_grants row: actions is not a non-empty array");
  }

  for (const action of row.actions) {
    if (!isPatientAction(action)) {
      throw new Error(
        `appointment_action_grants row: action is not one of the known actions (got ${JSON.stringify(action)})`,
      );
    }
  }

  // Narrowed by the loop above, one element at a time, against the same closed
  // set the column constraint enforces. Casting here records that the check
  // already happened rather than skipping it.
  const actions = row.actions as PatientAction[];

  const withdrawnAt =
    row.withdrawn_at === null || row.withdrawn_at === undefined
      ? null
      : toGrantDate(row.withdrawn_at, "withdrawn_at");

  return {
    jti: row.jti,
    appointmentId: row.appointment_id,
    actions: [...actions],
    expiresAt: toGrantDate(row.expires_at, "expires_at"),
    withdrawnAt,
  };
}

function toGrantDate(value: unknown, column: string): Date {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`appointment_action_grants row: ${column} is not a timestamp`);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`appointment_action_grants row: ${column} is not a timestamp`);
  }

  return date;
}

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
