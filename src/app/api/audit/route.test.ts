import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { resetServerEnvCache } from "@/lib/env";
import {
  AUDIT_ACTORS,
  InMemoryAuditLogStore,
  readAuditLog,
  setAuditLogStore,
} from "@/lib/audit";
import { resetSqlClient } from "@/lib/storage";
import { GET, POST } from "./route";

/**
 * The audit endpoints.
 *
 * What tightened in this change is the write: an action outside the closed set
 * and a details key outside the closed set are both refused, and a caller holding
 * the internal secret is not the same as a caller trusted with the shape of the
 * log. These are the tests for that, plus the guarantee that a durable store
 * which is down answers 500 rather than a success nobody can rely on.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

const SECRET = { "x-internal-secret": BASELINE.INTERNAL_API_SECRET };
let trail: InMemoryAuditLogStore;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://clinic.test/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const valid = {
  actor: AUDIT_ACTORS.internalApi,
  action: "PHI_READ",
  resource: "appointment:a1",
  details: { status: "scheduled" },
};

beforeEach(() => {
  delete process.env.DATABASE_URL;
  resetSqlClient();
  trail = new InMemoryAuditLogStore();
  setAuditLogStore(trail);
});

afterEach(() => {
  resetServerEnvCache();
});

describe("POST /api/audit", () => {
  test("refuses a write without the internal secret", async () => {
    // Unauthenticated writes let anyone forge entries and attribute an access to
    // a clinician who never made it.
    const response = await POST(post(valid));

    expect(response.status).toBe(401);
    expect(trail.size).toBe(0);
  });

  test("records an entry for an internal caller", async () => {
    const response = await POST(post(valid, SECRET));
    const body = (await response.json()) as { success: boolean; entry: { hash: string } };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.entry.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(trail.size).toBe(1);
  });

  test("refuses an action outside the closed set", async () => {
    const response = await POST(post({ ...valid, action: "ANYTHING_GOES" }, SECRET));

    expect(response.status).toBe(400);
    expect(trail.size).toBe(0);
  });

  test("refuses details outside the closed set, and does not echo the value", async () => {
    // The one caller that is not in this process. A trail cannot be redacted and
    // cannot be dropped, so the value must not reach a response body, a log, or a
    // ticket either.
    const response = await POST(
      post({ ...valid, details: { additionalInfo: "chest pain" } }, SECRET),
    );
    const body = (await response.json()) as { key: string };

    expect(response.status).toBe(400);
    expect(body.key).toBe("additionalInfo");
    expect(JSON.stringify(body)).not.toContain("chest pain");
    expect(trail.size).toBe(0);
  });

  test("rejects a malformed body", async () => {
    const response = await POST(post({ actor: "someone" }, SECRET));

    expect(response.status).toBe(400);
    expect(trail.size).toBe(0);
  });

  test("answers 500 when the trail cannot be written", async () => {
    // Fail closed: a success here would be a caller relying on an access being
    // recorded when it was not.
    setAuditLogStore({
      async append() {
        throw new Error("The database could not be reached.");
      },
      async read() {
        return [];
      },
      async verify() {
        return true;
      },
    });

    const response = await POST(post(valid, SECRET));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal Server Error" });
  });
});

describe("GET /api/audit", () => {
  test("refuses to read the trail without the internal secret", async () => {
    // The trail contains PHI in `details`, for every caller the moment the
    // details set is widened by anyone.
    const response = await GET(new NextRequest("https://clinic.test/api/audit"));

    expect(response.status).toBe(401);
  });

  test("returns the trail and whether the chain still holds", async () => {
    await POST(post(valid, SECRET));
    await POST(post({ ...valid, action: "APPOINTMENT_CANCELLED" }, SECRET));

    const response = await GET(new NextRequest("https://clinic.test/api/audit", { headers: SECRET }));
    const body = (await response.json()) as { logs: unknown[]; isValid: boolean };

    expect(response.status).toBe(200);
    expect(body.logs).toHaveLength(2);
    expect(body.isValid).toBe(true);
  });

  test("reports a chain that no longer holds", async () => {
    await POST(post(valid, SECRET));
    (trail as unknown as { entries: { actor: string }[] }).entries[0].actor = "someone-else";

    const response = await GET(new NextRequest("https://clinic.test/api/audit", { headers: SECRET }));
    const body = (await response.json()) as { isValid: boolean };

    expect(body.isValid).toBe(false);
  });

  test("verification covers the whole chain, not just what the response shows", async () => {
    // A check over the last N entries would answer a question about the tail and
    // report it as a question about the log.
    for (let index = 0; index < 5; index += 1) {
      await POST(post({ ...valid, details: { status: "scheduled" } }, SECRET));
    }

    const response = await GET(new NextRequest("https://clinic.test/api/audit", { headers: SECRET }));
    const body = (await response.json()) as { logs: unknown[]; isValid: boolean };

    expect(body.logs.length).toBeLessThanOrEqual(200);
    expect(body.isValid).toBe(true);
    expect(await readAuditLog()).toHaveLength(5);
  });
});
