import { NextRequest, NextResponse } from "next/server";
import { translateFromEnglish } from "@/lib/translateFromEnglish";
import { Resend } from "resend";
import { getEmailFrom } from "@/config";
import { getServerEnv } from "@/lib/env";

export async function POST(request: NextRequest) {
  try {
    const requestBody = await request.json();
    const { email, language, info } = requestBody;

    if (!email || !language || !info) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: email, language, and info are required",
        },
        { status: 401 },
      );
    }

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
