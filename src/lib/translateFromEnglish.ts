import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { getServerEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { buildEmailTranslationPrompt } from "@/lib/llm/prompt";
import {
  EMAIL_RESPONSE_SCHEMA,
  emailTranslationSchema,
  parseJsonResponse,
  type EmailTranslation,
} from "@/lib/llm/schema";
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
): Promise<EmailTranslation> {
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
          // The model emits the object and nothing else, so there is no fence
          // to strip and no prose to skip past before the JSON starts.
          responseMimeType: "application/json",
          responseSchema: EMAIL_RESPONSE_SCHEMA,
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      });

      // Was `content.match(/\{[\s\S]*\}/)` followed by an unchecked
      // `JSON.parse`, whose result was returned as `{subject, body}` with both
      // fields implicitly `any`. A subject of `undefined` was handed straight
      // to Resend. Constrained decoding plus a parse is a document; this is the
      // point where it is checked to be an email.
      const parsed = emailTranslationSchema.parse(
        parseJsonResponse(response.text),
      );

      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // The message is redacted and truncated by the logger: a Gemini SDK
      // error can echo the request payload, which here is the symptom text
      // that was sent for translation.
      logWarn("llm.attempt_failed", {
        cause: lastError,
        attempt: attempt + 1,
        limit: MAX_RETRIES,
      });

      if (attempt < MAX_RETRIES - 1) {
        const delay = calculateDelayWithJitter(attempt);
        logInfo("llm.retry_scheduled", { durationMs: delay, attempt: attempt + 1 });
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Translation failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
  );
}
