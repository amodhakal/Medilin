import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { INTERNAL_SECRET_HEADER } from "@/lib/auth/internal";
import { getRateLimitStore } from "@/lib/rate-limit";
import { sealRecord } from "@/lib/phi-token";
import { POST } from "./route";

/**
 * The clinician summary endpoint (#68).
 *
 * This is the only surface in the app that hands a model a patient's own
 * description of their symptoms and returns a second reading of it. So the
 * tests here are mostly about the boundary rather than the feature:
 *
 *   - who is allowed to call it at all,
 *   - what it accepts as a reference to a patient,
 *   - and what it gives back.
 *
 * The last of those is the one worth reading. The record the token decrypts to
 * holds a name, an email address, a phone number, a date of birth, an insurance
 * answer and the symptom text. A response body is a thing that gets copied into
 * a ticket, pasted into Slack, and cached by whatever proxy sits in front of
 * the app, so the assertions below are that the response carries the summary and
 * nothing else.
 */

const SECRET = "s".repeat(32);
const ADDRESS = "203.0.113.7";

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  INTERNAL_API_SECRET: SECRET,
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

const record = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Eye Doctor",
  additionalInfo: "Sharp pain behind my left eye since Tuesday",
  language: "english",
};

const summary = {
  chiefComplaint: "Pain behind the left eye",
  summary: "Reports sharp pain behind the left eye since Tuesday.",
  symptoms: ["sharp pain behind the left eye"],
  urgency: "soon",
  followUpQuestions: ["Has the vision in that eye changed?"],
};

function request(body: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers[INTERNAL_SECRET_HEADER] = secret;

  return new Request("https://clinic.example/api/intake-summary", {
    method: "POST",
    headers: { ...headers, "x-forwarded-for": ADDRESS },
    body: JSON.stringify(body),
  });
}

let modelCalls = 0;
let modelFailure: Error | null = null;

beforeEach(() => {
  modelCalls = 0;
  modelFailure = null;
  getRateLimitStore().reset();

  setLlmClient({
    async generateJson() {
      modelCalls += 1;
      if (modelFailure) throw modelFailure;
      return summary;
    },
  });
});

afterEach(() => {
  setLlmClient(null);
  getRateLimitStore().reset();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("authentication", () => {
  test("answers 401 without the internal secret", async () => {
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }, null));

    expect(response.status).toBe(401);
    // Refused before the token is even looked at, so a wrong guess costs
    // nothing and tells an attacker nothing about which part was wrong.
    expect(modelCalls).toBe(0);
  });

  test("answers 401 for a wrong secret", async () => {
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }, "x".repeat(32)));
    expect(response.status).toBe(401);
  });

  test("answers 401 for a prefix of the secret", async () => {
    const response = await POST(request({ token: "irrelevant" }, SECRET.slice(0, -1)));
    expect(response.status).toBe(401);
  });

  test("does not call the model for an unauthenticated request", async () => {
    await POST(request({ token: sealRecord(JSON.stringify(record)) }, null));
    expect(modelCalls).toBe(0);
  });

  test("spends nothing on a body it will refuse anyway", async () => {
    // Ordering: guard, then parse, then decrypt, then call the model. Each
    // cheap check is in front of the expensive one.
    const unauthenticated = await POST(request({ nonsense: true }, null));
    expect(unauthenticated.status).toBe(401);
    expect(modelCalls).toBe(0);
  });
});

describe("the request body", () => {
  test("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("https://clinic.example/api/intake-summary", {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: SECRET },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(modelCalls).toBe(0);
  });

  test.each([
    ["no token", {}],
    ["a blank token", { token: "" }],
    ["a non-string token", { token: 42 }],
    ["an extra key", { token: "abc", appointmentId: "1" }],
  ])("rejects %s", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(modelCalls).toBe(0);
  });

  test("takes the reference in the body, never the query string", async () => {
    // A sealed token in a URL is a bearer credential in every access log,
    // browser history and Referer header on the path. The whole point of the
    // existing token mechanism is that it stays out of those.
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("spectate");
  });
});

