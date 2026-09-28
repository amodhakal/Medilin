import "server-only";

import { getServerEnv } from "@/lib/env";
import { VendorRequestError, VoiceNotConfiguredError } from "./errors";

/**
 * Re-exported so a caller has one import site for "the client and the failures
 * it can produce". Defined in ./errors rather than here so that the intake
 * pipeline in this directory can throw the same types without importing the
 * transport.
 */
export { VendorRequestError, VoiceNotConfiguredError, VoiceSessionRefusedError } from "./errors";

/**
 * The one place this app talks to ElevenLabs.
 *
 * The browser used to talk to it directly, from a WebSocket URL it assembled
 * out of an agent id it had been handed in the RSC payload. That put a
 * long-lived, freely reusable credential in every visitor's devtools (#15), and
 * the URL was the credential: `wss://...?agent_id=X` is dialable by anyone, for
 * as long as the agent exists, at the account's expense.
 *
 * So the vendor call moved here, behind the API key, and what comes back is a
 * *signed* conversation URL: short-lived, minted per request, and useless
 * without a signature that this server obtained with its own key. The agent id
 * is still visible in the URL the browser eventually dials -- the vendor's
 * protocol puts it there and no client library hides it -- but on its own it no
 * longer authorises anything. What a browser can now do is hold a door key for
 * the length of one session, which is the difference between a permanent
 * credential and a lease.
 *
 * The full fix for this issue is a byte-pump WebSocket proxy in front of the
 * vendor, which keeps even the id off the wire. That needs a long-lived Node
 * server holding two sockets per session, and this application is deployed to a
 * serverless platform with no custom server and no state between invocations
 * (see the notes on the in-memory appointment store and the rate-limit store in
 * this repo). A proxy was rejected on those grounds and the tradeoff is written
 * up in the PR.
 *
 * The transport is a constructor parameter, so every test in this repo runs
 * without an ElevenLabs account and without a network.
 */

export const SIGNED_CONVERSATION_ENDPOINT =
  "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url";

/** The host a signed conversation URL must be on. See `readSignedUrl`. */
const VENDOR_HOST = "api.elevenlabs.io";

/**
 * How long a minted conversation URL is good for, in seconds.
 *
 * A minute. Long enough that a user who reads the room before pressing Start is
 * not holding an expired lease, short enough that a URL captured from a network
 * log, a Referer, or a bug report stops working while the incident is still
 * being looked at.
 */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60;

/** Bounds on the expiry this app will ask the vendor for. */
export const MIN_SIGNED_URL_TTL_SECONDS = 15;
export const MAX_SIGNED_URL_TTL_SECONDS = 300;

/** Speech-to-text. The intake path's recording arrives here. */
export const STT_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/** Text-to-speech. One voice per line of the intake review, read back. */
export const SPEECH_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Which models do the work.
 *
 * Constants rather than configuration, because a model id that can be wrong is a
 * deployment that transcribes nobody's speech correctly and says it worked. The
 * voice is the exception: which voice reads a patient's own words back to them
 * is a per-deployment choice about who is speaking to whom, and there is an
 * optional variable for it in src/lib/env.ts.
 */
export const TRANSCRIPTION_MODEL = "scribe_v1";
export const TTS_MODEL = "eleven_multilingual_v2";

/**
 * The voice used when none is configured.
 *
 * One of the vendor's published default voices, chosen because it is a stock
 * voice rather than a cloned one: this is a healthcare intake, and the
 * alternative reading a patient's own words back to them in a borrowed voice is
 * a decision nobody should make by accident. Override with
 * ELEVENLABS_TTS_VOICE_ID.
 */
export const DEFAULT_TTS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * Ceiling on an uploaded recording, in bytes.
 *
 * 15 MB is about an hour of compressed speech, which is far longer than any
 * intake answer, and the point is to bound what a single request can make the
 * server hold in memory and then forward. Checked before the upload, not after:
 * the useful time to refuse a 200 MB body is before it has been read.
 */
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

/**
 * Ceiling on text handed to speech-to-speech, in characters.
 *
 * A confirmation read back to a patient is a sentence or two. Anything longer
 * is a caller trying to make this endpoint a general text-to-speech service on
 * a metered account, and the route caps it again on the way in.
 */
export const MAX_SPEECH_CHARACTERS = 600;

/**
 * The body and headers of one vendor call.
 *
 * `FormData` for the endpoints that take a file. A recording is not a string,
 * and base64-encoding it into JSON would add a third to every upload and then
 * need decoding on the way in; the vendor takes multipart, so this does too.
 */
export interface VendorRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string | FormData;
}

/** One vendor call, as this client made it. What a test reads. */
export type VendorCall = VendorRequestInit & { url: string };

