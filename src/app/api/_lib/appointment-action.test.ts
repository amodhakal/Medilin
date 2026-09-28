import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryAppointmentStore,
  createAppointment,
  getAppointmentStore,
  issuePatientActions,
  setAppointmentStore,
} from "@/lib/appointments";
import { AUDIT_ACTORS, InMemoryAuditLogStore, readAuditLog, setAuditLogStore } from "@/lib/audit";
import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import type { AppointmentRecord } from "@/lib/validation/intake";
import {
  REFUSAL_MESSAGES,
  patientActionSchema,
  performPatientAction,
  toLocalSlot,
} from "./appointment-action";

/**
 * The patient-facing reschedule and cancel flow (#59).
 *
 * The two network calls are stubbed -- the model that translates the
 * confirmation, and Resend through the global fetch the SDK uses. Storage,
 * sealing, granting and the negotiation are real, because those are the parts a
 * clinic would be relying on.
 *
 * The negotiation is called with a fixed `random`, so the agreed time is a fact
 * in these assertions rather than a range. ./schedule is not modified and its
 * signature is not extended; the conflict machinery of #66 is being built against
 * the same function in another stack.
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

const NOW = Date.parse("2026-09-01T10:00:00.000Z");
/** Zero: the clinic agrees to exactly the slot asked for, so the tests can read. */
const NO_SHIFT = () => 0;

const patient: AppointmentRecord = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Doctor",
  additionalInfo: "headache",
  language: "spanish",
};

const realFetch = globalThis.fetch;
let emails: { to: string[]; subject: string; body: string }[] = [];
let resendStatus = 200;

beforeEach(() => {
  emails = [];
  resendStatus = 200;

  setAuditLogStore(new InMemoryAuditLogStore());
  setAppointmentStore(new InMemoryAppointmentStore());

  setLlmClient({
    async generateJson() {
      return { subject: "Su cita ha cambiado", body: "<p>Le esperamos el martes.</p>" };
    },
  });

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = new Request("https://api.resend.com/emails", init);
    const payload = (await request.json()) as { to: string[]; subject: string; html: string };
    emails.push({ to: payload.to, subject: payload.subject, body: payload.html });

    return resendStatus === 200
      ? new Response(JSON.stringify({ id: "resend-1" }), { status: 200 })
      : new Response(JSON.stringify({ message: "domain not verified" }), { status: resendStatus });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setLlmClient(null);
});

afterAll(() => {
  resetServerEnvCache();
});

/** A booked appointment with both of its management links. */
async function booked(overrides: Partial<AppointmentRecord> = {}) {
  const created = await createAppointment({ ...patient, ...overrides });
  const links = await issuePatientActions(created.id, { now: NOW });
  return { created, links };
}

describe("patientActionSchema", () => {
  test("accepts a reschedule with a slot", () => {
    const parsed = patientActionSchema.safeParse({
      token: "t",
      action: "reschedule",
      appointmentDateTime: "2026-10-02T14:00",
    });

    expect(parsed.success).toBe(true);
  });

  test("accepts a cancel with nothing else", () => {
    expect(patientActionSchema.safeParse({ token: "t", action: "cancel" }).success).toBe(true);
  });

  test.each([
    ["an unknown action", { token: "t", action: "delete" }],
    ["no token", { action: "cancel" }],
    ["an empty token", { token: "", action: "cancel" }],
    ["a reschedule with no slot", { token: "t", action: "reschedule" }],
    ["a cancel carrying a slot", { token: "t", action: "cancel", appointmentDateTime: "2026-10-02T14:00" }],
    ["a slot that is not a local date-time", { token: "t", action: "reschedule", appointmentDateTime: "2026-10-02" }],
    ["a slot carrying a zone", { token: "t", action: "reschedule", appointmentDateTime: "2026-10-02T14:00Z" }],
    ["an extra field", { token: "t", action: "cancel", status: "cancelled" }],
  ])("refuses %s", (_label, body) => {
    // Strict, because this is the only body in the application that can change an
    // appointment, and an unknown key here is either a bug or an attempt at one.
    expect(patientActionSchema.safeParse(body).success).toBe(false);
  });
});

