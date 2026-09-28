import { redactFields, redactValue, type LogFields } from "./redact";

/**
 * Scrubbing for the error-monitoring payload — the last thing that runs before
 * an event leaves the machine.
 *
 * ./redact is the policy for what the application chooses to log. This module
 * is the policy for what the SDK collects without being asked: Sentry attaches
 * the incoming request, the browser's console output, navigation history, and
 * (in v11) request and response bodies by default. On an intake form the
 * request body is the patient's symptom text, and on /track and /spectate the
 * path segment is a sealed record that is a bearer credential. So the policy
 * cannot be "the app only logs safe fields"; it has to be "the payload is
 * rebuilt from an allowlist on the way out".
 *
 * This is the same deny-by-default shape as ./redact, applied one level up: a
 * key that is not on the list below is dropped, and the lists are about the
 * shape of a Sentry event rather than about this app's domain.
 *
 * No `server-only` guard: the browser sends events through the same rules, and
 * the server and browser must not be able to disagree about what may leave the
 * device.
 */

/**
 * Event keys that survive. Everything else is dropped.
 *
 * Note what is absent: `user`, which Sentry populates with an id, an email and
 * an IP address. `server_name` is kept — it is this host's name, which is
 * worth having in a triage session and identifies no patient.
 */
const KEPT_EVENT_KEYS = new Set([
  "event_id",
  "timestamp",
  "platform",
  "level",
  "type",
  "logger",
  "environment",
  "release",
  "dist",
  "server_name",
  "fingerprint",
  "sdk",
  "modules",
  "sdkProcessingMetadata",
  "exception",
  "message",
  "transaction",
  "request",
  "breadcrumbs",
  "contexts",
  "extra",
  "tags",
]);

/** A frame may keep its location. It may not keep the variables it closed over. */
const KEPT_FRAME_KEYS = new Set([
  "filename",
  "abs_path",
  "module",
  "function",
  "lineno",
  "colno",
  "in_app",
  "instruction_addr",
]);

/**
 * Runtime facts worth having in a triage session.
 *
 * `response` is deliberately absent: it is the other half of the request body,
 * and the response to an intake POST echoes the translated symptom text back.
 */
const KEPT_CONTEXT_KEYS = ["runtime", "os", "device", "browser"];

/**
 * Breadcrumbs may keep when and what happened, never the words or the payload.
 *
 * `message`, `data`, `from`, `to` and `url` are all dropped: the console
 * integration puts argument values in `data`, the navigation and http
 * integrations put full URLs — query strings and sealed tokens included — in
 * `from`, `to` and `url`, and a message is unreviewed prose.
 */
const KEPT_BREADCRUMB_KEYS = ["timestamp", "type", "level", "category"];

const MAX_BREADCRUMBS = 100;

/**
 * A single path segment long enough to be an opaque credential rather than a
 * name.
 *
 * A sealed record (src/lib/phi-token.ts) is 29 bytes of header plus the
 * ciphertext, so base64url puts even an empty one past 40 characters. Source
 * paths and build artefacts do not: a chunk is `main-<hash>.js`, and the dot
 * keeps it out of this pattern.
 */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

const REDACTED_SEGMENT = "[redacted]";

const FRAME_LINE = /^\s*at\s/;

export type ErrorReport = {
  error: Error;
  extra: LogFields;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redact a free-text string: anything email-, phone-, or SSN-shaped becomes
 * "[redacted]", an opaque run becomes a redacted segment, and the result is
 * truncated.
 *
 * The opaque-run pass is the belt to ./redact's braces. A URL reaching an error
 * message — `no record for /track/<sealed record>` — is a bearer credential,
 * and /redact cannot know that an identifier-shaped string is a token rather
 * than a timeout.
 */
export function scrubText(value: string): string {
  const redacted = redactValue(value);
  const text = typeof redacted === "string" ? redacted : String(value);
  return text
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? REDACTED_SEGMENT : segment))
    .join("/");
}

