import "server-only";

import { getServerEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { E164, splitChannelPrefix, type FetchLike } from "./messaging";

/**
 * Twilio voice: one outbound call, to one line, with TwiML.
 *
 * A sibling of ./messaging rather than a branch of it. SMS and WhatsApp are the
 * same endpoint with a different addressing scheme, and this is a different
 * endpoint entirely -- `Calls.json` rather than `Messages.json`, and it takes a
 * URL to fetch rather than a body to deliver. What the two share is the thing
 * worth sharing: the same credentials, the same sender, the same `fetch`
 * injection seam, the same refusal to put a vendor's own words in an error.
 *
 * The SDK is still not used, and the reason from ./messaging holds with more
 * force here: the REST surface is one form-encoded POST, and a dependency for
 * it would put a hundred kilobytes of Twilio client in the server bundle to
 * save writing four fields. There is a second reason specific to this file.
 * Twilio's SDK ships a request validator with its own idea of how a signature
 * is computed, and the signature scheme it implements for form-encoded
 * callbacks is not the one HMAC-SHA256 over a JSON body would produce. Taking
 * the SDK would mean either trusting a validator this repository cannot test
 * against a real Twilio account, or replacing it anyway -- so the transport is
 * hand-rolled and the signature scheme is implemented, and asserted, in
 * @/lib/webhook/verify where the rest of that problem already lives.
 *
 * ## What this client will not do
 *
 * It will not dial a number it was not configured with, and it will not build a
 * URL out of anything a request carried. The `twimlUrl` a caller passes has to
 * be absolute https on a host this deployment chose: Twilio fetches it, from
 * outside, and a TwiML document fetched from a URL an anonymous caller chose is
 * a document this application executed on someone else's instructions. The
 * check is in ./clinic-call, which is the only caller, because that is where
 * the configured base URL lives.
 *
 * Nothing here logs or returns a vendor body. A Twilio error quotes the request
 * it rejected, and for a call that request is two phone numbers.
 */

const TWILIO_CALLS_BASE = "https://api.twilio.com/2010-04-01";

/**
 * A call that is never left hanging on a booking a patient is waiting for.
 *
 * The same ten seconds as ./messaging. Twilio answers this endpoint as soon as
 * the call is queued, not when it connects, so this is a vendor round trip and
 * not a wait for a receptionist to pick up.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface TwilioVoiceConfig {
  accountSid: string;
  authToken: string;
  /** The number the call comes from, E.164, with any channel prefix removed. */
  fromNumber: string;
  /** The clinic's line, E.164. The only destination this client will dial. */
  toNumber: string;
  /** Absolute https origin Twilio fetches this application's TwiML from. */
  callbackBaseUrl: string;
}

export interface TwilioCallRequest {
  /** E.164. Never anything this application received from a request. */
  to: string;
  /** E.164. The configured sender. */
  from: string;
  /** Absolute https URL Twilio fetches its instructions from. */
  twimlUrl: string;
  /**
   * Absolute https URL Twilio posts call status to.
   *
   * Omitted rather than blanked when absent: `StatusCallback=` is a URL Twilio
   * will try to fetch, and an empty one is a request it cannot make. Omitting
   * the field is the documented way to say "do not call me back".
   */
  statusCallback?: string;
}

export interface TwilioCallResult {
  /** Twilio's call SID. A vendor identifier; never a patient identifier. */
  sid: string;
  /** Twilio's own status word: queued, ringing, in-progress, completed. */
  status: string;
}

export interface TwilioVoiceClient {
  /** Resolves when Twilio accepted the call. Throws otherwise. */
  placeCall(request: TwilioCallRequest): Promise<TwilioCallResult>;
}

/**
 * A call Twilio did not accept, or a transport that never reached it.
 *
 * `statusCode` is undefined when the request never got an answer, which is the
 * difference between "Twilio said no" and "we could not ask". The message is
 * fixed text, for the reason the module note gives: the vendor's body quotes
 * the numbers the call was to.
 */
export class TwilioCallError extends Error {
  constructor(readonly statusCode?: number) {
    super(
      statusCode === undefined
        ? "Twilio call could not be placed"
        : `Twilio rejected the call (status ${statusCode})`,
    );
    this.name = "TwilioCallError";
  }
}

