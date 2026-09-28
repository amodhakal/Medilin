import { NextRequest, NextResponse } from "next/server";
import { badRequest, parseWith } from "@/lib/validation/parse";
import { webhookPayloadSchema } from "@/lib/validation/intake";
import { requireInternalSecret } from "@/lib/auth/internal";
import { logInfo } from "@/lib/logger";
import { verifyVendorWebhook, type WebhookVendor } from "@/lib/webhook/verify";
import { appendWebhookEvent, deriveEventType } from "@/lib/webhook/events";
import { deliverConfirmation } from "../_lib/deliver-confirmation";

/**
 * The webhook endpoint: vendor callbacks and the internal confirmation.
 *
 * Two authenticated paths, and the order between them is the security-relevant
 * part (#65).
 *
 *   1. A vendor signature, when the request carries one and that vendor's
 *      secret is configured. This is how a Twilio status update or an
 *      ElevenLabs agent event proves itself: HMAC-SHA256 over the raw body,
 *      compared in constant time. Those events are ingested and stored.
 *   2. Otherwise the internal shared secret, which is still the only gate for
 *      this app's own booking path. That path is unchanged and still guarded.
 *
 * A present-but-unverifiable vendor signature is a 401 and nothing else. It
 * does not fall through to the internal secret, because a request carrying a
 * signature we cannot check is a request we cannot vouch for -- and falling
 * through would re-open, for anyone holding the internal secret, exactly the
 * forgery hole the vendor check exists to close.
 *
 * The send stays in ../_lib/deliver-confirmation. The booking path calls it
 * directly rather than fetching this route (#43); what remains here is the part
 * that is only meaningful over HTTP, which is deciding who is allowed in.
 */
export async function POST(request: NextRequest) {
  // Read the body as text, once, before parsing anything. The HMAC is computed
  // over the exact bytes the vendor signed, and JSON.parse-then-re-stringify
  // does not round-trip: key order, whitespace, and unicode escapes all change.
  // Verifying after a parse would reject legitimately signed requests.
  const rawBody = await readBody(request);

  const vendor = verifyVendorWebhook(request.headers, rawBody);

  if (vendor.attempted) {
    if (!vendor.ok) {
      // No signature, no secret, no body in this line: the presented value is
      // attacker-controlled and the secret is the thing being defended.
      logInfo("webhook.signature_rejected", { status: vendor.vendor ?? "unknown" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    const guard = requireInternalSecret(request);
    if (!guard.ok) return guard.response;
  }

  const body = parseJson(rawBody);
  if (!body.ok) return body.response;

  if (vendor.attempted && vendor.vendor) {
    return ingest(vendor.vendor, body.value);
  }

  return sendConfirmation(body.value);
}

/**
 * Read the raw request body.
 *
 * A body that cannot be read is treated as empty, which then fails JSON
 * parsing below and answers 400. Swallowing it here keeps a transport-level
 * read error from surfacing as a 500.
 */
async function readBody(request: NextRequest): Promise<string> {
  try {
    return await request.text();
  } catch {
    return "";
  }
}

function parseJson(
  raw: string,
): { ok: true; value: unknown } | { ok: false; response: NextResponse } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  return { ok: true, value };
}

/**
 * Accept a verified vendor event.
 *
 * The payload is stored as received. It is deliberately not redacted before
 * storage -- redaction is a logging control, and stripping fields here would
 * destroy the data this event exists to deliver. What keeps patient-shaped
 * fields out of stdout is that the log line below passes through the
 * deny-by-default allowlist in @/lib/logger, which drops every key not on it.
 */
function ingest(vendor: WebhookVendor, payload: unknown): NextResponse {
  // Events are keyed by field, so a bare array or scalar is not an event.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return badRequest("Request body must be a JSON object").response;
  }

  const record = payload as Record<string, unknown>;
  const type = deriveEventType(record);
  const event = appendWebhookEvent({ vendor, type, payload: record });

  // `status` carries the vendor's event name, which is the part worth having
  // in the log, and `count` keeps the line countable. Both are on the
  // allowlist in @/lib/logger. `vendor`, `payload`, and every patient-shaped
  // key are not, and are dropped there -- which is the reason the log above
  // can be read at all next to a payload full of caller numbers.
  logInfo("webhook.event_ingested", { status: type, count: 1 });

  // The event id and nothing else. The response is a receipt, and the vendor
  // already knows what it sent; a payload echo would put call metadata into a
  // second place it has to be protected.
  return NextResponse.json({ success: true, eventId: event.id });
}

/** The original path: an internal caller asking for a confirmation email. */
async function sendConfirmation(body: unknown): Promise<NextResponse> {
  const validated = parseWith(webhookPayloadSchema, body);
  if (!validated.ok) {
    return NextResponse.json(
      { error: "Invalid request body", issues: validated.issues },
      { status: 400 },
    );
  }

  logInfo("webhook.received", { language: validated.data.language });

  const result = await deliverConfirmation(validated.data);

  if (!result.ok) {
    // 502: the request was well-formed and authorised, and the upstream that
    // had to accept it did not. The previous catch-all answered 400 "Invalid
    // request body" for every failure including this one, which told a caller
    // debugging a mail problem to go look at their own payload.
    return NextResponse.json(
      { error: "Confirmation email could not be sent" },
      { status: 502 },
    );
  }

  // The address is not echoed back: the caller sent it, and a response that
  // repeats a patient's email is one more copy in a log.
  return NextResponse.json({ success: true, subject: result.subject });
}

/**
 * Liveness only. Deliberately reports nothing about configuration or
 * upstream services, since this is reachable without a credential.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
