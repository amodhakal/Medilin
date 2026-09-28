import "server-only";

/**
 * The TwiML this application serves.
 *
 * TwiML is a document Twilio fetches from this app and executes on its own
 * platform: whatever verbs appear here are what happens on a real telephone
 * call. That is the whole security story of this file, and it is why the only
 * inputs are the clinic's name and -- in the branch above this one -- a WebSocket
 * URL that has been checked against configuration. Nothing a request carried is
 * interpolated into a document.
 *
 * Built by hand rather than by a template library, for the same reason the Twilio
 * client in ./voice is: the surface is a `<Response>` with one child, and a
 * dependency for it would be a dependency that decides what gets escaped.
 *
 * ## Escaping is not optional
 *
 * An unescaped `&` in a clinic name is a document Twilio refuses to parse, and
 * the symptom of that is a call that connects and says nothing at all. So the
 * escaping is here, it is total, and it is tested against a name that is trying
 * to break it.
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * A clinic name is a name.
 *
 * 60 characters, the same bound ./notification puts on the clinic name it puts
 * in a text message, and for the same reason: this string is read aloud on a
 * call, and a misconfigured value should not turn a receptionist's morning into
 * a minute of listening. The bound is on the *clinic name*, before the fixed
 * sentence is added, so the cap is a cap on the part that varies.
 */
export const MAX_SAY_CHARACTERS = 60;

const FALLBACK_CLINIC_NAME = "Your clinic";

/**
 * Escape the five XML entities, and nothing else.
 *
 * `'` is escaped as `&apos;` rather than left as a bare apostrophe. It is valid
 * XML to leave it, and this is the one document in the application whose
 * correctness is judged by a third party's parser, so the conservative form is
 * the one worth having.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The sentence a clinic's line answers with.
 *
 * One `<Say>`, and the sentence says three things and stops: this is
 * {clinic}, the call is from an automated appointment service, and a
 * receptionist is about to be asked about a booking.
 *
 * What it deliberately does not say is the interesting part. A waiting-room
 * line is a speakerphone, and this call is placed during a patient's booking
 * request -- so anything spoken here is being said in a room this application
 * does not control, to whoever is nearest it. The appointment time, the
 * patient's name, the reference number, the department: none of it is here, and
 * none of it is in a query string either, so there is nothing to leak in a log
 * and nothing to leak in a URL. The booking reaches the clinic the way every
 * other booking reaches it -- through the system that already holds it.
 *
 * The cost of that choice is real and belongs in the PR: the call tells a
 * receptionist that a request is waiting and nothing about which one. This
 * branch places a real call and speaks a fixed greeting. What the call
 * *negotiates* is the branch above it, where a media stream carries the
 * conversation.
 */
export function buildBookingGreetingTwiML({ clinicName }: { clinicName: string }): string {
  const clinic = sanitiseClinicName(clinicName);
  const spoken = `${clinic}: this is an automated appointment booking service. Please pick up.`;

  return `${XML_DECLARATION}<Response><Say>${escapeXml(spoken)}</Say></Response>`;
}

/**
 * A clinic name that can be spoken, or a fixed one.
 *
 * Control characters become spaces, runs of whitespace collapse, and the length
 * is capped. A blank result falls back rather than producing an empty `<Say>`,
 * because a call that is answered by silence is indistinguishable, to the person
 * hearing it, from a call that failed.
 */
function sanitiseClinicName(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SAY_CHARACTERS)
    .trim();

  return cleaned === "" ? FALLBACK_CLINIC_NAME : cleaned;
}
