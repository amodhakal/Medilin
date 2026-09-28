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

  // Gates every voice feature: without it this server cannot sign a
  // conversation URL, transcribe a recording, or synthesise speech, and the
  // pages offer a form instead.
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
  // Which voice reads a patient's intake details back to them. A per-deployment
  // choice; the client falls back to a stock default when this is absent.
  ELEVENLABS_TTS_VOICE_ID: z.string().min(1).optional(),

  // Gates error monitoring. Absent it, src/lib/logger/sentry stays inert: the
  // SDK is never loaded and nothing is sent anywhere. See that module for the
  // redaction that has to hold before anything is.
  SENTRY_DSN: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(1).optional(),
  // Twilio messaging, for SMS and WhatsApp confirmations (#60). All three or
  // none: a partial set disables messaging rather than half-configuring it,
  // and an unset TWILIO_FROM_NUMBER leaves the confirmation email-only. The
  // sender is E.164, optionally prefixed `whatsapp:` to send over WhatsApp
  // instead of SMS; see src/lib/twilio/messaging.ts.
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),

  // Twilio voice, for the outbound call to clinic reception (#64). The first
  // three above are reused rather than duplicated: a deployment that sends SMS
  // confirmations and places calls has one account and one sender, and a second
  // set of variables is a second set to keep in agreement with the first.
  //
  // Together with the three above, all five or nothing: see
  // src/lib/twilio/voice.ts, where a partial set is logged and refused rather
  // than half-attempted.
  //
  // TWILIO_CLINIC_NUMBER is the line to ring, in E.164. There is deliberately no
  // default for it, and no way to supply one per-request: a number this
  // application did not choose is a number it dialled from configuration it
  // cannot vouch for.
  TWILIO_CLINIC_NUMBER: z.string().min(1).optional(),
  // The absolute https origin Twilio fetches this application's TwiML from. A
  // variable rather than something derived from the request, because the request
  // that triggered a call is not made by Twilio: its Host header is the client's
  // to choose, and the instruction Twilio acts on is fetched from outside.
  TWILIO_CALLBACK_BASE_URL: z.string().min(1).optional(),

  // Where a Twilio media stream is terminated (#3). A `wss://` URL owned by a
  // long-lived service, not by this serverless application: a media stream is a
  // WebSocket that stays open for the length of a call, and this deployment has
  // no process to hold it. See src/lib/twilio/media-stream.ts for the whole
  // argument, which is the same one #15 settled for the ElevenLabs socket.
  //
  // Unset is a working configuration, not a broken one: the clinic's line is then
  // answered with a spoken greeting, which is a real telephone call.
  TWILIO_MEDIA_STREAM_URL: z.string().min(1).optional(),

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
