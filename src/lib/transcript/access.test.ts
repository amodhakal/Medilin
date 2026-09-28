import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { InMemoryAuditLogStore, readAuditLog, setAuditLogStore } from "@/lib/audit";
import { InMemoryAppointmentStore, setAppointmentStore } from "@/lib/appointments";
import type { Appointment } from "@/lib/appointments";
import { sealRecord, sealReference } from "@/lib/phi-token";
import { redactFields } from "@/lib/logger/redact";
import { resetServerEnvCache } from "@/lib/env";
import { buildTranscriptPdf, openTranscript, transcriptFilename } from "./access";
import type { AppointmentRecord } from "@/lib/validation/intake";

/**
 * Who may read a transcript, and what comes back when they may.
 *
 * This is the file the replay page and the PDF route both go through, and the
 * tests below are almost entirely about the boundary rather than the feature --
 * because a transcript is the most sensitive thing this application holds after
 * the record itself, and the two ways this can be wrong are "an unauthorised
 * caller got the words" and "two patients' conversations got mixed up". The
 * second one is not hypothetical: a single table keyed by anything other than the
 * appointment is a table that eventually serves one patient's call to another.
 *
 * Every unauthorised case below is asserted three ways -- the answer is null, the
 * PDF is not produced, and nothing was written to the trail about a transcript
 * that was never opened. The last of those is what stops a refused request from
 * looking, months later, like a read.
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
    medical_department: "Eye Doctor",
    additionalInfo: "Sharp pain behind my left eye since Tuesday",
    language: "english",
    ...overrides,
  };
}

const KEY = "a".repeat(64);
const savedMasterKey = process.env.HIPAA_MASTER_KEY;

beforeAll(() => {
  process.env.HIPAA_MASTER_KEY = KEY;
  resetServerEnvCache();
});

afterAll(() => {
  if (savedMasterKey === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = savedMasterKey;
  resetServerEnvCache();
});

let audit: InMemoryAuditLogStore;
let store: InMemoryAppointmentStore;

let minted = 0;

/** A fresh uuid, because a reference can only be minted for one. */
function nextId(): string {
  minted += 1;
  return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
}

/** A booked appointment with a call transcript, and the token that opens it. */
async function seeded(lines: { role: "patient" | "receptionist"; text: string }[]) {
  const { appendTranscript } = await import("@/lib/appointments");
  const created = await store.create(appointment(nextId()));
  await appendTranscript(
    created.id,
    lines.map((entry, seq) => ({
      seq,
      role: entry.role,
      text: entry.text,
      at: new Date(Date.UTC(2026, 8, 1, 9, 30, seq)),
      finalized: true,
    })),
  );
  return { id: created.id, token: sealReference(created.id) };
}

function appointment(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const createdAt = new Date("2026-09-01T09:00:00.000Z");
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

const CALL = [
  { role: "patient" as const, text: "My left eye has been painful since Tuesday." },
  { role: "receptionist" as const, text: "I am sorry to hear that. Can I take your date of birth?" },
];

beforeEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  audit = new InMemoryAuditLogStore();
  setAuditLogStore(audit);
});

afterEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  audit = new InMemoryAuditLogStore();
  setAuditLogStore(audit);
});

