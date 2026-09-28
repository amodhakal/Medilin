import { NextRequest, NextResponse } from "next/server";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";
import { parseJsonBody } from "@/lib/validation/parse";
import { webhookPayloadSchema } from "@/lib/validation/intake";

export async function POST(request: NextRequest) {
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

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "Webhook endpoint working",
  });
}