function scrubRequest(value: unknown): unknown {
  if (!isRecord(value)) return undefined;

  // Only `method` and the framework's route template. `url` and `query_string`
  // carry the sealed token, `headers` and `cookies` carry the session, and
  // `data` is the request body.
  const out: Record<string, unknown> = {};
  if (typeof value.method === "string") out.method = scrubText(value.method);
  if (typeof value.route === "string") out.route = scrubText(value.route);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Keep when and what happened; drop the words.
 *
 * `message` goes rather than being scrubbed, and that is the stricter half of
 * the policy. A breadcrumb message is console or fetch output the application
 * never wrote and never allowlisted, and it is the one channel where a run of
 * clinical prose could reach an event without ever having been a field on it.
 * `timestamp`, `category` and `type` still say what happened and in what order,
 * which is what a breadcrumb is for. `data`, `from`, `to` and `url` are gone
 * for the usual reasons: argument values in one, full URLs — query strings and
 * sealed tokens included — in the rest.
 */
function scrubBreadcrumbs(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;

  const kept = value.slice(-MAX_BREADCRUMBS).filter(isRecord).map((crumb) => {
    const out: Record<string, unknown> = {};
    for (const key of KEPT_BREADCRUMB_KEYS) {
      const entry = crumb[key];
      if (entry === undefined) continue;
      out[key] = entry;
    }
    return out;
  });

  return kept.length > 0 ? kept : undefined;
}

function scrubContexts(value: unknown): unknown {
  if (!isRecord(value)) return undefined;

  // These are SDK-generated device facts, never application data, so they are
  // kept as-is. The allowlist is what does the work here.
  const out: Record<string, unknown> = {};
  for (const key of KEPT_CONTEXT_KEYS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function scrubStacktrace(value: unknown): unknown {
  if (!isRecord(value)) return undefined;

  const frames = Array.isArray(value.frames) ? value.frames.filter(isRecord) : [];
  return {
    frames: frames.map((frame) => {
      const out: Record<string, unknown> = {};
      for (const key of KEPT_FRAME_KEYS) {
        const entry = frame[key];
        if (entry === undefined) continue;
        out[key] = typeof entry === "string" ? scrubText(entry) : entry;
      }
      return out;
    }),
  };
}

function scrubException(value: unknown): unknown {
  if (!isRecord(value)) return undefined;

  const values = Array.isArray(value.values) ? value.values.filter(isRecord) : [];
  return {
    values: values.map((entry) => {
      const out: Record<string, unknown> = {};
      if (typeof entry.type === "string") out.type = scrubText(entry.type);
      if (typeof entry.value === "string") out.value = scrubText(entry.value);
      if (typeof entry.module === "string") out.module = scrubText(entry.module);
      const stacktrace = scrubStacktrace(entry.stacktrace);
      if (stacktrace) out.stacktrace = stacktrace;
      return out;
    }),
  };
}

/**
 * Rebuild a Sentry event from the allowlist.
 *
 * Wired as `beforeSend`, so it also covers events the SDK raised on its own —
 * an unhandled route error, a console integration breadcrumb, a fetch
 * integration URL — which never pass through this app's logger at all.
 */
export function scrubSentryEvent(event: unknown): unknown {
  if (!isRecord(event)) return event;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event)) {
    if (!KEPT_EVENT_KEYS.has(key)) continue;

    switch (key) {
      case "request": {
        const request = scrubRequest(value);
        if (request) out.request = request;
        break;
      }
      case "breadcrumbs": {
        const breadcrumbs = scrubBreadcrumbs(value);
        if (breadcrumbs) out.breadcrumbs = breadcrumbs;
        break;
      }
      case "contexts": {
        const contexts = scrubContexts(value);
        if (contexts) out.contexts = contexts;
        break;
      }
      case "exception": {
        const exception = scrubException(value);
        if (exception) out.exception = exception;
        break;
      }
      case "extra":
      case "tags":
        // The application's own allowlist, applied to whatever the SDK or a
        // caller attached. Unknown keys are dropped, not logged.
        out[key] = redactFields(value);
        break;
      case "message":
      case "logger":
        out[key] = scrubText(String(value));
        break;
      case "transaction":
      case "fingerprint":
        out[key] = Array.isArray(value)
          ? value.map((entry) => scrubText(String(entry)))
          : scrubText(String(value));
        break;
      default:
        out[key] = value;
        break;
    }
  }

  return out;
}

/**
 * Collect only nothing.
 *
 * Sentry v11 replaced the `sendDefaultPii: false` option with `dataCollection`,
 * and every field here defaults to *on* — headers, cookies, query parameters,
 * and both directions of request and response body. Left unset, enabling this
 * SDK would forward the intake form's symptom text, the authorization header,
 * and the sealed record in the tracking URL on the first error. This object is
 * the `sendDefaultPii: false` of v11: assert the denial explicitly rather than
 * trusting a default, and change it in a PR that argues about the change.
 */
export const DENY_ALL_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  // The LLM prompt is the patient's own words and the LLM response is the
  // translation of them. Both are the record.
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Turn anything that was thrown into an Error safe to put on the wire.
 *
 * The stack is kept, because an error report without a stack is not an error
 * report. The header line is rebuilt rather than reused, because it is a copy
 * of the message, and the message is the field a vendor SDK fills with whatever
 * it was given — a Gemini error can echo the translation request back.
 */
export function reportableError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    const message = scrubText(error.message);
    const frames = typeof error.stack === "string"
      ? error.stack.split("\n").filter((line) => FRAME_LINE.test(line)).map(scrubText)
      : [];

    const reported = new Error(message);
    reported.name = scrubText(error.name) || "Error";
    if (frames.length > 0) reported.stack = `${reported.name}: ${message}\n${frames.join("\n")}`;
    return reported;
  }

  const message = error === undefined || error === null
    ? scrubText(fallbackMessage)
    : scrubText(safeStringify(error));

  const reported = new Error(message);
  reported.name = error === undefined || error === null ? "Error" : "NonErrorThrown";
  return reported;
}

/**
 * Build everything an error report is allowed to contain.
 *
 * The result is already scrubbed, so a caller that reports it cannot leak by
 * passing an unrecognised field: the same allowlist that guards stdout guards
 * the wire, and the error itself arrives already reduced to a name, a message,
 * and frames.
 */
export function buildErrorReport(message: string, error: unknown, fields?: LogFields): ErrorReport {
  return {
    error: reportableError(error, message),
    extra: { message: scrubText(message), ...redactFields(fields) },
  };
}
