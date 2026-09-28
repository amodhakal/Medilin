import "server-only";

import { getPatientAgentId, getReceptionistAgentId } from "@/config";
import { openRecord } from "@/lib/phi-token";
import {
  getElevenLabsClient,
  isVoiceConfigured,
  type SignedConversation,
} from "./elevenlabs";
import { VoiceNotConfiguredError, VoiceSessionRefusedError } from "./errors";

/** Re-exported for callers that catch this module's failures from one place. */
export { VoiceSessionRefusedError, VoiceNotConfiguredError, VendorRequestError } from "./errors";

/**
 * Who is allowed a voice session, and which agent they get.
 *
 * This module is the whole of the answer to #15 on the server. An agent id is
 * configuration, it is read here and nowhere else, and what leaves the process
 * in its place is a signed conversation URL with a minute on the clock. The
 * alternative -- and the previous design -- was to put the id in the page and
 * let the browser assemble a vendor URL from it.
 *
 * Two decisions are load-bearing:
 *
 *   1. The side is chosen by the caller, the agent by this module. A caller
 *      that could name an agent id would name the other one, so the parameter is
 *      a two-value union and the resolution is a `switch`, not a lookup of a
 *      caller-supplied string.
 *   2. A session requires the sealed token of a booked appointment. The
 *      spectate link is a bearer credential for one patient's appointment, and
 *      it is the only thing this app already knows that belongs to a patient who
 *      has actually booked. Without that check, "mint me a conversation URL" is
 *      an open endpoint on a paid account: a valid signature obtained by an
 *      anonymous caller is a valid signature.
 */

export const VOICE_SIDES = ["patient", "receptionist"] as const;

export type VoiceSide = (typeof VOICE_SIDES)[number];

/**
 * Narrow a caller-supplied side.
 *
 * `Object.hasOwn` on the tuple's values, which is a real membership test.
 * A plain `includes` on a string typed as `VoiceSide` would be a cast, and the
 * cast is where "and the receptionist agent" would become reachable.
 */
export function isVoiceSide(value: string): value is VoiceSide {
  return (VOICE_SIDES as readonly string[]).includes(value);
}

/** The configured agent for one side. The only place agent ids are read. */
export function agentIdForSide(side: VoiceSide): string {
  return side === "patient" ? getPatientAgentId() : getReceptionistAgentId();
}

/**
 * Is this the sealed token of a booked appointment?
 *
 * Deliberately a boolean over a full parse. The caller does not need the
 * record, and a session does not need to be tied to one field of it: what it
 * needs to know is whether the credential behind the request is a real booking
 * or a guess. The three fields checked are the ones the booking pipeline cannot
 * produce a record without, so their presence is a proxy for "this decrypts to
 * something this app wrote".
 *
 * Every failure mode of `openRecord` is already collapsed to null, which is the
 * right behaviour for a caller: truncated, tampered, sealed under a different
 * key, and minted by an older version are all "not a session", and
 * distinguishing them tells an attacker which one they managed.
 */
export function isBookedAppointment(token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;

  const plaintext = openRecord(token);
  if (!plaintext) return false;

  let record: unknown;
  try {
    record = JSON.parse(plaintext);
  } catch {
    return false;
  }

  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;

  const candidate = record as Record<string, unknown>;
  return (
    typeof candidate.firstName === "string" &&
    candidate.firstName.length > 0 &&
    typeof candidate.lastName === "string" &&
    candidate.lastName.length > 0 &&
    typeof candidate.email === "string" &&
    candidate.email.length > 0
  );
}

/**
 * Mint a signed conversation URL for one side of a booked appointment.
 *
 * Throws `VoiceSessionRefusedError` for a token that is not a booking,
 * `VoiceNotConfiguredError` when this deployment has no API key, and whatever
 * the credential client throws otherwise.
 *
 * Checks in that order, and the order is the point: the cheapest check that can
 * refuse a caller comes first, so an anonymous caller cannot make this server
 * spend a vendor request, and an unconfigured deployment never reaches the
 * network at all.
 *
 * The configured check is here rather than left to the client, so that the
 * guarantee is this module's and not the transport's. The client also refuses,
 * and it must: it is the only thing that ever sees the key. But a client that
 * is replaced, in a test or by a future vendor, cannot then be the reason a
 * deployment with no key starts dialling a paid account.
 */
export async function issueVoiceSession({
  side,
  sessionToken,
}: {
  side: VoiceSide;
  sessionToken: string;
}): Promise<SignedConversation> {
  if (!isBookedAppointment(sessionToken)) {
    throw new VoiceSessionRefusedError();
  }

  if (!isVoiceConfigured()) {
    throw new VoiceNotConfiguredError();
  }

  return getElevenLabsClient().mintConversationUrl({ agentId: agentIdForSide(side) });
}
