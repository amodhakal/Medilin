import { describe, expect, test } from "bun:test";
import { earliestSelectableSlot, isManageable, toManageSummary } from "./manage";

/**
 * What a management link is allowed to reveal.
 *
 * A management link can move or cancel an appointment, which makes it strictly
 * more powerful than a tracking link, so the temptation to show more here is
 * stronger rather than weaker. These assertions are that the temptation was
 * resisted: the list of what is *not* on the page is asserted as carefully as the
 * list of what is.
 */

const appointment = {
  id: "3f7c1e2a-9b4d-4c58-8a61-2d0e7b5f9c34",
  status: "scheduled",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  conversationEnded: false,
  patientInfo: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Doctor",
    additionalInfo: "chest pain since Tuesday",
    language: "spanish",
  },
};

describe("toManageSummary", () => {
  test("keeps the four things a person needs, and the state", () => {
    expect(toManageSummary(appointment)).toEqual({
      firstName: "Ada",
      department: "Doctor",
      language: "spanish",
      appointmentDateTime: "2026-10-01T09:30",
      status: "scheduled",
    });
  });

  test("carries no part of the record it did not choose", () => {
    // The whole of the security boundary. A page whose URL can cancel an
    // appointment must not be the page that renders a symptom description.
    const summary = toManageSummary(appointment)!;

    for (const leak of [
      "Lovelace",
      "ada@example.test",
      "1985-12-10",
      "+1 555 0100",
      "chest pain",
      "yes",
    ]) {
      expect(JSON.stringify(summary)).not.toContain(leak);
    }
  });

  test("does not carry the appointment id either", () => {
    // The link in the URL is the credential. A reference number invented out of
    // it would put a fragment of it in the DOM, in a screenshot, and in anything
    // the page copies out.
    expect(JSON.stringify(toManageSummary(appointment))).not.toContain(appointment.id);
  });

  test("carries no field the caller passed that it did not ask for", () => {
    const withExtras = { ...appointment, clinicNotes: "call before noon", patientInfo: { ...appointment.patientInfo, vip: true } };

    expect(JSON.stringify(toManageSummary(withExtras))).not.toContain("call before noon");
    expect(JSON.stringify(toManageSummary(withExtras))).not.toContain("vip");
  });

  test("truncates rather than refusing an over-long name", () => {
    // The name is a greeting, not a lookup key, so a long one is clipped instead
    // of failing the page. The intake schema already caps it at 100.
    expect(toManageSummary({
      ...appointment,
      patientInfo: { ...appointment.patientInfo, firstName: "A".repeat(500) },
    })!.firstName).toHaveLength(100);
  });

  test.each([
    ["no first name", { ...appointment, patientInfo: { ...appointment.patientInfo, firstName: "  " } }],
    ["no appointment time", { ...appointment, patientInfo: { ...appointment.patientInfo, appointmentDateTime: "" } }],
    ["a time carrying a zone", { ...appointment, patientInfo: { ...appointment.patientInfo, appointmentDateTime: "2026-10-01T09:30Z" } }],
    ["a time that is not a date at all", { ...appointment, patientInfo: { ...appointment.patientInfo, appointmentDateTime: "tomorrow" } }],
    ["no patient record", { ...appointment, patientInfo: null }],
    ["a patient record that is a string", { ...appointment, patientInfo: "Ada" }],
    ["not an appointment", "nope"],
    ["nothing at all", null],
  ])("returns null for %s, rather than rendering an empty appointment", (_label, value) => {
    // A page that renders an appointment with no name and no time tells a patient
    // something is wrong without telling them what, and is worse than a 404.
    expect(toManageSummary(value)).toBeNull();
  });

  test("defaults the department rather than rendering a blank row", () => {
    expect(
      toManageSummary({
        ...appointment,
        patientInfo: { ...appointment.patientInfo, medical_department: "" },
      })!.department,
    ).toBe("the clinic");
  });

  test("lowercases the language, as the tracking page does", () => {
    expect(
      toManageSummary({
        ...appointment,
        patientInfo: { ...appointment.patientInfo, language: "SPANISH" },
      })!.language,
    ).toBe("spanish");
  });
});

describe("isManageable", () => {
  test("is true only for the states a patient can still change", () => {
    expect(isManageable("scheduled")).toBe(true);
    expect(isManageable("confirmed")).toBe(true);
    expect(isManageable("cancelled")).toBe(false);
    expect(isManageable("completed")).toBe(false);
    // Not a closed set here on purpose: an unrecognised state must not be
    // offered a cancel button, and defaulting to false is the safe direction.
    expect(isManageable("something-else")).toBe(false);
    expect(isManageable("")).toBe(false);
  });
});

describe("earliestSelectableSlot", () => {
  const lead = 30 * 60_000;

  test("is the requested time plus the clinic's notice period", () => {
    const now = Date.parse("2026-09-01T10:07:00.000Z");

    // Built and read in the same zone, so the value is a wall-clock time the
    // `datetime-local` input can accept and `negotiateAppointmentTime` can parse.
    const slot = earliestSelectableSlot(now, lead);
    expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    const parsed = new Date(slot);
    expect(Math.abs(parsed.getTime() - (now + lead))).toBeLessThan(60_000);
  });

  test("floors to the minute, because the input has minute granularity", () => {
    // Without the floor, a patient in the minute before their own earliest slot
    // is shown a control whose value the server then refuses -- `10:37:59` is not
    // a value `datetime-local` can hold and `intakeSchema` accepts.
    const withinOneMinute = Date.parse("2026-09-01T10:07:00.000Z");
    const sameMinuteLater = Date.parse("2026-09-01T10:07:59.999Z");

    expect(earliestSelectableSlot(sameMinuteLater, lead)).toBe(
      earliestSelectableSlot(withinOneMinute, lead),
    );
    expect(new Date(earliestSelectableSlot(sameMinuteLater, lead)).getSeconds()).toBe(0);
  });

  test("rounds towards the past, so the slot it offers is one the server accepts", () => {
    // Flooring can land just under `now + lead`, which is correct rather than a
    // bug: the clinic's notice period is applied a second time by
    // `negotiateAppointmentTime`, and this only exists so the form does not offer
    // a time that is guaranteed to be moved.
    const now = Date.parse("2026-09-01T10:07:59.999Z");
    const slot = earliestSelectableSlot(now, lead);

    expect(new Date(slot).getTime()).toBeLessThanOrEqual(now + lead);
    expect(new Date(slot).getTime()).toBeGreaterThan(now + lead - 60_000);
  });
});
