/**
 * Field-level redaction.
 *
 * No `server-only` guard here: the browser needs the same rules, and a
 * patient record printed to devtools is exposed just as effectively as one
 * printed to stdout. Keeping the rules in one module means the client and
 * server cannot drift apart in what they consider safe to emit.
 *
 * Application logging goes through @/lib/logger (server) or
 * @/lib/logger/client (browser); this module is the policy both share.
 *
 * The previous approach was `console.log` with whatever was in scope, which
 * meant full patient records reached stdout on nearly every request. On Vercel
 * stdout is captured and retained by the platform's log drains, so those
 * records persisted outside the application's control. On any host, stdout is
 * routinely shipped to third-party aggregators.
 *
 * Redaction is deny-by-default: a value is only emitted if its key is on the
 * allowlist below. That inverts the failure mode. An allowlist that someone
 * forgets to extend logs nothing, which is visible and harmless; a denylist
 * that someone forgets to extend logs a patient's symptoms, which is neither.
 *
 * Client-side logging goes through redactForClient, since the same
 * redaction rules have to hold in the browser.
 */

/**
 * Keys safe to log.
 *
 * Note what is absent: name, email, phone, dob, insurance, additionalInfo,
 * symptoms, address, and anything patient-shaped. Those are redacted to
 * "[redacted]" even when they appear under an unexpected key name, via
 * redactValue below.
 */
const ALLOWED_KEYS = new Set([
  "appointmentId",
  "actor",
  "action",
  "resource",
  "status",
  "statusCode",
  "confirmed",
  "durationMs",
  "count",
  "attempt",
  "limit",
  "remaining",
  "retryAfterMs",
  "language",
  "department",
  "clinicName",
  "error",
  "errorName",
  "errorMessage",
  "cause",
  "field",
  "method",
  "path",
  "issueCount",
  "windowMs",
]);

/** Keys whose value is a patient identifier, redacted regardless of nesting. */
const SENSITIVE_KEYS = new Set([
  "name",
  "firstname",
  "lastname",
  "email",
  "phone",
  "dob",
  "dateofbirth",
  "insurance",
  "additionalinfo",
  "symptoms",
  "address",
  "patientinfo",
  "medical_department",
  "medicaldepartment",
  "smsn",
  "note",
  "notes",
  "message",
  "body",
  "text",
  "info",
]);

export const REDACTED = "[redacted]";
export const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

/** True if a value looks like an email address, phone number, or long digit run. */
function looksLikeIdentifier(value: string): boolean {
  return (
    /@[\w.-]+\.\w{2,}/.test(value) ||
    /\+?\d[\d\s().-]{7,}\d/.test(value) ||
    /\b\d{3}-\d{2}-\d{4}\b/.test(value)
  );
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    if (looksLikeIdentifier(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      // A vendor SDK error message can echo the request payload, which for this
      // app means the symptom text that was sent for translation.
      message: value.message.replace(/[\w.-]+@[\w.-]+\.\w{2,}/g, REDACTED).slice(0, MAX_STRING),
    };
  }

  if (depth >= 4) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => redactValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactFields(entry, depth + 1)[key];
    }
    return out;
  }

  return "[unloggable]";
}

/**
 * Filter a field bag down to what may be logged.
 *
 * A key that is not allowlisted is dropped. A key that is explicitly
 * sensitive is replaced with a marker rather than dropped, so the log still
 * shows that a value was present and was withheld.
 */
export function redactFields(fields: unknown, depth = 0): LogFields {
  if (fields === null || fields === undefined) return {};
  if (typeof fields !== "object") return {};

  const out: LogFields = {};

  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    const normalized = normalizeKey(key);

    if (SENSITIVE_KEYS.has(normalized)) {
      out[key] = REDACTED;
      continue;
    }

    if (!ALLOWED_KEYS.has(key) && !ALLOWED_KEYS.has(normalized)) {
      continue;
    }

    out[key] = redactValue(value, depth);
  }

  return out;
}
