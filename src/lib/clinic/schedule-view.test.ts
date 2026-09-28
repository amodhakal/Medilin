import { describe, expect, test } from "bun:test";
import { toClinicScheduleView, formatClinicTime } from "./schedule-view";
import type { Appointment } from "@/lib/appointments/store";
import type { AppointmentRecord } from "@/lib/validation/intake";

/**
 * What a clinician is shown, and the boundary that is the feature.
 *
 * `/track` is four fields from the same record, and its `summary.test.ts` is the
 * proof that the other six stay off the page. This file is the proof that they
 * are on *this* one, deliberately, and the two proofs are the reason the same
 * record can be read two ways without the argument happening at every call site.
 *
 * So the first block of tests here is the escalation, stated as assertions: the
 * date of birth, the contact details, the insurance answer and the patient's own
 * description of their symptoms are all in the view. If someone ever points this
 * module at a link a patient can forward, those tests are the thing that will
 * tell them, and they are written to fail loudly rather than to be updated.
 */

// Obviously fake. This repository is public.
function record(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    firstName: "REDACTED",
    lastName: "REDACTED",
    email: "patient@example.test",
    dob: "1985-12-10",
    insurance: "yes",
    phone: "+1 555 0100",
    appointmentDateTime: "2026-10-01T09:30",
    medical_department: "Doctor",
    additionalInfo: "",
    language: "english",
    ...overrides,
  };
}

function appointment(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const createdAt = new Date("2026-09-01T10:00:00.000Z");
  return {
    id,
    patientInfo: record(),
    createdAt,
    updatedAt: createdAt,
    conversationEnded: false,
    status: "scheduled",
    ...overrides,
  };
}

const NOW = new Date(2026, 8, 28, 8, 0); // 28 September 2026, 08:00 local.