export function createTwilioVoiceClient(
  config: TwilioVoiceConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): TwilioVoiceClient {
  const endpoint = `${TWILIO_CALLS_BASE}/Accounts/${encodeURIComponent(config.accountSid)}/Calls.json`;
  const authorization = `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`;

  return {
    async placeCall({ to, from, twimlUrl, statusCallback }: TwilioCallRequest): Promise<TwilioCallResult> {
      const form = new URLSearchParams({ From: from, To: to, Url: twimlUrl });

      // Two events rather than four. This application wants to know that a call
      // was placed (`initiated`, which is the record that a call happened) and
      // that it is over (`completed`, which is the record that the bill stopped).
      // `ringing` and `answered` are the vendor narrating a call this app cannot
      // influence, and each one is a request to store.
      if (statusCallback !== undefined) {
        form.set("StatusCallback", statusCallback);
        form.set("StatusCallbackEvent", "initiated completed");
      }

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => {
        throw new TwilioCallError();
      });

      if (!response.ok) {
        // The body is not read. It is the vendor's account of the call it
        // rejected, and the call is two phone numbers.
        throw new TwilioCallError(response.status);
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
 * The voice transport this deployment has, if it has one.
 *
 * The same shape as `getTwilioMessaging`, and the same rule: all five variables
 * or none. A partial set is a configuration mistake to be logged, not a call to
 * attempt -- and here the failure mode of guessing is a telephone call to
 * whoever's number was left in the variable, which is why the sender and the
 * clinic number are both re-read rather than defaulted.
 *
 * `TWILIO_CLINIC_NUMBER` and `TWILIO_CALLBACK_BASE_URL` are new. The first says
 * who to ring; the second says where Twilio fetches this application's TwiML
 * from, which cannot be derived from the request that triggered the call: that
 * request's `Host` header is chosen by the client, and Twilio is not the
 * client.
 */
export interface TwilioVoice {
  /** E.164, prefix removed. */
  from: string;
  /** E.164. The clinic. */
  to: string;
  /** Absolute https origin, no trailing slash. */
  callbackBaseUrl: string;
  client: TwilioVoiceClient;
}

export function getTwilioVoice(): TwilioVoice | null {
  if (injected) return injected;

  // Caught, not propagated. Every other reader of `getServerEnv` in this
  // directory lets a rejected environment throw, because those callers are
  // asked whether a feature is available. This one is reached from the booking
  // pipeline, where the alternative to a decision about telephony is a patient
  // whose booking throws over a malformed optional variable.
  let env: ReturnType<typeof getServerEnv>;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }

  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const configuredFrom = env.TWILIO_FROM_NUMBER?.trim() ?? "";
  const clinicNumber = env.TWILIO_CLINIC_NUMBER?.trim() ?? "";
  const callbackBaseUrl = env.TWILIO_CALLBACK_BASE_URL?.trim() ?? "";

  const required = [accountSid, authToken, configuredFrom, clinicNumber, callbackBaseUrl];
  const present = required.filter((value) => value !== "").length;
  if (present === 0) return null;

  if (present < required.length) {
    // Which variables are missing is not logged, only that the set is
    // incomplete. See ./messaging for why the names stay out of the line.
    logWarn("twilio.voice_incomplete_configuration", { status: "skipped" });
    return null;
  }

  // The messaging sender may be `whatsapp:+1...`. That prefix is a channel
  // decision for a text message and is not part of a dialable number, so it is
  // removed here rather than refused: an operator who has one Twilio number for
  // both should not have to buy a second.
  const { address: from } = splitChannelPrefix(configuredFrom);
  if (!E164.test(from) || !E164.test(clinicNumber)) {
    logWarn("twilio.voice_invalid_number", { status: "skipped" });
    return null;
  }

  const origin = readHttpsOrigin(callbackBaseUrl);
  if (!origin) {
    logWarn("twilio.voice_invalid_callback_base", { status: "skipped" });
    return null;
  }

  return {
    from,
    to: clinicNumber,
    callbackBaseUrl: origin,
    client: createTwilioVoiceClient({ accountSid, authToken, fromNumber: from, toNumber: clinicNumber, callbackBaseUrl: origin }),
  };
}

/**
 * An absolute https origin, or null.
 *
 * Scheme, host and nothing else. A path, a query or a fragment in this variable
 * would produce callback URLs that are subtly not the ones the operator
 * configured, so what survives is the origin and the rest is dropped rather
 * than appended to.
 */
function readHttpsOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname === "") return null;
  // Credentials in a URL are a way to put a secret in a log line and an access
  // log. There is no reason for one to be here.
  if (parsed.username !== "" || parsed.password !== "") return null;

  return `${parsed.protocol}//${parsed.host}`;
}

let injected: TwilioVoice | null = null;

/** Test seam. Mirrors setTwilioMessaging. */
export function setTwilioVoice(next: TwilioVoice | null): void {
  injected = next;
}