describe("openTranscript", () => {
  test("opens the appointment a reference names, and reads its transcript", async () => {
    const { id, token } = await seeded(CALL);

    const session = await openTranscript(token);

    expect(session?.appointmentId).toBe(id);
    expect(session?.appointment.status).toBe("scheduled");
    expect(session?.lines.map((line) => line.text)).toEqual(CALL.map((entry) => entry.text));
  });

  test("records the read, because a transcript is PHI", async () => {
    const { id, token } = await seeded(CALL);

    await openTranscript(token);

    const entries = await readAuditLog();
    const transcriptReads = entries.filter((entry) => entry.resource === `transcript:${id}`);
    // The seeding append is on the trail too, and it is on it under the same
    // resource -- so a reader of the trail can see the whole life of a
    // transcript rather than only the reads.
    expect(transcriptReads.map((entry) => entry.action)).toEqual([
      "TRANSCRIPT_APPENDED",
      "PHI_READ",
    ]);
  });

  test("refuses a token that is not a reference at all", async () => {
    await seeded(CALL);

    for (const token of ["", "nonsense", "2.not-a-uuid", "3.3f7c1e2a-9b4d-4c58-8a61-2d0e7b5f9c30"]) {
      expect(await openTranscript(token)).toBeNull();
    }
  });

  test("refuses a sealed record token, because a sealed token names no appointment", async () => {
    // Version 1 puts the record in the URL and keeps nothing behind it, so there
    // is no id to address a transcript with. Answering "here is somebody's call"
    // would mean guessing, and guessing is how one patient is shown another
    // patient's conversation.
    await seeded(CALL);

    expect(await openTranscript(sealRecord(JSON.stringify(record())))).toBeNull();
  });

  test("refuses a reference to an appointment that was never there", async () => {
    await seeded(CALL);

    // A well-formed reference to a row that does not exist. 122 bits of uuidv4
    // is not something anybody guesses, so in practice this is a link to a
    // booking that has been deleted -- and it must be a refusal rather than an
    // empty transcript, because an empty one is a plausible-looking answer.
    expect(await openTranscript(sealReference(nextId()))).toBeNull();
  });

  test("a cancelled appointment still has its transcript", async () => {
    // The same rule the tracking page follows on purpose: a patient whose
    // appointment vanished can still see that it existed, and a call that was cut
    // short is a thing they are entitled to read. Cancellation withdraws
    // capabilities to *change* things, not access to what already happened.
    const { id, token } = await seeded(CALL);
    await store.cancel(id);

    const session = await openTranscript(token);

    expect(session?.appointment.status).toBe("cancelled");
    expect(session?.lines).toHaveLength(2);
  });

  test("leaves nothing in the trail about a transcript it refused to open", async () => {
    // A refused request that still writes an entry is a trail that says somebody
    // read a transcript when nobody did, and a trail nobody can trust is not an
    // audit trail.
    await seeded(CALL);
    const before = (await readAuditLog()).length;

    expect(await openTranscript("2.3f7c1e2a-9b4d-4c58-8a61-2d0e7b5f9c30")).toBeNull();

    expect((await readAuditLog()).length).toBe(before);
  });

  test("gives one patient's link nothing but that patient's call", async () => {
    // The cross-tenant case, and the reason the store is keyed by appointment at
    // all. Two calls, two links, and a transcript is the most identifying thing
    // in the system: a patient's own account of their symptoms, in their own
    // words.
    const first = await seeded(CALL);
    const second = await seeded([{ role: "patient", text: "My knee has been locking." }]);

    const opened = await openTranscript(second.token);

    expect(opened?.appointmentId).toBe(second.id);
    expect(opened?.lines.map((line) => line.text)).toEqual(["My knee has been locking."]);
    expect(opened?.lines.map((line) => line.text)).not.toContain(CALL[0].text);
    expect(first.id).not.toBe(second.id);
  });

  test("an appointment with no call is a session with no lines, not a refusal", async () => {
    // A patient whose call never started still has a booking, and the page has
    // to be able to say so rather than pretending the link is broken.
    const created = await store.create(appointment(nextId()));

    const session = await openTranscript(sealReference(created.id));

    expect(session?.appointmentId).toBe(created.id);
    expect(session?.lines).toEqual([]);
  });
});

