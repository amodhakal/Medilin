import { describe, expect, test } from "bun:test";
import { buildBookingGreetingTwiML, escapeXml, MAX_SAY_CHARACTERS } from "./twiml";

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
