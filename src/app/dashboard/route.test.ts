import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetServerEnvCache } from "@/lib/env";
import { INTERNAL_SECRET_HEADER } from "@/lib/auth/internal";
import { InMemoryAppointmentStore, getAppointmentStore, setAppointmentStore } from "@/lib/appointments";
import type { Appointment, AppointmentStore } from "@/lib/appointments/store";
import { InMemoryAuditLogStore, readAuditLog, setAuditLogStore } from "@/lib/audit";
import type { AppointmentRecord } from "@/lib/validation/intake";
import { GET } from "./route";

/**
 * The clinic dashboard route (#63).
 *
 * The whole of this feature's security is in this file, so most of what is
 * asserted here is the boundary rather than the feature:
 *
 *   - it is refused without the internal secret, and refused before it opens a
 *     single record,
 *   - the secret is never in the response, the markup, or a link,
 *   - and the intake details it *does* show -- the symptoms, the date of birth,
 *     the contact details -- are shown on a surface no patient can be handed.
 *
 * The last one is a property of the route, not of a comment: the page it renders
 * is the wide one, and the only thing standing between it and a forwarded link is
 * the header this handler insists on. Which is also why the shared secret is a
 * real limitation rather than a shortcut, and the PR body says so in as many
 * words.
 */

const SECRET = "s".repeat(32);

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  INTERNAL_API_SECRET: SECRET,
  CLINIC_NAME: "City Medical Center",
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

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

/** n appointments, a minute apart, all in the future relative to `now`. */
async function book(count: number, overrides: (index: number) => Partial<AppointmentRecord> = () => ({})) {
  const store = new InMemoryAppointmentStore();
  setAppointmentStore(store);

  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 8, 1, 9, index));
    const appointment: Appointment = {
      id: `a${String(index).padStart(2, "0")}`,
      patientInfo: record({
        appointmentDateTime: `2026-10-${String(index + 1).padStart(2, "0")}T09:00`,
        ...overrides(index),
      }),
      createdAt,
      updatedAt: createdAt,
      conversationEnded: false,
      status: "scheduled",
    };
    await store.create(appointment);
  }
  return store;
}

function request(query = "", secret: string | null = SECRET): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers[INTERNAL_SECRET_HEADER] = secret;
  return new Request(`https://clinic.example/dashboard${query}`, { headers });
}

beforeEach(() => {
  setAuditLogStore(new InMemoryAuditLogStore());
});

afterEach(() => {
  setAppointmentStore(null);
  setAuditLogStore(new InMemoryAuditLogStore());
});

afterAll(() => {
  resetServerEnvCache();
});

describe("the gate", () => {
  test("refuses a request with no secret", async () => {
    await book(1);
    const response = await GET(request("", null));

    expect(response.status).toBe(401);
  });

  test("refuses a wrong secret, and a prefix of the right one", async () => {
    await book(1);

    expect((await GET(request("", "x".repeat(32)))).status).toBe(401);
    expect((await GET(request("", SECRET.slice(0, -1)))).status).toBe(401);
  });

  test("opens no records at all for a request it is going to refuse", async () => {
    // Ordering, and it is the point of the whole test: the check is in front of
    // the query, so a wrong guess costs nothing and tells an attacker nothing
    // about whether the clinic has bookings.
    await book(3);
    let opened = 0;
    setAppointmentStore({
      ...getAppointmentStore(),
      listPage: async (...args: Parameters<AppointmentStore["listPage"]>) => {
        opened += 1;
        return getAppointmentStore().listPage(...args);
      },
    } as never);

    const response = await GET(request("", null));

    expect(response.status).toBe(401);
    expect(opened).toBe(0);
  });

  test("says nothing about the clinic in a refusal", async () => {
    await book(1, () => ({ firstName: "Ada", additionalInfo: "Sharp pain behind my left eye" }));

    const body = await (await GET(request("", null))).text();

    expect(body).not.toContain("Sharp pain");
    expect(body).not.toContain("Ada");
    expect(body).not.toContain(SECRET);
  });

  test("a refusal is not cached, and neither is a page", async () => {
    await book(1);
    const refused = await GET(request("", null));
    const allowed = await GET(request());

    expect(refused.headers.get("cache-control")).toContain("no-store");
    expect(allowed.headers.get("cache-control")).toContain("no-store");
  });
});