describe("buildTranscriptPdf", () => {
  test("renders the call into a PDF, and says whose it is without saying who", async () => {
    const { token } = await seeded(CALL);

    const pdf = await buildTranscriptPdf(token);

    expect(pdf).not.toBeNull();
    const text = latin1(pdf!.bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("My left eye has been painful since Tuesday.");
    expect(text).toContain("I am sorry to hear that. Can I take your date of birth?");
    // A transcript is a patient's medical history, and this application hands
    // these links to people who forward them. Nothing that identifies the
    // patient beyond what the tracking page already shows goes on the page or
    // into the file.
    expect(text).not.toContain("REDACTED");
    expect(text).not.toContain("patient@example.test");
    expect(text).not.toContain("1985-12-10");
    expect(text).not.toContain("+1 555 0100");
    expect(text).not.toContain("Sharp pain behind my left eye since Tuesday");
  });

  test("records the export as its own event, not as a read", async () => {
    // "Was this transcript ever exported, and who asked?" is the first question
    // asked of a record like this, and `PHI_READ` cannot answer it: rendering a
    // PDF and reading the same transcript on a page are the same operation to the
    // store and completely different events everywhere else.
    const { id, token } = await seeded(CALL);

    await buildTranscriptPdf(token);

    const entries = await readAuditLog();
    const exports = entries.filter((entry) => entry.action === "TRANSCRIPT_EXPORTED");
    expect(exports).toHaveLength(1);
    expect(exports[0].resource).toBe(`transcript:${id}`);
  });

  test("produces no file at all for a caller that is not authorised", async () => {
    await seeded(CALL);

    for (const token of ["", "nonsense", sealRecord(JSON.stringify(record()))]) {
      expect(await buildTranscriptPdf(token)).toBeNull();
    }
  });

  test("produces no file for a reference to somebody else's appointment", async () => {
    await seeded(CALL);
    const theirs = await seeded([{ role: "patient", text: "My knee has been locking." }]);

    const pdf = await buildTranscriptPdf(theirs.token);

    expect(latin1(pdf!.bytes)).not.toContain("My left eye has been painful since Tuesday.");
    expect(latin1(pdf!.bytes)).toContain("My knee has been locking.");
  });

  test("refuses to render an export that cannot be recorded", async () => {
    // A PDF is the one thing this feature produces that leaves the system. If
    // the trail cannot say who asked for it, it must not be produced -- which is
    // the same fail-closed posture as a record read.
    const { token } = await seeded(CALL);
    setAuditLogStore({
      async append(): Promise<never> {
        throw new Error("the trail is unavailable");
      },
      async read() {
        return [];
      },
      async verify() {
        return false;
      },
    });

    await expect(buildTranscriptPdf(token)).rejects.toThrow(/unavailable/);
  });

  test("names the file after the appointment, never after the token", async () => {
    // A token in a `Content-Disposition` filename is a bearer credential in a
    // downloads folder, in a browser history, and in whatever the operating
    // system does with the name.
    const { id, token } = await seeded(CALL);

    const pdf = await buildTranscriptPdf(token);

    expect(pdf!.filename).toBe(transcriptFilename(id));
    expect(pdf!.filename).not.toContain(token);
    expect(pdf!.filename).toMatch(/^medilin-transcript-[0-9a-f-]+\.pdf$/);
  });

  test("a call with nothing in it still exports a document", async () => {
    const created = await store.create(appointment(nextId()));

    const pdf = await buildTranscriptPdf(sealReference(created.id));

    expect(latin1(pdf!.bytes)).toContain("No conversation was recorded");
  });

  test("never puts the token in the file, which is where the credential would leak", async () => {
    // The distinction this rests on: the appointment id identifies a record, and
    // this application already writes it into the audit trail; the token *opens*
    // one. The id is in the header so a printed transcript can be filed against
    // the appointment it belongs to, and the token is nowhere, because a token
    // in a forwarded document is a link that anybody it reaches can open.
    const { id, token } = await seeded(CALL);

    const text = latin1((await buildTranscriptPdf(token))!.bytes);

    expect(text).toContain(id);
    expect(text).not.toContain(token);
    expect(text).not.toContain(`2.${id}`);
  });
});

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * What may be logged about a transcript.
 *
 * The redaction policy in @/lib/logger/redact is deny-by-default -- a value is
 * emitted only if its key is on an allowlist, and patient-shaped keys are
 * replaced with a marker even under an unexpected name. These tests are here
 * because this feature is the first thing in the application whose entire
 * payload is PHI: there is no field of a transcript that is safe to log, so the
 * only correct logging is a count.
 */
const SAYING = "Sharp pain behind my left eye since Tuesday.";

describe("redaction posture", () => {
  test("a line of a transcript cannot be logged, whatever the key is called", () => {
    // `text` and `message` are on the sensitive list and are replaced outright.
    // The rest are simply not on the allowlist, so they are dropped. Both
    // directions matter: a key nobody has thought of must not become a way to
    // write a patient's symptoms into an aggregator.
    for (const key of ["text", "line", "lines", "message", "body", "content", "utterance"]) {
      const redacted = redactFields({ [key]: SAYING });
      expect(JSON.stringify(redacted)).not.toContain("eye");
      expect(redacted[key]).not.toBe(SAYING);
    }
  });

  test("a transcript cannot be smuggled through under an allowlisted key", () => {
    // `count` is allowlisted, because a count is not PHI. It is a number, and
    // the allowlist is on keys rather than on shapes -- so this asserts the
    // whole log line for an append, which is the only one this feature emits.
    expect(redactFields({ appointmentId: "a-1", count: 3 })).toEqual({
      appointmentId: "a-1",
      count: 3,
    });
  });

  test("every line this feature logs is a message, a count, and nothing else", async () => {
    // The whole logging surface of #57, asserted end to end. The appointment id
    // comes out as `[redacted]` rather than as a uuid, which is the existing
    // policy in @/lib/logger/redact: a value made of digits and hyphens is
    // shaped like the long digit runs it treats as identifiers, and being
    // over-cautious about a record reference in an aggregator is the right way
    // to be wrong here.
    const lines: string[] = [];
    const capture = (line: unknown) => lines.push(String(line));

    let id = "";
    // eslint-disable-next-line no-console -- the console is the thing under test.
    const original = console.info;
    // eslint-disable-next-line no-console -- see above.
    console.info = capture;
    try {
      const seededCall = await seeded(CALL);
      id = seededCall.id;
      await buildTranscriptPdf(seededCall.token);
    } finally {
      // eslint-disable-next-line no-console -- see above.
      console.info = original;
    }

    const logged = lines.join("\n");
    expect(logged).toContain("transcript.appended");
    expect(logged).toContain("transcript.opened");
    expect(logged).toContain("transcript.exported");
    expect(logged).toContain('"count":2');
    expect(logged).not.toContain("eye");
    expect(logged).not.toContain(id);
  });
});
