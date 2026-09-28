import { getLlmClient } from "@/lib/gemini";
import { buildEmailTranslationPrompt } from "@/lib/llm/prompt";
import {
  EMAIL_RESPONSE_SCHEMA,
  emailTranslationSchema,
  type EmailTranslation,
} from "@/lib/llm/schema";
import type { SupportedLanguage } from "@/lib/validation/intake";

/**
 * Write a confirmation email in the patient's language.
 *
 * What is left here after #41 is the part that is specific to this call: which
 * prompt, which schema, and the check that the reply is an email. The SDK, the
 * model id, the JSON mode, the retry budget and the response parsing all belong
 * to the shared client, so this file can no longer disagree with the intake
 * translation about any of them.
 *
 * The empty-text short circuit stays: an empty record is not a translation task
 * and should not cost a paid call. It returns empty strings, which the caller
 * treats as "nothing to send".
 */
export async function translateFromEnglish(
  text: string,
  targetLanguage: SupportedLanguage,
): Promise<EmailTranslation> {
  if (!text || text.trim() === "") {
    return { subject: "", body: "" };
  }

  const reply = await getLlmClient().generateJson({
    prompt: buildEmailTranslationPrompt(text, targetLanguage),
    responseSchema: EMAIL_RESPONSE_SCHEMA,
  });

  // Constrained decoding constrains the shape; it does not guarantee a usable
  // email. Previously this returned `parsed.subject` and `parsed.body` off an
  // unchecked parse, so a reply missing either field sent `undefined` to
  // Resend as a subject line.
  return emailTranslationSchema.parse(reply);
}
