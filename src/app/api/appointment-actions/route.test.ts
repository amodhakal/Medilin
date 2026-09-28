import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryAppointmentStore, createAppointment, getAppointmentStore, issuePatientActions, setAppointmentStore } from "@/lib/appointments";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { setRateLimitStore } from "@/lib/rate-limit";
import { GET, POST } from "./route";

/**
 * The patient-facing action endpoint (#59).
 *
 * As much about the lock as about the change. A management link is the entire
 * authorisation, so what this file pins down is what happens without one, with a
 * wrong one, with one twice, and with one that has been withdrawn -- and that the
 * answers do not tell a prober which of those they managed.
 *
 * Resend posts through the global `fetch`, so the outbound call is captured rather
 * than sent. The model is stubbed. Storage and sealing are real.
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

const realFetch = globalThis.fetch;
let emails: { to: string[] }[] = [];

beforeEach(() => {
  emails = [];
  setAuditLogStore(new InMemoryAuditLogStore());
  setAppointmentStore(new InMemoryAppointmentStore());
  // The rate-limit store is a process singleton, so the burst test below would
  // otherwise leave every later test in the file answering 429.
  setRateLimitStore(null);

  setLlmClient({
    async generateJson() {
      return { subject: "Su cita", body: "<p>Listo</p>" };
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
});

afterAll(() => {
  resetServerEnvCache();
});

function call(body: unknown) {
  return new Request("https://clinic.test/api/appointment-actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A booked appointment with both management links. */
async function booked() {
  const created = await createAppointment({
    firstName: "REDACTED",
    lastName: "REDACTED",
    email: "patient@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Doctor",
    additionalInfo: "",
    language: "english",
  });

  return { created, links: await issuePatientActions(created.id) };
}

describe("POST /api/appointment-actions", () => {
  test("reschedules through a valid link", async () => {
    const { links } = await booked();

    const response = await POST(
      call({
        token: links.reschedule.token,
        action: "reschedule",
        appointmentDateTime: "2026-10-02T14:00",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.action).toBe("reschedule");
    expect(body.nextPath).toMatch(/^\/reschedule\//);
    expect(emails).toHaveLength(1);
  });

  test("cancels through a valid link", async () => {
    const { links } = await booked();

    const response = await POST(call({ token: links.cancel.token, action: "cancel" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; action: string };
    expect(body.success).toBe(true);
    expect(body.action).toBe("cancel");
    expect(emails).toHaveLength(1);
  });

  test("the cancel response offers no next link", async () => {
    // Nothing left to manage, so offering one would be offering the "resurrect
    // it" affordance this whole issue exists to remove.
    const { links } = await booked();

    const response = await POST(call({ token: links.cancel.token, action: "cancel" }));

    expect(((await response.json()) as { nextPath: string | null }).nextPath).toBeNull();
  });

  test.each([
    ["a body that is not JSON", undefined, "not json"],
    ["no body at all", {}, ""],
  ])("answers 400 for %s", async (_label, body) => {
    const request =
      body === undefined
        ? new Request("https://clinic.test/api/appointment-actions", { method: "POST" })
        : call(body);

    expect((await POST(request)).status).toBe(400);
  });

  test.each([
    ["an unknown action", { token: "t", action: "delete" }],
    ["no token", { action: "cancel" }],
    ["a reschedule with no slot", { token: "t", action: "reschedule" }],
    ["an extra field", { token: "t", action: "cancel", force: true }],
  ])("answers 400 for %s, before anything is sent", async (_label, body) => {
    expect((await POST(call(body))).status).toBe(400);
    expect(emails).toEqual([]);
  });

  test("answers 404 for a token that is not one of ours", async () => {
    const response = await POST(call({ token: "not-a-token", action: "cancel" }));

    expect(response.status).toBe(404);
    expect(emails).toEqual([]);
  });

  test("answers 404 for a tracking link, which cannot manage anything", async () => {
    // The other token family. It resolves to the same appointment and is still not
    // accepted here: a tracking link is a read, and widening it into a write is
    // the exact regression #59 exists to stop.
    const { created } = await booked();

    const response = await POST(call({ token: `2.${created.id}`, action: "cancel" }));

    expect(response.status).toBe(404);
  });

  test("answers 409 for a link that has already been spent", async () => {
    const { links } = await booked();
    const body = { token: links.cancel.token, action: "cancel" };

    expect((await POST(call(body))).status).toBe(200);
    expect((await POST(call(body))).status).toBe(409);
    // The second attempt changed nothing: one email, one cancellation.
    expect(emails).toHaveLength(1);
  });

  test("answers 409 for a link used for something it does not grant", async () => {
    const { links } = await booked();

    const response = await POST(call({ token: links.reschedule.token, action: "cancel" }));

    expect(response.status).toBe(409);
    expect(emails).toEqual([]);
  });

  test("answers 502 when the store is down, and does not claim success", async () => {
    const { links } = await booked();
    // Broken after booking, so the failure is in the action rather than in the
    // setup: a store that was down when the patient booked never got a link.
    setAppointmentStore({
      ...getAppointmentStore(),
      spendActionGrant: async () => {
        throw new Error("the database could not be reached");
      },
    } as never);

    const response = await POST(call({ token: links.reschedule.token, action: "cancel" }));

    expect(response.status).toBe(502);
    expect(((await response.json()) as { success: boolean }).success).toBe(false);
    expect(emails).toEqual([]);
  });

  test("a refused action echoes nothing back: no token, no id, no field", async () => {
    const { created, links } = await booked();

    for (const response of [
      await POST(call({ token: links.reschedule.token, action: "cancel" })),
      await POST(call({ token: "not-a-token", action: "cancel" })),
    ]) {
      const text = await response.text();
      expect(text).not.toContain(links.reschedule.token);
      expect(text).not.toContain(created.id);
      expect(text).not.toContain("REDACTED");
      expect(text).not.toContain("1985-12-10");
    }
  });

  test("a successful response does not echo the patient's record back", async () => {
    const { links } = await booked();

    const response = await POST(
      call({
        token: links.reschedule.token,
        action: "reschedule",
        appointmentDateTime: "2026-10-02T14:00",
      }),
    );

    const text = await response.text();
    expect(text).not.toContain("patient@example.test");
    expect(text).not.toContain("1985-12-10");
  });

  test("rate limits a burst from one caller", async () => {
    const caller = { "x-forwarded-for": "203.0.113.7" };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push(
        (
          await POST(
            new Request("https://clinic.test/api/appointment-actions", {
              method: "POST",
              headers: { "content-type": "application/json", ...caller },
              body: JSON.stringify({ token: "not-a-token", action: "cancel" }),
            }),
          )
        ).status,
      );
    }

    // Friction, not a control: `callerKey` reads a header the client sets, so
    // this stops a loop and not a determined caller. What it must do is stop a
    // loop, and it must not stop the *first* few legitimate ones.
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe("GET /api/appointment-actions", () => {
  test("answers liveness without requiring a credential", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
