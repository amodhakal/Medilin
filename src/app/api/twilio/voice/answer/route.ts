import { NextResponse, type NextRequest } from "next/server";

import { getClinicName } from "@/config";
import { getServerEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { mintMediaStreamSession } from "@/lib/twilio/media-stream";
import { buildBookingGreetingTwiML, buildMediaStreamTwiML } from "@/lib/twilio/twiml";
import { publicRequestUrl, verifyVendorWebhook } from "@/lib/webhook/verify";

/**
 * POST /api/twilio/voice/answer -- the TwiML for a call this app placed.
 *
 * Twilio fetches this document when it connects the outbound call that
 * ../_lib/book-appointment.ts made, and executes it: whatever verbs are in here
 * are what happens on a real telephone. Two documents, in priority order.
 *
 *   1. `<Connect><Stream>` -- the call becomes a conversation with the
 *      receptionist agent this application already runs, over a socket held by a
 *      long-lived bridge. See @/lib/twilio/media-stream for why that socket is
 *      not in this repository, which is the same argument #15 settled for the
 *      ElevenLabs socket.
 *   2. `<Say>` -- a fixed greeting. The fallback for a deployment with no bridge,
 *      and what the branch below this one shipped. It is a working telephone
 *      call: the clinic's line rings and a receptionist picks up.
 *
 * Degrading rather than failing is the load-bearing decision on this route. A 500
 * here is a call that connects to nothing, which a clinic reports as a fault on
 * their line and an operator reports as a bug in the booking form. So every
 * failure to build the better document produces the worse one, and is logged.
 *
 * ## The gate
 *
 * Twilio's signature, verified with the scheme Twilio actually signs: HMAC-SHA1
 * over the URL it called, with the sorted form parameters concatenated onto the
 * end, keyed by the account's auth token. See @/lib/webhook/verify for why that
 * is a different thing from what `/api/webhook` does, and for the published
 * digest the implementation is tested against.
 *
 * A signature that is present and wrong is a 403. So is a request with no
 * signature at all, once `TWILIO_AUTH_TOKEN` is set: a deployment holding a
 * Twilio credential is one that can tell Twilio from anyone else, and a request
 * it cannot vouch for does not get a document. With no credential configured
 * there is no gate to apply and the fixed greeting is served, which is the
 * local-development and CI case and the behaviour the branch below had.
 *
 * Nothing from the request reaches the document. Not the call SID, not the
 * numbers, not `CallerName`. A caller who could put a `<Say>` in here could make
 * a clinic's line say anything, and the thing speaking is a speakerphone in a
 * waiting room.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Read the body as text, once, before parsing anything. Twilio's signature
  // covers the parameters in it, and re-serialising a parsed form does not
  // round-trip: verifying after a parse would reject legitimately signed
  // requests.
  const rawBody = await readBody(request);
  const url = publicRequestUrl(request);

  const verification = verifyVendorWebhook(request.headers, rawBody, {
    url,
    contentType: request.headers.get("content-type"),
  });

  const refused = authenticate(verification, request);
  if (refused) return refused;

  return twiml((await streamDocument()) ?? greeting());
}

/**
 * The two refusals, and why they get the same answer.
 *
 * A present-but-wrong signature is not the same as a missing one: the first is
 * someone who knows this route exists and cannot prove anything, the second is a
 * caller this deployment has no credential to check against. They get the same
 * status and the same empty body, because a difference a prober could use is
 * worth more than a difference an operator could read. They get different log
 * lines, because the second is a configuration question and the first is an
 * incident.
 */
function authenticate(
  verification: ReturnType<typeof verifyVendorWebhook>,
  request: NextRequest,
): NextResponse | null {
  if (verification.attempted) {
    if (verification.ok) return null;
    // No signature, no token, no body in this line: the presented value is
    // attacker-controlled and the thing being defended is the auth token.
    logWarn("twilio.answer_signature_rejected", {
      status: 403,
      path: request.nextUrl.pathname,
    });
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!hasTwilioCredentials()) {
    // Nothing to verify against, so nothing to refuse on. Logged, because a
    // deployment that reaches this line with a configured account is a
    // deployment whose Twilio is not signing.
    logInfo("twilio.answer_unverified", { path: request.nextUrl.pathname });
    return null;
  }

  logWarn("twilio.answer_unsigned", { status: 403, path: request.nextUrl.pathname });
  return new NextResponse("Forbidden", { status: 403 });
}

/**
 * Does this deployment hold a Twilio credential to check signatures with?
 *
 * The same reason the auth token is the key for Twilio's real scheme: a value
 * that is not the one Twilio signs with verifies nothing, so the presence of
 * the account is what decides whether an unverifiable request is a stranger or a
 * local `curl`.
 */
function hasTwilioCredentials(): boolean {
  try {
    return Boolean(getServerEnv().TWILIO_AUTH_TOKEN?.trim());
  } catch {
    return false;
  }
}

/**
 * The streaming document, or null when this call gets the greeting.
 *
 * Every failure is a null rather than a throw. A bridge that is not configured,
 * a deployment with no voice agent, a vendor that refuses a signature request:
 * all three have a better answer available than silence.
 */
async function streamDocument(): Promise<string | null> {
  try {
    const session = await mintMediaStreamSession();
    if (!session) return null;

    // A fact about the call, and nothing else. The stream URL is a credential
    // and the numbers in it are the clinic's and the vendor's; neither is
    // written down here.
    logInfo("twilio.media_stream_minted", { status: "streamed", resource: "stream" });
    return buildMediaStreamTwiML({ streamUrl: session.streamUrl });
  } catch (error) {
    // The vendor's own body is not logged: it echoes the request, and the
    // request is an API key and an agent id.
    logError("twilio.media_stream_failed", error, { status: "greeting" });
    return null;
  }
}

/** The greeting, for the calls that do not get a stream. */
function greeting(): string {
  return buildBookingGreetingTwiML({ clinicName: getClinicName() });
}

/** A document, as XML, uncacheable, for a call that is happening now. */
function twiml(document: string): NextResponse {
  return new NextResponse(document, {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The raw body, read once.
 *
 * A body that cannot be read is empty, which then fails verification -- and with
 * a configured account that is a 403, which is the honest answer to a request
 * whose body this process could not read. Swallowing the read error here keeps a
 * transport-level failure from surfacing as a 500.
 */
async function readBody(request: NextRequest): Promise<string> {
  try {
    return await request.text();
  } catch {
    return "";
  }
}
