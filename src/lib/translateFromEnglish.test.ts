import { afterEach, describe, expect, test } from "bun:test";
import { setLlmClient, type JsonRequest, type LlmClient } from "./gemini";
import { translateFromEnglish } from "./translateFromEnglish";

/**
 * The email translation, with the shared Gemini client replaced by a stub.
 *
 * The call itself is not interesting; what matters is what this function does
 * with a reply once the client has handed it back, and that it does not call the
 * model at all in the cases where an answer is already known.
 */

let calls: JsonRequest[] = [];

function stub(reply: unknown | (() => never)): void {
  calls = [];
  const client: LlmClient = {
    async generateJson(request) {
      calls.push(request);
      if (typeof reply === "function") reply();
      return reply;
    },
  };
  setLlmClient(client);
}

afterEach(() => {
  setLlmClient(null);
});

describe("translateFromEnglish", () => {
  test("returns the subject and body from a well-formed reply", async () => {
    stub({ subject: "Your appointment", body: "<p>Tuesday at 09:30</p>" });

    const result = await translateFromEnglish("{}", "spanish");

    expect(result).toEqual({
      subject: "Your appointment",
      body: "<p>Tuesday at 09:30</p>",
    });
  });

  test("asks for the target language and fences the record", async () => {
    stub({ subject: "s", body: "<p>b</p>" });

    await translateFromEnglish("{\"firstName\":\"Ada\"}", "portuguese");

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Write the email in portuguese");
    expect(calls[0].prompt).toContain("<<<UNTRUSTED_PATIENT_INPUT:appointment>>>");
    expect(calls[0].responseSchema.required).toEqual(["subject", "body"]);
  });

  test("returns empty strings for empty text without calling the model", async () => {
    // An empty record is not a translation task, and it should not cost a call.
    stub(() => {
      throw new Error("should not be called");
    });

    expect(await translateFromEnglish("", "spanish")).toEqual({
      subject: "",
      body: "",
    });
    expect(await translateFromEnglish("   ", "spanish")).toEqual({
      subject: "",
      body: "",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["a missing body", { subject: "Your appointment" }],
    ["a missing subject", { body: "<p>Tuesday</p>" }],
    ["a blank subject", { subject: "  ", body: "<p>Tuesday</p>" }],
    ["an extra key", { subject: "s", body: "<p>b</p>", to: ["attacker@example.test"] }],
  ])("throws on a reply with %s", async (_label, reply) => {
    // Previously these went straight to Resend: the function returned
    // `parsed.subject` and `parsed.body` off an unchecked parse, so both were
    // `any` and a missing subject was sent as `undefined`.
    stub(reply);

    await expect(translateFromEnglish("{}", "spanish")).rejects.toThrow();
  });

  test("trims the subject", async () => {
    stub({ subject: "  Your appointment  ", body: "<p>Tuesday</p>" });

    const result = await translateFromEnglish("{}", "spanish");

    expect(result.subject).toBe("Your appointment");
  });
});
