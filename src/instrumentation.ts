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
}
