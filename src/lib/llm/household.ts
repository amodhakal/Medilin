import { getLlmClient, type LlmClient } from "@/lib/gemini";
import { appointmentRecordSchema, type AppointmentRecord } from "@/lib/validation/intake";
import { buildIntakeTranslationPrompt } from "./prompt";
import { translationResponseSchema } from "./schema";

/**
 * Translate what everyone in a household said (#69).
 *
 * `translateToEnglish` handles the account holder, and it handles two fields on
 * one person. A household is several people, each with their own account of
 * their own symptoms, and a clinic that runs in three languages cannot have one
 * child's fever arriving in Spanish while their sibling's arrives in English --
 * a clinician triaging a list of notes in a language they do not read is not
 * triaging.
 *
 * Reuses the existing prompt builder and response schema rather than writing a
 * second translation path. The department half of the translation prompt is
 * about a field a dependent does not have, which is a wasted sentence in the
 * instruction rather than a problem: the *schema* is what decides the reply
 * shape, and it is asked only for `additionalInfo`. One implementation of
 * "translate this patient's words" is the point of `src/lib/gemini` existing.
 *
 * **One call per person.** A single batched call would be cheaper and is the
 * wrong trade. A reply carrying two translated strings in the wrong order
 * attaches one child's symptoms to another child, and nothing downstream can
 * detect it: both are well-formed strings in the right language in a schema
 * that has been satisfied. Correctness over one saved call, in a clinical
 * record, at a cost of at most four extra calls on a form that most people fill
 * in alone.
 *
 * A reply that cannot be used falls back to the text as submitted rather than
 * dropping the person. A symptom note in the wrong language is a problem a
 * clinician can recognise and ask about; a dependent who is silently missing
 * from a booking is not.
 *
 * A call that *fails* is a different case and does propagate, matching
 * `translateToEnglish`. There is nothing stored at that point, so the patient
 * is told to try again and loses nothing, whereas swallowing it would store a
 * household in which one person is quietly untranslated and no log says so.
 */

const MAX_TRANSLATION_LENGTH = 2000;

export async function translateHousehold(
  record: AppointmentRecord,
  client: LlmClient = getLlmClient(),
): Promise<AppointmentRecord> {
  const dependents = record.dependents;
  if (!dependents || dependents.length === 0) return record;

  // Index-preserving, because a person's position in this array is what the
  // clinician, the error summary, and the sealed record all address them by.
  const translated = await Promise.all(
    dependents.map(async (person) => {
      const additionalInfo = person.additionalInfo.trim();
      if (!additionalInfo) return person;

      const reply = await client.generateJson({
        prompt: buildIntakeTranslationPrompt({ additionalInfo }, record.language),
        responseSchema: translationResponseSchema(["additionalInfo"]),
      });

      return { ...person, additionalInfo: readTranslation(reply, additionalInfo) };
    }),
  );

  const merged: AppointmentRecord = { ...record, dependents: translated };

  // Re-validate rather than cast, for the same reason `applyTranslation` does:
  // the merge is a place a value the model chose ends up in a clinical record,
  // and the schema is the last place that can say no. A household that does not
  // survive it is dropped whole rather than partly applied.
  const parsed = appointmentRecordSchema.safeParse(merged);
  return parsed.success ? parsed.data : record;
}

/**
 * The one value this module will take from a translation reply.
 *
 * `additionalInfo`, as a non-empty string, trimmed and capped. Every other key
 * the model returns is discarded, so a reply carrying
 * `{"firstName": "Mallory", "email": "attacker@example.test"}` cannot rewrite
 * the record or a child. Constrained decoding constrains the shape; it does not
 * make the model honest, so the same allowlist `applyTranslation` uses applies
 * here.
 *
 * Anything unusable falls back to what the patient actually typed.
 */
function readTranslation(reply: unknown, fallback: string): string {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
    return fallback;
  }

  const value = (reply as Record<string, unknown>).additionalInfo;
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TRANSLATION_LENGTH) return fallback;

  return trimmed;
}
