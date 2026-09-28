import { NextResponse } from "next/server";

import { requireInternalSecret } from "@/lib/auth/internal";
import { logError } from "@/lib/logger";
import { summariseIntake } from "@/lib/llm/intake-summary";
import { openRecord } from "@/lib/phi-token";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { intakeSummaryRequestSchema } from "@/lib/validation/intake";
import { parseJsonBody } from "@/lib/validation/parse";

/**
 * POST /api/intake-summary -- a structured triage summary of one appointment
 * (#68), for a clinician rather than for the patient.
 *
 * The patient's own description of their symptoms is the most sensitive thing
 * this app holds after their identity, and until now the only thing done with it
 * was translate it. This turns it into something a clinician can read before the
 * consultation starts: the complaint in one line, the account in a paragraph,
 * the symptoms broken out, a routing hint, and the questions worth asking.
 *
 * Three decisions in here are load-bearing, and each of them is a reaction to
 * the shape of the existing surfaces rather than a preference.
 *
 * **It is a route handler behind the internal secret, not a page.**
 * `/track/[token]` and `/spectate/[token]` are pages because the person using
 * them is the patient or the demo operator, and the token in the URL is the
 * whole of the authorisation. A page cannot carry a custom request header, so a
 * page protected by the internal secret would need the secret in the query
 * string, and a shared secret in a URL is in every access log on the path. A
 * route handler is what the internal-secret mechanism in src/lib/auth/internal
 * actually supports, and the alternative -- reusing the sealed-token pattern and
 * making a page out of it -- would mean putting symptom text on a link designed
 * to be forwarded, which is the exact thing /track's allowlist exists to refuse.
 *
 * **The response is the summary and nothing else.** The token decrypts to the
 * whole record. A response body is the easiest thing in this app to paste into a
 * ticket, so it carries the summary, and the caller already has the record: it
 * holds the same token.
 *
 * **Nothing is stored.** The summary is generated per request. Storing it would
 * mean a second copy of a clinical reading of a patient sitting somewhere with
 * its own retention problem, and until there is durable storage there is nowhere
 * correct to put it.
 *
 * The cost is a Gemini call per request, which is why the rate limit is the same
 * shape as the booking endpoint's: this endpoint has no side effect to protect,
 * so the only thing an unlimited caller can do with it is spend money.
 */

const SUMMARY_LIMIT = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Rendered per request. This endpoint must never be cached or prerendered. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<NextResponse> {
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  const limited = await enforceRateLimit(
    callerKey(request, "intake-summary"),
    SUMMARY_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, intakeSummaryRequestSchema);
  if (!parsed.ok) return parsed.response;

  const plaintext = openRecord(parsed.data.token);
  if (!plaintext) {
    // Truncated, tampered, sealed under another key, or not a token at all. All
    // four are the same answer, and none of them is logged: which one it was
    // tells an attacker what they managed to do, and the token itself is a
    // credential.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let record: unknown;
  try {
    record = JSON.parse(plaintext);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const summary = await summariseIntake(record);

    // Null is one of two different facts and the caller needs to tell them
    // apart, so each is named rather than collapsed into an empty object. An
    // empty summary rendered without a reason reads as a patient with no
    // symptoms, which is a clinical finding this endpoint is not entitled to
    // invent.
    return NextResponse.json(
      summary
        ? { summary }
        : {
            summary: null,
            reason: hasNotes(record) ? "unusable_reply" : "no_intake_notes",
          },
      // Never cached: the body is PHI, and a shared cache holding it is a copy
      // of a patient's record held somewhere nobody chose.
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    // Not logged with the error attached, and the binding is dropped rather
    // than ignored. A vendor message can quote the request payload, and the
    // request payload here is a patient describing their symptoms. The caller is
    // told the pipeline is down, which is the distinction that matters:
    // reporting this as "no summary" would be a statement about the patient that
    // is not true.
    logError("intake_summary.failed", undefined);

    return NextResponse.json(
      { error: "The summary could not be generated" },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

/**
 * Whether the patient gave us anything to summarise.
 *
 * Duplicates one condition from `intakeSummaryInput` rather than importing it,
 * because the alternative is threading a second return value through
 * `summariseIntake` for the sake of a label. Cheap, and wrong in only one
 * direction: if the two ever disagree, the response says `unusable_reply` for a
 * record with no notes, which is confusing rather than harmful.
 */
function hasNotes(record: unknown): boolean {
  if (typeof record !== "object" || record === null) return false;
  const value = (record as Record<string, unknown>).additionalInfo;
  return typeof value === "string" && value.trim().length > 0;
}