describe("reschedule", () => {
  test("negotiates a time and writes what the clinic agreed", async () => {
    const { links } = await booked();

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    expect(outcome.ok).toBe(true);
    // The clinic agrees to the slot asked for, with no shift and well beyond its
    // minimum notice, so the written value is the one submitted.
    expect(outcome.ok && outcome.appointmentDateTime).toBe("2026-10-02T14:00");
  });

  test("writes the agreed time, not the requested one, when the clinic shifts it", async () => {
    // The bug this whole pipeline exists to close: the booking confirmation has
    // always told the patient a time that was never written anywhere.
    const { created, links } = await booked();

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: () => 0.99 },
    );

    const stored = (await getAppointmentStore().get(created.id))!;
    expect(stored.patientInfo.appointmentDateTime).not.toBe("2026-10-02T14:00");
    // Still later than the requested slot: a clinic that can only move you earlier
    // is not scheduling.
    expect(stored.patientInfo.appointmentDateTime > "2026-10-02T14:00").toBe(true);
    expect(outcome.ok && outcome.appointmentDateTime).toBe(
      stored.patientInfo.appointmentDateTime,
    );
  });

  test("marks the appointment confirmed", async () => {
    const { created, links } = await booked();

    await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    const after = await getAppointmentStore().get(created.id);
    expect(after!.status).toBe("confirmed");
    expect(after!.patientInfo.appointmentDateTime).toBe("2026-10-02T14:00");
  });

  test("leaves the rest of the record alone", async () => {
    const { created, links } = await booked();

    await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    const after = (await getAppointmentStore().get(created.id))!;
    expect(after.patientInfo).toEqual({ ...patient, appointmentDateTime: "2026-10-02T14:00" });
  });

  test("tells the patient, in their language, at their address", async () => {
    const { links } = await booked();

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    expect(outcome.ok && outcome.confirmationEmailSent).toBe(true);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ada@example.test"]);
    expect(emails[0].subject).toBe("Su cita ha cambiado");
  });

  test("does not put a symptom description in the message", async () => {
    // A confirmation about a reschedule has to say the new time and that the old
    // one no longer stands. Everything else on the record has no business in a
    // message that will sit in an inbox for years.
    const { links } = await booked({ additionalInfo: "chest pain since Tuesday" });

    await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    expect(JSON.stringify(emails)).not.toContain("chest pain");
  });

  test("spends the link, so the same one cannot be used twice", async () => {
    const { links } = await booked();
    const request = {
      token: links.reschedule.token,
      action: "reschedule",
      appointmentDateTime: "2026-10-02T14:00",
    } as const;

    const first = await performPatientAction(request, { now: NOW, random: NO_SHIFT });
    const second = await performPatientAction(request, { now: NOW, random: NO_SHIFT });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "already_used", message: REFUSAL_MESSAGES.already_used });
    expect(emails).toHaveLength(1);
  });

  test("hands back a working replacement link", async () => {
    // The patient rescheduled and must not be left unable to open their page. A
    // link that is minted before the write would be the opposite bug: a live link
    // to an appointment that was never moved.
    const { links } = await booked();

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    expect(outcome.ok && outcome.nextPath).toMatch(/^\/reschedule\//);

    const replacement = await performPatientAction(
      {
        token: outcome.ok ? outcome.nextPath!.split("/").pop()! : "",
        action: "reschedule",
        appointmentDateTime: "2026-10-03T09:00",
      },
      { now: NOW, random: NO_SHIFT },
    );

    expect(replacement.ok).toBe(true);
  });

  test("reports the email as undelivered without failing the reschedule", async () => {
    // The record has moved and the patient has a page that shows them so. A 502
    // here would report a reschedule that happened as one that did not, and the
    // patient would book a second appointment on top of the first.
    const { links } = await booked();
    resendStatus = 422;

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.confirmationEmailSent).toBe(false);
    expect(outcome.ok && outcome.nextPath).toMatch(/^\/reschedule\//);
  });
});

