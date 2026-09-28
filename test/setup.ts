import { mock } from "bun:test";

/**
 * `server-only` throws on import outside a React Server Component, which is
 * the point of it in the app and a problem for unit tests, which are neither.
 *
 * The module is stubbed rather than dropped from the source. Keeping the
 * import means the guard still fires if a client component ever reaches for
 * one of these modules during a real build.
 */
mock.module("server-only", () => ({}));
