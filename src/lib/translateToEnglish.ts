import { getLlmClient } from "@/lib/gemini";
import {
  appointmentRecordSchema,
  type AppointmentRecord,
  type IntakeFormData,
  type SupportedLanguage,
} from "@/lib/validation/intake";
import { buildIntakeTranslationPrompt } from "@/lib/llm/prompt";
import {
  TRANSLATABLE_FIELD_NAMES,
  translationResponseSchema,
} from "@/lib/llm/schema";

/**
 * The only fields the model is allowed to change.
 *
 * Everything else in a patient record is either a name, a date of birth, or a
 * contact detail that was typed into a form, and none of it needs
 * translating. Constraining the model to these two is what prevents a
 * response from rewriting the rest of the record.
 *
 * The list moved to ./llm/schema so that the prompt, the response schema, and
 * the merge below all derive from one declaration. It used to be spelled out in
 * this file and again inside the schema builder, which is a way for the schema
 * to constrain a field the merge does not read.
 */
const TRANSLATABLE_FIELDS = TRANSLATABLE_FIELD_NAMES;

type TranslatableField = (typeof TRANSLATABLE_FIELDS)[number];

export async function translateToEnglish(
  data: IntakeFormData,
  sourceLanguage: SupportedLanguage,
): Promise<AppointmentRecord> {
  const fieldsToTranslate: Partial<Record<TranslatableField, string>> = {};

  for (const key of TRANSLATABLE_FIELDS) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      fieldsToTranslate[key] = value;
    }
  }

  const base: AppointmentRecord = data;
  const requested = Object.keys(fieldsToTranslate) as TranslatableField[];
  if (requested.length === 0) {
    return base;
  }

  // Nothing to configure and nothing to parse: the client owns the model, the
  // JSON mode, and the retry budget. This function is now the part that is
  // specific to intake translation -- which fields, and what to do with a reply.
  const translated = await getLlmClient().generateJson({
    prompt: buildIntakeTranslationPrompt(fieldsToTranslate, sourceLanguage),
    responseSchema: translationResponseSchema(requested),
  });

  return applyTranslation(base, translated);
}

/**
 * Merge the model's response into the submitted record.
 *
 * Only the two translatable fields are taken from the response, and only when
 * the response is a non-empty string. Every other key the model returns is
 * discarded, so a response carrying `{"email": "attacker@example.test"}` is
 * ignored rather than merged.
 *
 * JSON mode makes the response carry only the two keys, but it does not make
 * the values correct and it does not make the model honest, so this stays.
 * Schema-constrained decoding is a statement about shape, not about intent.
 */
export function applyTranslation(
  base: AppointmentRecord,
  translated: unknown,
): AppointmentRecord {
  if (typeof translated !== "object" || translated === null || Array.isArray(translated)) {
    return base;
  }

  const response = translated as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };

  for (const key of TRANSLATABLE_FIELDS) {
    if (!Object.hasOwn(response, key)) continue;

    const value = response[key];
    if (typeof value !== "string") continue;

    const trimmed = value.trim();
    if (trimmed.length === 0) continue;

    merged[key] = trimmed.slice(0, 2000);
  }

  // Re-validate rather than cast: the model can still return a department
  // string that does not match anything the form offers.
  const parsed = appointmentRecordSchema.safeParse(merged);
  if (!parsed.success) {
    return base;
  }

  return parsed.data;
}
