import { NextResponse } from "next/server";

import { getClinicName } from "@/config";
import { buildBookingGreetingTwiML } from "@/lib/twilio/twiml";

/**
 * POST /api/twilio/voice/answer -- the TwiML for a call this app placed.
 *
 * Twilio fetches this document when it connects the outbound call that
 * ../_lib/book-appointment.ts made, and executes it: whatever verbs are in here
 * are what happens on a real telephone. That is why the document is a function
 * of configuration alone. Nothing from the request is read, echoed or
 * interpolated, and the test file drives a body full of TwiML through this route
 * to prove it -- a caller who could put a `<Say>` into this document could make
 * a clinic's line say anything at all.
 *
 * That leaves the obvious question, and it is answered in the PR rather than
 * glossed: this route is not authenticated, and a greeting is what it serves.
 * There is nothing in the document but the clinic's own name and the fact that
 * an automated booking service is calling, so the disclosure from serving it to
 * an unauthenticated caller is a clinic name, and the alternative -- refusing
 * until the signature check lands -- is a call that connects to silence. The
 * branch stacked on top of this one adds the check, because that is where the
 * signature scheme that actually matches Twilio's is implemented.
 *
 * `cache-control: no-store` is set here rather than left to the platform. This
 * is an instruction to a live call, and an intermediary that cached it would
 * hand the same greeting to the next call to the same clinic for an hour.
 *
 * The handler takes no `Request` at all, which is the signature this route
 * should have: a document that is a function of configuration and reads nothing
 * from the caller does not need the caller.
 */
export async function POST(): Promise<NextResponse> {
  return new NextResponse(buildBookingGreetingTwiML({ clinicName: getClinicName() }), {
    status: 200,
    headers: {
      "content-type": "text/xml; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