describe("toClinicScheduleView", () => {
  test("shows the fields /track deliberately withholds", () => {
    // This is the escalation, as an assertion rather than a comment. A clinician
    // in the room needs all of it; a forwarded tracking link must have none of
    // it. The two surfaces share a record and nothing else.
    const [row] = toClinicScheduleView(
      [
        appointment("a1", {
          patientInfo: record({
            firstName: "Ada",
            lastName: "Lovelace",
            dob: "1985-12-10",
            email: "ada@example.test",
            phone: "+44 20 7946 0100",
            insurance: "no",
            additionalInfo: "Sharp pain behind my left eye since Tuesday",
          }),
        }),
      ],
      NOW,
    );

    expect(row.patient).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      dob: "1985-12-10",
      email: "ada@example.test",
      phone: "+44 20 7946 0100",
      insurance: "no",
    });
    expect(row.reason).toBe("Sharp pain behind my left eye since Tuesday");
  });

  test("shows what running the appointment needs: when, where, and in what language", () => {
    const [row] = toClinicScheduleView(
      [
        appointment("a1", {
          status: "confirmed",
          patientInfo: record({
            appointmentDateTime: "2026-10-01T09:30",
            medical_department: "Eye Doctor",
            language: "spanish",
          }),
        }),
      ],
      NOW,
    );

    expect(row.requestedAt).toBe("2026-10-01T09:30");
    expect(row.requestedAtLabel).toEqual({ date: "Thursday 1 October 2026", time: "09:30" });
    expect(row.department).toBe("Eye Doctor");
    expect(row.language).toBe("spanish");
    expect(row.status).toBe("confirmed");
    expect(row.id).toBe("a1");
  });

  test("orders the page by the time the patient asked for, soonest first", () => {
    // The store pages in *booking* order, because the appointment time is
    // ciphertext and cannot be an ordering key there. Opening the page is what
    // makes the time readable, so the page is sorted here -- where the plaintext
    // is -- and nowhere else.
    const rows = toClinicScheduleView(
      [
        appointment("late", { patientInfo: record({ appointmentDateTime: "2026-10-05T11:00" }) }),
        appointment("early", { patientInfo: record({ appointmentDateTime: "2026-10-01T09:30" }) }),
        appointment("middle", { patientInfo: record({ appointmentDateTime: "2026-10-03T14:15" }) }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.id)).toEqual(["early", "middle", "late"]);
  });

  test("puts an appointment whose time has passed at the top, and says so", () => {
    // Not filtered out. An appointment that was never marked completed and whose
    // time has gone is the work most likely to be missed, and a list that hides
    // it behind a filter is a list where it is missed.
    const rows = toClinicScheduleView(
      [
        appointment("later", { patientInfo: record({ appointmentDateTime: "2026-10-05T11:00" }) }),
        appointment("overdue", { patientInfo: record({ appointmentDateTime: "2026-09-28T07:15" }) }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.id)).toEqual(["overdue", "later"]);
    expect(rows[0].timeHasPassed).toBe(true);
    expect(rows[1].timeHasPassed).toBe(false);
  });

  test("breaks a tie on the appointment id, so the order is total", () => {
    const rows = toClinicScheduleView(
      [
        appointment("b", { patientInfo: record({ appointmentDateTime: "2026-10-01T09:30" }) }),
        appointment("a", { patientInfo: record({ appointmentDateTime: "2026-10-01T09:30" }) }),
      ],
      NOW,
    );

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });

  test("carries the household, because a clinician runs the booking and not the person", () => {
    // #69: one booking, several people. The account holder's record holds the
    // others, so a clinic looking at that appointment has to be able to see who
    // else is coming -- the child's age is what decides which clinician is free.
    const [row] = toClinicScheduleView(
      [
        appointment("a1", {
          patientInfo: record({
            dependents: [
              {
                firstName: "Maya",
                dob: "2016-04-02",
                relationship: "child",
                additionalInfo: "Cough at night",
              },
            ],
          }),
        }),
      ],
      NOW,
    );

    expect(row.household).toEqual([
      {
        firstName: "Maya",
        lastName: null,
        dob: "2016-04-02",
        relationship: "child",
        additionalInfo: "Cough at night",
      },
    ]);
  });

  test("a booking with no household is an empty list, not a missing key", () => {
    // `dependents` is absent from every record stored before #69 and from every
    // single-person booking, on purpose -- see dependentsField in the intake
    // schema. So "absent" is the common case, not an edge case.
    const [row] = toClinicScheduleView([appointment("a1")], NOW);

    expect(row.household).toEqual([]);
  });

  test("shows a record whose time is unusable rather than hiding the patient", () => {
    // The opposite of /track, which returns null for a record it cannot place in
    // time -- there, a page that cannot say when is a page for the wrong person
    // and a link is easy to forward. Here, dropping a row is dropping a patient
    // from a work list, and a visibly incomplete row is a thing a clinician can
    // act on.
    const [row] = toClinicScheduleView(
      [appointment("a1", { patientInfo: record({ appointmentDateTime: "sometime next week" }) })],
      NOW,
    );

    expect(row.requestedAt).toBeNull();
    expect(row.requestedAtLabel).toBeNull();
    expect(row.timeHasPassed).toBe(false);
    expect(row.patient.firstName).toBe("REDACTED");
  });

  test("carries nothing that was not asked for", () => {
    // An allowlist, in the same sense /track's is: the object this function
    // returns is the only thing the view can reach a field through, so a key
    // added to a record by some future writer does not become a field on a
    // clinician's screen because the view spreads what it was given.
    const leaky = appointment("a1") as Appointment & { patientInfo: Record<string, unknown> };
    leaky.patientInfo.internalNotes = "call the interpreter first";

    const [row] = toClinicScheduleView([leaky], NOW);

    expect(JSON.stringify(row)).not.toContain("internalNotes");
    expect(Object.keys(row).sort()).toEqual([
      "bookedAt",
      "department",
      "household",
      "id",
      "language",
      "patient",
      "reason",
      "requestedAt",
      "requestedAtLabel",
      "status",
      "timeHasPassed",
      "updatedAt",
    ]);
  });

  test("does not truncate the clinical text", () => {
    // The alternative -- clamping the reason to a rendering budget -- would show
    // a clinician half a symptom description and give them no way to know it had
    // been cut. The intake schema bounds this at 2000 characters on the way in;
    // re-imposing a smaller bound here would be a second rule in a place nobody
    // would look for it.
    const long = "x".repeat(5_000);
    const [row] = toClinicScheduleView(
      [appointment("a1", { patientInfo: record({ additionalInfo: long }) })],
      NOW,
    );

    expect(row.reason).toBe(long);
  });

  test("an empty page is an empty page", () => {
    expect(toClinicScheduleView([], NOW)).toEqual([]);
  });
});

describe("formatClinicTime", () => {
  test("spells out a submitted wall-clock time", () => {
    // The intake form submits `datetime-local`, which is a wall-clock time with no
    // zone, so the components are read out of the string and put back together in
    // the same zone. `new Date("2026-10-01T09:30")` would resolve against the
    // server's zone and move the *date* for anyone not on it.
    expect(formatClinicTime("2026-10-01T09:30")).toEqual({
      date: "Thursday 1 October 2026",
      time: "09:30",
    });
  });

  test.each([
    ["a time with a zone on the end", "2026-10-01T09:30Z"],
    ["a date on its own", "2026-10-01"],
    ["a nonsense value", "next tuesday"],
    ["an empty string", ""],
    ["an impossible calendar date", "2026-02-31T09:30"],
    ["an hour that does not exist", "2026-10-01T25:30"],
    // `$` in a JavaScript pattern matches before a trailing newline, so this one
    // passes a shape check and is refused by a length check instead.
    ["a trailing newline", "2026-10-01T09:30\n"],
  ])("refuses %s rather than guessing at it", (_label, value) => {
    expect(formatClinicTime(value)).toBeNull();
  });

  test("is its own function rather than a reuse of /track's", () => {
    // Not an accident, and not a duplication to tidy up. /track is the surface
    // that must stay narrow; importing its helpers into the surface that must not
    // is how two surfaces that are supposed to be independent end up sharing one
    // allowlist by a later pull request. The two formats -- a patient-facing slip
    // and a clinician's day list -- can also legitimately diverge, and when they
    // do, that is a decision somebody should make on purpose.
    expect(formatClinicTime("2026-10-01T09:30")).not.toBeNull();
  });
});