describe("cancel", () => {
  test("marks the appointment cancelled and tells the patient", async () => {
    const { created, links } = await booked();

    const outcome = await performPatientAction(
      { token: links.cancel.token, action: "cancel" },
      { now: NOW },
    );

    expect(outcome.ok).toBe(true);
    expect((await getAppointmentStore().get(created.id))!.status).toBe("cancelled");
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["ada@example.test"]);
  });

  test("hands back no replacement link", async () => {
    // There is nothing left to manage. Offering a link to a cancelled appointment
    // would be offering the "resurrect it" affordance this issue exists to remove.
    const { links } = await booked();

    const outcome = await performPatientAction({ token: links.cancel.token, action: "cancel" }, { now: NOW });

    expect(outcome.ok && outcome.nextPath).toBeNull();
  });

  test("withdraws every link to the appointment", async () => {
    // The invariant. Without it a patient could cancel through one link and then
    // reschedule through an old copy of another, and the clinic would be holding
    // a record that is cancelled and booked at the same time.
    const { links } = await booked();

    await performPatientAction({ token: links.cancel.token, action: "cancel" }, { now: NOW });

    expect(
      (await performPatientAction(
        {
          token: links.reschedule.token,
          action: "reschedule",
          appointmentDateTime: "2026-10-02T14:00",
        },
        { now: NOW, random: NO_SHIFT },
      )).ok,
    ).toBe(false);
  });

  test("a cancel link cannot reschedule, and a reschedule link cannot cancel", async () => {
    const { links } = await booked();

    expect(
      (
        await performPatientAction(
          { token: links.reschedule.token, action: "cancel" },
          { now: NOW },
        )
      ).ok,
    ).toBe(false);

    expect(
      (
        await performPatientAction(
          {
            token: links.cancel.token,
            action: "reschedule",
            appointmentDateTime: "2026-10-02T14:00",
          },
          { now: NOW, random: NO_SHIFT },
        )
      ).ok,
    ).toBe(false);
  });
});

describe("refusals", () => {
  test("a link that is not ours is refused, and nothing is sent", async () => {
    const outcome = await performPatientAction(
      { token: "not-a-token", action: "cancel" },
      { now: NOW },
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "link_unusable",
      message: REFUSAL_MESSAGES.link_unusable,
    });
    expect(emails).toEqual([]);
  });

  test("an expired link is refused", async () => {
    const { links } = await booked();
    const expiresAt = links.reschedule.expiresAt.getTime();

    const outcome = await performPatientAction(
      { token: links.reschedule.token, action: "cancel" },
      { now: expiresAt },
    );

    expect(outcome.ok).toBe(false);
    expect(emails).toEqual([]);
  });

  test("every reason has a message, and none of them quotes the token", () => {
    // A refusal is the response an attacker is most likely to be collecting.
    for (const message of Object.values(REFUSAL_MESSAGES)) {
      expect(message).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
    expect(new Set(Object.values(REFUSAL_MESSAGES)).size).toBe(
      Object.keys(REFUSAL_MESSAGES).length,
    );
  });

  test("a refusal is in the trail, attributed to the link and not to a patient", async () => {
    await performPatientAction({ token: "not-a-token", action: "cancel" }, { now: NOW });

    const refusals = (await readAuditLog()).filter(
      (entry) => entry.action === "APPOINTMENT_ACTION_REFUSED",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0].actor).toBe(AUDIT_ACTORS.patientLink);
  });

  test("a successful action leaves the trail joinable to the appointment", async () => {
    const { created, links } = await booked();

    await performPatientAction(
      { token: links.reschedule.token, action: "reschedule", appointmentDateTime: "2026-10-02T14:00" },
      { now: NOW, random: NO_SHIFT },
    );

    const trail = await readAuditLog();
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((entry) => entry.resource === `appointment:${created.id}`)).toBe(true);
  });
});

describe("toLocalSlot", () => {
  test("round-trips an instant into the form the record holds", () => {
    const slot = toLocalSlot("2026-10-02T14:00:00.000Z");
    const back = new Date(slot);

    expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(9);
    expect(back.getDate()).toBe(2);
  });

  test("keeps the calendar date, whatever the server's zone", () => {
    // The trap this avoids: building the date with Date.UTC and reading it back
    // with getUTC* would agree, and so would the reverse, but a wall-clock time
    // with no zone is only meaningful against one zone, and the server has only
    // ever had the one.
    expect(toLocalSlot("2026-01-01T00:00:00.000Z")).toMatch(/^2026-01-01T/);
    expect(toLocalSlot("2026-12-31T23:59:00.000Z")).toMatch(/^2026-12-3[01]T/);
  });

  test("refuses a value that is not a date rather than writing NaN to a record", () => {
    expect(() => toLocalSlot("not a date")).toThrow(/not a date/);
  });
});
