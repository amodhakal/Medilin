import { describe, expect, test } from "bun:test";
import {
  buildBookingGreetingTwiML,
  buildMediaStreamTwiML,
  escapeXml,
  MAX_SAY_CHARACTERS,
} from "./twiml";

/**
 * The document a clinic's line speaks.
 *
 * TwiML is XML, and XML is the kind of format that fails by being *almost*
 * right: an unescaped ampersand in a clinic name is a document Twilio rejects,
 * and a rejected TwiML document is a call that is answered by silence. So the
 * escaping and the length bound are tested here rather than assumed.
 *
 * The other thing this module is careful about is what it says. A clinic line
 * is a speakerphone in a waiting room. Everything it is told here is chosen to
 * be true of a booking and false of a patient: no name, no symptoms, no contact
 * details, no appointment time. The minimum necessary for "someone is on the
 * other end of this call" is the clinic's own name and the fact that an
 * automated booking service is calling.
 */

/** The argument every test in the second block shares. */
function greeting(clinicName: string): string {
  return buildBookingGreetingTwiML({ clinicName });
}

describe("escapeXml", () => {
  test("escapes the five entities and nothing else", () => {
    expect(escapeXml(`City & Co <Clinic> "East" 'wing'`)).toBe(
      "City &amp; Co &lt;Clinic&gt; &quot;East&quot; &apos;wing&apos;",
    );
  });

  test("leaves a plain string untouched", () => {
    expect(escapeXml("City Medical Center")).toBe("City Medical Center");
  });
});

describe("buildBookingGreetingTwiML", () => {
  test("is a Say inside a Response, which is the only verb this sends", () => {
    const xml = greeting("City Medical Center");

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<Response>");
    expect(xml).toContain("</Response>");
    expect(xml).toMatch(/<Say>[^<]+<\/Say>/);
  });

  test("names the clinic and says what the call is", () => {
    const spoken = /<Say>([^<]+)<\/Say>/.exec(greeting("City Medical Center"))?.[1] ?? "";

    expect(spoken).toContain("City Medical Center");
    // The two things a person on a waiting-room line needs to know: who is
    // calling, and that this is not a patient being telephoned.
    expect(spoken).toContain("automated");
    expect(spoken.toLowerCase()).toContain("appointment");
  });

  test("has no field a patient-shaped value could arrive in", () => {
    // The clinic name is the only input, and it comes from configuration, so
    // there is nothing here for a name, a symptom or a date of birth to be
    // interpolated into. Asserted on the shape: one input, one sentence.
    expect(greeting("City Medical Center")).toMatch(/^<\?xml[\s\S]*<Say>[^<]+<\/Say>[\s\S]*<\/Response>$/);
    expect(greeting("City Medical Center")).not.toMatch(/patientInfo|additionalInfo|symptom/i);
  });

  test("escapes a clinic name that is not XML-safe", () => {
    const xml = greeting("Ben & Jerry's <Clinic>");

    expect(xml).toContain("Ben &amp; Jerry&apos;s &lt;Clinic&gt;");
    expect(xml).not.toContain("<Clinic>");
  });

  test("strips control characters, which cannot be spoken and cannot be signed", () => {
    const xml = greeting("City\u0000 Medical\u0007 Center");

    expect(xml).toContain("<Say>City Medical Center");
  });

  test("falls back rather than speaking an empty clinic name", () => {
    // An empty <Say></Say> is a call that rings and then says nothing, which a
    // receptionist reports as a fault on their line.
    expect(greeting("   ")).toContain("<Say>Your clinic");
  });

  test("caps what is said, because a clinic name is a name", () => {
    const spoken = /<Say>([^<]+)<\/Say>/.exec(greeting("A".repeat(4000)))?.[1] ?? "";

    expect(spoken.startsWith("A".repeat(MAX_SAY_CHARACTERS))).toBe(true);
    expect(spoken).not.toContain("A".repeat(MAX_SAY_CHARACTERS + 1));
  });
});

/**
 * Handing Twilio a socket instead of a sentence (#3).
 *
 * `<Connect><Stream url>` is the difference between a clinic's line hearing a
 * recorded greeting and a clinic receptionist having a conversation with the
 * agent this application already runs. It is also a URL Twilio opens and
 * follows for the length of a call, so the attribute is escaped and the builder
 * takes the URL it was given rather than building one: deciding where the audio
 * goes is ./media-stream's job, and it has already checked the scheme.
 */
describe("buildMediaStreamTwiML", () => {
  const STREAM_URL = "wss://bridge.example/media?conversation=wss%3A%2F%2Fvendor%2Fx";

  test("is a Stream inside a Connect inside a Response", () => {
    const xml = buildMediaStreamTwiML({ streamUrl: STREAM_URL });

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<Connect>");
    expect(xml).toContain("<Stream ");
    expect(xml).toContain("</Connect></Response>");
  });

  test("carries the stream URL it was given, unaltered", () => {
    const xml = buildMediaStreamTwiML({ streamUrl: STREAM_URL });

    expect(xml).toContain(`url="${STREAM_URL}"`);
  });

  test("asks for both directions, because a conversation needs both", () => {
    // Spelled out rather than left to the default: an inbound-only stream is a
    // call the clinic can hear into and never answer, and the default is a
    // vendor-side value this application would rather not be wrong about.
    expect(buildMediaStreamTwiML({ streamUrl: STREAM_URL })).toContain('track="both_tracks"');
  });

  test("escapes a URL that would otherwise close the attribute", () => {
    const xml = buildMediaStreamTwiML({ streamUrl: 'wss://bridge.example/"><Say>hi</Say>' });

    expect(xml).toContain("&quot;&gt;&lt;Say&gt;hi&lt;/Say&gt;");
    expect(xml).not.toContain('"><Say>');
  });

  test("refuses a stream URL that is not one", () => {
    // A Stream pointed at http is a call's audio in plaintext, and a builder
    // that would emit it anyway is a builder that has to be trusted not to be
    // handed one -- so the check is here, next to the escaping.
    for (const streamUrl of ["", "http://bridge.example/media", "/media", "wss://"]) {
      expect(() => buildMediaStreamTwiML({ streamUrl })).toThrow();
    }
  });
});
