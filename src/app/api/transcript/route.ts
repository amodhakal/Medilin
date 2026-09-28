import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { appendTranscript, MAX_TRANSCRIPT_TEXT_LENGTH, TRANSCRIPT_ROLES } from "@/lib/appointments";
import { appointmentIdForToken } from "@/lib/phi-token";
import { logError, logInfo } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation/parse";

/**
 * POST /api/transcript -- the browser's half of #57.
 *
 * The relay that runs the call lives in a client component, so the browser is
 * the only thing that has ever witnessed a conversation and the browser is
 * therefore the only thing that can write it down. That is the whole awkwardness
 * of this endpoint, and it is why the shape here is narrow: the client can add
 * words to the transcript of the appointment its own token names, and it can
 * correct a line it has already sent. It cannot reach another appointment, it
 * cannot delete or reorder, and it cannot make this endpoint store a line with
 * nothing in it.
 *
 * Five decisions, and each is a test in route.test.ts.
 *
 * **The same token authorises it as the tracking page.** Not a session, not an
 * account, not a credential minted for this feature. A second access path to the
 * most sensitive data in the application is a second thing to get wrong.
 *
 * **A version 1 token is refused.** It is the record sealed into the URL with
 * nothing behind it, so there is no appointment to write against. Answering "no"
 * is honest; inventing a key would put a patient's words somewhere with no
 * record to delete them with.
 *
 * **The whole batch is validated before any of it is stored.** Half a call is not
 * a call, and a transcript with a hole where a refused line should be is a
 * conversation that appears to have gone differently than it did.
 *
 * **Nothing from a line is ever logged.** The log line carries the appointment
 * id and a count, both of which are on the allowlist in @/lib/logger/redact;
 * there is no transcript text in this file's logging at all, which is the
 * redaction posture for a surface whose payload *is* the PHI.
 *
 * **It is metered.** A call produces tens of lines over a few minutes. Sixty
 * writes a minute per caller is far more than any session needs and cheap
 * enough that a loop over it is obviously a loop.
 */

/** Rendered per request: the body is a patient's own account of their symptoms. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const APPEND_LIMIT = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** A sealed spectate token is a ciphertext of a record; this bounds the input. */
const MAX_TOKEN_LENGTH = 8_192;

/** A live call produces tens of lines. See the note on the limit above. */
const MAX_BATCH = 200;

/**
 * One line, as it arrives from the relay.
 *
 * `at` is epoch milliseconds because that is what the relay already has and what
 * a `Date` is not: a transcript entry is data, not a view, and a `Date` is a
 * mutable object in a store other code holds references into. Converted to a
 * `Date` here, once, on the way into the store.
 */
const lineSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    role: z.enum(TRANSCRIPT_ROLES),
    text: z.string().min(1).max(MAX_TRANSCRIPT_TEXT_LENGTH),
    at: z.number().int().nonnegative(),
    finalized: z.boolean(),
  })
  // `.strict()`, so a caller cannot smuggle a field past the schema and into the
  // store. The intake schema is strict for the same reason.
  .strict();

const requestSchema = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    entries: z.array(lineSchema).min(1).max(MAX_BATCH),
  })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceRateLimit(
    callerKey(request, "transcript_append"),
    APPEND_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, requestSchema);
  if (!parsed.ok) return parsed.response;

  const { token, entries } = parsed.data;

  const appointmentId = appointmentIdForToken(token);
  if (appointmentId === null) {
    // One answer for every refusal, and the token is not in it, in the log, or
    // in the body. Which of the four ways this can fail is not the caller's
    // business.
    logInfo("transcript.append_refused", { status: 404 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const lines = entries.map((entry) => ({
    seq: entry.seq,
    role: entry.role,
    text: entry.text,
    at: new Date(entry.at),
    finalized: entry.finalized,
  }));

  let stored: number;
  try {
    stored = await appendTranscript(appointmentId, lines);
  } catch (error) {
    // The trail could not be written, or the store is down. Either way the lines
    // are not stored: a write that cannot be recorded must not happen, and a
    // transcript that is on disk with no account of who put it there is a copy
    // of a patient's medical history nobody chose to keep.
    logError("transcript.append_failed", error, { appointmentId });
    return NextResponse.json({ error: "The transcript could not be saved" }, { status: 500 });
  }

  // Zero means the appointment is not there. A miss, not a failure, and the
  // same 404 as a token that named nothing -- so a caller cannot use this to ask
  // which appointment ids exist.
  if (stored === 0) {
    logInfo("transcript.append_refused", { appointmentId, status: 404 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(
    { stored },
    { headers: { "cache-control": "private, no-store" } },
  );
}
