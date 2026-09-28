import { describe, expect, test } from "bun:test";
import {
  MAX_SHIFT_MINUTES,
  MIN_LEAD_MS,
  SLOT_MINUTES,
  negotiateAppointmentTime,
} from "./schedule";

/**
 * The mock clinic's scheduling decision (#19).
 *
 * The bug under test is a single wrong comparison: the agreed time was drawn
 * against `now`, so it ignored the requested slot and could land before it.
 * These tests are mostly about which side of that comparison a value falls on.
 */

/** A fixed clock: Wednesday 2026-03-04T12:00:00Z. */
const NOW = Date.parse("2026-03-04T12:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("negotiateAppointmentTime", () => {
  test("confirms a requested slot that is comfortably in the future", () => {
    // The patient asked for Friday at 09:00 and got Friday at 09:00, rather
    // than the old `now + random(0, 24h)`, which would have said Thursday.
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const agreed = negotiateAppointmentTime(requested, NOW, () => 0);

    expect(Date.parse(agreed)).toBe(Date.parse(requested));
  });

  test("never agrees to a time earlier than the requested slot", () => {
    // The regression. Against any draw, the confirmed time is at or after the
    // slot in the form.
    const requested = new Date(NOW + 2 * HOUR).toISOString().slice(0, 16);

    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => draw));
      expect(agreed).toBeGreaterThanOrEqual(Date.parse(requested));
    }
  });

  test("never agrees to a time in the past", () => {
    // A slot the patient picked has gone by while the form was open. Agreeing
    // to it literally would email someone an appointment that has already
    // elapsed, so the clinic offers the next slot it could actually open.
    const requested = new Date(NOW - 3 * HOUR).toISOString().slice(0, 16);
    const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => 0));

    expect(agreed).toBeGreaterThanOrEqual(NOW);
    expect(agreed).toBe(NOW + MIN_LEAD_MS);
  });

  test("honours a requested slot that is only just far enough ahead", () => {
    // One minute more than the notice period: the requested time wins, because
    // the patient asked for it and it is bookable.
    const requested = new Date(NOW + MIN_LEAD_MS + MINUTE)
      .toISOString()
      .slice(0, 16);

    const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => 0));

    expect(agreed).toBeGreaterThanOrEqual(Date.parse(requested));
  });

  test("only ever moves the appointment forward, in quarter-hour slots", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);
    const base = Date.parse(requested);

    for (let draw = 0; draw < 1; draw += 0.1) {
      const agreed = Date.parse(negotiateAppointmentTime(requested, NOW, () => draw));
      const shift = agreed - base;

      expect(shift).toBeGreaterThanOrEqual(0);
      expect(shift % (SLOT_MINUTES * MINUTE)).toBe(0);
    }
  });

  test("stays within the clinic's maximum shift", () => {
    const requested = new Date(NOW + 2 * DAY).toISOString().slice(0, 16);

    // Math.random never returns 1, so the ceiling is drawn as the largest
    // representable value below it.
    const agreed = Date.parse(
      negotiateAppointmentTime(requested, NOW, () => 0.999999999),
    );

    expect(agreed - Date.parse(requested)).toBeLessThanOrEqual(
      MAX_SHIFT_MINUTES * MINUTE,
    );
  });

  test("keeps the date the patient asked for when the shift is small", () => {
    // The old bug also lost the date. Friday requested, Friday confirmed.
    const requested = "2026-03-06T09:00";
    const now = Date.parse("2026-03-04T12:00:00.000Z");

    const agreed = new Date(negotiateAppointmentTime(requested, now, () => 0.2));

    expect(agreed.toISOString().slice(0, 10)).toBe(
      new Date(Date.parse(requested)).toISOString().slice(0, 10),
    );
  });

  test("returns an ISO-8601 timestamp", () => {
    // It goes straight into the confirmation email, so the format is part of
    // the contract rather than an implementation detail.
    const agreed = negotiateAppointmentTime("2026-03-06T09:00", NOW, () => 0);

    expect(agreed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(agreed))).toBe(false);
  });

  test("falls back to the next bookable slot for an unparseable request", () => {
    // intakeSchema refuses this before it gets here, so the guard is about not
    // emitting `NaN` into a patient's inbox if that ever stops being true.
    const agreed = Date.parse(negotiateAppointmentTime("not a date", NOW, () => 0));

    expect(agreed).toBe(NOW + MIN_LEAD_MS);
  });

  test("reads the clock by default rather than requiring it", () => {
    const requested = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 16);
    const agreed = Date.parse(negotiateAppointmentTime(requested));

    expect(agreed).toBeGreaterThan(Date.now());
  });
});
