import { describe, expect, test } from "bun:test";
import { formatRequestedAt, timeUntilDescription, toTrackSummary } from "./summary";

/**
 * The tracking page's security boundary, tested.
 *
 * `/track/[token]` renders whatever `toTrackSummary` returns and nothing else,
 * so these assertions are about what a bearer link can reveal — not about how
 * the page looks.
 */

const fullRecord = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  phone: "+44 20 7946 0000",
  language: "English",
  medical_department: "Eye Doctor",
  additionalInfo: "blurred vision in the left eye, worse in the mornings",
  insurance: "yes",
  appointmentDateTime: "2026-10-01T09:30",
};

describe("toTrackSummary", () => {
  test("keeps only the four fields the page renders", () => {
    const summary = toTrackSummary(fullRecord);
    expect(summary).toEqual({
      firstName: "Ada",
      department: "Eye Doctor",
      language: "english",
      requestedAt: "2026-10-01T09:30",
    });
  });

  test("drops every field the page is not meant to show", () => {
    const summary = toTrackSummary(fullRecord);
    const rendered = JSON.stringify(summary);

    // The symptom description is the one that would do real harm on a page
    // designed to be forwarded, so it is checked first and by name.
    expect(rendered).not.toContain("blurred vision");
    expect(rendered).not.toContain("additionalInfo");
    expect(rendered).not.toContain("1985-12-10");
    expect(rendered).not.toContain("dob");
    expect(rendered).not.toContain("ada@example.test");
    expect(rendered).not.toContain("email");
    expect(rendered).not.toContain("7946");
    expect(rendered).not.toContain("phone");
    expect(rendered).not.toContain("insurance");
    expect(rendered).not.toContain("Lovelace");
  });

  test("rejects a record with no first name", () => {
    expect(toTrackSummary({ ...fullRecord, firstName: "" })).toBeNull();
    expect(toTrackSummary({ ...fullRecord, firstName: "   " })).toBeNull();
  });

  test("rejects a record with no usable appointment time", () => {
    expect(toTrackSummary({ ...fullRecord, appointmentDateTime: "" })).toBeNull();
    expect(toTrackSummary({ ...fullRecord, appointmentDateTime: "tomorrow" })).toBeNull();
    expect(toTrackSummary({ ...fullRecord, appointmentDateTime: "2026-10-01 09:30" })).toBeNull();
    expect(toTrackSummary({ ...fullRecord, appointmentDateTime: "2026-10-01T09:30Z" })).toBeNull();
  });

  test("rejects a record that is not an object", () => {
    expect(toTrackSummary(null)).toBeNull();
    expect(toTrackSummary("Ada")).toBeNull();
    expect(toTrackSummary([fullRecord])).toBeNull();
  });

  test("ignores fields of the wrong type instead of coercing them", () => {
    const summary = toTrackSummary({
      ...fullRecord,
      firstName: "Ada",
      medical_department: { name: "Eye Doctor" },
    });
    expect(summary?.department).toBe("the clinic");
  });

  test("truncates an over-long name rather than rendering it whole", () => {
    const summary = toTrackSummary({ ...fullRecord, firstName: "a".repeat(400) });
    expect(summary?.firstName).toHaveLength(100);
  });

  test("falls back to a readable department when there isn't one", () => {
    const summary = toTrackSummary({ ...fullRecord, medical_department: "" });
    expect(summary?.department).toBe("the clinic");
  });

  test("leaves language blank rather than showing a missing one", () => {
    const summary = toTrackSummary({ ...fullRecord, language: "" });
    expect(summary?.language).toBe("");
  });
});

