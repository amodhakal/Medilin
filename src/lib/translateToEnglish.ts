import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { getServerEnv } from "@/lib/env";

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

export async function translateToEnglish(
  data: Record<string, unknown>,
  sourceLanguage: string,
): Promise<Record<string, unknown>> {
  const textFieldsToTranslate = [
    "additionalInfo",
    "medical_department",
  ];

  const fieldsToTranslate: Record<string, string> = {};
  const nonTextFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (textFieldsToTranslate.includes(key) && typeof value === "string") {
      fieldsToTranslate[key] = value;
    } else {
      nonTextFields[key] = value;
    }
  }

  if (Object.keys(fieldsToTranslate).length === 0) {
    return data;
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

      let translatedFields: Record<string, string>;
      try {
        const jsonMatch =
          content.match(/```json\n?([\s\S]*?)\n?```/) ||
          content.match(/(\{[\s\S]*\})/);
        const jsonString = jsonMatch ? jsonMatch[1] : content;
        translatedFields = JSON.parse(jsonString);
      } catch {
        translatedFields = JSON.parse(content);
      }

      return { ...nonTextFields, ...translatedFields };
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
