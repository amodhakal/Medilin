import { afterEach, describe, expect, test } from "bun:test";
import { ThinkingLevel, Type, type Schema } from "@google/genai";
import {
  createGeminiClient,
  setLlmClient,
  TRANSLATION_MODEL,
  type GenerateContent,
  type JsonRequest,
} from "./gemini";
import type { RetryPolicy } from "./llm/retry";

/**
 * The client seam, with the SDK replaced by a fake transport.
 *
 * A live Gemini call cannot be unit-tested, so what is tested here is the part
 * this app is responsible for: that every translation goes through one client,
 * that the request carries the model id, JSON mode, and the caller's response
 * schema, and that the reply comes back as a document. See also
 * translateToEnglish.test.ts and translateFromEnglish.test.ts, which stand in
 * for this client entirely.
 */

const schema: Schema = {
  type: Type.OBJECT,
  properties: { subject: { type: Type.STRING } },
  required: ["subject"],
};

const request: JsonRequest = { prompt: "prompt text", responseSchema: schema };

/** A policy that fails fast, so a retry assertion costs no real time. */
const fastPolicy: RetryPolicy = {
  label: "Translation",
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  totalBudgetMs: 1000,
};

interface Recorded {
  model: string;
  config: Record<string, unknown>;
  contents: { role: string; parts: { text: string }[] }[];
}

function recorder(reply: { text?: string }): {
  sent: Recorded[];
  generate: GenerateContent;
} {
  const sent: Recorded[] = [];
  return {
    sent,
    generate: async (params) => {
      sent.push(params as unknown as Recorded);
      return reply;
    },
  };
}

afterEach(() => {
  setLlmClient(null);
});

describe("createGeminiClient", () => {
  test("requests JSON mode from the API rather than asking in prose", async () => {
    // The end-to-end assertion for #30: no part of the app looks for braces in
    // the reply any more, because the reply is a document by construction.
    const { sent, generate } = recorder({ text: '{"subject":"ok"}' });

    await createGeminiClient(generate).generateJson(request);

    expect(sent).toHaveLength(1);
    expect(sent[0].config.responseMimeType).toBe("application/json");
    expect(sent[0].config.responseSchema).toEqual(schema);
    expect(sent[0].model).toBe(TRANSLATION_MODEL);
    expect(sent[0].contents).toEqual([
      { role: "user", parts: [{ text: "prompt text" }] },
    ]);
  });

  test("keeps the configured thinking level", async () => {
    const { sent, generate } = recorder({ text: "{}" });

    await createGeminiClient(generate).generateJson(request);

    expect(sent[0].config.thinkingConfig).toEqual({
      thinkingLevel: ThinkingLevel.HIGH,
    });
  });

  test("parses the reply into a document", async () => {
    const { generate } = recorder({
      text: '{"subject":"Your appointment","body":"<p>Tuesday</p>"}',
    });

    const result = await createGeminiClient(generate).generateJson(request);

    expect(result).toEqual({
      subject: "Your appointment",
      body: "<p>Tuesday</p>",
    });
  });

  test("retries a transport failure and succeeds", async () => {
    let calls = 0;
    const generate: GenerateContent = async () => {
      calls += 1;
      if (calls === 1) throw new Error("overloaded");
      return { text: '{"subject":"ok"}' };
    };

    const result = await createGeminiClient(generate, fastPolicy).generateJson(
      request,
    );

    expect(calls).toBe(2);
    expect(result).toEqual({ subject: "ok" });
  });

  test("gives up once the shared policy's budget is spent", async () => {
    let calls = 0;
    const generate: GenerateContent = async () => {
      calls += 1;
      throw new Error("overloaded");
    };

    await expect(
      createGeminiClient(generate, fastPolicy).generateJson(request),
    ).rejects.toThrow("Translation failed after 2 attempts: overloaded");
    expect(calls).toBe(2);
  });

  test("treats a non-JSON reply as a failure rather than returning text", async () => {
    // A caller that silently accepted this would merge a fenced code block
    // into a patient record.
    const { generate } = recorder({ text: "```json\n{\"subject\":\"ok\"}\n```" });

    await expect(
      createGeminiClient(generate, fastPolicy).generateJson(request),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("setLlmClient", () => {
  test("redirects every translation call, and null restores the real client", async () => {
    // The seam the translate modules are tested through. `null` is the reset,
    // not a client that returns nothing, so a test cannot leave a stub installed
    // for the next one.
    setLlmClient({
      async generateJson() {
        return { subject: "stubbed", body: "<p>stubbed</p>" };
      },
    });

    const { translateFromEnglish } = await import("./translateFromEnglish");
    expect(await translateFromEnglish("{}", "spanish")).toEqual({
      subject: "stubbed",
      body: "<p>stubbed</p>",
    });

    setLlmClient(null);
    expect(setLlmClient).toBeInstanceOf(Function);
  });
});
