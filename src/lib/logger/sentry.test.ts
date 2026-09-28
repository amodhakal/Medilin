import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clientLog } from "./client";
import { logError } from "./index";
import {
  initErrorMonitoring,
  isErrorMonitoringEnabled,
  setErrorReporter,
  type ErrorReporter,
} from "./sentry";
import {
  isBrowserErrorReportingEnabled,
  setBrowserErrorReporter,
  type BrowserErrorReporter,
} from "./sentry.client";
import {
  buildErrorReport,
  DENY_ALL_DATA_COLLECTION,
  scrubSentryEvent,
  scrubText,
} from "./sentry-event";
/**
 * These tests are the reason the error monitoring is allowed to exist.
 *
 * The logger's own tests prove the allowlist redacts what it is handed. This
 * file proves the thing that actually leaves the device: the report off-box.
 * Every assertion below is written the same way — a patient-shaped value goes
 * in, and the serialised payload comes out and is searched for it.
 */

/**
 * Fixture data only, and obviously not a real person. The repo's own convention
 * (scripts/verify-hipaa.ts) is that nothing resembling a real record is
 * committed, so the values here are chosen to be recognisable as fixtures and
 * distinctive enough that a leak is unambiguous.
 */
const PATIENT = {
  firstName: "Fixturefirst",
  lastName: "Fixturelast",
  email: "fixture.patientname@example.test",
  phone: "+1 (555) 010-0199",
  dob: "1985-12-10",
  ssn: "123-45-6789",
  insurance: "FixtureMutual PPO 4471882",
  medical_department: "Fixture Speciality Clinic",
  additionalInfo: "fixture symptom narrative: migraine with photophobia",
  address: "12 Fixture Street, Springfield",
} as const;

/** A sealed record's shape: version | iv | authTag | ciphertext, base64url. */
const SEALED_TOKEN =
  "AQIDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo" +
  "MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u";
const TOKEN_PREFIX = "AQIDREVGR0hJSktMTU5PUFFSU1RVVldYWVox";
const TOKEN_SUFFIX = "bW5vcHFyc3R1dnd4eXo";

const AUTH_HEADER = "Bearer eyJhbGciOiJIUzI1NiJ9.fixture-session-credential";
const SESSION_COOKIE = "medilin_session=fixture-session-cookie-value";
const CLIENT_IP = "203.0.113.7";

/**
 * Every patient-shaped value, asserted absent from anything that goes off-box.
 *
 * Names are in this list as field values and nowhere else: ./redact protects a
 * name by the key it arrives under, not by recognising the word in prose, and
 * so does this. That boundary is written down in the "documents the boundary"
 * test below rather than left to be discovered.
 */
const LEAKS = [
  PATIENT.firstName,
  PATIENT.lastName,
  PATIENT.email,
  PATIENT.phone,
  PATIENT.dob,
  PATIENT.ssn,
  PATIENT.insurance,
  PATIENT.medical_department,
  PATIENT.address,
  AUTH_HEADER,
  SESSION_COOKIE,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
] as const;

/** Everything a captured event could smuggle out, in one payload. */
function patientShapedFields() {
  return {
    ...PATIENT,
    appointmentId: "fixture-appointment-1",
    language: "spanish",
    headers: { authorization: AUTH_HEADER, cookie: SESSION_COOKIE },
    data: PATIENT,
    url: `/track/${SEALED_TOKEN}`,
  };
}

type Capture = { error: unknown; extra: Record<string, unknown> | undefined };

function fakeReporter(): ErrorReporter & { calls: Capture[] } {
  const calls: Capture[] = [];
  return {
    calls,
    captureException(error, context) {
      calls.push({ error, extra: context?.extra });
      return "event-id";
    },
    flush() {
      return true;
    },
  };
}

function fakeBrowserReporter(): BrowserErrorReporter & { calls: Capture[] } {
  const calls: Capture[] = [];
  return {
    calls,
    captureException(error, context) {
      calls.push({ error, extra: context?.extra });
      return "event-id";
    },
  };
}

