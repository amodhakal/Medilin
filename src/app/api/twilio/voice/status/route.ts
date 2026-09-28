import { NextResponse, type NextRequest } from "next/server";

import { getServerEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { appendWebhookEvent } from "@/lib/webhook/events";
import { publicRequestUrl, verifyVendorWebhook } from "@/lib/webhook/verify";

/**
 * POST /api/twilio/voice/status -- what happened to the call.
 *
 * A call that was placed is not a call that reached anyone. `intake.booking_dialled`
 * says a clinic's line was asked for; this route says whether the line rang, was
 * answered, and how long the call ran. Without it the only honest statement this
 * application can make about its own telephony is one it made before the call.
 *
 * The event is stored in the same append log as every other vendor callback
 * (../webhook/events), and for the same reason: one place where an acknowledged
 * vendor event is buffered, so a future reader has one place to look rather than
 * a per-vendor convention. That store is in memory and per-instance, which is
 * #17's problem and is stated in that module rather than here.
 *
 * ## Two details that are not obvious
 *
 * **The event name is read from `CallStatus`, not derived.** `deriveEventType` in
 * ../webhook/events looks for `type`, `event` and `status`, which is right for
 * ElevenLabs and wrong for Twilio: Twilio's field is `CallStatus`, and a generic
 * derivation files a completed call as an event called "unknown". The name is
 * read here, where the vendor's own field name is known, and the value is
 * bounded before it becomes a log field.
 *
 * **The payload is stored as received and the response is empty.** Storage is not
 * redacted, because redaction is a logging control and this event is the data.
 * The response carries no event id and no payload, because a receipt that echoes
 * a call is a second copy of it; Twilio already knows what it sent, and 204 is
 * what it treats as success.
 *
 * The gate is Twilio's real signature -- HMAC-SHA1 over the URL with the sorted
 * form parameters appended, keyed by the account's auth token. See
 * @/lib/webhook/verify. An unsigned request is refused once
 * `TWILIO_AUTH_TOKEN` is set, and accepted when it is not: nothing to verify
 * against means nothing to refuse on, which is the local-development and CI
 * case and the same posture /api/twilio/voice/answer takes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await readBody(request);

  const verification = verifyVendorWebhook(request.headers, rawBody, {
    url: publicRequestUrl(request),
    contentType: request.headers.get("content-type"),
  });

  if (verification.attempted) {
    if (!verification.ok) {
      // No signature, no token, no body in this line: the presented value is
      // attacker-controlled and the thing being defended is the auth token.
      logWarn("twilio.status_signature_rejected", { status: 403 });
      return new NextResponse("Forbidden", { status: 403 });
    }
  } else if (hasTwilioCredentials()) {
    // A request this deployment could have checked and did not. Refused for the
    // same reason the answer route refuses one: a gate that applies to signed
    // callers and not to unsigned ones is not a gate.
    logWarn("twilio.status_unsigned", { status: 403 });
    return new NextResponse("Forbidden", { status: 403 });
  } else {
    logInfo("twilio.status_unverified", {});
  }

  const params = new URLSearchParams(rawBody);
  const event = appendWebhookEvent({
    vendor: "twilio",
    type: readCallStatus(params),
    // `URLSearchParams` collapses a repeated name, and a callback with two
    // `CallStatus` fields is not a callback this application has a use for.
    payload: Object.fromEntries(params),
  });

  // The event name is the whole of what is worth having: it is Twilio's own
  // word for where the call got to. Every other field -- the numbers, the
  // duration, the recording URL -- is on no allowlist in @/lib/logger and is
  // dropped there, which is what keeps a callback full of phone numbers readable
  // in a log at all.
  logInfo("twilio.call_status", { status: event.type, count: 1 });

  return new NextResponse(null, { status: 204 });
}

/**
 * Twilio's status for this call, or "unknown".
 *
 * Bounded, and stripped of control characters, because this string becomes a log
 * field and an event type that is echoed back into a response elsewhere. The
 * bound is what a vendor status word needs -- `queued`, `ringing`,
 * `in-progress`, `completed`, `busy`, `failed`, `no-answer` -- with a hundred
 * times that for a vendor that has not been met yet.
 */
function readCallStatus(params: URLSearchParams): string {
  const status = params.get("CallStatus")?.trim() ?? "";
  const cleaned = status.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
  return cleaned === "" ? "unknown" : cleaned;
}

/** Whether this deployment holds a Twilio credential at all. */
function hasTwilioCredentials(): boolean {
  try {
    return Boolean(getServerEnv().TWILIO_AUTH_TOKEN?.trim());
  } catch {
    return false;
  }
}

/**
 * The raw body, read once, before any parsing.
 *
 * The signature covers the parameters in it, so this is read as text and handed
 * to the verifier as the bytes Twilio signed. A body that cannot be read is
 * empty, which then fails verification, which is a 403 rather than a 500.
 */
async function readBody(request: NextRequest): Promise<string> {
  try {
    return await request.text();
  } catch {
    return "";
  }
}
