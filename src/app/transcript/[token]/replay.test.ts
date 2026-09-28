import { describe, expect, test } from "bun:test";

import type { Appointment, TranscriptLine } from "@/lib/appointments";
import type { TranscriptSession } from "@/lib/transcript/access";
import { MAX_REPLAY_TEXT_LENGTH, toReplayView } from "./replay";

/**
 * What a transcript replay is allowed to show.
 *
 * The same shape of decision as `../track/[token]/summary.ts`, and the same
 * reason for keeping it in its own module: it is the security boundary of the
 * page, and a boundary that is only enforced by which fields a component
 * happens to reach for is not a boundary.
 *
 * It is an allowlist. `toReplayView` returns the only object the page has, so
 * there is no path by which the rest of the appointment record -- the name, the
 * date of birth, the contact details, the intake notes -- reaches the markup of
 * a page whose URL is a bearer credential that gets forwarded.
 *
 * The one field that is PHI is the text of the lines, because that is the page.
 * Everything else is either a label or a fact the tracking page already shows.
 */

function line(overrides: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    seq: 0,
    role: "patient",
    text: "My left eye has been painful since Tuesday.",
    at: new Date("2026-09-01T09:30:02.000Z"),
    finalized: true,
    ...overrides,
  };
}

function session(overrides: Partial<TranscriptSession> = {}): TranscriptSession {
  const createdAt = new Date("2026-09-01T09:00:00.000Z");
  return {
    appointmentId: "00000000-0000-4000-8000-000000000001",
    appointment: {
      id: "00000000-0000-4000-8000-000000000001",
      patientInfo: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.test",
        dob: "1985-12-10",
        insurance: "yes",
        phone: "+1 555 0100",
        appointmentDateTime: "2026-10-01T09:30",
        medical_department: "Eye Doctor",
        additionalInfo: "Sharp pain behind my left eye since Tuesday",
        language: "english",
      },
      createdAt,
      updatedAt: createdAt,
      conversationEnded: false,
      status: "scheduled",
    } as Appointment,
    lines: [
      line(),
      line({ seq: 1, role: "receptionist", text: "I am sorry to hear that. Can I take your date of birth?" }),
    ],
    ...overrides,
  };
}

describe("toReplayView", () => {
  test("carries the words of the call, in order, with who said them and when", () => {
    const view = toReplayView(session());

    expect(view).not.toBeNull();
    expect(view!.entries.map((entry) => entry.text)).toEqual([
      "My left eye has been painful since Tuesday.",
      "I am sorry to hear that. Can I take your date of birth?",
    ]);
    expect(view!.entries.map((entry) => entry.speaker)).toEqual(["Patient", "Receptionist"]);
    expect(view!.entries[0].at).toBe("2026-09-01T09:30:02.000Z");
    expect(view!.entries[0].clock).toBe("09:30:02");
  });

  test("carries nothing else from the record", () => {
    // The allowlist, asserted. A name, a date of birth, a phone number and a
    // symptom description have no business on a page whose URL is a credential
    // that gets forwarded, and a list of omissions is only worth anything if
    // something enforces it.
    const view = toReplayView(session())!;
    const rendered = JSON.stringify(view);

    for (const leak of [
      "Ada",
      "Lovelace",
      "ada@example.test",
      "1985-12-10",
      "+1 555 0100",
      "yes",
      "Sharp pain behind my left eye since Tuesday",
    ]) {
      expect(rendered).not.toContain(leak);
    }
  });

  test("says which appointment this is, by reference", () => {
    // An id identifies a record and this repository already writes it into the
    // audit trail, the log, and the URL the reader is holding. It opens nothing.
    const view = toReplayView(session())!;

    expect(view.reference).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("marks a line the agent never finished, rather than quietly showing it as whole", () => {
    // A stream that stopped mid-utterance is closed by the relay and stored, but
    // the words are not the whole sentence. Rendering it as though it were would
    // be putting a sentence in a patient's medical record that nobody said.
    const view = toReplayView(session({ lines: [line({ finalized: false })] }))!;

    expect(view.entries[0].interrupted).toBe(true);
    expect(view.entries[0].text).toBe("My left eye has been painful since Tuesday.");
  });

  test("a call with nothing in it is an empty transcript, not a broken view", () => {
    const view = toReplayView(session({ lines: [] }))!;

    expect(view.entries).toEqual([]);
    expect(view.lineCount).toBe(0);
  });

  test("caps a line's length, so one enormous utterance cannot break the page", () => {
    const view = toReplayView(
      session({ lines: [line({ text: "x".repeat(MAX_REPLAY_TEXT_LENGTH + 500) })] }),
    )!;

    expect(view.entries[0].text).toHaveLength(MAX_REPLAY_TEXT_LENGTH);
  });

  test("answers no for anything that is not a session", () => {
    // The page treats null as "this link does not open", which is the same answer
    // it gives a token it cannot resolve -- so a malformed record cannot produce
    // a page that renders.
    expect(toReplayView(null)).toBeNull();
    expect(toReplayView(undefined)).toBeNull();
    expect(toReplayView({} as TranscriptSession)).toBeNull();
  });

  test("says the state the appointment is in, which is a fact the reader needs", () => {
    const view = toReplayView(
      session({
        appointment: { ...session().appointment, status: "cancelled" },
      }),
    )!;

    expect(view.status).toBe("cancelled");
  });
});
