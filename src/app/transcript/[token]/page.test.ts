import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { appendTranscript, InMemoryAppointmentStore, setAppointmentStore } from "@/lib/appointments";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { sealRecord, sealReference } from "@/lib/phi-token";
import TranscriptPage from "./page";

/**
 * The replay page, rendered.
 *
 * The allowlist in ./replay is unit tested there, and this file renders the page
 * itself to check the thing an allowlist cannot: that the whole response for a
 * link that does not open contains nothing, and that the response for one that
 * does contains the call and none of the record around it.
 *
 * The 404 cases are asserted as "it threw the not-found signal", because that is
 * what `notFound()` does and what makes the request a 404 rather than a page
 * that renders an empty conversation. An empty transcript is a legitimate page
 * and a refused link is not, and a test that only checked the status code would
 * not tell the two apart.
 */

const KEY = "a".repeat(64);
const ADDRESS = "203.0.113.7";
const savedMasterKey = process.env.HIPAA_MASTER_KEY;

// The page reads the clinic name from the server environment, which validates
// every required variable. They are placeholders: this test is about who may read
// a transcript, not about what the clinic is called.
const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: KEY,
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  INTERNAL_API_SECRET: "s".repeat(32),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(BASELINE)) process.env[name] = value;
  resetServerEnvCache();
});

afterAll(() => {
  if (savedMasterKey === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = savedMasterKey;
  resetServerEnvCache();
});

const SAYING = "Sharp pain behind my left eye since Tuesday.";

let store: InMemoryAppointmentStore;
let minted = 0;

function nextId(): string {
  minted += 1;
  return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
}

async function booked(lines: { role: "patient" | "receptionist"; text: string }[]) {
  const now = new Date("2026-09-01T09:00:00.000Z");
  const created = await store.create({
    id: nextId(),
    patientInfo: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      dob: "1985-12-10",
      insurance: "yes",
      phone: "+1 555 0100",
      appointmentDateTime: "2026-10-01T09:30",
      medical_department: "Eye Doctor",
      additionalInfo: "Sharp pain behind my left eye since Tuesday, worse in the mornings",
      language: "english",
    },
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

  return { id: created.id, token: sealReference(created.id) };
}

/**
 * Next's `notFound()` throws a digest-tagged error rather than returning, so
 * "this link did not open" is observable as a throw and nothing else. A returned
 * promise that resolved would be a page that rendered.
 */
async function rendersNotFound(token: string): Promise<boolean> {
  try {
    await render(token);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "digest" in error &&
      String((error as { digest?: unknown }).digest ?? "").startsWith(
        "NEXT_HTTP_ERROR_FALLBACK",
      )
    );
  }
}

async function render(token: string): Promise<string> {
  const element = await TranscriptPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  store = new InMemoryAppointmentStore();
  setAppointmentStore(store);
  setAuditLogStore(new InMemoryAuditLogStore());
});

describe("the transcript replay page", () => {
  test("shows the call, who said each line, and when", async () => {
    const { token } = await booked([
      { role: "patient", text: SAYING },
      { role: "receptionist", text: "I am sorry to hear that. Can I take your date of birth?" },
    ]);

    const html = await render(token);

    expect(html).toContain(SAYING);
    expect(html).toContain("I am sorry to hear that. Can I take your date of birth?");
    expect(html).toContain("Patient");
    expect(html).toContain("Receptionist");
    // Timestamps are rendered in UTC and labelled, because this is a server
    // component and anything else is formatted in the timezone of whichever
    // instance answered.
    expect(html).toContain("UTC");
    expect(html).toContain('dateTime="2026-09-01T09:00:01.000Z"');
    expect(html).toContain("09:00:01 UTC");
  });

  test("carries the record's identity nowhere in the markup", async () => {
    // A transcript is forwarded, screenshotted, and opened on shared machines.
    // The conversation is the page; the name, the date of birth and the intake
    // notes have no business being on it.
    const { token } = await booked([{ role: "patient", text: SAYING }]);

    const html = await render(token);

    for (const leak of ["Ada", "Lovelace", "ada@example.test", "1985-12-10", "+1 555 0100", "worse in the mornings"]) {
      expect(html).not.toContain(leak);
    }
  });

  test("offers the PDF export, and points it at the same link", async () => {
    const { token } = await booked([{ role: "patient", text: SAYING }]);

    const html = await render(token);

    expect(html).toContain(`/api/transcript/${token}/pdf`);
    expect(html).toContain("Download as PDF");
  });

  test("says so plainly when a call was never recorded", async () => {
    const { id } = await booked([]);

    const html = await render(sealReference(id));

    expect(html).toContain("Nothing was recorded");
  });

  test.each([
    ["a token that is not one", "nonsense"],
    ["a reference with no uuid", "2."],
    ["a reference to a booking that is gone", "2.00000000-0000-4000-8000-0000000000ff"],
  ])("does not render a page for %s", async (_label, token) => {
    await booked([{ role: "patient", text: SAYING }]);

    expect(await rendersNotFound(token)).toBe(true);
  });

  test("does not render a page for a token sealed under another key", async () => {
    // A version 1 token is the record itself, sealed into the URL, with nothing
    // stored behind it. There is no id to address a transcript with, so the
    // honest answer is that this kind of link does not open one.
    await booked([{ role: "patient", text: SAYING }]);
    const token = sealRecord(JSON.stringify({ firstName: "Ada" }));

    expect(await rendersNotFound(token)).toBe(true);
  });

  test("one patient's link does not render another patient's call", async () => {
    const theirs = await booked([{ role: "patient", text: "My knee has been locking for weeks." }]);
    await booked([{ role: "patient", text: SAYING }]);

    const html = await render(theirs.token);

    expect(html).toContain("My knee has been locking for weeks.");
    expect(html).not.toContain(SAYING);
  });

  test("is never cached and never indexed", async () => {
    // Both are static exports rather than behaviour, and both are the reason the
    // URL is safe to put in an email: the URL is the credential.
    const { dynamic, revalidate, metadata } = await import("./page");

    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});
