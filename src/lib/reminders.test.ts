import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryAppointmentStore,
  createAppointment,
  setAppointmentStore,
  updateAppointment,
} from "@/lib/appointments";
import { InMemoryAuditLogStore, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import type { AppointmentRecord } from "@/lib/validation/intake";
import {
  LOOKAHEAD_MS,
  LOOKBEHIND_MS,
  isDue,
  reminderText,
  reminderWindow,
  runReminderPass,
  slotToInstant,
} from "./reminders";

/**
 * The reminder pass (#67).
 *
 * The subject of most of this file is not "does it send an email" -- it is what
 * happens when a run happens more than once, because that is the case that
 * actually occurs. A scheduler retries, a deploy lands mid-run, a platform
 * double-fires, and a window is wide enough to be picked up by two consecutive
 * runs on purpose. Every one of those must produce one email.
 *
 * The two network calls are stubbed; the store, the sealing and the claim ledger
 * are real, because they are the parts that decide whether anything is sent twice.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
  CLINIC_NAME: "Riverside Clinic",
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

/** 09:00 UTC, which is when vercel.json says the cron fires. */
const NINE_AM = Date.parse("2026-09-01T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

const realFetch = globalThis.fetch;
let emails: { to: string[]; subject: string; html: string }[] = [];
let prompts: string[] = [];
let resendStatus = 200;

beforeEach(() => {
  emails = [];
  prompts = [];
  resendStatus = 200;

  setAuditLogStore(new InMemoryAuditLogStore());
  setAppointmentStore(new InMemoryAppointmentStore());

  setLlmClient({
    async generateJson({ prompt }) {
      prompts.push(prompt);
      return { subject: "Your appointment is coming up", body: "<p>See you soon.</p>" };
    },
  });

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = new Request("https://api.resend.com/emails", init);
    const payload = (await request.json()) as { to: string[]; subject: string; html: string };
    emails.push(payload);

    return resendStatus === 200
      ? new Response(JSON.stringify({ id: "resend-1" }), { status: 200 })
      : new Response(JSON.stringify({ message: "not verified" }), { status: resendStatus });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
});

afterAll(() => {
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
    appointmentDateTime: "2026-09-01T10:00",
    medical_department: "Doctor",
    additionalInfo: "chest pain since Tuesday",
    language: "english",
    ...overrides,
  };
}

/** An appointment `hours` away from `now`, in the record's own local format. */
async function inHours(hours: number, now = NINE_AM, overrides: Partial<AppointmentRecord> = {}) {
  const at = new Date(now + hours * 3_600_000);
  const slot =
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-` +
    `${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:` +
    `${String(at.getMinutes()).padStart(2, "0")}`;

  return createAppointment(record({ appointmentDateTime: slot, ...overrides }));
}

/**
 * The interval a cron expression fires at.
 *
 * Only the two forms this project uses, and it *throws* on anything else rather
 * than guessing -- because a guess here would let the schedule and the look-ahead
 * window drift apart silently, and the symptom of that is not a failing test, it
 * is reminders that quietly stop going out.
 */
function cronIntervalMs(expression: string): number {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/);

  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    throw new Error(`Unsupported cron schedule: ${expression}`);
  }
  if (hour === "*") return 3_600_000;
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) return DAY_MS;

  throw new Error(`Unsupported cron schedule: ${expression}`);
}

describe("the schedule and the window agree", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
  ) as { crons: { path: string; schedule: string }[] };

  test("there is a schedule, and it points at the route that exists", () => {
    expect(config.crons).toHaveLength(1);
    expect(config.crons[0].path).toBe("/api/cron/reminders");
  });

  test("the look-ahead is wider than the interval, or a missed run drops reminders forever", () => {
    // The whole reason LOOKAHEAD_MS is two days. With a window equal to the
    // interval, an appointment is inside one run's window and outside every later
    // one, so a single missed run loses it permanently rather than delaying it.
    const interval = cronIntervalMs(config.crons[0].schedule);

    expect(LOOKAHEAD_MS).toBeGreaterThan(interval);
    expect(reminderWindow(NINE_AM).to - NINE_AM).toBeGreaterThan(interval);
  });
});

describe("slotToInstant", () => {  test("reads the record's wall-clock time the way the rest of the app does", () => {
    // Built in the server's own zone, which is what `negotiateAppointmentTime`
    // parses with and what `formatRequestedAt` renders with. Reading it in UTC
    // instead would shift every reminder by the server's offset.
    expect(slotToInstant("2026-09-01T10:00")).toBe(new Date(2026, 8, 1, 10, 0).getTime());
  });

  test.each([
    ["an empty string", ""],
    ["a date with no time", "2026-09-01"],
    ["an instant with a zone", "2026-09-01T10:00Z"],
    ["nonsense", "tomorrow"],
    ["a time with seconds", "2026-09-01T10:00:00"],
  ])("returns null for %s rather than guessing", (_label, slot) => {
    // The tracking page refuses a zoneless-looking value for the same reason: a
    // value carrying a zone is exactly the value a job must not reinterpret.
    expect(slotToInstant(slot)).toBeNull();
  });
});

describe("reminderWindow", () => {
  test("looks ahead twice the schedule interval, and that is the whole point", () => {
    // With a 24-hour window on a 24-hour cron, an appointment at 10:00 tomorrow
    // is inside today's window and outside tomorrow's -- so one missed run drops
    // that reminder permanently rather than delaying it. See the header.
    expect(LOOKAHEAD_MS).toBe(2 * DAY_MS);
    expect(reminderWindow(NINE_AM).to - NINE_AM).toBe(LOOKAHEAD_MS);
  });

  test("has a small lookbehind, so a run that fires late still catches its hour", () => {
    // Half-open and negative: the appointment at the moment the run starts is
    // inside it, and it is bounded so that a run at 09:00 does not remind
    // somebody about something that was yesterday.
    expect(LOOKBEHIND_MS).toBeLessThan(0);
    expect(reminderWindow(NINE_AM).from).toBe(NINE_AM + LOOKBEHIND_MS);
  });

  test("is half-open, so an appointment on the far edge is left to the next run", () => {
    // `to` is exclusive, which is what keeps consecutive runs from both claiming
    // the same appointment on the boundary -- though the claim is what actually
    // enforces that, and this is the belt to its braces.
    const window = reminderWindow(NINE_AM);

    expect(isDue(appointmentAt(window.to), window)).toBe(false);
    expect(isDue(appointmentAt(window.to - 60_000), window)).toBe(true);
    expect(isDue(appointmentAt(window.from), window)).toBe(true);
    expect(isDue(appointmentAt(window.from - 60_000), window)).toBe(false);
  });

  test("is named for the day the run started, so two runs a day apart differ", () => {
    expect(reminderWindow(NINE_AM).name).toBe("2026-09-01");
    expect(reminderWindow(NINE_AM + DAY_MS).name).toBe("2026-09-02");
    // And two runs on the same day agree without talking to each other, which is
    // the entire mechanism the double-fire defence rests on.
    expect(reminderWindow(NINE_AM + 3_600_000).name).toBe(reminderWindow(NINE_AM).name);
  });
});

/** A minimal appointment shape for the pure window checks. */
function appointmentAt(instant: number) {
  const date = new Date(instant);
  const slot =
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-` +
    `${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:` +
    `${String(date.getMinutes()).padStart(2, "0")}`;

  return {
    id: "a1",
    patientInfo: record({ appointmentDateTime: slot }),
    createdAt: new Date(instant),
    updatedAt: new Date(instant),
    conversationEnded: false,
    status: "scheduled" as const,
  };
}

describe("isDue", () => {
  const window = reminderWindow(NINE_AM);

  test("is true for an appointment inside the window", () => {
    expect(isDue(appointmentAt(NINE_AM + 3_600_000), window)).toBe(true);
  });

  test("is false for one beyond the look-ahead", () => {
    expect(isDue(appointmentAt(NINE_AM + LOOKAHEAD_MS + 60_000), window)).toBe(false);
  });

  test("is false for one already long past, rather than reminding about yesterday", () => {
    expect(isDue(appointmentAt(NINE_AM - DAY_MS), window)).toBe(false);
  });

  test("is false for a record whose time cannot be read", () => {
    const broken = appointmentAt(NINE_AM);
    broken.patientInfo.appointmentDateTime = "whenever";

    expect(isDue(broken, window)).toBe(false);
  });
});

describe("runReminderPass", () => {
  test("reminds an appointment inside the window and nobody else", async () => {
    await inHours(3);
    await inHours(70);
    await inHours(100);

    const summary = await runReminderPass({ now: NINE_AM });

    expect(summary.due).toBe(1);
    expect(summary.sent).toBe(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["patient@example.test"]);
  });

  test("reaches past the next run, so a missed run is recoverable", async () => {
    // 30 hours out is inside a 48-hour look-ahead, so the appointment at 15:00
    // today is seen both by today's run and by tomorrow's. Both claiming it is
    // correct; only one sending it is right.
    await inHours(30);

    const today = await runReminderPass({ now: NINE_AM });
    const tomorrow = await runReminderPass({ now: NINE_AM + DAY_MS });

    expect(today.due).toBe(1);
    expect(tomorrow.due).toBe(1);
    expect(today.sent + tomorrow.sent).toBe(1);
    expect(emails).toHaveLength(1);
  });

  test("never reminds a cancelled appointment", async () => {
    // The one thing a reminder job must never do. The exclusion is in the store
    // query, so this asserts the query rather than the filter.
    const cancelled = await inHours(3);
    await updateAppointment(cancelled.id, { status: "cancelled" });

    const summary = await runReminderPass({ now: NINE_AM });

    expect(summary.due).toBe(0);
    expect(emails).toEqual([]);
  });

  test("never reminds a completed appointment", async () => {
    const done = await inHours(3);
    await updateAppointment(done.id, { status: "completed" });

    expect((await runReminderPass({ now: NINE_AM })).sent).toBe(0);
    expect(emails).toEqual([]);
  });

  test("sends in the language the patient booked in", async () => {
    await inHours(3, NINE_AM, { language: "spanish", email: "ada@example.test" });

    await runReminderPass({ now: NINE_AM });

    expect(emails[0].to).toEqual(["ada@example.test"]);
    expect(prompts).toHaveLength(1);
  });

  test("does not put a symptom description in the reminder", async () => {
    await inHours(3, NINE_AM, { additionalInfo: "chest pain since Tuesday" });

    await runReminderPass({ now: NINE_AM });

    // A reminder is an email that will sit in an inbox for years.
    expect(JSON.stringify(prompts)).not.toContain("chest pain");
    expect(JSON.stringify(emails)).not.toContain("chest pain");
  });

  test("says the time that is on the record", async () => {
    await inHours(3);

    await runReminderPass({ now: NINE_AM });

    // The clinic moves times, and a patient told the wrong hour by a reminder is
    // worse off than one told nothing, so the time in the payload has to be the one
    // on the record rather than "tomorrow" or "in 24 hours".
    expect(prompts[0]).toContain("2026-09-01T12:00");
    expect(prompts[0]).toContain("Riverside Clinic");
  });

  test("reminderText is the same shape as every other message this clinic sends", () => {
    const payload = JSON.parse(reminderText(appointmentAt(NINE_AM + 3_600_000), "Riverside Clinic"));

    // One translator, one inbox, one thing this clinic knows how to render.
    expect(Object.keys(payload).sort()).toEqual([
      "appointmentDateTime",
      "confirmed",
      "hospitalName",
      "patientInfo",
      "referenceNumber",
      "reminder",
    ]);
    expect(payload.patientInfo.additionalInfo).toBe("");
  });

  describe("exactly once", () => {
    test("a second run on the same day sends nothing", async () => {
      // The scheduler retried, or the platform double-fired.
      await inHours(3);

      const first = await runReminderPass({ now: NINE_AM });
      const second = await runReminderPass({ now: NINE_AM });

      expect(first.sent).toBe(1);
      expect(second.sent).toBe(0);
      expect(second.skippedAlreadyClaimed).toBe(1);
      expect(emails).toHaveLength(1);
    });

    test("a run hours later the same day still sends nothing", async () => {
      // A redeploy at 14:00 that fires the schedule early, or a manual trigger.
      await inHours(3);

      await runReminderPass({ now: NINE_AM });
      await runReminderPass({ now: NINE_AM + 5 * 3_600_000 });

      expect(emails).toHaveLength(1);
    });

    test("two runs on different days do not double-send an overlapping appointment", async () => {
      // This is the overlap the wide window deliberately creates, and it is the
      // reason the claim exists. 15:00 today is inside today's 48-hour look-ahead
      // and inside tomorrow's too; both runs see it and exactly one sends.
      await inHours(30);

      const first = await runReminderPass({ now: NINE_AM });
      const second = await runReminderPass({ now: NINE_AM + DAY_MS });

      expect(first.sent).toBe(1);
      expect(second.due).toBe(1);
      expect(second.sent).toBe(0);
      expect(second.skippedAlreadyClaimed).toBe(1);
      expect(emails).toHaveLength(1);
    });

    test("two concurrent runs send one email between them", async () => {
      await inHours(3);

      const [a, b] = await Promise.all([
        runReminderPass({ now: NINE_AM }),
        runReminderPass({ now: NINE_AM }),
      ]);

      expect(a.sent + b.sent).toBe(1);
      expect(a.skippedAlreadyClaimed + b.skippedAlreadyClaimed).toBe(1);
      expect(emails).toHaveLength(1);
    });

    test("a missed run is covered by the next one", async () => {
      // The failure mode a narrow window has and a wide one does not: the
      // appointment is inside the next day's window, so it is not lost.
      await inHours(30); // 15:00 today -- inside tomorrow's 48-hour look-ahead

      expect((await runReminderPass({ now: NINE_AM + DAY_MS })).sent).toBe(1);
      expect(emails).toHaveLength(1);
    });

    test("the claim is keyed on the appointment, not on the window", async () => {
      // The subtle part, so it is asserted directly rather than left implied. A
      // key of `<id>:<window name>` would give the two overlapping runs two
      // different keys and both would send; one claim per appointment is what makes
      // the deliberate overlap safe.
      const store = new InMemoryAppointmentStore();
      const claimed: string[] = [];
      const inner = store.claimOnce.bind(store);
      store.claimOnce = async (scope, key) => {
        claimed.push(key);
        return inner(scope, key);
      };
      setAppointmentStore(store);

      await inHours(30);
      await runReminderPass({ now: NINE_AM });
      await runReminderPass({ now: NINE_AM + DAY_MS });

      // Two attempts, the same key, one win.
      expect(claimed).toHaveLength(2);
      expect(new Set(claimed).size).toBe(1);
      expect(claimed[0]).not.toContain("2026-09");
    });

    test("a rescheduled appointment is not reminded about twice", async () => {
      // The consequence of the per-appointment key, stated so it is a decision
      // rather than an accident. The reschedule already emailed the new time.
      const appointment = await inHours(30);
      await runReminderPass({ now: NINE_AM });

      await updateAppointment(appointment.id, { status: "confirmed" });
      const after = await runReminderPass({ now: NINE_AM + DAY_MS });

      expect(after.due).toBe(1);
      expect(after.sent).toBe(0);
      expect(after.skippedAlreadyClaimed).toBe(1);
      expect(emails).toHaveLength(1);
    });

    test("the claim is taken before the send, so a crash skips rather than repeats", async () => {
      // The direction to fail in for a courtesy email: one patient telephones, or
      // none do.
      await inHours(3);
      globalThis.fetch = (async () => {
        throw new Error("the network went away mid-run");
      }) as unknown as typeof fetch;

      const summary = await runReminderPass({ now: NINE_AM });

      expect(summary.sent).toBe(0);
      expect(summary.failed).toBe(1);
      // The claim is still spent, so a retry does not re-attempt the same patient
      // within this window.
      const retried = await runReminderPass({ now: NINE_AM });
      expect(retried.skippedAlreadyClaimed).toBe(1);
    });
  });

  describe("failures", () => {
    test("one bounced email does not stop the others", async () => {
      await inHours(2);
      await inHours(4, NINE_AM, { email: "second@example.test" });
      resendStatus = 422;

      const summary = await runReminderPass({ now: NINE_AM });

      expect(summary.due).toBe(2);
      expect(summary.attempted).toBe(2);
      expect(summary.failed).toBe(2);
      expect(summary.sent).toBe(0);
    });

    test("a store that is down fails the pass rather than reporting nothing to do", async () => {
      await inHours(3);
      const broken = new InMemoryAppointmentStore();
      broken.listByStatus = async () => {
        throw new Error("the database could not be reached");
      };
      setAppointmentStore(broken);

      await expect(runReminderPass({ now: NINE_AM })).rejects.toThrow(/could not be reached/);
      expect(emails).toEqual([]);
    });

    test("reports truncation rather than silently covering part of the clinic", async () => {
      const store = new InMemoryAppointmentStore();
      for (let index = 0; index < 505; index += 1) {
        await store.create({
          id: `a${index}`,
          patientInfo: record({ appointmentDateTime: "2026-09-01T12:00" }),
          createdAt: new Date(NINE_AM),
          updatedAt: new Date(NINE_AM),
          conversationEnded: false,
          status: "scheduled",
        });
      }
      setAppointmentStore(store);

      const summary = await runReminderPass({ now: NINE_AM });

      // A capped scan that looks like a complete one produces a job that quietly
      // stops reminding anybody past the cap, and the only symptom is silence.
      expect(summary.truncated).toBe(true);
      expect(summary.due).toBe(500);
    });
  });
});
