import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { appendTranscript, InMemoryAppointmentStore, setAppointmentStore } from "@/lib/appointments";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { sealRecord, sealReference } from "@/lib/phi-token";
import { getRateLimitStore } from "@/lib/rate-limit";
import type { AppointmentRecord } from "@/lib/validation/intake";
import { GET } from "./route";

/**
 * GET /api/transcript/[token]/pdf -- the one surface in this application that
 * hands a patient's conversation to something outside it.
 *
 * Everything below is about the boundary, and the two halves are the two ways
 * this can go wrong. Either an unauthorised caller gets a PDF of somebody's
 * medical history, or a legitimate export happens with nothing in the trail to
 * say who asked. Both are reportable, and neither is caught by a test that only
 * checks the happy path returns bytes.
 *
 * The 404s are all the same 404 on purpose. A token that is malformed, one that
 * was sealed under a different key, one naming an appointment that has been
 * deleted, and one that was never a token at all are one answer to a caller, and
 * the difference between them is a free oracle for whoever is guessing.
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

const SAYING = "Sharp pain behind my left eye since Tuesday, worse in the mornings.";

let store: InMemoryAppointmentStore;
let minted = 0;

function nextId(): string {
  minted += 1;
  return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
}

async function booked(lines: { role: "patient" | "receptionist"; text: string }[]) {
  const now = new Date();
  const created = await store.create({
    id: nextId(),
    patientInfo: record(),
    createdAt: now,
    updatedAt: now,
    conversationEnded: false,
    status: "scheduled",
  });

  await appendTranscript(
    created.id,
    lines.map((entry, seq) => ({
      seq,
      role: entry.role,
      text: entry.text,
      at: new Date(now.getTime() + seq * 1000),
      finalized: true,
    })),
  );

  return sealReference(created.id);
}

beforeEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  setAuditLogStore(new InMemoryAuditLogStore());
  getRateLimitStore().reset();
});

afterEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  getRateLimitStore().reset();
});

function request(token: string, address = ADDRESS): NextRequest {
  return new NextRequest(`https://clinic.example/api/transcript/${token}/pdf`, {
    headers: { "x-forwarded-for": address },
  });
}

async function body(response: Response): Promise<string> {
  return new Uint8Array(await response.arrayBuffer()).reduce(
    (out, byte) => out + String.fromCharCode(byte),
    "",
  );
}

describe("GET /api/transcript/[token]/pdf", () => {
  test("answers an authorised caller with a PDF of the call", async () => {
    const token = await booked([
      { role: "patient", text: SAYING },
      { role: "receptionist", text: "I am sorry to hear that. Can I take your date of birth?" },
    ]);

    const response = await GET(request(token), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const text = await body(response);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain(SAYING);
  });

  test("offers it as a download, and never lets it be cached", async () => {
    // A transcript is PHI and a PDF is the artefact most likely to be kept, so
    // the headers are the control: an attachment rather than something a browser
    // renders inline, and no store on any machine on the path.
    const token = await booked([{ role: "patient", text: SAYING }]);

    const response = await GET(request(token), { params: Promise.resolve({ token }) });

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(".pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("the download name is the appointment, not the link", async () => {
    const token = await booked([{ role: "patient", text: SAYING }]);

    const response = await GET(request(token), { params: Promise.resolve({ token }) });

    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain(token);
    expect(disposition).not.toContain("2.");
  });

  test.each([
    ["no token at all", ""],
    ["a token that is not one", "nonsense"],
    ["a reference with no uuid", "2."],
    ["a reference to a booking that is not there", "2.00000000-0000-4000-8000-0000000000ff"],
  ])("answers 404 for %s, with no PDF in the body", async (_label, token) => {
    const response = await GET(request(token), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(404);
    const text = await body(response);
    expect(text).not.toContain("%PDF");
    expect(text).not.toContain(SAYING);
  });

  test("answers 404 for a sealed record token, which names no appointment", async () => {
    // A version 1 token is the record itself, sealed into the URL. There is no
    // id behind it, so there is nothing to address a transcript with, and the
    // honest answer is that the link does not open one.
    const token = sealRecord(JSON.stringify(record()));

    const response = await GET(request(token), { params: Promise.resolve({ token }) });

    expect(response.status).toBe(404);
  });

  test("one patient's link cannot fetch another patient's transcript", async () => {
    const theirs = await booked([{ role: "patient", text: "My knee has been locking for weeks." }]);
    await booked([{ role: "patient", text: SAYING }]);

    const response = await GET(request(theirs), { params: Promise.resolve({ token: theirs }) });

    expect(response.status).toBe(200);
    const text = await body(response);
    expect(text).toContain("My knee has been locking for weeks.");
    expect(text).not.toContain(SAYING);
  });

  test("a rate-limited caller gets a 429 rather than an unbounded export", async () => {
    const token = await booked([{ role: "patient", text: SAYING }]);
    const params = Promise.resolve({ token });

    let limited: Response | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await GET(request(token), { params });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited!.status).toBe(429);
  });

  test("the limiter is per caller, so one address cannot exhaust another's", async () => {
    const token = await booked([{ role: "patient", text: SAYING }]);
    const params = Promise.resolve({ token });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await GET(request(token, "203.0.113.7"), { params });
    }
    const other = await GET(request(token, "198.51.100.9"), { params });

    expect(other.status).toBe(200);
  });
});
