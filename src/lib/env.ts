import { z } from "zod";

/**
 * Canonical server environment.
 *
 * Variable names here are the source of truth: `.env.example` and the README
 * are both written against this schema, not the other way around.
 *
 * Two tiers:
 *   - required: asserted at boot by `assertServerEnv()` (src/instrumentation.ts)
 *   - optional: absent values disable the feature behind them, and callers
 *     must handle `undefined` rather than assume availability
 */
const serverEnvSchema = z.object({
  // LLM translation
  GEMINI_KEY: z.string().min(1, "GEMINI_KEY is required for intake translation"),

  // Transactional email
  RESEND_KEY: z.string().min(1, "RESEND_KEY is required to send confirmations"),

  // Envelope encryption key-encryption-key. 32 bytes, hex-encoded.
  // Absent this, encryption fails closed rather than using a fallback secret.
  HIPAA_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "HIPAA_MASTER_KEY must be exactly 64 hex characters (32 bytes) for AES-256",
    ),

  // Voice agent identifiers. Read server-side; see src/config.
  ELEVENLABS_AGENT_PATIENT_ID: z
    .string()
    .min(1, "ELEVENLABS_AGENT_PATIENT_ID is required for the voice session"),
  ELEVENLABS_AGENT_RECEPTIONIST_ID: z
    .string()
    .min(1, "ELEVENLABS_AGENT_RECEPTIONIST_ID is required for the voice session"),

  // Clinic identity
  CLINIC_NAME: z.string().min(1).default("City Medical Center"),
  EMAIL_FROM: z.string().min(1).default("onboarding@resend.dev"),

  // Shared secret authenticating service-to-service calls to the internal
  // webhook and audit endpoints. Required: without it those endpoints reject
  // every caller, and intake stops being able to send confirmations.
  INTERNAL_API_SECRET: z
    .string()
    .min(32, "INTERNAL_API_SECRET must be at least 32 characters"),

  // Optional capabilities
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  // Postgres for the durable appointment store (#17) and the durable audit log
  // (#4). Optional in the sense that matters here: unset does not fail the boot,
  // it selects the in-memory stores, which are per-instance and do not survive a
  // serverless cold start. A production deployment that leaves this unset is
  // still losing bookings, and has an audit trail with gaps in it that are
  // indistinguishable from accesses nobody recorded. The schema only decides
  // whether a *durable* store is available to do either in.
  //
  // Must be an http(s) Postgres HTTP endpoint, not a postgres:// socket URL.
  // See src/lib/storage.ts.
  DATABASE_URL: z.string().min(1).optional(),
  SENTRY_DSN: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),

  // Webhook signing secrets (#65). Each is consulted only when its vendor's
  // signature header is present on an inbound /api/webhook request; when
  // unset, vendor verification for that vendor is skipped and the internal
  // shared secret remains the only gate.
  TWILIO_WEBHOOK_SECRET: z.string().min(1).optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Parse and cache the server environment.
 *
 * Parsing is deliberately lazy rather than done at module scope: `next build`
 * imports these modules while generating pages, and a throw at import time would
 * fail the build instead of telling an operator which variable is missing.
 * Boot-time failure is handled by `assertServerEnv`.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid server environment:\n${formatIssues(result.error)}\n\n` +
        "See .env.example for the full list of variables.",
    );
  }

  cached = result.data;
  return cached;
}

/**
 * Fail fast at boot. Called from src/instrumentation.ts on server start.
 *
 * Intentionally not called during `next build`; this guards the running
 * process, not the compiler.
 */
export function assertServerEnv(): void {
  getServerEnv();
}

/** Test seam: drops the parsed cache so a test can re-read process.env. */
export function resetServerEnvCache(): void {
  cached = null;
}
