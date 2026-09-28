/**
 * The intake endpoint.
 *
 * The implementation moved to ../_lib/handle-booking so that /api/intake and
 * /api/appointments are one handler rather than two that happen to agree.
 * Everything about the request is handled there: rate limiting, strict schema
 * validation, translation, storage, the sealed spectate URL, and the internal
 * confirmation webhook.
 */
export { handleBooking as POST } from "../_lib/handle-booking";