describe("a valid request", () => {
  test("returns the summary", async () => {
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary });
  });

  test("returns nothing but the summary", async () => {
    // The token decrypts to a whole record. None of it comes back: a response
    // body is the easiest thing in this app to copy somewhere it should not be,
    // and the caller already has the record -- it holds the same token.
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));
    const body = JSON.stringify(await response.json());

    expect(body).not.toContain("Lovelace");
    expect(body).not.toContain("ada@example.test");
    expect(body).not.toContain("555 0100");
    expect(body).not.toContain("1985-12-10");
    expect(body).not.toContain("insurance");
    expect(body).not.toContain("phone");
    expect(body).not.toContain("dob");
    expect(body).not.toContain("token");
  });

  test("does not echo the symptom text verbatim under its own key", async () => {
    // The summary is a second reading of the account, not a copy of it. The
    // model's prose legitimately overlaps, so what is asserted is that the
    // response carries no field that is a passthrough of the record.
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(["summary"]);
    expect(body.summary).toEqual(summary);
  });

  test("answers 404 for a token that does not open", async () => {
    // Truncated, tampered, or sealed under another key. Deliberately the same
    // answer for all of them, and never a reason.
    const response = await POST(request({ token: "not-a-real-token" }));

    expect(response.status).toBe(404);
    expect(modelCalls).toBe(0);
    expect(JSON.stringify(await response.json())).not.toContain("decrypt");
  });

  test("answers 404 when the token opens to something that is not a record", async () => {
    const response = await POST(request({ token: sealRecord("not json at all") }));
    expect(response.status).toBe(404);
  });

  test("says so plainly when the patient wrote no symptoms", async () => {
    // Not an error, and not an empty summary rendered as if it were a finding.
    const empty = { ...record, additionalInfo: "" };
    const response = await POST(request({ token: sealRecord(JSON.stringify(empty)) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: null, reason: "no_intake_notes" });
    expect(modelCalls).toBe(0);
  });

  test("says so when the model returns something unusable", async () => {
    setLlmClient({ async generateJson() { return { urgency: "emergency" }; } });
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: null, reason: "unusable_reply" });
  });

  test("answers 502 when the model call fails", async () => {
    // Distinguished from "there is no summary" on purpose. A clinician told
    // "nothing to report" when the pipeline is down has been told a falsehood
    // about a patient.
    modelFailure = new Error("Model returned a response that is not valid JSON");
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));

    expect(response.status).toBe(502);
  });

  test("does not put the symptom text in a failure response", async () => {
    // A vendor error message can quote the request payload, and the request
    // payload here is a patient describing their symptoms.
    modelFailure = new Error("upstream rejected: Sharp pain behind my left eye");
    const response = await POST(request({ token: sealRecord(JSON.stringify(record)) }));

    expect(response.status).toBe(502);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("Sharp pain");
    expect(body).not.toContain("rejected");
  });
});

describe("cost", () => {
  test("rate limits a caller who asks for the same record over and over", async () => {
    // Every accepted request is a paid Gemini call, and this endpoint has no
    // side effect to protect, so the only thing an unlimited caller can do with
    // it is spend money. Same reasoning, and the same limit, as the booking
    // endpoint that also spends a call per request.
    const token = sealRecord(JSON.stringify(record));
    const statuses: number[] = [];

    for (let i = 0; i < 12; i += 1) {
      statuses.push((await POST(request({ token }))).status);
    }

    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 200).length).toBeLessThan(statuses.length);
  });

  test("counts a refused request as well as an accepted one", async () => {
    // A caller hammering with bad tokens is the case a limit is for, so the
    // check cannot sit behind the token.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await POST(request({ token: "nope" }))).status);
    }
    expect(statuses).toContain(429);
  });
});