/**
 * The wire payload, as the SDK would receive it. An Error serialises to `{}`
 * by default, so its name, message and stack are read off explicitly — those
 * are the fields that end up as `exception.values[0]`.
 */
function wirePayload(capture: Capture): string {
  const error = capture.error;
  const exception =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { value: error };

  return JSON.stringify({ exception, extra: capture.extra ?? {}, context: { user: undefined } });
}

const REQUIRED_ENV = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_RECEPTIONIST_ID: "unused",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
} as const;

const TOUCHED = ["SENTRY_DSN", "NEXT_PHASE", ...Object.keys(REQUIRED_ENV)] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of TOUCHED) saved.set(key, process.env[key]);
  setErrorReporter(null);
  setBrowserErrorReporter(null);
  for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setErrorReporter(null);
  setBrowserErrorReporter(null);
});

describe("logError -> reporting payload", () => {
  test("no patient-shaped value survives the trip to the reporter", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);

    // An error that echoes identifiers back, as a vendor SDK's does, plus a
    // field bag that is a whole patient record.
    const thrown = new Error(
      `translation failed for ${PATIENT.email} with ssn ${PATIENT.ssn}`,
    );
    logError("intake.failed", thrown, patientShapedFields());

    expect(reporter.calls).toHaveLength(1);
    const payload = wirePayload(reporter.calls[0]);

    for (const leak of LEAKS) {
      expect(payload).not.toContain(leak);
    }
  });

  test("the report is still useful, so the test above is not vacuous", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);

    const thrown = new Error("resend rejected the request");
    thrown.stack = "Error: resend rejected the request\n    at deliver (src/app/api/_lib/deliver-confirmation.ts:88:15)";
    logError("webhook.resend_failed", thrown, { language: "spanish" });

    const payload = wirePayload(reporter.calls[0]);
    // Operational signal survives: which error, on which line, in which call.
    expect(payload).toContain("resend rejected the request");
    expect(payload).toContain("deliver-confirmation.ts");
    expect(payload).toContain("webhook.resend_failed");
    expect(payload).toContain("spanish");
  });

  test("an unrecognised field is dropped rather than forwarded", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);

    logError("intake.failed", undefined, {
      symptomDraft: PATIENT.additionalInfo,
      rawRecord: PATIENT,
      ...patientShapedFields(),
    });

    const extra = reporter.calls[0].extra ?? {};
    expect(extra).not.toHaveProperty("symptomDraft");
    expect(extra).not.toHaveProperty("rawRecord");
    expect(extra).not.toHaveProperty("headers");
    expect(extra).not.toHaveProperty("data");
    expect(extra).not.toHaveProperty("url");
    expect(extra.appointmentId).toBe("fixture-appointment-1");
  });

  test("a vendor error echoing the request payload is not forwarded verbatim", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);

    // The shape a vendor SDK error takes: a message that is the payload, with
    // the payload attached beside it.
    const vendorError = {
      message: `400 rejected ${PATIENT.email}`,
      request: { data: PATIENT, headers: { authorization: AUTH_HEADER } },
    };
    logError("intake.failed", vendorError, { language: "spanish" });

    const payload = wirePayload(reporter.calls[0]);
    for (const leak of LEAKS) {
      expect(payload).not.toContain(leak);
    }
  });

  test("a sealed record in a path is not forwarded", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);

    logError("track.failed", new Error(`no record for /track/${SEALED_TOKEN}`));

    const payload = wirePayload(reporter.calls[0]);
    expect(payload).not.toContain(TOKEN_PREFIX);
    expect(payload).not.toContain(SEALED_TOKEN);
    expect(payload).toContain("/track/[redacted]");
  });

  test("the report carries no DSN and no user identity", () => {
    const reporter = fakeReporter();
    setErrorReporter(reporter);
    process.env.SENTRY_DSN = "https://fixturePublicKey@o0.ingest.sentry.io/0";

    logError("intake.failed", new Error("boom"), { language: "spanish" });

    const payload = wirePayload(reporter.calls[0]);
    expect(payload).not.toContain("fixturePublicKey");
    expect(payload).not.toContain("o0.ingest.sentry.io");
    expect(payload).not.toContain("user");
  });

  test("a reporting failure never propagates out of logError", () => {
    setErrorReporter({
      captureException() {
        throw new Error("transport unavailable");
      },
      flush() {
        return true;
      },
    });

    expect(() => logError("intake.failed", new Error("boom"), { language: "spanish" })).not.toThrow();
  });
});

