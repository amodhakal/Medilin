import { NextRequest, NextResponse } from "next/server";
import { createAppointment, getAppointment } from "@/lib/appointments";
import { appointmentRequestSchema } from "@/lib/validation/intake";
import { parseJsonBody } from "@/lib/validation/parse";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { logInfo } from "@/lib/logger";
import { sealRecord } from "@/lib/phi-token";

const APPOINTMENTS_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(
    callerKey(request, "appointments"),
    APPOINTMENTS_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(request, appointmentRequestSchema);
  if (!parsed.ok) return parsed.response;

  const patientInfo = parsed.data;
  const appointment = createAppointment(patientInfo);

  const { email, language } = patientInfo;

  const token = sealRecord(JSON.stringify(patientInfo));
  const spectateUrl = `${request.nextUrl.origin}/spectate/${token}`;

  // Was a decorative banner printing the whole patient record serialised with
  // indentation, the email address, and the spectate URL, on every request.
  logInfo("appointment.created", { appointmentId: appointment.id, language });

  return NextResponse.json({
    id: appointment.id,
    url: spectateUrl,
    patientInfo: patientInfo,
    email: email,
    language: language,
    message: "Appointment created.",
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "id is required" },
      { status: 400 }
    );
  }

  const appointment = getAppointment(id);

  if (!appointment) {
    return NextResponse.json(
      { error: "Appointment not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(appointment);
}
