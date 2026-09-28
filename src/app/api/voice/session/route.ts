import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { logError, logInfo, logWarn } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation/parse";
import { VendorRequestError, VoiceNotConfiguredError, VoiceSessionRefusedError } from "@/lib/voice/errors";
import { VOICE_SIDES, issueVoiceSession } from "@/lib/voice/session";

/**
 * POST /api/voice/session -- a short-lived signed conversation URL, for one
 * side of one booked appointment.
 *
 * This endpoint is the replacement for the agent ids the browser used to be
 * handed in the RSC payload. Before it, anyone could read an id out of the
 * shipped page and dial `wss://api.elevenlabs.io/...?agent_id=X` for as long as
 * the agent existed, and the URL was the authorisation: the vendor accepted it
 * because an id in a query string is a public agent, not a credential. Now the
 * id never leaves this process and what comes back is a signature with a minute
 * on it.
 *
 * Three properties, and each one is a test in route.test.ts:
 *
 *   - Only a holder of a real booking gets one. The sealed spectate token is the
 *     credential; it is what the patient already has, it is already a bearer
 *     token for one appointment, and it is the only identifier in this app that
 *     means "a patient who booked".
 *   - The caller cannot choose the agent. It names a side, and the side is
 *     resolved to configuration here. A body that also carries `agent_id` is
 *     refused by the strict schema.
 *   - The endpoint is metered. Ten signatures a minute per caller is more than a
 *     session needs -- a call reconnects a handful of times -- and cheap
 *     enough that a script looping on it is obviously a script.
 *
 * The response is `no-store`. It is a credential, and the only reason a browser
 * would not cache it is a header this route has to set itself.
 */

const SESSION_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** The sealed spectate token is a ciphertext of a record; this bounds the input. */
const MAX_SESSION_TOKEN_LENGTH = 8_192;

const requestSchema = z
  .object({
    side: z.enum(VOICE_SIDES),
    session: z.string().min(1).max(MAX_SESSION_TOKEN_LENGTH),
  })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceRateLimit(
    callerKey(request, "voice_session"),
    SESSION_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, requestSchema);
  if (!parsed.ok) return parsed.response;

  const { side, session } = parsed.data;

  try {
    const signed = await issueVoiceSession({ side, sessionToken: session });

    // The side, not the agent and not the id: the log has to be able to say
    // which half of a call was asked for without being a place agent ids are
    // written down.
    logInfo("voice.session_issued", { resource: `agent_${side}` });
    return NextResponse.json(
      { side, url: signed.url, expiresAt: signed.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof VoiceSessionRefusedError) {
      // One message for a token that is truncated, tampered, sealed under
      // another key, or not a booking at all. Which one it was is not the
      // caller's business.
      logWarn("voice.session_refused", { resource: `agent_${side}`, status: 403 });
      return NextResponse.json({ error: "Not a valid voice session" }, { status: 403 });
    }

    if (error instanceof VoiceNotConfiguredError) {
      // A deployment fact rather than a bad request, and the one status a page
      // can act on: offer the form instead of a control that cannot work.
      return NextResponse.json({ error: "Voice is not available" }, { status: 503 });
    }

    if (error instanceof VendorRequestError) {
      // The vendor's own body is not in the log, the response, or the message:
      // it echoes the request, and the request is the API key and an agent id.
      logError("voice.vendor_failed", error, {
        resource: `agent_${side}`,
        statusCode: error.status,
      });
      return NextResponse.json(
        { error: "The voice service is unavailable. Please try again." },
        { status: 502 },
      );
    }

    logError("voice.session_failed", error, { resource: `agent_${side}` });
    return NextResponse.json({ error: "Could not start a voice session" }, { status: 500 });
  }
}