describe("formatRequestedAt", () => {
  test("spells the date out", () => {
    expect(formatRequestedAt("2026-10-01T09:30")).toEqual({
      date: "Thursday 1 October 2026",
      time: "09:30",
    });
  });

  test("keeps the calendar date whatever the server's timezone is", () => {
    // The trap this whole function exists to avoid: `new Date("2026-10-01T09:30")`
    // resolves against the server's zone, so on a UTC host a patient east of
    // Greenwich would be shown 1 October when they asked for 2 October.
    expect(formatRequestedAt("2026-10-01T00:05")?.date).toBe("Thursday 1 October 2026");
    expect(formatRequestedAt("2026-10-01T23:55")?.date).toBe("Thursday 1 October 2026");
    expect(formatRequestedAt("2026-01-01T00:00")?.date).toBe("Thursday 1 January 2026");
    expect(formatRequestedAt("2026-12-31T23:59")?.date).toBe("Thursday 31 December 2026");
  });

  test("pads the time to a fixed width", () => {
    expect(formatRequestedAt("2026-10-01T09:05")?.time).toBe("09:05");
    expect(formatRequestedAt("2026-10-01T19:00")?.time).toBe("19:00");
  });

  test("rejects a date that does not exist", () => {
    expect(formatRequestedAt("2026-02-30T10:00")).toBeNull();
    expect(formatRequestedAt("2026-13-01T10:00")).toBeNull();
    expect(formatRequestedAt("2026-10-01T25:00")).toBeNull();
    expect(formatRequestedAt("2026-10-01T10:61")).toBeNull();
  });

  test("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(formatRequestedAt("2028-02-29T10:00")?.date).toBe("Tuesday 29 February 2028");
    expect(formatRequestedAt("2027-02-29T10:00")).toBeNull();
  });

  test("rejects anything that is not the form the intake submits", () => {
    expect(formatRequestedAt("")).toBeNull();
    expect(formatRequestedAt("2026-10-01")).toBeNull();
    expect(formatRequestedAt("2026-10-01T09:30:00")).toBeNull();
    expect(formatRequestedAt("2026-10-01T09:30Z")).toBeNull();
    expect(formatRequestedAt("01/10/2026 09:30")).toBeNull();
  });
});

describe("timeUntilDescription", () => {
  const at = (requestedAt: string, now: string) =>
    timeUntilDescription(requestedAt, new Date(now));

  test("counts in minutes when it is close", () => {
    expect(at("2026-10-01T09:30", "2026-10-01T09:05")?.text).toBe("in about 25 minutes");
    expect(at("2026-10-01T09:01", "2026-10-01T09:00")?.text).toBe("in about 1 minute");
  });

  test("counts in hours when it is not", () => {
    expect(at("2026-10-01T12:00", "2026-10-01T09:00")?.text).toBe("in about 3 hours");
    expect(at("2026-10-01T10:00", "2026-10-01T09:00")?.text).toBe("in about 1 hour");
  });

  test("counts in days when it is far off", () => {
    expect(at("2026-10-04T09:00", "2026-10-01T09:00")?.text).toBe("in about 3 days");
    expect(at("2026-10-02T09:00", "2026-10-01T09:00")?.text).toBe("in about 1 day");
  });

  test("marks the next three hours as imminent", () => {
    expect(at("2026-10-01T11:00", "2026-10-01T09:00")?.imminent).toBe(true);
    expect(at("2026-10-01T13:00", "2026-10-01T09:00")?.imminent).toBe(false);
  });

  test("says nothing once the time has passed", () => {
    expect(at("2026-10-01T09:00", "2026-10-01T09:00")).toBeNull();
    expect(at("2026-10-01T08:00", "2026-10-01T09:00")).toBeNull();
  });

  test("reads the wall-clock time in the viewer's own zone", () => {
    // The whole reason this is a browser-side computation: `new Date(2026, 9, 1,
    // 9, 30)` is nine thirty wherever the code is running, which is the only
    // reading that is certainly right for a time the viewer themselves picked.
    const now = new Date(2026, 9, 1, 9, 0);
    expect(timeUntilDescription("2026-10-01T09:30", now)?.text).toBe("in about 30 minutes");
  });

  test("ignores a malformed time rather than guessing", () => {
    expect(at("not a time", "2026-10-01T09:00")).toBeNull();
  });
});
