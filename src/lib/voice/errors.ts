/**
 * What can go wrong on the way to a voice session, as types.
 *
 * One module so that the API routes, the credential client, and the intake
 * pipeline can all say the same thing about a failure and answer with the same
 * status. Three failures, deliberately, and they are not interchangeable:
 *
 *   - Not configured. `ELEVENLABS_API_KEY` is absent, so there is no way to
 *     talk to the vendor at all. A deployment fact, and the caller's request
 *     was fine.
 *   - Refused. The caller did not present a session it is entitled to. Not a
 *     vendor problem, and not worth a retry.
 *   - Vendor failure. Everything else: a 401 from the vendor, a 500, a body
 *     that is not what the API documents.
 *
 * Nothing here carries the vendor's response body, the API key, or an agent id.
 * These are thrown into route handlers that log them and turn them into status
 * codes, and all three of those places end up in a log drain.
 */

export class VoiceNotConfiguredError extends Error {
  constructor(message = "Voice is not configured on this deployment") {
    super(message);
    this.name = "VoiceNotConfiguredError";
  }
}

export class VoiceSessionRefusedError extends Error {
  constructor(message = "Not a valid voice session") {
    super(message);
    this.name = "VoiceSessionRefusedError";
  }
}

export class VendorRequestError extends Error {
  /**
   * The vendor's status, when it gave one.
   *
   * Kept because it is a number the vendor chose, and it is the difference
   * between "the key is wrong" and "the vendor is having a bad day", which are
   * different things to put in front of a caller. Nothing else about the
   * response is retained.
   */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "VendorRequestError";
    this.status = status;
  }
}
