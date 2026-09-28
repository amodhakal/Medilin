import "server-only";

/**
 * SQL access for the durable store (#17).
 *
 * Appointments were a `Map` in the module, so a serverless cold start or a
 * redeploy lost every booking the process had ever taken. The fix is a real
 * database, and this module is the one place that knows how to reach one.
 *
 * Two decisions worth stating, because both are about what happens when the
 * database is not there.
 *
 * **The durable path is gated on an optional DATABASE_URL.** There are no
 * credentials in every environment this runs in -- a contributor's laptop, CI,
 * a preview deploy -- and requiring one would mean the app does not start
 * without it. So `getSqlClient()` returns `null` when the variable is unset and
 * the caller falls back to the in-memory store. That is not the same as
 * pretending the bug is fixed: the memory store is still the default, it is
 * still per-instance, and a deployment that wants durability has to configure
 * one. What changes is that configuring one is all it takes.
 *
 * **A connection string this client cannot speak to throws.** The line between
 * "no DATABASE_URL" and "a DATABASE_URL we cannot use" is the difference
 * between an app that runs and an app that quietly runs on per-instance memory
 * while its operator believes it is durable. Only the first is absorbed.
 *
 * The transport is the Postgres HTTP driver -- a JSON request to a `/sql`
 * endpoint, which is what Neon and the serverless Postgres providers expose --
 * rather than a driver package, so nothing is added to the dependency tree for a
 * connection this app makes a handful of times a minute. `SqlClient` is the
 * whole surface, so a `pg`-backed implementation drops in behind it without
 * anything above this file changing.
 */

/** A statement, its bound parameters, and the rows it produced. */
export interface SqlClient {
  /** Identifies the transport, for diagnostics. Never contains a credential. */
  readonly driver: string;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

/**
 * Every failure from the database is this, and only this.
 *
 * A closed type rather than whatever the transport threw, so a caller can
 * distinguish "the database said no" from "the database was unreachable" and
 * decide which one is worth retrying.
 */
export class SqlError extends Error {
  constructor(
    /** The driver's SQLSTATE, the HTTP status, or `transport`/`response`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SqlError";
  }
}

/** The JSON body the driver posts, and the shape it answers with. */
interface DriverRequest {
  query: string;
  params: unknown[];
}

interface DriverResponse {
  fields?: { name: string }[];
  rows?: unknown[][];
  error?: string;
  code?: string;
}

/**
 * The driver's endpoint, which is the configured URL with `/sql` appended to
 * its path.
 *
 * Parsed rather than concatenated, because the path has to grow before the
 * query string: `.../neon?sslmode=require` + `/sql` is a database called
 * `neon?sslmode=require`, not a database called `neon`. Any credentials in the
 * URL are preserved, since an operator who put them there expects them sent.
 */
function endpointFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const path = url.pathname.replace(/\/+$/, "");

  url.pathname = path.endsWith("/sql") ? path : `${path}/sql`;
  return url.toString();
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function createPostgresHttpClient(databaseUrl: string): SqlClient {
  const raw = databaseUrl?.trim() ?? "";

  if (!raw) {
    throw new Error(
      "DATABASE_URL is empty. The durable store needs a Postgres HTTP endpoint, " +
        "or the variable should be left unset to use the in-memory store.",
    );
  }

  if (!isHttpUrl(raw)) {
    throw new Error(
      "DATABASE_URL must be an http(s) Postgres HTTP endpoint, such as the " +
        "connection string Neon and the other serverless Postgres providers " +
        "issue. A postgres:// socket URL needs a driver-backed SqlClient " +
        "instead: implement the SqlClient interface in src/lib/storage.ts " +
        "against `pg`, or leave DATABASE_URL unset to use the in-memory store.",
    );
  }

  const endpoint = endpointFor(raw);

  return {
    driver: "postgres-http",

    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      const body: DriverRequest = { query: sql, params: [...params] };

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Deliberately does not interpolate the cause or the endpoint. The
        // endpoint is a credential-bearing URL and the cause is a transport
        // error that can echo the request.
        throw new SqlError("transport", "The database could not be reached.");
      }

      if (!response.ok) {
        throw new SqlError(
          String(response.status),
          `The database refused the request with status ${response.status}.`,
        );
      }

      let payload: DriverResponse;
      try {
        payload = (await response.json()) as DriverResponse;
      } catch {
        throw new SqlError(
          "response",
          "The database returned a response that is not a Postgres HTTP result.",
        );
      }

      if (payload.error) {
        throw new SqlError(
          payload.code ?? "unknown",
          `The database rejected the statement: ${payload.error}`,
        );
      }

      const names = (payload.fields ?? []).map((field) => field.name);
      const rows = payload.rows ?? [];

      // The wire format is positional arrays, so this pairing is the whole of
      // the mapping. Getting it wrong silently puts every value in the wrong
      // column.
      return rows.map((row) => {
        const out: Record<string, unknown> = {};
        names.forEach((name, index) => {
          out[name] = row[index];
        });
        return out as T;
      });
    },
  };
}

let memo: SqlClient | null | undefined;

function configuredDatabaseUrl(): string | undefined {
  // Read straight from process.env rather than through getServerEnv(). The
  // schema is the source of truth for the *name*, and DATABASE_URL is declared
  // there as optional precisely so that its absence is a normal, quiet state.
  // Running the full required-variable validation to discover that an optional
  // variable is unset would couple appointment storage to unrelated keys.
  const value = process.env.DATABASE_URL;
  return value && value.trim() ? value : undefined;
}

/** True when a durable store is configured, and therefore in use. */
export function isDurableStoreEnabled(): boolean {
  return configuredDatabaseUrl() !== undefined;
}

/**
 * The shared client, or `null` when no database is configured.
 *
 * Memoised because a client is a connection pool, and because the appointment
 * store and the audit log store both need the same one. Throws on a connection
 * string it cannot use -- see the module comment.
 */
export function getSqlClient(): SqlClient | null {
  if (memo === undefined) {
    const databaseUrl = configuredDatabaseUrl();
    memo = databaseUrl === undefined ? null : createPostgresHttpClient(databaseUrl);
  }
  return memo;
}

/** Test seam, and the hook for a driver-backed client. */
export function resetSqlClient(): void {
  memo = undefined;
}
