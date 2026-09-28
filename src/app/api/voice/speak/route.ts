import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { logError } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation/parse";
import { MAX_SPEECH_CHARACTERS, getElevenLabsClient, isVoiceConfigured } from "@/lib/voice/elevenlabs";
import { VendorRequestError, VoiceNotConfiguredError } from "@/lib/voice/errors";

/**
 * POST /api/voice/speak -- read the intake summary back to the patient.
 *
 * The reason this exists is specific rather than decorative. Somebody who has
 * just dictated a date of birth and a phone number aloud is somebody who has
 * just had a chance to get it wrong and not notice, and hearing it read back is
 * the cheapest way to catch that before a confirmation email goes to an address
 * that is not theirs.
 *
 * It is also the most abusable endpoint in the app, because text-to-speech on a
 * metered account is a service anyone can walk up to. So: a hard length cap
 * checked before the vendor is called, no voice parameter in the body (the voice
 * is this deployment's choice, not the caller's), and a per-caller budget. It
 * is a read-back for a form, not a text-to-speech API.
 */

const SPEAK_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const requestSchema = z
  .object({
    // Trimmed, then bounded. Trimming first is the point: a caller cannot buy
    // 600 characters of speech by sending 600 spaces.
    text: z
      .string()
      .trim()
      .min(1, "Nothing to read aloud")
      .max(MAX_SPEECH_CHARACTERS, "That is too long to read aloud"),
  })
  // No `voice`, no `model`, no `voice_settings`. A caller that can choose the
  // voice can impersonate a doctor. `.strict()` so an attempt to pass one is
  // refused rather than quietly dropped, which would be a caller believing they
  // had picked a voice.
  .strict();

export async function POST(request: NextRequest): Promise<Response> {
  const limited = await enforceRateLimit(
    callerKey(request, "voice_speak"),
    SPEAK_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, requestSchema);
  if (!parsed.ok) return parsed.response;

  if (!isVoiceConfigured()) {
    return NextResponse.json({ error: "Speech is not available" }, { status: 503 });
  }

  try {
    const audio = await getElevenLabsClient().speak(parsed.data.text);

    return new Response(audio, {
      headers: {
        // What the vendor sent, which is MPEG audio.
        "content-type": "audio/mpeg",
        "content-length": String(audio.byteLength),
        // The text spoken is a patient's own details. It is not cacheable, and a
        // shared cache that ignored this would serve one patient's read-back to
        // the next caller.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof VoiceNotConfiguredError) {
      return NextResponse.json({ error: "Speech is not available" }, { status: 503 });
    }

    if (error instanceof VendorRequestError) {
      // The vendor's body is not logged or returned: it echoes the request, and
      // the request is the summary of a patient's appointment.
      logError("voice.speech_failed", error, { statusCode: error.status });
      return NextResponse.json(
        { error: "We could not read that aloud." },
        { status: 502 },
      );
    }

    logError("voice.speech_failed", error);
    return NextResponse.json({ error: "We could not read that aloud." }, { status: 502 });
  }
}