/** The slice of `fetch` this client depends on. */
export type VendorFetch = (
  url: string,
  init: VendorRequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface SignedConversation {
  /** The signed `wss://` URL for the browser to dial. */
  url: string;
  /**
   * When this app considers the URL spent, in epoch milliseconds.
   *
   * Derived from the expiry this app *asked for*, not from anything in the
   * response: the vendor's documented response is a bare `url`, so the request
   * is the only statement about how long the lease runs, and guessing from a
   * `expires` query parameter would be trusting a value the vendor might format
   * differently from the one it enforces.
   */
  expiresAt: number;
}

/** A recording on its way to the vendor, as bytes rather than as a form. */
export interface VoiceAudio {
  /**
   * `Uint8Array<ArrayBuffer>` rather than any `Uint8Array`, because that is what
   * a `BlobPart` accepts and a view onto a `SharedArrayBuffer` is not one. Both
   * callers -- the vendor response and the multipart upload -- start from an
   * `ArrayBuffer`, so the narrower type costs nothing and stops the upload from
   * being unbuildable.
   */
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** A name for the multipart part. Not a path, and never used as one. */
  filename: string;
}

export interface Transcription {
  /** What was said, verbatim. May be in any language the vendor recognised. */
  text: string;
  /** The vendor's own language guess, when it made one. */
  languageCode: string | null;
}

export interface ElevenLabsClient {
  /**
   * Mint a short-lived signed conversation URL for one agent.
   *
   * Throws `VoiceNotConfiguredError` when no API key is set, and
   * `VendorRequestError` when the vendor refuses or answers with something that
   * is not a signed conversation URL. It never throws with the vendor's body,
   * the API key, or the agent id in the message.
   */
  mintConversationUrl(request: { agentId: string; ttlSeconds?: number }): Promise<SignedConversation>;

  /**
   * Transcribe a recording.
   *
   * Throws rather than returning an empty transcript. Silence, a failed
   * transcription, and a vendor that changed its response shape are three
   * different things and the caller cannot tell them apart from `""`; the first
   * of them is a person holding a phone and saying nothing yet.
   */
  transcribe(audio: VoiceAudio, options: { languageCode?: string }): Promise<Transcription>;

  /**
   * Read text aloud. Returns the encoded audio the browser will play.
   *
   * `Uint8Array<ArrayBuffer>` for the same reason `VoiceAudio.bytes` is: a
   * `Response` body accepts an `ArrayBuffer` view over a real `ArrayBuffer` and
   * nothing else, and both the vendor's reply and this response start as one.
   */
  speak(text: string): Promise<Uint8Array<ArrayBuffer>>;
}

class HttpElevenLabsClient implements ElevenLabsClient {
  constructor(
    private readonly apiKey: string,
    private readonly doFetch: VendorFetch,
    private readonly now: () => number,
  ) {}

  async mintConversationUrl({
    agentId,
    ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS,
  }: {
    agentId: string;
    ttlSeconds?: number;
  }): Promise<SignedConversation> {
    const expiresInSecs = clampTtl(ttlSeconds);

    const response = await this.doFetch(SIGNED_CONVERSATION_ENDPOINT, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: agentId, expires_in_secs: expiresInSecs }),
    });

    if (!response.ok) {
      // The body is deliberately not read and not reported: a vendor error
      // echoes the request, and the request is the API key and an agent id.
      throw new VendorRequestError("The voice vendor refused the request", response.status);
    }

    const url = readSignedUrl(await response.json());
    if (!url) {
      throw new VendorRequestError(
        "The voice vendor returned an unexpected response",
        response.status,
      );
    }

    return { url, expiresAt: this.now() + expiresInSecs * 1000 };
  }

  async transcribe(
    { bytes, mimeType, filename }: VoiceAudio,
    { languageCode }: { languageCode?: string },
  ): Promise<Transcription> {
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new VendorRequestError("The recording is too long to transcribe");
    }

    const form = new FormData();
    form.set("file", new File([bytes], filename, { type: mimeType }));
    form.set("model_id", TRANSCRIPTION_MODEL);
    // Off by default in some accounts and on by default in others. A transcript
    // with `[laughs]` in it is a transcript nobody can extract fields from.
    form.set("tag_audio_events", "false");
    if (languageCode) form.set("language_code", languageCode);

    const response = await this.doFetch(STT_ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey },
      body: form,
    });

    if (!response.ok) {
      throw new VendorRequestError("The voice vendor refused the recording", response.status);
    }

    return readTranscription(await response.json());
  }

  async speak(text: string): Promise<Uint8Array<ArrayBuffer>> {
    if (text.trim().length === 0 || text.length > MAX_SPEECH_CHARACTERS) {
      throw new VendorRequestError("That is not something to read aloud");
    }

    const response = await this.doFetch(`${SPEECH_ENDPOINT}/${this.voiceId()}`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
    });

    if (!response.ok) {
      throw new VendorRequestError("The voice vendor refused the request", response.status);
    }

    return new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  }

  /** The configured voice, or a well-known default when none is set. */
  private voiceId(): string {
    return getServerEnv().ELEVENLABS_TTS_VOICE_ID || DEFAULT_TTS_VOICE_ID;
  }
}

/**
 * Read a transcription out of a vendor response.
 *
 * `text` is the only field that matters, and its absence is a failure. An empty
 * transcript is not an answer this app can use: it produces a review step with
 * nothing in it, and the next thing the patient is told is that no fields could
 * be extracted, which is both true and useless.
 */
