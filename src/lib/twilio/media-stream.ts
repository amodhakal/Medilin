import "server-only";

import { getServerEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { getReceptionistAgentId } from "@/config";
import { getElevenLabsClient, isVoiceConfigured } from "@/lib/voice/elevenlabs";

/**
 * Where a Twilio media stream is terminated, and why it is not here (#3).
 *
 * ## The constraint
 *
 * A Twilio media stream is a WebSocket that Twilio opens, that stays open for as
 * long as the call does, and that carries audio in both directions for every one
 * of those twenty-millisecond frames. Holding one means a long-lived process
 * with two open sockets per call and no request to return to. This application
 * is deployed to a serverless platform: no custom server, no state between
 * invocations, and an execution model in which a finished request is a dead
 * invocation. A WebSocket cannot be served here, and pretending otherwise
 * produces a route that accepts an upgrade request and then has nowhere to put
 * the audio.
 *
 * This is not a new constraint and not a new decision. The identical argument
 * was made and settled for the ElevenLabs socket in #15, and written down at
 * length in src/lib/voice/elevenlabs.ts and src/lib/voice/agent-socket.ts. The
 * answer there was a signed vendor URL rather than a proxy, with the reasoning
 * that a byte-pump proxy is not wrong, it is not deployable. The answer is the
 * same here and for the same reason: the socket lives in a long-lived service,
 * configured as `TWILIO_MEDIA_STREAM_URL`.
 *
 * ## What is therefore here
 *
 * Three things, and they are the three this application is actually for:
 *
 *   1. Verification of Twilio's requests, in @/lib/webhook/verify.
 *   2. The TwiML that hands Twilio a stream URL, in ./twiml.
 *   3. A short-lived signed conversation URL for the receptionist agent, minted
 *      here with the same client #15 built, and put in the stream URL.
 *
 * The bridge is a media pump: Twilio's frames in, the agent's audio back out,
 * using the codec in ./media-frames. It is not in this repository, it holds no
 * appointment data, and it is not needed at all for a deployment that leaves
 * `TWILIO_MEDIA_STREAM_URL` unset -- the call is then answered with the greeting
 * from the branch below, which is a working phone call.
 *
 * ## What is not here, and is the honest gap
 *
 * The conversation is not attached to a booking. The stream URL carries no
 * appointment reference, on purpose: a sealed patient token in a URL that
 * Twilio fetches, logs and stores would put PHI in three more places to serve a
 * bridge that has no use for it. So the agent negotiates a time out loud, and
 * the time in the patient's confirmation email is still the one
 * ../_lib/schedule.ts produced locally. Wiring the negotiated slot back onto the
 * appointment is a separate piece of work -- a status callback carrying the
 * agreed time, or a tool the agent can call -- and it is named as such in the
 * PR rather than left for someone to discover from a clinic's phone log.
 */

/** The query parameter the bridge reads the conversation lease out of. */
export const CONVERSATION_PARAM = "conversation";

export interface MediaStreamBridge {
  /** Absolute wss URL, path included. Never carries credentials. */
  url: string;
}

export interface MediaStreamSession {
  /** What goes in the `<Stream url>` attribute. */
  streamUrl: string;
  /**
   * When the conversation lease inside it stops working, in epoch ms. Taken from
   * the vendor lease, for the reason in ./voice: the response is a bare URL and
   * the request is the only statement about how long it lasts.
   */
  expiresAt: number;
}

/**
 * The bridge this deployment points at, or null.
 *
 * Null is the ordinary case, and it is not a degraded one: a clinic line that
 * answers with a spoken greeting is a telephone call, which is what the branch
 * below this one ships. Set the variable and the same call becomes a streamed
 * conversation with the receptionist agent.
 */
export function getMediaStreamBridge(): MediaStreamBridge | null {
  if (injected) return injected;

  // Guarded, like the other optional-feature readers in this directory: this is
  // reached from a route serving a live call, and a malformed optional variable
  // should not be the reason a clinic's line gets no instructions.
  let env: ReturnType<typeof getServerEnv>;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }

  const configured = env.TWILIO_MEDIA_STREAM_URL?.trim() ?? "";
  if (configured === "") return null;

  if (!isSafeStreamUrl(configured)) {
    logWarn("twilio.media_stream_invalid_url", { status: "skipped" });
    return null;
  }

  return { url: configured };
}

/**
 * Is this somewhere Twilio should open a WebSocket to?
 *
 * Absolute and `wss:`. The same rule as the callback base in ./voice, and for
 * the same reason with a larger prize: this URL carries every frame of a live
 * call's audio in both directions.
 */
export function isSafeStreamUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "wss:" || parsed.hostname === "") return false;
  // Credentials in a URL are a way to put a secret in an access log.
  return parsed.username === "" && parsed.password === "";
}

/**
 * Mint a stream session, or null when this deployment cannot have one.
 *
 * Null for the two configurations in which a stream would be worse than a
 * greeting: no bridge, and no voice agent to talk to. Both are ordinary -- they
 * are the default deployment and an ElevenLabs-less one respectively -- and the
 * caller falls back rather than failing the call.
 *
 * A failure from the vendor *propagates*, because it is not a configuration
 * fact: a voice API that refused a request should be visible in the response and
 * in the log, not quietly downgraded into "no bridge configured".
 */
export async function mintMediaStreamSession(): Promise<MediaStreamSession | null> {
  const bridge = getMediaStreamBridge();
  if (!bridge) return null;

  // The receptionist agent, and only the receptionist agent: this is a call to
  // the clinic. A patient agent on the clinic's line is a patient-shaped
  // conversation with a member of staff, which is not a thing this application
  // should be able to arrange by changing one variable.
  if (!isVoiceConfigured()) return null;

  const signed = await getElevenLabsClient().mintConversationUrl({
    agentId: getReceptionistAgentId(),
  });

  const streamUrl = new URL(bridge.url);
  streamUrl.searchParams.set(CONVERSATION_PARAM, signed.url);

  return { streamUrl: streamUrl.toString(), expiresAt: signed.expiresAt };
}

let injected: MediaStreamBridge | null = null;

/** Test seam. Mirrors setTwilioVoice. */
export function setMediaStreamBridge(next: MediaStreamBridge | null): void {
  injected = next;
}
