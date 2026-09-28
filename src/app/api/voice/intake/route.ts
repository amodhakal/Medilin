import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { logError, logInfo, logWarn } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { SUPPORTED_LANGUAGES } from "@/lib/validation/intake";
import { MAX_AUDIO_BYTES, getElevenLabsClient, isVoiceConfigured } from "@/lib/voice/elevenlabs";
import { VendorRequestError, VoiceNotConfiguredError } from "@/lib/voice/errors";
import { extractIntakeFromTranscript } from "@/lib/voice/extraction";

/**
 * POST /api/voice/intake -- a recording becomes a filled-in form.
 *
 * Two vendor calls in sequence: transcribe, then read the transcript into the
 * fields the intake schema defines. Both happen here, on the server, with the
 * API key; the browser sends audio and gets JSON, and never sees a vendor
 * credential or a vendor URL.
 *
 * What this endpoint deliberately does not do is book anything. It returns a
 * *draft*, and the patient confirms it, and the booking goes through the same
 * server action the form uses. A voice path that booked on the end of a
 * recording would book whatever the model heard, with nobody looking at it, and
 * the confirmation email would be the first time anyone saw the date of birth.
 *
 * So the shape of the response is the shape of the form, the field names are the
 * form's field names, and the fields are validated by the form's own schema
 * before they leave this process.
 */

/**
 * Two a minute.
 *
 * One recording costs a transcription and a model call, both metered, and this
 * is the endpoint that spends them. A patient answers intake once; a loop does
 * not.
 */
const INTAKE_LIMIT = 2;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** The languages the form can book in. The same union, not a second list. */
const languageSchema = z.enum(SUPPORTED_LANGUAGES);

/**
 * What this endpoint accepts.
 *
 * A `File` for the recording, because a recording is a file and encoding one
 * into JSON would add a third to every upload before decoding it again. The
 * `language` part is a form of the slug, and it goes into the record as
 * `intakeSchema.language` -- the field the form gets from its route, so the two
 * agree by construction.
 */
function parseRecording(request: NextRequest): Promise<
  | { ok: true; audio: { bytes: Uint8Array<ArrayBuffer>; mimeType: string; filename: string }; language: z.infer<typeof languageSchema> }
  | { ok: false; status: 400 | 413; error: string }
> {
  return (async () => {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, status: 400, error: "Expected a multipart form" };
    }

    // The strict part: exactly these two fields. A body that also carries
    // something else is refused rather than partially honoured, because a
    // partially honoured body is a request nobody can reason about.
    for (const key of form.keys()) {
      if (key !== "audio" && key !== "language") {
        return { ok: false, status: 400, error: "Unexpected field in the request" };
      }
    }

    const language = languageSchema.safeParse(form.get("language"));
    if (!language.success) {
      return { ok: false, status: 400, error: "That language is not available" };
    }

    const part = form.get("audio");
    if (!(part instanceof File) || part.size === 0) {
      return { ok: false, status: 400, error: "No recording was sent" };
    }

    // Checked from the part's own length, before `arrayBuffer()`. A 200 MB
    // upload that this server is going to refuse should not first be read into
    // memory in order to be refused.
    if (part.size > MAX_AUDIO_BYTES) {
      return { ok: false, status: 413, error: "That recording is too long" };
    }

    const mimeType = resolveAudioType(part);
    if (!mimeType) {
      return { ok: false, status: 400, error: "That recording is not an audio file" };
    }

    return {
      ok: true,
      audio: {
        bytes: new Uint8Array(await part.arrayBuffer()),
        mimeType,
        // The client's own filename, used only as a multipart part name. It is
        // not a path this server opens and it is never logged.
        filename: part.name || "recording.webm",
      },
      language: language.data,
    };
  })();
}

/**
 * Filename extension to the container it holds.
 *
 * What `MediaRecorder` produces in the browsers this app supports, and what the
 * vendor accepts. Anything not in here is refused here rather than uploaded and
 * rejected there.
 */
const AUDIO_EXTENSIONS = new Map<string, string>([
  ["webm", "audio/webm"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["mp4", "audio/mp4"],
  ["m4a", "audio/mp4"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
]);

/**
 * Decide whether an uploaded part is audio, and what to call it.
 *
 * Two signals, and the order matters. The declared `Content-Type` is first
 * because it is what a real browser sends and what a real runtime parses. The
 * filename extension is the fallback, and it is there for a specific reason: a
 * multipart parser is free to reconstruct a part's type from the filename
 * instead of the header -- Bun's does, and reports `video/webm` for a part
 * declared `audio/mp4` -- and a check that trusted the declared type alone
 * would reject every real recording whenever the runtime got it wrong.
 *
 * Neither signal is trustworthy, and the function does not pretend otherwise.
 * Both come from the client. What this establishes is "not obviously not audio",
 * which is a cheap early error; the vendor is the authority on whether the bytes
 * decode, and a file that does not is a 502 with an honest message rather than a
 * booking.
 */
function resolveAudioType(part: File): string | null {
  const declared = part.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared.startsWith("audio/")) return declared;

  const name = part.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;

  return AUDIO_EXTENSIONS.get(name.slice(dot + 1)) ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceRateLimit(
    callerKey(request, "voice_intake"),
    INTAKE_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseRecording(request);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const { audio, language } = parsed;

  // Checked here rather than left to the client, so the guarantee is this
  // route's: a deployment with no voice credential never reads a recording off
  // the network stack at all, whatever the client is.
  if (!isVoiceConfigured()) {
    return NextResponse.json({ error: "Voice intake is not available" }, { status: 503 });
  }

  try {
    const transcription = await getElevenLabsClient().transcribe(audio, {
      // The language is a hint, not a constraint: the vendor is better at
      // detecting this than we are, and a wrong hint on a right recording is
      // worse than no hint at all.
      languageCode: language,
    });

    logInfo("voice.transcribed", { language });

    const extraction = await extractIntakeFromTranscript(transcription.text, language);

    logInfo("voice.extracted", {
      language,
      // How much of the form the recording filled in. A count, never a value.
      count: Object.keys(extraction.fields).length,
    });

    return NextResponse.json(
      {
        transcript: transcription.text,
        language,
        fields: extraction.fields,
        issues: extraction.issues,
        complete: extraction.complete,
      },
      // The transcript is the patient's own words, going back to the patient.
      // It is still PHI, so it is not cached by anything on the way.
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof VoiceNotConfiguredError) {
      return NextResponse.json({ error: "Voice intake is not available" }, { status: 503 });
    }

    if (error instanceof VendorRequestError) {
      // The vendor's own words are not in the log or the response: its body
      // echoes the request, and the request is a recording of a patient.
      logError("voice.transcription_failed", error, { language, statusCode: error.status });
      return NextResponse.json(
        { error: "We could not hear that recording. Please try again." },
        { status: 502 },
      );
    }

    // A model failure lands here, and so does a refusal from the booking
    // pipeline's own translator. Both are "we could not read your answers",
    // which is a different message from "we could not hear you" and the one a
    // patient can act on by speaking again.
    logError("voice.extraction_failed", error, { language });
    logWarn("voice.intake_incomplete", { language });
    return NextResponse.json(
      { error: "We could not read your answers. Please try again, or use the form." },
      { status: 502 },
    );
  }
}