describe("what a clinician is shown", () => {
  test("the intake details needed to run the appointment", async () => {
    await book(1, () => ({
      firstName: "Ada",
      lastName: "Lovelace",
      dob: "1985-12-10",
      email: "ada@example.test",
      phone: "+44 20 7946 0100",
      insurance: "no",
      additionalInfo: "Sharp pain behind my left eye since Tuesday",
      medical_department: "Eye Doctor",
      language: "spanish",
    }));

    const body = await (await GET(request())).text();

    expect(body).toContain("Ada Lovelace");
    expect(body).toContain("1985-12-10");
    expect(body).toContain("ada@example.test");
    expect(body).toContain("+44 20 7946 0100");
    expect(body).toContain("Sharp pain behind my left eye since Tuesday");
    expect(body).toContain("Eye Doctor");
    // The language is an interpreter instruction, not a preference.
    expect(body).toContain("spanish");
  });

  test("the requested time, spelled out, and the status", async () => {
    await book(1);
    const body = await (await GET(request())).text();

    expect(body).toContain("Thursday 1 October 2026");
    expect(body).toContain("09:00");
    expect(body).toContain("scheduled");
  });

  test("the rest of the household, because a clinician runs the booking", async () => {
    await book(1, () => ({
      dependents: [
        {
          firstName: "Maya",
          dob: "2016-04-02",
          relationship: "child",
          additionalInfo: "Cough at night",
        },
      ],
    }));

    const body = await (await GET(request())).text();

    expect(body).toContain("Maya");
    expect(body).toContain("2016-04-02");
    expect(body).toContain("child");
    expect(body).toContain("Cough at night");
  });

  test("never offers a cancelled or completed appointment", async () => {
    const store = await book(3);
    const [first, second] = await store.listByStatus(["scheduled"], 10);
    await store.cancel(first!.id);
    await store.update(second!.id, { status: "completed" });

    const body = await (await GET(request())).text();

    expect(body).toContain('data-appointment="a02"');
    expect(body).not.toContain('data-appointment="a00"');
    expect(body).not.toContain('data-appointment="a01"');
  });

  test("says so when the clinic has no live appointments", async () => {
    await book(0);
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No live appointments");
  });

  test("marks an appointment whose requested time has passed", async () => {
    // A record booked for a moment that has already gone by is the work most
    // likely to be missed, and the row says which one it is rather than leaving
    // the reader to compare clocks.
    await book(1, () => ({ appointmentDateTime: "2020-01-01T08:00" }));

    expect(await (await GET(request())).text()).toContain("requested time has passed");
  });
});

describe("the secret", () => {
  test("is nowhere in the response, including in every link on the page", async () => {
    // A shared secret that reaches a URL is a shared secret in every access log,
    // browser history and Referer header on the path -- which is the reason this
    // is a route handler behind a header and not a page behind a query string.
    await book(30);

    const body = await (await GET(request())).text();

    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("x-internal-secret");
    for (const href of body.match(/href="[^"]*"/g) ?? []) {
      expect(href).not.toContain(SECRET);
    }
  });

  test("is not reflected anywhere in a refusal either", async () => {
    const body = await (await GET(request("", SECRET.slice(0, 4)))).text();
    expect(body).not.toContain(SECRET.slice(0, 4));
  });
});

