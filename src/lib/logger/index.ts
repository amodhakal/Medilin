import "server-only";

import { redactFields, redactValue, type LogFields } from "./redact";
import { reportError } from "./sentry";

/**
 * Server-side structured logging.
 *
 * The previous approach was `console.log` with whatever was in scope, which is
 * how full patient records reached stdout. On Vercel stdout is captured and
 * retained by the platform's log drains, so those records persisted outside
 * this application's control; on any host, stdout is routinely shipped to
 * third-party aggregators.
 *
 * Every field is filtered through the allowlist in ./redact before it is
 * emitted, so a caller cannot accidentally log PHI by passing an extra key.
 * The browser equivalent is ./client.
 *
 * The same allowlist is what makes the error monitoring in ./sentry safe. The
 * console line is the local record; the report off-box is the one that leaves
 * this application's control for good, so it is built from the same policy
 * rather than from a second one that could drift.
 */

function emit(
  level: "info" | "warn" | "error",
  message: string,
  fields?: unknown,
): void {
  const record = {
    level,
    message,
    time: new Date().toISOString(),
    ...redactFields(fields),
  };

  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** Log a successful operation. Fields are filtered by the allowlist. */
export function logInfo(message: string, fields?: LogFields): void {
  emit("info", message, fields);
}

/** Log a recoverable problem. */
export function logWarn(message: string, fields?: LogFields): void {
  emit("warn", message, fields);
}

/**
 * Log a failure, and report it to error monitoring.
 *
 * The Error goes in as `cause` so it passes through redactValue, which
 * truncates the message and strips anything email- or phone-shaped. Passing a
 * vendor error object straight to console.error is how a symptom string ends
 * up in a log aggregator: a Gemini SDK error can echo the request payload.
 *
 * The same argument, and the same fields, are forwarded to Sentry by
 * `reportError` — already redacted, and only when SENTRY_DSN is set.
 */
export function logError(message: string, error?: unknown, fields?: LogFields): void {
  emit("error", message, { ...fields, cause: error });
  reportError(message, error, fields);
}

export { redactFields, redactValue, REDACTED, MAX_STRING } from "./redact";
export type { LogFields } from "./redact";
