import "server-only";

import { getServerEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";

/**
 * Twilio messaging: one client, two channels.
 *
 * SMS and WhatsApp are the same Twilio endpoint with a different addressing
 * scheme -- `whatsapp:+1555...` instead of `+1555...` -- so they are one client
 * with a `channel` on the request rather than two clients that could disagree
 * about credentials, timeouts, or how a failure is reported.
 *
 * The SDK is not used. The REST surface needed here is a single POST with a
 * form-encoded body, and taking a dependency for it would put a hundred
 * kilobytes of client in the server bundle for one call. The useful
 * consequence is the seam: `createTwilioMessagingClient(config, fetch)` takes
 * the transport, so the outbound request -- including the message body, which
 * is the thing with a privacy rule attached to it -- is asserted directly in a
 * test rather than mocked away.
 *
 * Nothing here logs or returns a vendor message. Twilio's error bodies quote
 * the message they rejected, and this message is patient-facing content, so a
 * failure comes back as `TwilioMessagingError` with the HTTP status and a fixed
 * sentence. A caller that wants to log something logs the status.
 */

export type TwilioMessageChannel = "sms" | "whatsapp";

/**
 * E.164: a country code, then up to 14 more digits, and nothing else.
 *
 * Exported because ./voice has to hold a number to the same standard and
 * "roughly a phone number" is not a standard. A message sent to a mistyped
 * number and a call placed to one are the same disclosure with a dial tone.
 */
export const E164 = /^\+[1-9]\d{6,14}$/;

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

/**
 * A send that is never left hanging on a request the patient is waiting for.
 *
 * Ten seconds is long enough for a vendor round trip and short enough that a
 * black-holed connection surfaces as a failure the caller can report rather
 * than a booking that times out.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** The sender, E.164, with any `whatsapp:` prefix already removed. */
  fromNumber: string;
}

export interface TwilioMessageRequest {
  channel: TwilioMessageChannel;
  /** E.164. Addresses the message, and is never part of the body. */
  to: string;
  body: string;
}

export interface TwilioMessageResult {
  sid: string;
  /** Twilio's own status word: queued, sent, delivered, or similar. */
  status: string;
}

export interface TwilioMessagingClient {
  /** Resolves when Twilio accepted the message. Throws otherwise. */
  sendMessage(request: TwilioMessageRequest): Promise<TwilioMessageResult>;
}

/**
 * A message Twilio did not accept, or a transport that never reached it.
 *
 * `statusCode` is undefined when the request never got an answer, which is the
 * difference between "Twilio said no" and "we could not ask". The message is
 * fixed text: see the module note on why the vendor's is dropped.
 */
export class TwilioMessagingError extends Error {
  constructor(readonly statusCode?: number) {
    super(
      statusCode === undefined
        ? "Twilio message could not be sent"
        : `Twilio rejected the message (status ${statusCode})`,
    );
    this.name = "TwilioMessagingError";
  }
}

const CHANNEL_PREFIX = /^(sms|whatsapp):/i;

/**
 * Separate a channel prefix from the address it qualifies.
 *
 * An address carrying a prefix this module does not know is returned untouched
 * with no prefix, which fails the E.164 check downstream. Interpreting
 * `messaging-service:SM...` as a phone number would be worse than refusing it.
 */
export function splitChannelPrefix(address: string): {
  prefix: TwilioMessageChannel | undefined;
  address: string;
} {
  const match = CHANNEL_PREFIX.exec(address);
  if (!match) return { prefix: undefined, address };
  return {
    prefix: match[1].toLowerCase() as TwilioMessageChannel,
    address: address.slice(match[0].length),
  };
}

/**
 * The configured Twilio transport, with the channel the sender implies.
 *
 * A resolved sender is also a channel decision, which is why the two live
 * together: `TWILIO_FROM_NUMBER=whatsapp:+1555...` is how an operator says
 * "send over WhatsApp", and a number without that prefix is a plain SMS
 * sender. One variable, no second one to keep in agreement with the first.
 */
export interface TwilioMessaging {
  channel: TwilioMessageChannel;
  /** The sender address, prefix removed. */
  from: string;
  client: TwilioMessagingClient;
}

export function createTwilioMessagingClient(
  config: TwilioConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): TwilioMessagingClient {
  const endpoint = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const authorization = `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`;

  return {
    async sendMessage({ channel, to, body }: TwilioMessageRequest): Promise<TwilioMessageResult> {
      const form = new URLSearchParams({
        From: addressFor(config.fromNumber, channel),
        To: addressFor(to, channel),
        Body: body,
      });

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {
        throw new TwilioMessagingError();
      });

      if (!response.ok) {
        // The body is not read. It is the vendor's account of the message it
        // rejected, which is the message.
        throw new TwilioMessagingError(response.status);
      }

      const accepted = (await response.json().catch(() => null)) as {
        sid?: string;
        status?: string;
      } | null;

      return { sid: accepted?.sid ?? "", status: accepted?.status ?? "" };
    },
  };
}

/**
 * Qualify an address for the channel it is being sent on.
 *
 * WhatsApp is addressed by prefix, because that is how Twilio distinguishes a
 * WhatsApp message from a text one. SMS is sent as a bare number: Twilio
 * accepts an `sms:` prefix, and omitting it keeps the ordinary case looking
 * like the number an operator would recognise in the Twilio console.
 */
function addressFor(address: string, channel: TwilioMessageChannel): string {
  const bare = splitChannelPrefix(address).address;
  return channel === "whatsapp" ? `whatsapp:${bare}` : bare;
}

let injected: TwilioMessaging | null = null;

/**
 * The transport for this request, or null when messaging is not configured.
 *
 * Null is the answer for the ordinary deployment, where the TWILIO_* variables
 * are absent and the confirmation goes out by email exactly as it always did.
 * A half-configured environment is also null, deliberately: a missing auth
 * token is a configuration mistake to be logged, not a send to attempt.
 *
 * Not cached. `getServerEnv` caches the parsed environment, and a cached client
 * on top of it would keep a messaging transport alive after the variables it
 * was built from are gone -- which is exactly the state a test asserts against.
 */
export function getTwilioMessaging(): TwilioMessaging | null {
  if (injected) return injected;

  const env = getServerEnv();
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const configuredFrom = env.TWILIO_FROM_NUMBER?.trim() ?? "";

  const present = [accountSid, authToken, configuredFrom].filter((value) => value !== "").length;
  if (present === 0) return null;

  if (present < 3) {
    // The variable names are not logged, only that the set is incomplete. A
    // config key is not PHI, but the habit of writing values into log lines is
    // what put patient records there in the first place.
    logWarn("twilio.incomplete_configuration", { status: "skipped" });
    return null;
  }

  const { prefix, address } = splitChannelPrefix(configuredFrom);
  if (!E164.test(address)) {
    logWarn("twilio.invalid_sender", { status: "skipped" });
    return null;
  }

  return {
    channel: prefix ?? "sms",
    from: address,
    client: createTwilioMessagingClient({ accountSid, authToken, fromNumber: address }),
  };
}

/** Test seam. Mirrors setLlmClient. */
export function setTwilioMessaging(next: TwilioMessaging | null): void {
  injected = next;
}
