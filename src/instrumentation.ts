/**
 * Next.js instrumentation hook. Runs once when the server process starts.
 *
 * Purpose: fail fast on a misconfigured deploy. Every route in this app
 * depends on configuration that lives in the environment, and the previous
 * behaviour was to construct clients with `undefined` keys and fail later,
 * per request, with a vendor error.
 *
 * Validation is skipped for the edge runtime, which has no access to the
 * Node process environment, and deliberately not run during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertServerEnv } = await import("@/lib/env");
  assertServerEnv();

  // Error monitoring, opt-in on SENTRY_DSN. Runs after the assertion so a
  // missing required variable still fails the boot rather than being reported
  // to a third party as a crash. Returns false and loads nothing when the DSN
  // is absent, which is the normal state for a contributor and for CI.
  const { initErrorMonitoring } = await import("@/lib/logger/sentry");
  await initErrorMonitoring();
}
