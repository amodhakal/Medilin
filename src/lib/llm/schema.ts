import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { MEDICAL_DEPARTMENTS } from "@/lib/validation/intake";

/**
 * Structured output for the translation calls.
 *
 * Both translation helpers used to scrape the model with a regex:
 *
 *   content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/(\{[\s\S]*\})/)
 *
 * and then `JSON.parse` whatever came back. That asks the model to be a JSON
 * emitter and then parses its prose hoping to find JSON inside it. The failure
 * modes are all silent and all bad: a ```json fence with a trailing sentence
 * after it, a brace inside a translated symptom text ("pain in {left} knee")
 * balancing against the real closing brace, an empty response treated as `{}`.
 * Every one of those either threw somewhere unrelated or, worse, parsed into an
 * object missing the field the caller expected.
 *
 * Gemini can be asked for JSON directly. `responseMimeType: "application/json"`
 * makes the model emit JSON and nothing else, and `responseSchema` constrains the
 * shape, so the decoder is the API's rather than a regular expression's. The
 * regex is not replaced with a stricter regex; it is deleted.
 *
 * Schemas are built per call rather than declared once. The intake call only
 * asks for the fields the patient actually filled in, and marking a field
 * required that the prompt never mentions teaches the model to invent it.
 */

export const TRANSLATABLE_FIELD_NAMES = [
  "additionalInfo",
  "medical_department",
] as const;

export type TranslatableFieldName = (typeof TRANSLATABLE_FIELD_NAMES)[number];

const FIELD_DESCRIPTIONS: Record<TranslatableFieldName, string> = {
  additionalInfo:
    "The patient's own description of their symptoms, translated into English. Translate the text; never add medical advice.",
  medical_department:
    "The medical department they are asking for, as one of the listed values.",
};

/**
 * Schema for an intake translation, covering only the fields requested.
 *
 * The department is additionally constrained to `MEDICAL_DEPARTMENTS` so the
 * constrained decoder cannot produce a label the form never offers. This is a
 * second line of defence rather than the only one: applyTranslation still
 * re-validates the whole record before anything is stored.
 */
export function translationResponseSchema(
  fields: readonly TranslatableFieldName[],
): Schema {
  const properties: Record<string, Schema> = {};

  for (const field of fields) {
    properties[field] = { type: Type.STRING, description: FIELD_DESCRIPTIONS[field] };
  }

  if (fields.includes("medical_department")) {
    properties.medical_department = {
      ...properties.medical_department,
      type: Type.STRING,
      enum: [...MEDICAL_DEPARTMENTS],
    };
  }

  return {
    type: Type.OBJECT,
    properties,
    required: [...fields],
  };
}

/** Schema for a confirmation email. Both halves are required: an email with no
 * subject, or a subject with no body, is not sendable. */
export const EMAIL_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    subject: { type: Type.STRING, description: "One-line email subject." },
    body: {
      type: Type.STRING,
      description: "Email body as simple HTML: p, strong, ul, li, br only.",
    },
  },
  required: ["subject", "body"],
};

/**
 * What a model may hand back, in the shape the callers accept.
 *
 * The email body is a string of HTML the app then emails to a patient, so the
 * ceiling is 20,000 characters, matching `webhookPayloadSchema`'s cap on the
 * record it is built from. Truncating a subject is not useful, so it is capped
 * and rejected rather than shortened.
 */
export const emailTranslationSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(20_000),
  })
  .strict();

export type EmailTranslation = z.infer<typeof emailTranslationSchema>;

/**
 * Parse a response that the API has already constrained to JSON.
 *
 * A single `JSON.parse`, with no extraction step, because in JSON mode the whole
 * text is the document. An empty or unparseable response throws rather than
 * falling back to `{}`: in JSON mode that is a failed call, not a model that
 * declined to answer, and reporting it as an empty object turns a transport
 * fault into a silently untranslated appointment.
 */
export function parseJsonResponse(text: string | undefined): unknown {
  const trimmed = text?.trim();

  if (!trimmed) {
    throw new Error("Model returned an empty response in JSON mode");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // The message is fixed. The raw text is a translation of a patient's own
    // words, and an SDK error path that quotes it is how symptom text ends up
    // in a log aggregator.
    throw new Error("Model returned a response that is not valid JSON");
  }
}
