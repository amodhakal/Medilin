import { redactFields, type LogFields } from "./redact";

/**
 * Browser-side logging, using the same allowlist as the server.
 *
 * Client logs are visible to the patient in devtools and are routinely
 * captured by error-reporting SDKs, which forward them off-device. A patient
 * record printed here is exposed as effectively as one printed to stdout, so
 * the spectate page's three "here is your decoded record" logs are gone.
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
}
