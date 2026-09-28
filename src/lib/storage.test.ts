import { afterEach, describe, expect, test } from "bun:test";
import {
  SqlError,
  createPostgresHttpClient,
  getSqlClient,
  isDurableStoreEnabled,
  resetSqlClient,
} from "./storage";

/**
 * The SQL client behind the durable store (#17).
 *
 * The two things this file has to be right about are that it is *optional* --
 * an unset DATABASE_URL has to mean "no database", not "a broken app", because
 * that is what keeps local dev and CI running with no credentials -- and that
 * it never puts the connection string in an error, because that string contains
 * the database password.
 */

const URL_WITH_PASSWORD = "https://user:hunter2@db.example.test/neon?sslmode=require";
const ENDPOINT = "https://user:hunter2@db.example.test/neon/sql?sslmode=require";

const savedDatabaseUrl = process.env.DATABASE_URL;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  resetSqlClient();
  globalThis.fetch = realFetch;
});

/** Capture what the client sent, and answer with a canned driver response. */
function stubFetch(response: unknown, init?: { status?: number; body?: string }) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];

  globalThis.fetch = (async (input: unknown, requestInit?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(requestInit?.body)),
      headers: (requestInit?.headers ?? {}) as Record<string, string>,
    });

    const status = init?.status ?? 200;
    return new Response(init?.body ?? JSON.stringify(response), { status });
  }) as unknown as typeof fetch;

  return calls;
}

/** The shape the Postgres HTTP driver returns for a successful query. */
function driverRows(rows: unknown[][], fields = ["id", "status"]) {
  return {
    command: "SELECT",
    fields: fields.map((name) => ({ name, dataTypeID: 25 })),
    rowCount: rows.length,
    rows,
  };
}

