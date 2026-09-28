import { describe, expect, test } from "bun:test";

import { INTAKE_SUMMARY_RESPONSE_SCHEMA, type TriageSummary } from "./schema";
import { intakeSummaryInput, summariseIntake } from "./intake-summary";
import type { LlmClient } from "../gemini";

/**
 * Turning one patient's account into a summary a clinician can read (#68).
 *
 * Three things are worth pinning here, in this order.
 *
 *   1. The narrowing. A decrypted record is `unknown` and holds a date of
 *      birth, an email, a phone number and a symptom description.
 *      `intakeSummaryInput` is the allowlist, and like the one on the tracking
 *      page it exists so that the wider record has no route into a prompt.
 *   2. The refusal to spend a call on nothing. The single most common record in
 *      this app is a patient who left the symptoms box empty, and asking a model
 *      to summarise an empty string costs money and invents content.
 *   3. The re-validation. Constrained decoding constrains the shape of the
 *      reply; it does not make the model honest about what the patient said.
 */

const now = new Date("2026-09-28T12:00:00.000Z");

const record = {
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
};

const reply: TriageSummary = {
  chiefComplaint: "Pain behind the left eye",
  summary: "Reports sharp pain behind the left eye since Tuesday.",
  symptoms: ["sharp pain behind the left eye"],
  urgency: "soon",
  followUpQuestions: ["Has the vision in that eye changed?"],
};

function fakeClient(value: unknown): LlmClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    generateJson: async (request) => {
      calls.push(request);
      return value;
    },
  };
}

describe("intakeSummaryInput", () => {
  test("narrows a record to the three facts triage uses", () => {
    expect(intakeSummaryInput(record, now)).toEqual({
      additionalInfo: "Sharp pain behind my left eye since Tuesday",
      medical_department: "Eye Doctor",
      ageYears: 40,
    });
  });

  test("carries no identifier into the prompt", () => {
    // The whole point of the allowlist. A date of birth, an email address and a
    // phone number are all in the record, and none of them belong in a third
    // party's prompt. `ageYears` is a lossy derivation of the first one and is
    // the only form of it that is allowed through.
    const input = intakeSummaryInput(record, now);
    expect(input).not.toBeNull();

    const rendered = JSON.stringify(input);
    expect(rendered).not.toContain("1985-12-10");
    expect(rendered).not.toContain("ada@example.test");
    expect(rendered).not.toContain("555 0100");
    expect(rendered).not.toContain("Lovelace");
  });

  test("returns null when the patient wrote nothing", () => {
    // The common case, and the one that must not reach the model.
    expect(intakeSummaryInput({ ...record, additionalInfo: "" }, now)).toBeNull();
    expect(intakeSummaryInput({ ...record, additionalInfo: "   \n  " }, now)).toBeNull();
    expect(intakeSummaryInput({ ...record, additionalInfo: undefined }, now)).toBeNull();
    expect(intakeSummaryInput({ ...record, additionalInfo: 42 }, now)).toBeNull();
  });

  test("returns null for a record that is not an object", () => {
    expect(intakeSummaryInput(null, now)).toBeNull();
    expect(intakeSummaryInput("sharp pain", now)).toBeNull();
    expect(intakeSummaryInput([record], now)).toBeNull();
  });

  test("derives whole years, and does not round up early", () => {
    const onBirthday = intakeSummaryInput({ ...record, dob: "1986-09-28" }, now);
    expect(onBirthday?.ageYears).toBe(40);

    const theDayBefore = intakeSummaryInput({ ...record, dob: "1986-09-29" }, now);
    expect(theDayBefore?.ageYears).toBe(39);
  });

  test("reports an age as not stated rather than guessing or failing", () => {
    // A clinician reading "the patient is 0 years old" because the date of
    // birth was unparseable would be actively misled. The prompt renders this
    // as "not stated", which is the honest version of the same fact.
    for (const dob of ["", "not-a-date", "1985-13-45", "1985-02-30", 19851210, null]) {
      const input = intakeSummaryInput({ ...record, dob }, now);
      expect(input?.ageYears).toBeNull();
    }
  });

  test("refuses a date of birth in the future", () => {
    // Which is either a typo or something trying to be the youngest patient in
    // the clinic, and neither is a fact to hand a model.
    const input = intakeSummaryInput({ ...record, dob: "2030-01-01" }, now);
    expect(input?.ageYears).toBeNull();
  });

  test("keeps a department that is not a known one rather than dropping the record", () => {
    // A department the form does not offer still needs summarising; refusing
    // the whole summary over it would mean an old record from before a label
    // changed cannot be read by a clinician at all.
    const input = intakeSummaryInput({ ...record, medical_department: "Auriculotherapy" }, now);
    expect(input?.medical_department).toBe("Auriculotherapy");
  });

  test("falls back to a placeholder when the department is missing entirely", () => {
    const input = intakeSummaryInput({ ...record, medical_department: undefined }, now);
    expect(input?.medical_department).toBe("unspecified");
  });

  test("caps the symptom text it will read", () => {
    const huge = intakeSummaryInput({ ...record, additionalInfo: "x".repeat(100_000) }, now);
    expect(huge?.additionalInfo.length).toBeLessThanOrEqual(2000);
  });
});

