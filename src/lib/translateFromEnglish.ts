import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { getServerEnv } from "@/lib/env";
import { buildEmailTranslationPrompt } from "@/lib/llm/prompt";
import type { SupportedLanguage } from "@/lib/validation/intake";

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

export async function translateFromEnglish(
  text: string,
  targetLanguage: SupportedLanguage,
): Promise<{ subject: string; body: string }> {
  if (!text || text.trim() === "") {
    return { subject: "", body: "" };
  }

  const prompt = buildEmailTranslationPrompt(text, targetLanguage);

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

      const content = response.text?.trim() || "";

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse JSON response from translation");
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        subject: parsed.subject,
        body: parsed.body,
      };
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
