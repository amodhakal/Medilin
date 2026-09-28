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
 * Routing hint, and the one field here with a cost when it is wrong.
 *
 * Deliberately three values and a string, not an enum the rest of the app
 * branches on: this is what a reception queue could sort by, and the name says
 * `suggested` because the model is reading a paragraph of free text, not
 * examining anyone. `emergency` is not one of them. A patient describing chest
 * pain is an emergency whoever triages them, and a four-value enum invites
 * somebody to build an "emergency" bucket that the model is expected to fill in
 * from a sentence, which is the failure this whole endpoint is shaped to avoid.
 */
export const URGENCIES = ["routine", "soon", "urgent"] as const;

export type Urgency = (typeof URGENCIES)[number];

/**
 * Schema for a clinician intake/triage summary.
 *
 * A statement to the decoder, not to the caller: it makes the reply have this
 * shape, and `triageSummarySchema` below is what makes the values usable. Every
 * field is required, because a summary missing a part is not a summary the
 * caller can render honestly -- a partial document silently shown to a
 * clinician reads as a complete one.
 */
export const INTAKE_SUMMARY_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    chiefComplaint: {
      type: Type.STRING,
      description:
        "One short line, the patient's reason for coming in, in the patient's own terms. Not a condition and not a cause.",
    },
    summary: {
      type: Type.STRING,
      description:
        "A few sentences restating the account for a clinician, including duration and severity only if the patient stated them.",
    },
    symptoms: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Each symptom the patient described, as a separate short phrase. Only what was stated.",
    },
    urgency: {
      type: Type.STRING,
      enum: [...URGENCIES],
      description:
        "A routing hint: how soon the clinic should look at this. Not a clinical determination.",
    },
    followUpQuestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Questions a clinician would need answered before the consultation, derived from gaps in the account.",
    },
  },
  required: ["chiefComplaint", "summary", "symptoms", "urgency", "followUpQuestions"],
};

const SUMMARY_TEXT_MAX = 2000;
const CHIEF_COMPLAINT_MAX = 200;
const LIST_ITEM_MAX = 200;
const LIST_MAX_ITEMS = 10;

/**
 * What the caller is willing to render.
 *
 * `.strict()`, like every other schema in this app, and for the same reason: a
 * model that volunteers a `diagnosis` key must have it refused rather than
 * carried through, because a summary is read as if every part of it came from
 * the patient's own account.
 *
 * Everything is capped and everything is rejected rather than truncated. The
 * difference matters for a clinical artefact: a summary silently cut at 2,000
 * characters can stop mid-sentence and still render as though it were the whole
 * thing, whereas a refusal is visible and the caller can fall back to showing
 * the clinician the patient's own words.
 */
export const triageSummarySchema = z
  .object({
    chiefComplaint: z.string().trim().min(1).max(CHIEF_COMPLAINT_MAX),
    summary: z.string().trim().min(1).max(SUMMARY_TEXT_MAX),
    symptoms: z.array(z.string().trim().min(1).max(LIST_ITEM_MAX)).max(LIST_MAX_ITEMS),
    urgency: z.enum(URGENCIES),
    followUpQuestions: z.array(z.string().trim().min(1).max(LIST_ITEM_MAX)).max(LIST_MAX_ITEMS),
  })
  .strict();

export type TriageSummary = z.infer<typeof triageSummarySchema>;

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
