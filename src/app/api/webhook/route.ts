import { NextRequest, NextResponse } from "next/server";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";
import { parseJsonBody } from "@/lib/validation/parse";
import { webhookPayloadSchema } from "@/lib/validation/intake";
import { requireInternalSecret } from "@/lib/auth/internal";
import { logError, logInfo } from "@/lib/logger";
import type { SupportedLanguage } from "@/lib/validation/intake";

export async function POST(request: NextRequest) {
  // Authenticate before anything else. Without this the endpoint is an open
  // mail relay: anyone could POST an address and a message and have the app
  // send it through Resend.
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  // Hoisted so the catch block can report the language without restating a
  // value it never received.
  let language: SupportedLanguage | undefined;

  try {
    const parsed = await parseJsonBody(request, webhookPayloadSchema);
    if (!parsed.ok) return parsed.response;

    language = parsed.data.language;
    const { email, info } = parsed.data;

    logInfo("webhook.received", { language });

    const { subject, body } = await translateFromEnglish(info, language);

    const resend = new Resend(getServerEnv().RESEND_KEY);

    const { data, error } = await resend.emails.send({
      from: getEmailFrom(),
      to: [email],
      subject: subject,
      html: body,
    });

    if (error) {
      logError("webhook.resend_failed", error, { language });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    logInfo("webhook.sent", { subject });

    return NextResponse.json({
      success: true,
      email,
      subject,
    });
  } catch (error) {
    logError("webhook.failed", error, { language });
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}

/**
 * Liveness only. Deliberately reports nothing about configuration or
 * upstream services, since this is reachable without a credential.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
