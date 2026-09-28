import { describe, expect, test } from "bun:test";
import {
  buildAppointmentIcs,
  buildIcsEvent,
  escapeIcsText,
  foldIcsLine,
  formatIcsDateTime,
  parseAppointmentDetails,
} from "./ics";

/**
 * Calendar invites attached to the confirmation email (#58).
 *
 * The invite is a hand-rolled VCALENDAR, not an OAuth sync: the email carries
 * a `.ics` the patient's mail client can import. These tests pin the
 * attachment contract -- a VCALENDAR with one VEVENT, UTC timestamps, and a
 * stable UID -- because a malformed invite fails silently in the patient's
 * calendar while the email looks fine.
 */

describe("formatIcsDateTime", () => {
  test("formats as UTC YYYYMMDDTHHMMSSZ", () => {
    expect(formatIcsDateTime(new Date("2026-03-06T09:30:00.000Z"))).toBe(
      "20260306T093000Z",
    );
  });
});

describe("escapeIcsText", () => {
  test("escapes commas, semicolons, backslashes and newlines", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
});

describe("foldIcsLine", () => {
  test("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });

  test("folds long lines with CRLF + space", () => {
    const folded = foldIcsLine("SUMMARY:" + "x".repeat(100));
    expect(folded).toContain("\r\n ");
    // Unfolding restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe("SUMMARY:" + "x".repeat(100));
  });
});

describe("buildIcsEvent", () => {
  test("emits a VCALENDAR with a single VEVENT", () => {
    const ics = buildIcsEvent({
      startIso: "2026-03-06T09:30:00.000Z",
      summary: "Appointment at Test Clinic",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).not.toBeNull();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("DTSTART:20260306T093000Z");
    // Default 30-minute appointment.
    expect(ics).toContain("DTEND:20260306T100000Z");
    expect(ics).toContain("SUMMARY:Appointment at Test Clinic");
    expect(ics).toContain("DTSTAMP:20260301T000000Z");
  });

  test("honours an explicit duration", () => {
    const ics = buildIcsEvent({
      startIso: "2026-03-06T09:30:00.000Z",
      durationMinutes: 60,
      summary: "Appointment",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).toContain("DTEND:20260306T103000Z");
  });

  test("escapes summary and description text", () => {
    const ics = buildIcsEvent({
      startIso: "2026-03-06T09:30:00.000Z",
      summary: "Visit; Room 1,2",
      description: "Line one\nLine two",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).toContain("SUMMARY:Visit\\; Room 1\\,2");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
  });

  test("returns null for an unparseable start", () => {
    expect(
      buildIcsEvent({ startIso: "not a date", summary: "Appointment" }),
    ).toBeNull();
  });

  test("uses CRLF line endings", () => {
    const ics = buildIcsEvent({
      startIso: "2026-03-06T09:30:00.000Z",
      summary: "Appointment",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(ics).toContain("\r\n");
  });
});

describe("buildAppointmentIcs", () => {
  test("names the clinic and carries the reference", () => {
    const ics = buildAppointmentIcs({
      agreedDateTimeIso: "2026-03-06T09:30:00.000Z",
      hospitalName: "Test Clinic",
      referenceNumber: "HOSP-123",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).toContain("SUMMARY:Appointment at Test Clinic");
    expect(ics).toContain("DESCRIPTION:Reference: HOSP-123");
    expect(ics).toContain("LOCATION:Test Clinic");
    expect(ics).toContain("X-MEDILIN-REFERENCE:HOSP-123");
    expect(ics).toContain("BEGIN:VCALENDAR");
  });

  test("falls back to a generic summary without a clinic name", () => {
    const ics = buildAppointmentIcs({
      agreedDateTimeIso: "2026-03-06T09:30:00.000Z",
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).toContain("SUMMARY:Medical appointment");
  });

  test("returns null for an unparseable time", () => {
    expect(
      buildAppointmentIcs({ agreedDateTimeIso: "whenever" }),
    ).toBeNull();
  });
});

describe("parseAppointmentDetails", () => {
  test("recovers the negotiated slot, clinic and reference from the booking response", () => {
    // The shape the booking path serialises into `info`.
    const details = parseAppointmentDetails(
      JSON.stringify({
        patientInfo: { email: "patient@example.com" },
        agreedDateTime: "2026-03-06T09:30:00.000Z",
        confirmed: true,
        hospitalName: "Test Clinic",
        referenceNumber: "HOSP-123",
      }),
    );

    expect(details).toEqual({
      agreedDateTimeIso: "2026-03-06T09:30:00.000Z",
      hospitalName: "Test Clinic",
      referenceNumber: "HOSP-123",
    });
  });

  test("feeds straight into buildAppointmentIcs", () => {
    const details = parseAppointmentDetails(
      JSON.stringify({
        agreedDateTime: "2026-03-06T09:30:00.000Z",
        hospitalName: "Test Clinic",
        referenceNumber: "HOSP-123",
      }),
    );
    expect(details).not.toBeNull();

    const ics = buildAppointmentIcs({
      ...details!,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(ics).toContain("DTSTART:20260306T093000Z");
    expect(ics).toContain("SUMMARY:Appointment at Test Clinic");
    expect(ics).toContain("DESCRIPTION:Reference: HOSP-123");
  });

  test("tolerates a response with a time but no clinic or reference", () => {
    const details = parseAppointmentDetails(
      JSON.stringify({ agreedDateTime: "2026-03-06T09:30:00.000Z" }),
    );

    expect(details).toEqual({
      agreedDateTimeIso: "2026-03-06T09:30:00.000Z",
      hospitalName: undefined,
      referenceNumber: undefined,
    });
  });

  test("ignores non-string clinic and reference values", () => {
    // A hospital response is not under this layer's control, so the field
    // types are checked rather than assumed.
    const details = parseAppointmentDetails(
      JSON.stringify({
        agreedDateTime: "2026-03-06T09:30:00.000Z",
        hospitalName: 42,
        referenceNumber: null,
      }),
    );

    expect(details?.hospitalName).toBeUndefined();
    expect(details?.referenceNumber).toBeUndefined();
  });

  test("returns null when there is no usable time", () => {
    // Each of these would produce an email whose invite is wrong or absent.
    expect(parseAppointmentDetails("not json")).toBeNull();
    expect(parseAppointmentDetails("null")).toBeNull();
    expect(parseAppointmentDetails('"a string"')).toBeNull();
    // An array passes `typeof === "object"` but carries no agreedDateTime.
    expect(parseAppointmentDetails("[]")).toBeNull();
    expect(parseAppointmentDetails("{}")).toBeNull();
    expect(parseAppointmentDetails('{"agreedDateTime":"soon"}')).toBeNull();
    expect(parseAppointmentDetails('{"agreedDateTime":12345}')).toBeNull();
  });
});
