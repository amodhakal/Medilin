import "server-only";

import { getServerEnv } from "../env";
import type { LogFields } from "./redact";
import { buildErrorReport, DENY_ALL_DATA_COLLECTION, scrubSentryEvent } from "./sentry-event";

/**
 * Server-side error monitoring.
 *
 * Everything the SDK would attach to an event that this app did not ask for is
 * stopped twice: once in the init options, and again in `beforeSend`. The
 * options stop the collection, `beforeSend` covers the events the SDK raises
 * on its own, and the payload handed to `captureException` is redacted before
 * it is handed over at all, so any one of the three being wrong is not enough
 * to leak.
 *
 * The whole module is inert until SENTRY_DSN is set. A contributor and CI run
 * the same code path as production minus the SDK: the import is dynamic, so a
 * machine with no DSN never even loads it.
 */

/** The slice of a Sentry client this module uses. */
export interface ErrorReporter {
  captureException(error: unknown, context?: { extra?: LogFields }): unknown;
  flush(timeout?: number): unknown;
}

let reporter: ErrorReporter | null = null;

/** True once a reporter is installed, i.e. once SENTRY_DSN was found. */
export function isErrorMonitoringEnabled(): boolean {
  return reporter !== null;
}

/**
 * Install a reporter directly, bypassing the SDK.
 *
 * Exists for tests, which assert on the payload without a network, and as the
 * seam for a different sink. Pass `null` to un-install.
 */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

/**
 * Initialise error monitoring. Called once from src/instrumentation.ts.
 *
 * Returns whether reporting is on. `false` means either no DSN, or a build,
 * and both are the boring answer: nothing is loaded and nothing is sent.
 */
export async function initErrorMonitoring(): Promise<boolean> {
  if (reporter) return true;

  // Errors thrown while compiling are the compiler's, not a patient's, and a
  // build should not be talking to Sentry at all.
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  // Safe to let this throw: register() has already asserted the environment,
  // and a missing required variable is a boot failure the operator must see.
  const dsn = getServerEnv().SENTRY_DSN;
  if (!dsn) return false;

  // Dynamic so that a machine with no DSN does not load the SDK at all.
  const Sentry = await import("@sentry/nextjs");

  Sentry.init({
    dsn,

    // The v11 spelling of `sendDefaultPii: false`. Every category defaults to
    // on; see DENY_ALL_DATA_COLLECTION for what that would hand over.
    dataCollection: DENY_ALL_DATA_COLLECTION,

    // Performance tracing is a separate decision from error monitoring, and
    // it is the feature that wants span attributes on the intake request.
    tracesSampleRate: 0,

    // Covers the events the SDK collects without the logger: an unhandled
    // route error, a console breadcrumb, a request integration URL.
    beforeSend: (event) => scrubSentryEvent(event) as typeof event,
  });

  reporter = {
    captureException: (error, context) => Sentry.captureException(error, context),
    flush: (timeout) => Sentry.flush(timeout),
  };

  return true;
}

/**
 * Report a failure, already redacted.
 *
 * Never throws and never rejects: monitoring that can fail the request it is
 * watching is worse than no monitoring.
 */
export function reportError(message: string, error?: unknown, fields?: LogFields): void {
  if (!reporter) return;

  const report = buildErrorReport(message, error, fields);

  try {
    reporter.captureException(report.error, { extra: report.extra });
  } catch {
    // A reporting failure is not an application failure. Swallowing it here is
    // the only place in the logger where something is dropped silently, and
    // the console line logError already wrote is the local record.
  }
}