describe("a hostile record", () => {
  test("is escaped, in every field that takes patient text", async () => {
    // The names, the reason and the household are free text written by whoever
    // made the booking, and this is a page rendered as HTML. Nothing here may
    // reach the markup unescaped.
    await book(1, () => ({
      firstName: '<script>alert("first")</script>',
      lastName: '"><img src=x onerror=alert(1)>',
      additionalInfo: "</script><script>alert('reason')</script>",
      dependents: [
        {
          firstName: "<b>Maya</b>",
          dob: "2016-04-02",
          relationship: "child",
          additionalInfo: "<i>cough</i>",
        },
      ],
    }));

    const body = await (await GET(request())).text();

    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("<b>Maya</b>");
    expect(body).not.toContain("<i>cough</i>");
    // Escaped, not dropped: the clinician still reads what the patient said.
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;b&gt;Maya&lt;/b&gt;");
  });

  test("cannot get out through a record whose time is a tag", async () => {
    await book(1, () => ({ appointmentDateTime: "2026-10-01T09:30\"><script>alert(1)</script>" }));

    const body = await (await GET(request())).text();

    expect(body).not.toContain("<script>alert(1)");
  });
});

describe("paging", () => {
  test("a clinic with more appointments than a page is paged, not truncated", async () => {
    await book(25);
    const first = await (await GET(request())).text();

    // The first page is bounded -- this is the property that makes the route safe
    // to point at a real clinic's data.
    expect((first.match(/data-appointment="/g) ?? []).length).toBe(20);
    expect(first).toContain("Next");
    expect(first).toContain("more bookings");
  });

  test("the next page continues where the last one stopped", async () => {
    await book(25);

    const first = await (await GET(request())).text();
    const firstIds = [...first.matchAll(/data-appointment="(a\d\d)"/g)].map((match) => match[1]);

    // The next link is an offset in the URL and nothing else: no secret, no
    // token, nothing a caller has to hold on to to ask for the page after this.
    expect(first).toContain('href="/dashboard?offset=20"');

    const second = await (await GET(request("?offset=20"))).text();
    const secondIds = [...second.matchAll(/data-appointment="(a\d\d)"/g)].map((match) => match[1]);

    expect(firstIds).toHaveLength(20);
    expect(secondIds).toHaveLength(5);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  test("the last page offers no next page", async () => {
    await book(3);
    const body = await (await GET(request())).text();

    expect(body).not.toContain("Next");
    expect(body).toContain("Previous");
  });

  test("an offset that is not a page number is refused, not guessed at", async () => {
    await book(3);

    const response = await GET(request("?offset=soon"));

    expect(response.status).toBe(400);
  });

  test("a hostile offset is not reflected into the page", async () => {
    await book(3);

    const response = await GET(request(`?offset=${encodeURIComponent('20"><script>alert(1)')}`));
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("<script>alert(1)");
  });

  test("a negative offset is refused", async () => {
    await book(3);
    expect((await GET(request("?offset=-1"))).status).toBe(400);
  });
});

describe("the trail", () => {
  test("records a dashboard read for every record on the page", async () => {
    await book(3);

    await GET(request());

    const reads = (await readAuditLog()).filter((e) => e.action === "CLINIC_SCHEDULE_READ");
    expect(reads).toHaveLength(3);
    expect(reads.every((e) => e.actor === "internal-api")).toBe(true);
  });

  test("no entry in it carries anything from the record", async () => {
    await book(1, () => ({
      firstName: "Ada",
      additionalInfo: "Sharp pain behind my left eye since Tuesday",
    }));

    await GET(request());

    const trail = JSON.stringify(await readAuditLog());
    expect(trail).not.toContain("Sharp pain");
    expect(trail).not.toContain("Ada");
  });

  test("hands back no records when the trail cannot be written", async () => {
    await book(2, () => ({ firstName: "Ada", additionalInfo: "Sharp pain" }));
    setAuditLogStore({
      async append() {
        throw new Error("the audit store is down");
      },
      async read() {
        return [];
      },
      async verify() {
        return false;
      },
    });

    const response = await GET(request());
    const body = await response.text();

    // A bulk read that cannot be logged is a bulk read that does not happen. The
    // error page is generic for the same reason the summary route's is: a vendor
    // or driver message can quote what was being read.
    expect(response.status).toBe(500);
    expect(body).not.toContain("Sharp pain");
    expect(body).not.toContain("Ada");
  });
});
