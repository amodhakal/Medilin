import { NextRequest, NextResponse } from "next/server";
import { translateToEnglish } from "@/lib/translateToEnglish";
import { createAppointment } from "@/lib/appointments";
import { getClinicName } from "@/config";
import { intakeSchema } from "@/lib/validation/intake";
import { parseJsonBody } from "@/lib/validation/parse";
import { internalHeaders } from "@/lib/auth/internal";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";

const INTAKE_LIMIT = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  // Each accepted request costs a Gemini call and a Resend email, and the
  // translation helpers retry up to ten times on failure, so an unthrottled
  // client can burn the whole budget in a loop.
  const limited = await enforceRateLimit(callerKey(request, "intake"), INTAKE_LIMIT, RATE_LIMIT_WINDOW_MS);
  if (limited) return limited;

  try {
    const parsed = await parseJsonBody(request, intakeSchema);
    if (!parsed.ok) return parsed.response;

    const data = parsed.data;
    const sourceLanguage = data.language;
    console.log("Processing intake form from:", sourceLanguage, data);

    const translatedData = await translateToEnglish(data, sourceLanguage);
    console.log("Converted into English:", translatedData);

    const appointment = createAppointment(translatedData);

    const baseUrl = request.nextUrl.origin;
    const encodedPatientInfo = encodeURIComponent(
      JSON.stringify(translatedData),
    );
    const spectateUrl = `${baseUrl}/spectate/${appointment.id}?patientInfo=${encodedPatientInfo}`;

    console.log("Spectate URL:", spectateUrl);

    const mockHospitalResponse = {
      patientInfo: translatedData,
      agreedDateTime: new Date(
        Date.now() + Math.floor(Math.random() * 86400000),
      ).toISOString(),
      confirmed: true,
      hospitalName: getClinicName(),
      referenceNumber: `HOSP-${appointment.id}`,
    };

    console.log("Hospital response:", mockHospitalResponse);

    const webhookUrl = `${request.nextUrl.origin}/api/webhook`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({
        email: translatedData.email,
        language: sourceLanguage,
        info: JSON.stringify(mockHospitalResponse),
      }),
    });

    return NextResponse.json({
      success: true,
      appointmentId: appointment.id,
      spectateUrl: spectateUrl,
    });
  } catch (error) {
    console.error("Translation error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process form" },
      { status: 500 },
    );
  }
}
