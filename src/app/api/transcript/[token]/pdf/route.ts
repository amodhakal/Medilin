import type { NextRequest } from "next/server";

import { logWarn } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { buildTranscriptPdf } from "@/lib/transcript/access";

/**
 * GET /api/transcript/[token]/pdf -- a call transcript as a downloadable PDF.
 *
 * The only surface in this application that hands a patient's conversation to
 * something outside it, and it is built server-side for that reason. The
 * alternative -- a PDF library in the browser -- downloads the whole transcript
 * to a device that asked for a picture of it, and ships a compression stack, a
 * font parser, and a compression-bomb surface to do it. The bytes are assembled
 * here from lines that have already been authorised and audited, and handed
 * back as an attachment.
 *
 * Five properties, and each is a test in route.test.ts:
 *
 *   - The same token the tracking page is opened with authorises it, and nothing
 *     else does. The authorisation itself is in @/lib/transcript/access, shared
 *     with the replay page, because two surfaces that each resolve a token will
 *     drift and the difference between them is a control.
 *   - Every refusal is a 404 with no PDF in the body. A malformed token, a
 *     tampered one, one sealed under another key and one for a deleted booking
 *     are one answer, and the difference between them tells a prober which of
 *     the four they managed.
 *   - The response is `private, no-store`. A transcript is PHI and a PDF is the
 *     artefact most likely to be kept.
 *   - The filename is built from the appointment, not from the link. A token in
 *     a `Content-Disposition` is a working credential in a downloads folder, in
 *     browser history, and in whatever the operating system does with the name.
 *   - It is metered. Ten exports a minute per caller is far more than anybody
 *     needs to download their own transcript, and cheap enough that a loop over
 *     it is obviously a loop.
 */

/** Rendered per request, and never cached: the body is PHI. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const EXPORT_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const limited = await enforceRateLimit(
    callerKey(request, "transcript_pdf"),
    EXPORT_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const { token } = await params;

  let pdf: Awaited<ReturnType<typeof buildTranscriptPdf>>;
  try {
    pdf = await buildTranscriptPdf(token);
  } catch (error) {
    // The trail could not be written, or a stored line could not be opened.
    // Either way no PDF is produced, because an export nobody can account for is
    // a copy of a patient's medical history that nobody chose to keep. The
    // message is fixed and carries no part of the transcript: an error string
    // from this layer is a string about a patient's call.
    logWarn("transcript.export_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return new Response("The transcript could not be exported.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
    });
  }

  // One answer for every refusal, and no part of the token in the log.
  if (!pdf) {
    logWarn("transcript.export_refused", { status: 404 });
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
    });
  }

  return new Response(pdf.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${pdf.filename}"`,
      "content-length": String(pdf.bytes.length),
      "cache-control": "private, no-store",
      // A PDF is a document the browser may open, and one that is told it may
      // run scripts in the context of this origin is a document that has found a
      // way to be something else. Nothing here needs any of these.
      "x-content-type-options": "nosniff",
    },
  });
}
