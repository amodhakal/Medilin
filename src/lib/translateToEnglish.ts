import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { getServerEnv } from "@/lib/env";
import {
  appointmentRecordSchema,
  type AppointmentRecord,
  type IntakeFormData,
} from "@/lib/validation/intake";

/**
 * Constructed lazily.
 *
 * Previously this ran at module scope, so importing the module built a client
 * with an `undefined` key and logged "API key should be set" during `next build`
 * and on every cold start, deferring the real failure to the first API call.
 */
function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getServerEnv().GEMINI_KEY });
}

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelayWithJitter(attempt: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * exponentialDelay;
  return Math.min(jitter, MAX_DELAY_MS);
}

/**
 * The only fields the model is allowed to change.
 *
 * Everything else in a patient record is either a name, a date of birth, or a
 * contact detail that was typed into a form, and none of it needs
 * translating. Constraining the model to these two is what prevents a
 * response from rewriting the rest of the record.
 */
const TRANSLATABLE_FIELDS = ["additionalInfo", "medical_department"] as const;

type TranslatableField = (typeof TRANSLATABLE_FIELDS)[number];

function isTranslatableField(key: string): key is TranslatableField {
  return (TRANSLATABLE_FIELDS as readonly string[]).includes(key);
}

export async function translateToEnglish(
  data: IntakeFormData,
  sourceLanguage: string,
): Promise<AppointmentRecord> {
  const fieldsToTranslate: Partial<Record<TranslatableField, string>> = {};

  for (const key of TRANSLATABLE_FIELDS) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      fieldsToTranslate[key] = value;
    }
  }

  const base: AppointmentRecord = data;
  if (Object.keys(fieldsToTranslate).length === 0) {
    return base;
  }

  const prompt = `You are a medical intake form translator. Translate the following text fields from ${sourceLanguage} to English. Only translate the values, not the field names or other data.

Fields to translate:
${JSON.stringify(fieldsToTranslate, null, 2)}

Return ONLY a valid JSON object with the same structure, but with values translated to English. Do not include any explanation or additional text.`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().models.generateContent({
        model: "gemini-3-flash-preview",
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      });

      const content = response.text?.trim() || "{}";

      let parsed: unknown;
      try {
        const jsonMatch =
          content.match(/```json\n?([\s\S]*?)\n?```/) ||
          content.match(/(\{[\s\S]*\})/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[1] : content);
      } catch {
        parsed = JSON.parse(content);
      }

      return applyTranslation(base, parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `Translation attempt ${attempt + 1} failed:`,
        lastError.message,
      );

      if (attempt < MAX_RETRIES - 1) {
        const delay = calculateDelayWithJitter(attempt);
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Translation failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}

/**
 * Merge the model's response into the submitted record.
 *
 * Only the two translatable fields are taken from the response, and only when
 * the response is a non-empty string. Every other key the model returns is
 * discarded, so a response carrying `{"email": "attacker@example.test"}` is
 * ignored rather than merged.
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