describe("summariseIntake", () => {
  test("returns the summary the model produced", async () => {
    const client = fakeClient(reply);
    const result = await summariseIntake(record, client, now);

    expect(result).toEqual(reply);
  });

  test("asks for JSON against the summary schema", async () => {
    const client = fakeClient(reply);
    await summariseIntake(record, client, now);

    const [call] = client.calls as Array<{
      prompt: string;
      responseSchema: unknown;
    }>;
    expect(call.responseSchema).toBe(INTAKE_SUMMARY_RESPONSE_SCHEMA);
    expect(call.prompt).toContain("Sharp pain behind my left eye");
  });

  test("does not put the date of birth in the prompt", async () => {
    const client = fakeClient(reply);
    await summariseIntake(record, client, now);

    const [call] = client.calls as Array<{ prompt: string }>;
    expect(call.prompt).not.toContain("1985-12-10");
  });

  test("spends nothing when the patient wrote nothing", async () => {
    // An empty symptoms box is the default state of this form, so this is the
    // single most common call this endpoint would otherwise make.
    const client = fakeClient(reply);
    const result = await summariseIntake({ ...record, additionalInfo: "" }, client, now);

    expect(client.calls).toEqual([]);
    expect(result).toBeNull();
  });

  test("refuses a reply that does not match the schema", async () => {
    // Constrained decoding constrains the shape. This is the check on the
    // values, and it is the reason a model that volunteers a diagnosis cannot
    // get one in front of a clinician.
    for (const bad of [
      { ...reply, urgency: "emergency" },
      { ...reply, diagnosis: "acute glaucoma" },
      { ...reply, chiefComplaint: "" },
      { ...reply, symptoms: "sharp pain" },
      { ...reply, summary: "x".repeat(2001) },
      "a string, not an object",
      null,
    ]) {
      const client = fakeClient(bad);
      expect(await summariseIntake(record, client, now)).toBeNull();
    }
  });

  test("throws when the model call itself fails", async () => {
    // Null and a throw are different facts. Null means "there is no usable
    // summary"; a throw means the pipeline is broken, and the caller answers 502
    // rather than telling a clinician this patient has nothing to report.
    const failing: LlmClient = {
      generateJson: async () => {
        throw new Error("Model returned a response that is not valid JSON");
      },
    };
    expect(summariseIntake(record, failing, now)).rejects.toThrow(/not valid JSON/);
  });

  test("never throws the model's own words back at the caller", async () => {
    // The reply is derived from what a patient typed, so it is PHI-adjacent. The
    // schema's failure message must not quote the value that failed.
    const client = fakeClient({ ...reply, urgency: "emergency" });
    const result = await summariseIntake(record, client, now);
    expect(result).toBeNull();
  });
});

describe("age derivation", () => {
  test("is stable regardless of the time of day the caller derives it", () => {
    // `now` is injected rather than read from the clock so this is not a test
    // that fails on 29 September.
    const morning = intakeSummaryInput({ ...record, dob: "1985-12-10" }, new Date("2026-09-28T00:00:00.000Z"));
    const evening = intakeSummaryInput({ ...record, dob: "1985-12-10" }, new Date("2026-09-28T23:59:59.000Z"));
    expect(morning?.ageYears).toBe(evening?.ageYears);
  });

  test("is computed in UTC so a server's zone cannot shift it", () => {
    // The record's `dob` is a plain calendar date. Reading it with `new Date()`
    // and local getters would make the age depend on the machine doing the
    // deriving, which is how a patient is 39 on a server in one region and 40
    // on one in another.
    const input = intakeSummaryInput({ ...record, dob: "2000-01-01" }, now);
    expect(input?.ageYears).toBe(26);
  });
});
