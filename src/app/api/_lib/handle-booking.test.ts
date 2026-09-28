import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { setRateLimitStore } from "@/lib/rate-limit";
import { handleBooking } from "./handle-booking";
import { POST as intakePost } from "../intake/route";
import { GET as appointmentsGet, POST as appointmentsPost } from "../appointments/route";

/**
 * The consolidated booking endpoint (#32).
 *
 * Asserted against a real NextRequest rather than by calling the pipeline,
 * because the things #32 is about are the HTTP-shaped ones: two URLs, one rate
 * limit, strict validation, and a response body that carries an opaque token
 * instead of the record.
 *
 * Gemini and the confirmation webhook are the two network calls on the path, so
 * both are stubbed. Everything else -- sealing, storage, validation, the
 * limiter -- is the real implementation.
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

const submission = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "dolor de cabeza",
  language: "spanish",
};

const realFetch = globalThis.fetch;
/** Anything the booking path tried to send over the network. Should be empty. */
let outboundCalls: unknown[] = [];

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://clinic.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  outboundCalls = [];
  setRateLimitStore(null);

  setLlmClient({
    async generateJson() {
      return { additionalInfo: "headache", medical_department: "Doctor" };
    },
  });

  // Any HTTP call at all from the booking path is a self-call, and the stub
  // records it rather than letting it reach a network.
  globalThis.fetch = (async (input: unknown) => {
    outboundCalls.push(input);
    return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
  setRateLimitStore(null);
});

afterAll(() => {
  resetServerEnvCache();
});

describe("the two booking routes", () => {
  test("are the same handler, not two that happen to agree", () => {
    // The consolidation is the assertion: if one route is ever wired back to its
    // own implementation, this fails before anyone deploys it.
    expect(intakePost).toBe(appointmentsPost);
    expect(intakePost).toBe(handleBooking);
  });

  test("both book, and return the same response shape", async () => {
    const fromIntake = await (await handleBooking(post("/api/intake", submission))).json();
    const fromAppointments = await (
      await handleBooking(post("/api/appointments", submission))
    ).json();

    expect(fromIntake.success).toBe(true);
    expect(fromAppointments.success).toBe(true);
    expect(Object.keys(fromIntake).sort()).toEqual(Object.keys(fromAppointments).sort());
    expect(fromIntake.spectateUrl).toMatch(/^\/spectate\/|^https:\/\/clinic\.test\/spectate\//);
  });

  test("the spectate URL carries a sealed token, not the record", async () => {
    const body = await (await handleBooking(post("/api/appointments", submission))).json();

    // The route that used to echo `patientInfo` back. Nothing in a booking
    // response should be a patient identifier.
    expect(JSON.stringify(body)).not.toContain("ada@example.test");
    expect(JSON.stringify(body)).not.toContain("Lovelace");
    expect(JSON.stringify(body)).not.toContain("dolor de cabeza");
  });

  test("makes no HTTP request to itself", async () => {
    // The booking path used to POST to this application's own /api/webhook, at
    // a URL built from the request's Host header, and then ignore what came
    // back. There is no self-call left on the path: not to the webhook, and not
    // anywhere else.
    await (await handleBooking(post("/api/intake", submission))).json();

    expect(outboundCalls).toEqual([]);
  });
});

describe("validation and rate limiting survive consolidation", () => {
  test("rejects a malformed submission with 400 and per-field detail", async () => {
    const response = await handleBooking(
      post("/api/appointments", { ...submission, email: "nope" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: { field: string }[] };
    expect(body.issues.map((issue) => issue.field)).toContain("email");
  });

  test("rejects an unknown field rather than dropping it", async () => {
    const response = await handleBooking(
      post("/api/intake", { ...submission, isAdmin: true }),
    );

    expect(response.status).toBe(400);
  });

  test("counts the two URLs against one budget", async () => {
    // Five through /api/intake, then the sixth request is throttled whichever
    // URL it arrives on. Separate counters per path would have made the strict
    // limit free to bypass by using the other one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ok = await handleBooking(post("/api/intake", submission));
      expect(ok.status).toBe(200);
    }

    // Same budget whichever URL asks for it.
    const throttled = await handleBooking(post("/api/appointments", submission));

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBeTruthy();
  });

  test("does not spend the budget on a rejected submission", async () => {
    await handleBooking(post("/api/intake", { ...submission, dob: "nope" }));
    await handleBooking(post("/api/intake", { ...submission, dob: "nope" }));

    const ok = await handleBooking(post("/api/intake", submission));
    expect(ok.status).toBe(200);
  });
});

describe("GET /api/appointments", () => {
  const get = (query: string, headers: Record<string, string> = {}) =>
    new NextRequest(`https://clinic.test/api/appointments${query}`, { headers });

  test("refuses to read a patient record without the internal secret", async () => {
    // getAppointment returns the whole record, and the id was the only thing
    // protecting it. Unguessable is not secret.
    const response = await appointmentsGet(get("?id=anything"));

    expect(response.status).toBe(401);
  });

  test("returns the appointment to an internal caller", async () => {
    const booked = (await (await handleBooking(post("/api/intake", submission))).json()) as {
      appointmentId: string;
    };

    const response = await appointmentsGet(get(`?id=${booked.appointmentId}`, {
      "x-internal-secret": BASELINE.INTERNAL_API_SECRET,
    }));

    expect(response.status).toBe(200);
    const appointment = (await response.json()) as { id: string };
    expect(appointment.id).toBe(booked.appointmentId);
  });

  test("404s for an unknown id and 400s for a missing one", async () => {
    const headers = { "x-internal-secret": BASELINE.INTERNAL_API_SECRET };

    expect((await appointmentsGet(get("?id=missing", headers))).status).toBe(404);
    expect((await appointmentsGet(get("", headers))).status).toBe(400);
  });
});
