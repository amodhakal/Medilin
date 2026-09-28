import { redactFields, type LogFields } from "./redact";
import { captureBrowserError } from "./sentry.client";

/**
 * Browser-side logging, using the same allowlist as the server.
 *
 * Client logs are visible to the patient in devtools and are routinely
 * captured by error-reporting SDKs, which forward them off-device. A patient
 * record printed here is exposed as effectively as one printed to stdout, so
 * the spectate page's three "here is your decoded record" logs are gone.
 *
 * Errors are also forwarded to error monitoring, through the same redaction —
 * a client SDK is off-device by definition, which is the whole reason the
 * redaction has to happen before the handoff and not inside the client. With
 * no browser reporter installed, which is the state this ships in, that call
 * does nothing and the behaviour below is the whole of it.
 *
 * No `server-only` guard, obviously. The guard lives in ./index.
 */

export function clientLog(
  level: "info" | "warn" | "error",
  message: string,
  fields?: LogFields,
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

  if (level === "error") captureBrowserError(message, fields);
}
