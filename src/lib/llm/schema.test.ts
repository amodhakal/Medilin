import { describe, expect, test } from "bun:test";
import { Type } from "@google/genai";
import {
  EMAIL_RESPONSE_SCHEMA,
  emailTranslationSchema,
  parseJsonResponse,
  translationResponseSchema,
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
