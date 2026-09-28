import { describe, expect, test } from "bun:test";
import { Type } from "@google/genai";
import {
  EMAIL_RESPONSE_SCHEMA,
  INTAKE_SUMMARY_RESPONSE_SCHEMA,
  emailTranslationSchema,
  parseJsonResponse,
  translationResponseSchema,
  triageSummarySchema,
} from "./schema";

describe("translationResponseSchema", () => {
  test("constrains the reply to exactly the fields that were sent", () => {
    // The prompt only quotes the fields the patient filled in, so requiring a
    // field the prompt never mentions would invite the model to invent one.
    const schema = translationResponseSchema(["additionalInfo"]);

    expect(schema.required).toEqual(["additionalInfo"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["additionalInfo"]);
  });

  test("describes each field so the model is not guessing", () => {
    const schema = translationResponseSchema([
      "additionalInfo",
      "medical_department",
    ]);

    expect(schema.properties?.additionalInfo.type).toBe(Type.STRING);
    expect(schema.properties?.additionalInfo.description).toContain("symptoms");
    expect(schema.properties?.medical_department.description).toBeTruthy();
  });

  test("restricts the department to the values the form offers", () => {
    const schema = translationResponseSchema(["medical_department"]);

    // The same enum `appointmentRecordSchema` validates against, so the decoder
    // cannot emit a department the record would later reject.
    expect(schema.properties?.medical_department.enum).toContain("Dentist");
    expect(schema.properties?.medical_department.enum).not.toContain("Astrology");
  });

  test("leaves the department unconstrained when it was not requested", () => {
    const schema = translationResponseSchema(["additionalInfo"]);

    expect(schema.properties?.medical_department).toBeUndefined();
  });
});

describe("EMAIL_RESPONSE_SCHEMA", () => {
  test("requires a subject and a body", () => {
    expect(EMAIL_RESPONSE_SCHEMA.required).toEqual(["subject", "body"]);
  });
});

describe("parseJsonResponse", () => {
  test("parses the whole text as the document", () => {
    expect(parseJsonResponse('{"subject":"hi","body":"<p>bye</p>"}')).toEqual({
      subject: "hi",
      body: "<p>bye</p>",
    });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseJsonResponse('\n  {"additionalInfo":"headache"}  \n')).toEqual({
      additionalInfo: "headache",
    });
  });

  test.each([
    ["a fenced block", '```json\n{"subject":"hi"}\n```'],
    ["prose around an object", 'Here you go: {"subject":"hi"} hope that helps'],
    ["a truncated object", '{"subject":"hi"'],
    ["a bare string", "not json at all"],
  ])("throws on %s", (_label, text) => {
    // The old code scraped the object out of these. In JSON mode the API
    // returns the document and nothing else, so a body like these is a failed
    // call that must surface rather than be quietly mined for a fragment.
    expect(() => parseJsonResponse(text)).toThrow(/not valid JSON/);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   \n "],
  ])("throws on an %s response", (_label, text) => {
    // Previously an empty response became `{}`, which merged into the record as
    // "nothing was translated" and booked an appointment in the wrong language.
    expect(() => parseJsonResponse(text)).toThrow(/empty response/);
  });

  test("the thrown error does not echo the response", () => {
    // The body is a translation of what the patient typed.
    try {
      parseJsonResponse("dolor de cabeza y fiebre alta");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("fiebre");
    }
  });
});

describe("emailTranslationSchema", () => {
  test("accepts a subject and a body", () => {
    const result = emailTranslationSchema.safeParse({
      subject: "Your appointment",
      body: "<p>Tuesday at 09:30</p>",
    });
    expect(result.success).toBe(true);
  });

  test.each([
    ["a missing subject", { body: "<p>hi</p>" }],
    ["a blank subject", { subject: "   ", body: "<p>hi</p>" }],
    ["a missing body", { subject: "hi" }],
    ["an extra key", { subject: "hi", body: "<p>hi</p>", to: ["a@b.test"] }],
  ])("rejects %s", (_label, value) => {
    expect(emailTranslationSchema.safeParse(value).success).toBe(false);
  });

  test("rejects an oversized body", () => {
    const result = emailTranslationSchema.safeParse({
      subject: "hi",
      body: "x".repeat(20_001),
    });
    expect(result.success).toBe(false);
  });
});

/**
 * The clinician triage summary (#68).
 *
 * Two separate contracts, and the distinction is the point. The Gemini `Schema`
 * is what constrains the *decoder*, so the reply has the right shape. The zod
 * schema is what the caller *trusts*, so the values have to survive being
 * re-read by code that has not seen the prompt. Constrained decoding is a
 * statement about shape, not about the model having been honest, and a clinical
 * artefact is the worst possible place to confuse the two.
 */
