import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryAppointmentStore, createAppointment, setAppointmentStore } from "@/lib/appointments";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { GET, POST } from "./route";

/**
 * The reminder endpoint (#67).
 *
 * This route is on the public internet and it sends email to real patients in
 * bulk, so the first half of this file is about the lock and only the second half
 * is about the job. An unauthenticated caller here is not a nuisance: it is a mail
 * relay pointed at a list of people who booked appointments.
 *
 * Resend posts through the global `fetch`, so the outbound call is captured rather
 * than sent. The model is stubbed.
 */

const SECRET = "cron-secret-value";

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
  CRON_SECRET: SECRET,
};

const saved = { ...process.env };

let emails: { to: string[] }[] = [];

beforeEach(() => {
  emails = [];

  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  resetServerEnvCache();

  setAuditLogStore(new InMemoryAuditLogStore());
  setAppointmentStore(new InMemoryAppointmentStore());

  setLlmClient({
    async generateJson() {
      return { subject: "Your appointment", body: "<p>See you soon.</p>" };
    },
  });

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = new Request("https://api.resend.com/emails", init);
    emails.push((await request.json()) as { to: string[] });

    return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
  process.env = { ...saved };
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

const realFetch = globalThis.fetch;

function cron(authorization?: string) {
  return new Request("https://clinic.test/api/cron/reminders", {
    method: "GET",
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** An appointment inside the reminder pass's window. */
async function dueSoon() {
  const now = Date.now();
  const at = new Date(now + 3 * 3_600_000);

  return createAppointment({
    firstName: "REDACTED",
    lastName: "REDACTED",
    email: "patient@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime:
      `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-` +
      `${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:` +
      `${String(at.getMinutes()).padStart(2, "0")}`,
    medical_department: "Doctor",
    additionalInfo: "",
    language: "english",
  });
}

describe("GET /api/cron/reminders", () => {
  test("refuses an unauthenticated caller without reading anything", async () => {
    await dueSoon();

    const response = await GET(cron());

    expect(response.status).toBe(401);
    expect(emails).toEqual([]);
  });

  test("refuses a caller with the wrong secret", async () => {
    await dueSoon();

    expect((await GET(cron("Bearer wrong"))).status).toBe(401);
    expect(emails).toEqual([]);
  });

  test("refuses everything when CRON_SECRET is not configured", async () => {
    // The whole reason `verifyCronSecret` fails closed. Deploying without the
    // variable set must produce a job that does not run, not a bulk mail relay.
    delete process.env.CRON_SECRET;
    resetServerEnvCache();
    await dueSoon();

    const response = await GET(cron(`Bearer ${SECRET}`));

    expect(response.status).toBe(401);
    expect(emails).toEqual([]);
  });

  test("does not accept the internal secret in its place", async () => {
    // Two trust boundaries with two credentials: a caller holding
    // INTERNAL_API_SECRET is this application's own code, and a scheduler holds
    // CRON_SECRET. Neither implies the other.
    await dueSoon();

    expect((await GET(cron(`Bearer ${BASELINE.INTERNAL_API_SECRET}`))).status).toBe(401);
  });

  test("runs the pass for a scheduler, and says what it did", async () => {
    await dueSoon();

    const response = await GET(cron(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      sent: number;
      window: string;
      skippedAlreadyClaimed: number;
      truncated: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.window).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.skippedAlreadyClaimed).toBe(0);
    expect(body.truncated).toBe(false);
    expect(emails).toHaveLength(1);
  });

  test("sends once however many times it is called", async () => {
    await dueSoon();

    const first = await GET(cron(`Bearer ${SECRET}`));
    const second = await GET(cron(`Bearer ${SECRET}`));

    expect(((await first.json()) as { sent: number }).sent).toBe(1);
    expect(((await second.json()) as { sent: number }).sent).toBe(0);
    expect(emails).toHaveLength(1);
  });

  test("reports 200 with failed counted when a send bounces", async () => {
    // Some reminders bouncing is normal and is not the job's problem. Reporting
    // it as a failure would make the platform retry the whole pass and double-send
    // to everybody else.
    await dueSoon();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "not verified" }), { status: 422 })) as unknown as typeof fetch;

    const response = await GET(cron(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { failed: number }).failed).toBe(1);
  });

  test("answers 500 when the store is down, rather than reporting nothing to do", async () => {
    // A run that examined nothing and reported success is worse than one that
    // failed loudly: the platform will not retry a 200.
    const broken = new InMemoryAppointmentStore();
    broken.listByStatus = async () => {
      throw new Error("the database could not be reached");
    };
    setAppointmentStore(broken);

    const response = await GET(cron(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ success: false });
    // No counts: `sent: 0` would read as "there was nobody to remind".
    expect(text).not.toContain("sent");
    expect(emails).toEqual([]);
  });

  test("the response carries counts and nothing about a patient", async () => {
    const appointment = await dueSoon();

    const text = await (await GET(cron(`Bearer ${SECRET}`))).text();

    // A scheduler's request log is retained by the platform and read by whoever
    // has access to the project.
    expect(text).not.toContain(appointment.id);
    expect(text).not.toContain("patient@example.test");
    expect(text).not.toContain("REDACTED");
    expect(text).not.toContain("1985-12-10");
    expect(text).not.toContain(SECRET);
  });
});

describe("POST /api/cron/reminders", () => {
  test("is refused, so there is no second way to trigger a bulk send", async () => {
    // A cron request is a GET. Answering POST with the job's results would be a
    // second trigger on a method no scheduler uses.
    const response = await POST();

    expect(response.status).toBe(405);
    expect(emails).toEqual([]);
  });
});