describe("createPostgresHttpClient", () => {
  test("posts the statement and its parameters to the driver endpoint", async () => {
    const calls = stubFetch(driverRows([["a1", "scheduled"]]));
    const client = createPostgresHttpClient(URL_WITH_PASSWORD);

    const rows = await client.query("SELECT id, status FROM appointments WHERE id = $1", ["a1"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].body).toEqual({
      query: "SELECT id, status FROM appointments WHERE id = $1",
      params: ["a1"],
    });
    expect(rows).toEqual([{ id: "a1", status: "scheduled" }]);
  });

  test("maps rows onto the driver's field names, in order", async () => {
    // The wire format is positional arrays. Getting this wrong silently pairs
    // every value with the wrong column, which for a patient record means
    // writing a date of birth into an email column.
    stubFetch(driverRows([["a1", "scheduled"], ["a2", "cancelled"]]));

    const rows = await createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", []);

    expect(rows).toEqual([
      { id: "a1", status: "scheduled" },
      { id: "a2", status: "cancelled" },
    ]);
  });

  test("treats a statement with no parameters as an empty parameter list", async () => {
    const calls = stubFetch(driverRows([]));
    await createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1");
    expect(calls[0].body).toEqual({ query: "SELECT 1", params: [] });
  });

  test("grows the path before the query string, and keeps any credentials", async () => {
    // `.../neon?sslmode=require` + `/sql` by concatenation is a database named
    // "neon?sslmode=require", which is a 404 that looks like a config mistake.
    const calls = stubFetch(driverRows([]));
    await createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", []);

    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].url).toContain("/neon/sql?");
  });

  test("does not append /sql to an endpoint that already has it", async () => {
    const calls = stubFetch(driverRows([]));
    await createPostgresHttpClient("https://db.example.test/neon/sql").query("SELECT 1", []);
    expect(calls[0].url).toBe("https://db.example.test/neon/sql");
  });

  test("tolerates a trailing slash", async () => {
    const calls = stubFetch(driverRows([]));
    await createPostgresHttpClient("https://db.example.test/neon/").query("SELECT 1", []);
    expect(calls[0].url).toBe("https://db.example.test/neon/sql");
  });

  test("returns an empty array for a statement that matched nothing", async () => {
    stubFetch(driverRows([]));
    expect(await createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", [])).toEqual([]);
  });

  test("rejects a connection string that is not an HTTP endpoint", () => {
    // The honest failure. Silently ignoring an unusable DATABASE_URL would put
    // every booking back in per-instance memory on a deployment that believes
    // it is durable -- the exact bug this store exists to fix.
    expect(() => createPostgresHttpClient("postgres://user:pw@localhost:5432/medilin")).toThrow(
      /HTTP/,
    );
    expect(() => createPostgresHttpClient("")).toThrow(/DATABASE_URL/);
    expect(() => createPostgresHttpClient("   ")).toThrow(/DATABASE_URL/);
  });

  test("raises a SqlError carrying the driver's code", async () => {
    stubFetch({ error: 'relation "appointments" does not exist', code: "42P01" });

    const error = await createPostgresHttpClient(URL_WITH_PASSWORD)
      .query("SELECT 1", [])
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SqlError);
    expect((error as SqlError).code).toBe("42P01");
  });

  test("raises a SqlError on a non-2xx response", async () => {
    stubFetch(null, { status: 401, body: "unauthorized" });

    await expect(
      createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", []),
    ).rejects.toBeInstanceOf(SqlError);
  });

  test("raises a SqlError when the transport fails", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", []),
    ).rejects.toBeInstanceOf(SqlError);
  });

  test("raises a SqlError on an unparseable response", async () => {
    stubFetch(null, { status: 200, body: "<html>gateway</html>" });

    await expect(
      createPostgresHttpClient(URL_WITH_PASSWORD).query("SELECT 1", []),
    ).rejects.toBeInstanceOf(SqlError);
  });

  test("never puts the connection string, or the password in it, in an error", async () => {
    // DATABASE_URL is a credential. An error that quotes it lands in a log
    // drain, a Sentry issue, and a support ticket, none of which are places a
    // database password belongs.
    stubFetch({ error: "connection refused", code: "08006" });

    const error = (await createPostgresHttpClient(URL_WITH_PASSWORD)
      .query("SELECT 1", [])
      .catch((thrown: unknown) => thrown)) as SqlError;

    const rendered = `${error.message} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain(URL_WITH_PASSWORD);
    expect(rendered).not.toContain("db.example.test");
  });

  test("reports a 401 without echoing the request", async () => {
    stubFetch(null, { status: 401, body: "unauthorized" });

    const error = (await createPostgresHttpClient(URL_WITH_PASSWORD)
      .query("SELECT 1", [])
      .catch((thrown: unknown) => thrown)) as SqlError;

    expect(error.message).toContain("401");
  });
});

describe("getSqlClient", () => {
  test("is absent when DATABASE_URL is unset", () => {
    // The default that keeps local dev and CI green with no credentials.
    delete process.env.DATABASE_URL;
    expect(getSqlClient()).toBeNull();
    expect(isDurableStoreEnabled()).toBe(false);
  });

  test("is built and memoised when DATABASE_URL is set", () => {
    process.env.DATABASE_URL = URL_WITH_PASSWORD;
    resetSqlClient();

    const first = getSqlClient();
    expect(first).not.toBeNull();
    expect(getSqlClient()).toBe(first);
    expect(isDurableStoreEnabled()).toBe(true);
  });

  test("does not build a client from a blank DATABASE_URL", () => {
    process.env.DATABASE_URL = "   ";
    resetSqlClient();
    expect(getSqlClient()).toBeNull();
    expect(isDurableStoreEnabled()).toBe(false);
  });

  test("resetSqlClient drops the memo so a new URL is picked up", () => {
    process.env.DATABASE_URL = URL_WITH_PASSWORD;
    resetSqlClient();
    const first = getSqlClient();

    resetSqlClient();
    expect(getSqlClient()).not.toBe(first);
  });

  test("an unusable DATABASE_URL throws rather than silently degrading", () => {
    // The one case that must not be absorbed: a deployment configured with a
    // connection string this client cannot speak to should fail loudly at first
    // use, not quietly run on per-instance memory.
    process.env.DATABASE_URL = "postgres://user:pw@localhost:5432/medilin";
    resetSqlClient();

    expect(() => getSqlClient()).toThrow(/HTTP/);
  });
});