describe("INTAKE_SUMMARY_RESPONSE_SCHEMA", () => {
  test("requires the whole summary rather than whatever fits", () => {
    // Every field is load-bearing for a clinician reading the result. A reply
    // that omits `followUpQuestions` is not a summary with one part missing, it
    // is a different artefact, and the caller should refuse it rather than
    // render a summary that looks complete.
    expect(INTAKE_SUMMARY_RESPONSE_SCHEMA.required?.sort()).toEqual([
      "chiefComplaint",
      "followUpQuestions",
      "summary",
      "symptoms",
      "urgency",
    ]);
  });

  test("models the two lists as arrays of strings", () => {
    const properties = INTAKE_SUMMARY_RESPONSE_SCHEMA.properties ?? {};
    expect(properties.symptoms.type).toBe(Type.ARRAY);
    expect(properties.symptoms.items?.type).toBe(Type.STRING);
    expect(properties.followUpQuestions.type).toBe(Type.ARRAY);
    expect(properties.followUpQuestions.items?.type).toBe(Type.STRING);
  });

  test("constrains urgency to the three routing values", () => {
    // An unconstrained string here is a model free to invent a fourth value,
    // which is then rendered as an unknown word in front of a clinician.
    expect(INTAKE_SUMMARY_RESPONSE_SCHEMA.properties?.urgency.enum).toEqual([
      "routine",
      "soon",
      "urgent",
    ]);
  });

  test("describes each field, and never asks for a diagnosis", () => {
    const properties = INTAKE_SUMMARY_RESPONSE_SCHEMA.properties ?? {};
    for (const property of Object.values(properties)) {
      expect(property.description?.trim().length).toBeGreaterThan(0);
      // A description is model-facing text and is where a diagnosis request
      // would sneak in.
      expect(property.description?.toLowerCase()).not.toContain("diagnos");
    }
  });
});

describe("triageSummarySchema", () => {
  const valid = {
    chiefComplaint: "Pain behind the left eye",
    summary: "Reports sharp pain behind the left eye since Tuesday, worse in the mornings.",
    symptoms: ["sharp pain", "worse in the mornings"],
    urgency: "soon",
    followUpQuestions: ["Has the vision in that eye changed?"],
  };

  test("accepts a well-formed summary", () => {
    const result = triageSummarySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("keeps a summary with no symptoms and no questions", () => {
    // Both are optional in substance: a patient who wrote one sentence has no
    // symptom list to give, and refusing the whole summary over an empty array
    // would mean the endpoint returns nothing for the shortest submissions.
    const result = triageSummarySchema.safeParse({
      ...valid,
      symptoms: [],
      followUpQuestions: [],
    });
    expect(result.success).toBe(true);
  });

  test.each([
    ["a blank chief complaint", { ...valid, chiefComplaint: "   " }],
    ["a blank summary", { ...valid, summary: "" }],
    ["a missing summary", { chiefComplaint: "x", urgency: "routine" }],
    ["an unknown urgency", { ...valid, urgency: "emergency" }],
    ["a capitalised urgency", { ...valid, urgency: "Soon" }],
    ["symptoms that are not strings", { ...valid, symptoms: [{ name: "pain" }] }],
    ["symptoms that are not a list", { ...valid, symptoms: "sharp pain" }],
    ["questions that are not a list", { ...valid, followUpQuestions: "none" }],
    ["an extra key", { ...valid, diagnosis: "acute glaucoma" }],
  ])("rejects %s", (_label, value) => {
    // The extra-key case is the one that matters most: a model that volunteers a
    // diagnosis must have it dropped or refused, never stored next to a summary
    // a clinician will read.
    expect(triageSummarySchema.safeParse(value).success).toBe(false);
  });

  test("rejects an oversized field rather than truncating it", () => {
    // A summary truncated to 2,000 characters can end mid-sentence in a way
    // that reads as a complete thought. The caller is told the model returned
    // something it cannot use.
    const result = triageSummarySchema.safeParse({ ...valid, summary: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  test("rejects a list with more entries than a clinician would read", () => {
    const result = triageSummarySchema.safeParse({
      ...valid,
      symptoms: Array.from({ length: 11 }, (_, i) => `symptom ${i}`),
    });
    expect(result.success).toBe(false);
  });

  test("trims the strings it keeps", () => {
    const result = triageSummarySchema.parse({ ...valid, chiefComplaint: "  Pain  " });
    expect(result.chiefComplaint).toBe("Pain");
  });

  test("rejects a list entry that is only whitespace", () => {
    const result = triageSummarySchema.safeParse({ ...valid, symptoms: ["pain", "   "] });
    expect(result.success).toBe(false);
  });
});
