import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/logger";
import { callerKey, enforceRateLimit } from "@/lib/rate-limit";
import { intakeSchema } from "@/lib/validation/intake";
import { parseJsonBody } from "@/lib/validation/parse";
import { bookAppointment } from "./book-appointment";
import { ConfirmationDeliveryError } from "./deliver-confirmation";

/**
 * The booking endpoint.
 *
 * One implementation, reachable at two URLs. POST /api/intake and
 * POST /api/appointments are the same handler by re-export, not by convention,
 * because a "we'll keep them in sync" comment is not a mechanism and the two
 * copies had already diverged.
 *
 * The limit is deliberately keyed on the same scope for both routes. If each
 * URL had kept its own counter, the stricter of the two limits would have been
 * free to bypass by posting to the other path: five per minute at
 * /api/intake and twenty at /api/appointments is one budget, not twenty-five.
 * The stricter limit is the real one, because each accepted request costs a
 * Gemini call and a Resend email.
 */

const BOOKING_LIMIT = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function handleBooking(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceRateLimit(
    callerKey(request, "intake"),
    BOOKING_LIMIT,
    RATE_LIMIT_WINDOW_MS,
  );
  if (limited) return limited;

  try {
    const parsed = await parseJsonBody(request, intakeSchema);
    if (!parsed.ok) return parsed.response;

    const booking = await bookAppointment(parsed.data, request.nextUrl.origin);

    return NextResponse.json({
      success: true,
      confirmationEmailSent: true,
      ...booking,
    });
  } catch (error) {
    logError("intake.failed", error);

    if (error instanceof ConfirmationDeliveryError) {
      // The record is stored; the confirmation is not on its way. Answering 200
      // with `success: true` here is what #20 was about, so the flag and the
      // status both say what happened, and the message says which half of the
      // booking went wrong.
      return NextResponse.json(
        {
          success: false,
          confirmationEmailSent: false,
          error:
            "The appointment was created but the confirmation email could not be sent",
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { success: false, error: "Failed to process form" },
      { status: 500 },
    );
  }
}