describe("error monitoring gating", () => {
  test("nothing is reported and no SDK is loaded without SENTRY_DSN", async () => {
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env.SENTRY_DSN;

    expect(await initErrorMonitoring()).toBe(false);
    expect(isErrorMonitoringEnabled()).toBe(false);

    const reporter = fakeReporter();
    setErrorReporter(reporter);
    setErrorReporter(null);

    // And the reporter is genuinely absent, so logError cannot reach out.
    expect(isErrorMonitoringEnabled()).toBe(false);
  });

  test("a build does not report, even with a DSN configured", async () => {
    Object.assign(process.env, REQUIRED_ENV);
    process.env.SENTRY_DSN = "https://fixturePublicKey@o0.ingest.sentry.io/0";
    process.env.NEXT_PHASE = "phase-production-build";

    expect(await initErrorMonitoring()).toBe(false);
    expect(isErrorMonitoringEnabled()).toBe(false);
  });

  test("logError still writes its console line with no monitoring configured", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => lines.push(line);

    try {
      logError("intake.failed", new Error("boom"), { language: "spanish" });
    } finally {
      console.error = original;
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("intake.failed");
  });
});

describe("clientLog -> browser reporting payload", () => {
  test("no patient-shaped value survives the trip to the browser reporter", () => {
    const reporter = fakeBrowserReporter();
    setBrowserErrorReporter(reporter);
    expect(isBrowserErrorReportingEnabled()).toBe(true);

    const original = console.error;
    console.error = () => {};
    try {
      clientLog("error", "intake.submit_failed", patientShapedFields());
    } finally {
      console.error = original;
    }

    expect(reporter.calls).toHaveLength(1);
    const payload = wirePayload(reporter.calls[0]);
    for (const leak of LEAKS) {
      expect(payload).not.toContain(leak);
    }
  });

  test("info and warn are not reported", () => {
    const reporter = fakeBrowserReporter();
    setBrowserErrorReporter(reporter);

    const original = console.info;
    console.info = () => {};
    try {
      clientLog("info", "intake.submit_accepted", patientShapedFields());
    } finally {
      console.info = original;
    }

    expect(reporter.calls).toHaveLength(0);
  });

  test("no reporter installed means no reporting and no throw", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(isBrowserErrorReportingEnabled()).toBe(false);
      expect(() => clientLog("error", "intake.submit_failed", patientShapedFields())).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});

describe("scrubSentryEvent", () => {
  /** A Sentry event carrying every PHI-bearing field the SDK can attach. */
  function dirtyEvent() {
    return {
      event_id: "abc123",
      timestamp: "2026-01-01T00:00:00.000Z",
      platform: "node",
      level: "error",
      environment: "production",
      server_name: "fixture-server",
      message: `intake failed for ${PATIENT.email}`,
      transaction: `/track/${SEALED_TOKEN}`,
      fingerprint: ["{{ default }}", `/track/${SEALED_TOKEN}`],
      user: {
        id: PATIENT.email,
        email: PATIENT.email,
        username: PATIENT.firstName,
        ip_address: CLIENT_IP,
      },
      request: {
        url: `https://fixture.test/track/${SEALED_TOKEN}?email=${PATIENT.email}`,
        method: "POST",
        headers: { authorization: AUTH_HEADER, cookie: SESSION_COOKIE },
        cookies: { medilin_session: SESSION_COOKIE },
        data: PATIENT,
        query_string: `email=${PATIENT.email}`,
        env: { DATABASE_URL: "postgres://fixture" },
      },
      breadcrumbs: [
        {
          timestamp: 1,
          type: "http",
          category: "fetch",
          message: `POST /api/intake ${PATIENT.additionalInfo}`,
          data: { body: PATIENT },
          url: `https://fixture.test/intake?email=${PATIENT.email}`,
          from: `https://fixture.test/track/${SEALED_TOKEN}`,
          to: `https://fixture.test/intake?email=${PATIENT.email}`,
          state: "xhr",
        },
      ],
      contexts: {
        runtime: { name: "node", version: "v22.0.0" },
        response: { headers: { "set-cookie": SESSION_COOKIE }, data: PATIENT },
        trace: { trace_id: "fixture-trace" },
      },
      extra: { language: "spanish", email: PATIENT.email, secret: PATIENT.additionalInfo },
      tags: { "logger.name": "fixture", patientEmail: PATIENT.email },
      exception: {
        values: [
          {
            type: "Error",
            value: `failed for ${PATIENT.email} with ssn ${PATIENT.ssn}`,
            module: null,
            stacktrace: {
              frames: [
                {
                  filename: "src/app/actions.ts",
                  function: "submitIntake",
                  lineno: 99,
                  colno: 23,
                  in_app: true,
                  vars: { email: PATIENT.email, dob: PATIENT.dob, form: PATIENT },
                },
              ],
            },
          },
        ],
      },
      sdkProcessingMetadata: { normalizeDepth: 3 },
      // Not on the allowlist at all.
      attachments: [{ filename: "intake.json", data: PATIENT }],
    };
  }

  test("no patient-shaped value survives scrubbing", () => {
    const payload = JSON.stringify(scrubSentryEvent(dirtyEvent()));

    for (const leak of LEAKS) {
      expect(payload).not.toContain(leak);
    }
    // The clinical prose that rode along in the breadcrumb message is gone
    // too, because the whole message is.
    expect(payload).not.toContain(PATIENT.additionalInfo);
    expect(payload).not.toContain(CLIENT_IP);
  });

  test("user identity is dropped entirely", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    expect(event).not.toHaveProperty("user");
  });

  test("the request keeps only its method and route template", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    expect(event.request).toEqual({ method: "POST" });
  });

  test("headers, cookies, and request bodies never survive", () => {
    const payload = JSON.stringify(scrubSentryEvent(dirtyEvent()));
    expect(payload).not.toContain("authorization");
    expect(payload).not.toContain("set-cookie");
    expect(payload).not.toContain("query_string");
  });

  test("a breadcrumb keeps when and what happened, and nothing else", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    const crumb = (event.breadcrumbs as Record<string, unknown>[])[0];

    expect(crumb).toEqual({ timestamp: 1, type: "http", category: "fetch" });
    for (const dropped of ["message", "data", "url", "from", "to", "state"]) {
      expect(crumb).not.toHaveProperty(dropped);
    }
  });

  test("the response context is dropped, the runtime context is kept", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    const contexts = event.contexts as Record<string, unknown>;
    expect(contexts.response).toBeUndefined();
    expect(contexts.trace).toBeUndefined();
    expect(contexts.runtime).toEqual({ name: "node", version: "v22.0.0" });
  });

  test("stack frames keep their location and lose their variables", () => {
    const event = scrubSentryEvent(dirtyEvent()) as {
      exception: { values: { stacktrace: { frames: Record<string, unknown>[] } }[] };
    };
    const frame = event.exception.values[0].stacktrace.frames[0];
    expect(frame).toEqual({
      filename: "src/app/actions.ts",
      function: "submitIntake",
      lineno: 99,
      colno: 23,
      in_app: true,
    });
    expect(frame).not.toHaveProperty("vars");
  });

  test("extra and tags go through the application allowlist", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;

    // `email` is a sensitive key, so it is marked present-but-withheld.
    // `secret` and `patientEmail` are on no list at all, so they are dropped.
    expect(event.extra).toEqual({ language: "spanish", email: "[redacted]" });
    expect(event.tags).toEqual({});
  });

  test("keys outside the allowlist are dropped wholesale", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    expect(event).not.toHaveProperty("attachments");
    // Triage fields are kept, so the report is still worth reading.
    expect(event.event_id).toBe("abc123");
    expect(event.level).toBe("error");
    expect(event.environment).toBe("production");
    expect(event.server_name).toBe("fixture-server");
  });

  test("a sealed record in the transaction is masked, the route shape is not", () => {
    const event = scrubSentryEvent(dirtyEvent()) as Record<string, unknown>;
    expect(event.transaction).toBe("/track/[redacted]");
    expect(scrubText("/track/[token]")).toBe("/track/[token]");
  });

  test("non-object input is passed through unchanged", () => {
    expect(scrubSentryEvent(null)).toBe(null);
    expect(scrubSentryEvent(undefined)).toBe(undefined);
    expect(scrubSentryEvent("string")).toBe("string");
  });

  /**
   * The boundary of the policy, written down so it is not mistaken for a
   * guarantee.
   *
   * A name is protected by the key it arrives under — `name`, `firstName`,
   * `patientInfo` are denied, so a field is dropped or marked withheld
   * whatever its value. The same is true of an email, a phone number, an SSN,
   * a sealed record, a header, a cookie, a request body: none of them can
   * reach the wire in any position, because a key they arrive under is not
   * allowlisted, or the value is identifier-shaped, or the string containing
   * one is redacted whole.
   *
   * What is *not* covered is free-form clinical prose sitting inside a string
   * that carries no identifier — a vendor SDK echoing the translation request
   * into an error message, verbatim and with nothing recognisable in it. That
   * is truncated, the same as `cause` is on stdout, and the remaining text
   * goes to Sentry. It is the one channel where a symptom narrative can leave
   * the machine, so it is a standing reason not to interpolate clinical
   * content into an error message, and a reason to revisit this if it ever
   * becomes a problem.
   */
  test("documents the boundary: identifier-free prose is truncated, not removed", () => {
    // An identifier anywhere redacts the whole string, not just the run.
    const withIdentifier = scrubText(
      `rejected: ${PATIENT.additionalInfo} for ${PATIENT.email}`,
    );
    expect(withIdentifier).toBe("[redacted]");

    // Clinical prose with nothing recognisable in it is bounded, not removed.
    const proseOnly = scrubText(`rejected: ${PATIENT.additionalInfo}`);
    expect(proseOnly.length).toBeLessThanOrEqual(201);
    expect(proseOnly).toContain("rejected:");

    // And an over-long one is cut at the shared cap, not sent whole.
    expect(scrubText("x".repeat(5000)).length).toBeLessThanOrEqual(201);
  });
});