function readTranscription(body: unknown): Transcription {
  if (typeof body !== "object" || body === null) {
    throw new VendorRequestError("The voice vendor returned an unexpected response");
  }

  const source = body as Record<string, unknown>;
  const text = source.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new VendorRequestError("The voice vendor returned no transcript");
  }

  const language = source.language_code;
  return {
    text: text.trim(),
    languageCode: typeof language === "string" && language.length > 0 ? language : null,
  };
}

/**
 * Check the URL before publishing it.
 *
 * This client is the last point at which a URL that a browser will dial can be
 * inspected, and the URL is a function of the vendor's response. Four checks,
 * each closing a way that a wrong answer becomes an open door:
 *
 *   - It parses as a URL. A malformed string handed to `new WebSocket` fails in
 *     the browser, with the raw string in the error.
 *   - It is `wss:`, not `https:`. A signed URL over TLS that is not a WebSocket
 *     URL is not what this code asked for, and an `http(s)` URL that somehow
 *     reached a socket would be a different protocol entirely.
 *   - It is on the vendor's host, compared after parsing rather than with
 *     `includes`. `includes` passes `api.elevenlabs.io.attacker.test` and
 *     `evil-api.elevenlabs.io`, both of which a redirect or a DNS answer can
 *     produce.
 *   - It carries a signature. Without one the URL is a bare agent id, which is
 *     precisely the thing this change exists to stop handing out; a vendor
 *     answer without a signature is refused rather than passed on.
 */
function readSignedUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const url = (body as Record<string, unknown>).url;
  if (typeof url !== "string" || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "wss:") return null;
  if (parsed.hostname !== VENDOR_HOST) return null;
  if (!parsed.searchParams.get("signature")) return null;

  return url;
}

function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.min(Math.max(Math.trunc(seconds), MIN_SIGNED_URL_TTL_SECONDS), MAX_SIGNED_URL_TTL_SECONDS);
}

/**
 * Build a client over any transport.
 *
 * The seam the tests use and the hook an alternative vendor would be installed
 * through, for the same reason `createGeminiClient` is a function in
 * src/lib/gemini.ts: the app should not be shaped by one provider's SDK, and
 * its behaviour should be assertable without that provider's account.
 */
export function createElevenLabsClient({
  fetchImpl = globalThis.fetch as unknown as VendorFetch,
  apiKey = getServerEnv().ELEVENLABS_API_KEY,
  now = () => Date.now(),
}: {
  fetchImpl?: VendorFetch;
  apiKey?: string;
  now?: () => number;
} = {}): ElevenLabsClient {
  if (!apiKey) {
    // Not thrown: `getElevenLabsClient` is called from module scope all over
    // this app's server code and from `next build`, where a throw fails the
    // build instead of naming the missing variable. The refusal happens at the
    // call, in `mintConversationUrl`, where it can still be reported.
    return new UnconfiguredElevenLabsClient();
  }
  return new HttpElevenLabsClient(apiKey, fetchImpl, now);
}

/**
 * Stands in for the client when there is no key, and refuses every request.
 *
 * All three, not just the one the spectate page needs. A voice feature that
 * mints nothing but will happily upload a patient's recording to a vendor with
 * no credential is worse than one that is off.
 */
class UnconfiguredElevenLabsClient implements ElevenLabsClient {
  mintConversationUrl(): Promise<SignedConversation> {
    return Promise.reject(new VoiceNotConfiguredError());
  }

  transcribe(): Promise<Transcription> {
    return Promise.reject(new VoiceNotConfiguredError());
  }

  speak(): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.reject(new VoiceNotConfiguredError());
  }
}

let client: ElevenLabsClient | null = null;

/** The shared client. Built lazily, for the reason above. */
export function getElevenLabsClient(): ElevenLabsClient {
  if (!client) client = createElevenLabsClient();
  return client;
}

/**
 * Whether voice is available on this deployment.
 *
 * Read by the pages to decide whether to offer the feature at all, so a
 * deployment without a key shows a patient a form rather than a Start button
 * that cannot work. Absent is a normal state, not an error.
 *
 * The one place in this app that answers a capability question rather than a
 * correctness one, which is why it does not throw on a rejected environment.
 * `ELEVENLABS_API_KEY=` -- a blank line left over from copying `.env.example`,
 * and the single most likely way this variable is set -- fails the
 * `min(1)` check in the env schema, and an absent optional variable does not.
 * "No" is the right answer in both cases, and it is the only answer a page can
 * act on: the alternative is a 500 on the spectate page for a deployment that
 * is otherwise fine and simply has voice switched off.
 */
export function isVoiceConfigured(): boolean {
  try {
    return Boolean(getServerEnv().ELEVENLABS_API_KEY);
  } catch {
    return false;
  }
}

/** Test seam. Mirrors setLlmClient and setRateLimitStore. */
export function setElevenLabsClient(next: ElevenLabsClient | null): void {
  client = next;
}
