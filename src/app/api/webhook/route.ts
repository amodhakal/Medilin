import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/validation/parse";
import { webhookPayloadSchema } from "@/lib/validation/intake";
import { requireInternalSecret } from "@/lib/auth/internal";
import { logInfo } from "@/lib/logger";
import { deliverConfirmation } from "../_lib/deliver-confirmation";

/**
 * The internal confirmation webhook.
 *
 * The translation and the send moved to ../_lib/deliver-confirmation so the
 * booking path can call them directly instead of `fetch`ing this route. What
 * stays here is the part that is only meaningful over HTTP: the shared-secret
 * guard.
 *
 * That guard is not decoration and is not weakened by anything in that move.
 * This route is still an unauthenticated-internet-reachable path, and without
 * the secret it is an open mail relay: anyone could POST an address and a
 * message and have the app send it through Resend. The booking path no longer
 * *needs* to authenticate, because it is not making an HTTP request -- that is
 * the point of #43 -- but the door is still there, so the door still has a
 * lock.
 */
export async function POST(request: NextRequest) {
  // Authenticate before anything else.
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  const parsed = await parseJsonBody(request, webhookPayloadSchema);
  if (!parsed.ok) return parsed.response;

  logInfo("webhook.received", { language: parsed.data.language });

  const result = await deliverConfirmation(parsed.data);

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
