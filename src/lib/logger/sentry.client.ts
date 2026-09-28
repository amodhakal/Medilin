import type { LogFields } from "./redact";
import { buildErrorReport, DENY_ALL_DATA_COLLECTION, scrubSentryEvent } from "./sentry-event";

/**
 * Browser-side error monitoring, through the same redaction as the server.
 *
 * Deliberately small, and deliberately not wired to an environment variable.
 * SENTRY_DSN is a server-side key, and introducing a second one for the browser
 * would mean a DSN compiled into the client bundle and a new secret in
 * .env.example for the same destination. The browser reports through an
 * installer instead: something that constructs a Sentry client and registers it
 * with setBrowserErrorReporter. Until that exists, this is a no-op and
 * clientLog keeps doing exactly what it did.
 *
 * The safety property does not depend on the installer cooperating. The payload
 * handed to `captureException` is redacted here, by the same code the server
 * uses, before any client sees it — so a browser SDK installed with default
 * options still cannot receive a patient record from the logger. What the
 * installer is given below is for the events the SDK raises on its own.
 */

/** The slice of a browser Sentry client this module uses. */
export interface BrowserErrorReporter {
  captureException(error: unknown, context?: { extra?: LogFields }): unknown;
}

let reporter: BrowserErrorReporter | null = null;

/**
 * Install a browser reporter.
 *
 * Whoever does this should merge BROWSER_ERROR_INIT_OPTIONS into the client's
 * own init options, so the SDK's own default collection stays off.
 */
export function setBrowserErrorReporter(next: BrowserErrorReporter | null): void {
  reporter = next;
}

/**
 * The init options an installer needs, kept next to the code that relies on
 * them so they cannot drift apart.
 */
export const BROWSER_ERROR_INIT_OPTIONS = {
  dataCollection: DENY_ALL_DATA_COLLECTION,
  tracesSampleRate: 0,
  beforeSend: (event: unknown) => scrubSentryEvent(event) as typeof event,
} as const;

/** True once a reporter is installed. */
export function isBrowserErrorReportingEnabled(): boolean {
  return reporter !== null;
}

/** Report a client-side failure, already redacted. Never throws. */
export function captureBrowserError(message: string, fields?: LogFields): void {
  if (!reporter) return;

  const report = buildErrorReport(message, undefined, fields);

  try {
    reporter.captureException(report.error, { extra: report.extra });
  } catch {
    // Same contract as the server path: a monitoring failure is not a reason
    // to fail the interaction the patient is having.
  }
}
