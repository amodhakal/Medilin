import { NextRequest, NextResponse } from "next/server";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";
import { parseJsonBody } from "@/lib/validation/parse";
import { webhookPayloadSchema } from "@/lib/validation/intake";
import { requireInternalSecret } from "@/lib/auth/internal";

export async function POST(request: NextRequest) {
  // Authenticate before anything else. Without this the endpoint is an open
  // mail relay: anyone could POST an address and a message and have the app
  // send it through Resend.
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  try {
    const parsed = await parseJsonBody(request, webhookPayloadSchema);
    if (!parsed.ok) return parsed.response;

    const { email, language, info } = parsed.data;

    console.log(
      `Webhook original: `,
      JSON.stringify({ email, language, info }),
    );

    const { subject, body } = await translateFromEnglish(info, language);

    const resend = new Resend(getServerEnv().RESEND_KEY);

    const { data, error } = await resend.emails.send({
      from: getEmailFrom(),
      to: [email],
      subject: subject,
      html: body,
    });

    if (error) {
      console.error("Resend error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`Email sent to ${email}:`, data);

    return NextResponse.json({
      success: true,
      email,
      subject,
    });
  } catch (error) {
    console.error("Webhook error:", error);
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