describe("buildErrorReport", () => {
  test("keeps the stack frames and drops the header line's original message", () => {
    const thrown = new Error(`resend rejected ${PATIENT.email}`);
    thrown.stack = `Error: resend rejected ${PATIENT.email}\n    at deliver (deliver-confirmation.ts:88:15)`;

    const report = buildErrorReport("webhook.resend_failed", thrown, { language: "spanish" });

    expect(report.error).toBeInstanceOf(Error);
    expect(report.error.stack).toContain("deliver-confirmation.ts:88:15");
    expect(report.error.stack).not.toContain(PATIENT.email);
    expect(report.error.message).not.toContain(PATIENT.email);
  });

  test("substitutes the log message when nothing was thrown", () => {
    const report = buildErrorReport("intake.confirmation_failed", undefined, { language: "spanish" });
    expect(report.error.message).toBe("intake.confirmation_failed");
    expect(report.extra).toEqual({
      message: "intake.confirmation_failed",
      language: "spanish",
    });
  });

  test("handles a thrown non-Error without stringifying the whole record", () => {
    const circular: Record<string, unknown> = { email: PATIENT.email };
    circular.self = circular;

    const report = buildErrorReport("intake.failed", circular, { language: "spanish" });
    expect(report.error.name).toBe("NonErrorThrown");
    expect(report.error.message).not.toContain(PATIENT.email);
  });
});

describe("DENY_ALL_DATA_COLLECTION", () => {
  test("denies every category the SDK would otherwise collect by default", () => {
    expect(DENY_ALL_DATA_COLLECTION).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
  });
});
