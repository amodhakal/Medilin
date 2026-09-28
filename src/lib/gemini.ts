import "server-only";

import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";
import { getServerEnv } from "@/lib/env";
import { parseJsonResponse } from "@/lib/llm/schema";
import { TRANSLATION_RETRY_POLICY, withRetry, type RetryPolicy } from "@/lib/llm/retry";

/**
 * The one place this app talks to Gemini.
 *
 * `translateToEnglish` and `translateFromEnglish` each built their own
 * `GoogleGenAI`, and each hardcoded the model id, the thinking level, the JSON
 * mime type, and a full copy of the retry loop. That is four things that have
 * to agree between two call sites and are changed independently: fixing a
 * model deprecation in one file leaves the other calling a model that no longer
 * exists, and only one of the two users of translation notices.
 *
 * So the client is a seam with a narrow interface, `generateJson`: a prompt in,
 * a schema-constrained JSON document out, retries included. Callers pick a
 * prompt and a response schema and never see the SDK.
 *
 * `parseJsonResponse` lives inside the seam rather than at the call sites so
 * that raw model text never crosses it. The text is a translation of what a
 * patient typed, and the one place it must not go is into an error message that
 * a caller might log or return.
 */

export const TRANSLATION_MODEL = "gemini-3-flash-preview";

/** The slice of `models.generateContent` this client depends on. */
export type GenerateContent = (params: {
  model: string;
  config: {
    thinkingConfig: { thinkingLevel: ThinkingLevel };
    responseMimeType: string;
    responseSchema: Schema;
  };
  contents: { role: string; parts: { text: string }[] }[];
}) => Promise<{ text?: string }>;

export interface JsonRequest {
  prompt: string;
  /** Constrains the reply. See ./llm/schema. */
  responseSchema: Schema;
}

export interface LlmClient {
  /**
   * Ask the model for JSON matching `responseSchema`.
   *
   * Throws on transport failure, on an exhausted retry budget, and on a reply
   * that is not a JSON document. Does not validate the document against the
   * caller's own schema: JSON mode constrains the shape, it does not make the
   * values correct, and the caller is the only one who knows what a valid value
   * is.
   */
  generateJson(request: JsonRequest): Promise<unknown>;
}

class GeminiClient implements LlmClient {
  constructor(
    private readonly generate: GenerateContent,
    private readonly policy: RetryPolicy,
  ) {}

  async generateJson({ prompt, responseSchema }: JsonRequest): Promise<unknown> {
    return withRetry(
      async () => {
        const response = await this.generate({
          model: TRANSLATION_MODEL,
          config: {
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.HIGH,
            },
            // JSON mode, not a JSON request in the prompt text: the API
            // constrains the decoder instead of the caller constraining a
            // regular expression against the model's prose.
            responseMimeType: "application/json",
            responseSchema,
          },
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
        });

        return parseJsonResponse(response.text);
      },
      this.policy,
    );
  }
}

/**
 * Build a client over any transport that speaks `generateContent`.
 *
 * The seam the tests use, and the hook an alternative provider would be
 * installed through. The policy is a parameter for the same reason: a test
 * should not have to wait out real backoff to assert that a retry happened.
 */
export function createGeminiClient(
  generate: GenerateContent,
  policy = TRANSLATION_RETRY_POLICY,
): LlmClient {
  return new GeminiClient(generate, policy);
}

let client: LlmClient | null = null;

/**
 * The shared client.
 *
 * Constructed lazily. This previously ran at module scope, so importing the
 * module built a client with an `undefined` key and logged "API key should be
 * set" during `next build` and on every cold start, deferring the real failure
 * to the first API call.
 */
export function getLlmClient(): LlmClient {
  if (!client) {
    const genai = new GoogleGenAI({ apiKey: getServerEnv().GEMINI_KEY });
    client = createGeminiClient((params) =>
      genai.models.generateContent(
        params as Parameters<typeof genai.models.generateContent>[0],
      ),
    );
  }
  return client;
}

/** Test seam. Mirrors setRateLimitStore. */
export function setLlmClient(next: LlmClient | null): void {
  client = next;
}
