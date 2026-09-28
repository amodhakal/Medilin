import { NextRequest, NextResponse } from "next/server";
import { translateToEnglish } from "@/lib/translateToEnglish";
import { createAppointment } from "@/lib/appointments";
import { getClinicName } from "@/config";
import { intakeSchema } from "@/lib/validation/intake";
import { parseJsonBody } from "@/lib/validation/parse";
import { internalHeaders } from "@/lib/auth/internal";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { logError, logInfo } from "@/lib/logger";

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
    logInfo("intake.received", { language: sourceLanguage });

    const translatedData = await translateToEnglish(data, sourceLanguage);
    logInfo("intake.translated", { language: sourceLanguage });

    const appointment = createAppointment(translatedData);

    const baseUrl = request.nextUrl.origin;
    const encodedPatientInfo = encodeURIComponent(
      JSON.stringify(translatedData),
    );
    const spectateUrl = `${baseUrl}/spectate/${appointment.id}?patientInfo=${encodedPatientInfo}`;

    // The spectate URL is deliberately not logged. It carries the appointment
    // id and, for now, the whole record; logging it puts a joinable patient
    // identifier into a log store. The record stops being in the URL in the
    // next commit on this branch.
    logInfo("intake.session_url_created", { appointmentId: appointment.id });

    const mockHospitalResponse = {
      patientInfo: translatedData,
      agreedDateTime: new Date(
        Date.now() + Math.floor(Math.random() * 86400000),
      ).toISOString(),
      confirmed: true,
      hospitalName: getClinicName(),
      referenceNumber: `HOSP-${appointment.id}`,
    };

    logInfo("intake.booking_simulated", { appointmentId: appointment.id });

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
    logError("intake.failed", error);
    return NextResponse.json(
      { success: false, error: "Failed to process form" },
      { status: 500 },
    );
  }
}
