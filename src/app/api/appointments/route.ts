import { NextRequest, NextResponse } from "next/server";
import { getAppointment } from "@/lib/appointments";
import { requireInternalSecret } from "@/lib/auth/internal";
import { logInfo } from "@/lib/logger";

/**
 * The appointments endpoint.
 *
 * POST used to be a second, lesser booking endpoint: no translation, so a
 * Spanish submission booked through it reached the confirmation email
 * untranslated, and it returned the entire patient record in the response
 * body, which is the one thing a booking response has no reason to do. It is
 * now the same handler as /api/intake, sharing its rate limit, so the old URL
 * keeps working for anything already posting to it and the two budgets cannot
 * be played off against each other. See ../_lib/handle-booking.
 *
 * GET stays, because looking an appointment up by id is a different capability
 * from making one. It now requires the internal secret. `getAppointment`
 * returns the full patient record, and the id is the only thing standing
 * between a caller and that record: uuidv4 is unguessable, not secret, and the
 * ids are handed out in booking responses. The spectate page does not use this
 * -- it reads a sealed token -- so nothing in the app depends on it being open.
 *
 * The response is the whole appointment, which now includes `status` and
 * `updatedAt` as well as the record. That is the status lookup: an id, the
 * state it is in, and when it last changed, and none of it requires a second
 * endpoint to be added later.
 */
export { handleBooking as POST } from "../_lib/handle-booking";

export async function GET(request: NextRequest) {
  const guard = requireInternalSecret(request);
  if (!guard.ok) return guard.response;

  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Awaited rather than read synchronously: a durable store is a network round
  // trip, and a synchronous signature over one would either block the event
  // loop or hide the await behind a promise nobody checks.
  const appointment = await getAppointment(id);

  if (!appointment) {
    return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
  }

  logInfo("appointment.read", { appointmentId: appointment.id });

  return NextResponse.json(appointment);
}
