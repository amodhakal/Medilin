import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetServerEnvCache } from "@/lib/env";
import { POST } from "./route";

/**
 * POST /api/twilio/voice/answer -- the TwiML a clinic's line speaks.
 *
 * Twilio fetches this document when it connects an outbound call, so the only
 * things worth testing are what the document says, what type it is served as,
 * and that nothing from the request can get into it. A TwiML document that is
 * served as JSON is a call that connects to silence, which is indistinguishable
 * from a call that failed -- so the content type is a test and not a detail.
 *
 * The branch above this one is where the signature check and the media stream
 * arrive. What matters here is that this document is a function of configuration
 * alone, because that is what makes it safe to serve before it is authenticated.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
  CLINIC_NAME: "City Medical Center",
};

const saved = new Map<string, string | undefined>();
for (const key of Object.keys(BASELINE)) saved.set(key, process.env[key]);

function setEnv(values: Partial<Record<string, string>> = {}): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  Object.assign(process.env, BASELINE, values);
  resetServerEnvCache();
}

/** The body Twilio actually sends: form-encoded, with the call's own fields. */
function twilioForm(fields: Record<string, string> = {}) {
  const form = new URLSearchParams({
    CallSid: "CA00000000000000000000000000",
    From: "+15558675309",
    To: "+15551230000",
    ...fields,
  });

  return new NextRequest("https://clinic.example/api/twilio/voice/answer", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

beforeEach(() => {
  setEnv();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("POST /api/twilio/voice/answer", () => {
  test("serves TwiML as XML, because a JSON body is a call that says nothing", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
  });

  test("is not cacheable, because it is an instruction to a live call", async () => {
    const response = await POST();

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("greets with the configured clinic name", async () => {
    const response = await POST();

    const body = await response.text();
    expect(body).toContain("<Response>");
    expect(body).toContain("City Medical Center");
    expect(body).toMatch(/<Say>[^<]+<\/Say>/);
  });

  test("declares no request parameter, so there is nothing to echo", () => {
    // The signature is the guarantee. A document that is a function of
    // configuration and takes no `Request` cannot be steered by a caller at
    // all, and this is what fails if someone adds the parameter back to read a
    // field.
    expect(POST.length).toBe(0);
  });

  test("echoes nothing from a Twilio callback into the document", async () => {
    // A caller who could put a `<Say>` into this document could make a clinic's
    // line say anything. The request is built and never handed over, which is
    // the point: the body is full of TwiML (percent-encoded, as a form is) and
    // none of it can reach the answer.
    const hostile = twilioForm({
      CallerName: "<Say>Your records are ready to be collected</Say>",
      From: "+15550000000",
    });
    expect(await hostile.text()).toContain("%3CSay%3E");

    const body = await (await POST()).text();

    expect(body).not.toContain("CallerName");
    expect(body).not.toContain("Your records are ready to be collected");
    expect(body).not.toContain("+15550000000");
    expect(body.match(/<Say>/g)).toHaveLength(1);
  });

  test("uses the clinic name from the environment, not a fallback", async () => {
    setEnv({ CLINIC_NAME: "Riverside Family Practice" });

    const body = await (await POST()).text();

    expect(body).toContain("Riverside Family Practice");
  });
});
