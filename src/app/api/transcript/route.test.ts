import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { InMemoryAppointmentStore, setAppointmentStore } from "@/lib/appointments";
import { InMemoryAuditLogStore, readAuditLog, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { sealRecord, sealReference } from "@/lib/phi-token";
import { getRateLimitStore } from "@/lib/rate-limit";
import type { AppointmentRecord } from "@/lib/validation/intake";
import { POST } from "./route";

/**
 * POST /api/transcript -- the only writer of a patient's transcript.
 *
 * The browser is the only thing that has ever seen a call, so the browser is
 * what has to write it down, and that is the whole awkwardness of this endpoint:
 * a client is the least trustworthy party in the system and it is the only
 * witness to the event.
 *
 * So the tests below are about what that leaves the endpoint able to do. It can
 * add words to the transcript of the appointment its own token names, and it can
 * correct a line it has already sent. It cannot reach another appointment, it
 * cannot delete or reorder, it cannot put a role in that the application has not
 * heard of, and it cannot make the endpoint store a line with nothing in it. The
 * last one matters most: a transcript with a gap in it is a call that appears to
 * have gone differently than it did, and the cheapest way to get one is a client
 * that drops the line it could not deliver.
 */

const KEY = "a".repeat(64);
const ADDRESS = "203.0.113.7";
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

const SAYING = "Sharp pain behind my left eye since Tuesday.";
const AT = Date.UTC(2026, 8, 1, 9, 30, 0);

let store: InMemoryAppointmentStore;
let minted = 0;

function nextId(): string {
  minted += 1;
  return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
}

async function booked(overrides: Partial<AppointmentRecord> = {}): Promise<{ id: string; token: string }> {
  const now = new Date();
  const created = await store.create({
    id: nextId(),
    patientInfo: {
      firstName: "REDACTED",
      lastName: "REDACTED",
      email: "patient@example.test",
      dob: "1985-12-10",
      insurance: "yes",
      phone: "+1 555 0100",
      appointmentDateTime: "2026-10-01T09:30",
      medical_department: "Eye Doctor",
      additionalInfo: "",
      language: "english",
      ...overrides,
    },
    createdAt: now,
    updatedAt: now,
    conversationEnded: false,
    status: "scheduled",
  });
  return { id: created.id, token: sealReference(created.id) };
}

function entry(overrides: Record<string, unknown> = {}) {
  return { seq: 0, role: "patient", text: SAYING, at: AT, finalized: true, ...overrides };
}

function request(body: unknown, address = ADDRESS): NextRequest {
  return new NextRequest("https://clinic.example/api/transcript", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  setAuditLogStore(new InMemoryAuditLogStore());
  getRateLimitStore().reset();
});

afterEach(() => {
  getRateLimitStore().reset();
});

describe("POST /api/transcript", () => {
  test("stores the lines a call produced, and says how many", async () => {
    const { id, token } = await booked();

    const response = await POST(
      request({ token, entries: [entry(), entry({ seq: 1, role: "receptionist" })] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 2 });
    expect(await store.getTranscript(id)).toHaveLength(2);
  });

  test("keeps the order the conversation happened in, not the order it arrived", async () => {
    const { id, token } = await booked();

    await POST(request({ token, entries: [entry({ seq: 2, text: "third" })] }));
    await POST(request({ token, entries: [entry({ seq: 0, text: "first" })] }));
    await POST(request({ token, entries: [entry({ seq: 1, text: "second" })] }));

    expect((await store.getTranscript(id)).map((line) => line.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("a line sent again corrects itself rather than appearing twice", async () => {
    // The streaming case, and the reason the endpoint can be retried: a voice
    // agent sends an utterance as partial frames and then one final, and a
    // client whose response it never saw may send the same batch twice. Neither
    // may leave "how how how are you" in a patient's medical record.
    const { id, token } = await booked();

    await POST(request({ token, entries: [entry({ text: "how are", finalized: false })] }));
    const second = await POST(request({ token, entries: [entry({ text: "how are you today" })] }));

    expect(second.status).toBe(200);
    expect(await store.getTranscript(id)).toEqual([
      { seq: 0, role: "patient", text: "how are you today", at: new Date(AT), finalized: true },
    ]);
  });

  test("stores nothing for a token that names no appointment", async () => {
    // A version 1 token is the record sealed into the URL with nothing behind
    // it, so there is no id to write a transcript against. Answering "no" is the
    // honest thing; inventing a key would put a patient's words somewhere with
    // no record to delete them with.
    const token = sealRecord(JSON.stringify({ firstName: "REDACTED" }));

    const response = await POST(request({ token, entries: [entry()] }));

    expect(response.status).toBe(404);
    expect(store.transcriptCount).toBe(0);
  });

  test.each([
    ["a token that is not one", "nonsense"],
    ["a reference to a booking that is not there", "2.00000000-0000-4000-8000-0000000000ff"],
  ])("answers 404 for %s, and echoes nothing back", async (_label, token) => {
    const response = await POST(request({ token, entries: [entry()] }));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(token);
  });

  test("a token for one appointment cannot write into another's transcript", async () => {
    const theirs = await booked();
    const mine = await booked();

    await POST(request({ token: theirs.token, entries: [entry({ text: "not mine to write" })] }));

    expect((await store.getTranscript(mine.id)).length).toBe(0);
    expect((await store.getTranscript(theirs.id)).map((line) => line.text)).toEqual([
      "not mine to write",
    ]);
  });

  test.each([
    ["a role the application has not heard of", entry({ role: "operator" })],
    ["a negative position", entry({ seq: -1 })],
    ["a fractional position", entry({ seq: 1.5 })],
    ["a line with nothing in it", entry({ text: "" })],
    ["a line with no text at all", { ...entry(), text: undefined }],
    ["a timestamp that is not a number", entry({ at: "yesterday" })],
    ["an extra field on a line", entry({ patientName: "Ada" })],
  ])("refuses %s, and stores nothing", async (_label, bad) => {
    const { id, token } = await booked();

    const response = await POST(request({ token, entries: [entry(), bad] }));

    expect(response.status).toBe(400);
    // Half a call is not a call: the good line beside the bad one is not stored
    // either, or a patient is handed a transcript with a hole in it.
    expect(await store.getTranscript(id)).toEqual([]);
  });

  test.each([
    ["a body that is not JSON", "{"],
    ["no token", { entries: [entry()] }],
    ["an empty token", { token: "", entries: [entry()] }],
    ["no entries", { token: "2.x" }],
    ["an empty batch", { token: "2.x", entries: [] }],
    ["a field the schema does not have", { token: "2.x", entries: [entry()], replace: true }],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
  });

  test("refuses a batch larger than a call could plausibly produce", async () => {
    // The endpoint exists for a live call, and a live call produces tens of
    // lines. A batch of thousands is not a call that got long, it is somebody
    // using this as somewhere to put a body.
    const { token } = await booked();
    const entries = Array.from({ length: 500 }, (_unused, seq) => entry({ seq }));

    const response = await POST(request({ token, entries }));

    expect(response.status).toBe(400);
  });

  test("records the write in the trail, against the transcript and not the appointment", async () => {
    const { id, token } = await booked();

    await POST(request({ token, entries: [entry()] }));

    const entries = await readAuditLog();
    const appends = entries.filter((entry_) => entry_.action === "TRANSCRIPT_APPENDED");
    expect(appends).toHaveLength(1);
    expect(appends[0].resource).toBe(`transcript:${id}`);
  });

  test("writes nothing to the trail about a transcript it refused", async () => {
    await booked();

    await POST(request({ token: "nonsense", entries: [entry()] }));

    expect((await readAuditLog()).filter((entry) => entry.action === "TRANSCRIPT_APPENDED")).toEqual(
      [],
    );
  });

  test("the refusal body does not quote the line it refused", async () => {
    // A validation error that restates the value is a copy of a patient's own
    // words in a log aggregator, in a browser console, and in whatever the caller
    // does with the response.
    const { token } = await booked();

    const response = await POST(
      request({ token, entries: [entry({ role: "operator" })] }),
    );

    const text = await response.text();
    expect(text).not.toContain(SAYING);
    expect(text).not.toContain(token);
  });

  test("is metered, because it is an unbounded write into a patient's record", async () => {
    const { token } = await booked();

    let limited: Response | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await POST(request({ token, entries: [entry({ seq: attempt })] }));
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
  });
});
