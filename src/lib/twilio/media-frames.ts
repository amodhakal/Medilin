import "server-only";

/**
 * The bidirectional half of a Twilio media stream (#3).
 *
 * Twilio's `<Stream>` speaks JSON text frames over a WebSocket. It sends
 * `start`, `connected`, a `media` frame for every 20ms of the caller's audio,
 * optionally `dtmf`, and `stop`. A conversation needs the other direction too:
 * `media` frames carrying audio back, addressed by `streamSid`, and `mark` to
 * commit what has been buffered. Both are here, and both are tested.
 *
 * This module is used by no route in this application, and the reason is the
 * same one that decides where the socket lives: see ./media-stream. What is here
 * is the part of the protocol that belongs to this codebase -- bounded, validated
 * audio in both directions -- so that the service which does hold the socket is
 * a pump rather than a second, untested implementation of a wire format. The
 * alternative is that the format lives in that service, where nothing in this
 * repository can test it, which is how a codec ends up wrong in a way nobody
 * finds out about until a patient is on the phone.
 *
 * Two rules shape everything below, and both come from the same fact: anything
 * that can open the socket can send anything on it.
 *
 *   - Every field is length-bounded before it is used, and a frame that is over
 *     the ceiling is refused before it is parsed. A 20ms media frame is about
 *     216 characters of base64; the ceilings below are generous by an order of
 *     magnitude and still small enough that "allocate whatever the peer asks
 *     for" is not reachable.
 *   - Base64 is decoded strictly. `Buffer.from` is famously forgiving -- it
 *     decodes the valid part and discards the rest -- which turns a corrupt
 *     frame into audio that is subtly wrong, played over a real call. A frame
 *     that does not re-encode to itself is refused.
 */

/** The five frames Twilio sends. Anything else is not a media stream. */
export const MEDIA_STREAM_EVENTS = ["start", "connected", "media", "stop", "dtmf"] as const;

export type MediaStreamEvent = (typeof MEDIA_STREAM_EVENTS)[number];

/**
 * The whole frame, as text.
 *
 * 64 KiB. A media frame with a 20ms payload is roughly 300 characters, so this
 * is two hundred times a normal frame and still far too small to be a way to
 * make this process allocate.
 */
export const MAX_FRAME_CHARS = 64 * 1024;

/**
 * One frame's audio, base64-encoded.
 *
 * 8 KiB of base64 is about 6 KiB of mu-law, or 30 frames' worth of speech at
 * 20ms each. A call legitimate in one frame that is larger than this is not a
 * call.
 */
export const MAX_AUDIO_CHARS = 8 * 1024;

/** The same ceiling after decoding, since that is where the memory goes. */
export const MAX_AUDIO_BYTES = 6 * 1024;

/** A stream identity is short. A long one is a way to be remembered. */
export const MAX_STREAM_SID_LENGTH = 64;

/** A mark name is this application's own label for a turn. */
const MAX_MARK_LENGTH = 64;

export interface MediaStreamFrame {
  event: MediaStreamEvent;
  streamSid: string;
  start?: {
    streamSid: string;
    tracks: readonly string[];
    /**
     * The query parameters Twilio was given on the `<Stream url>`.
     *
     * Bounded, and not treated as a credential. This application's stream URL
     * carries no secret, so there is nothing here to authenticate against --
     * which is the reason the stream URL in ./media-stream carries a
     * short-lived vendor lease and not an appointment token.
     */
    customParameters?: Readonly<Record<string, string>>;
  };
  connected?: { streamSid: string };
  media?: { track: string; payload: string };
  stop?: { accountSid?: string; callSid?: string };
  dtmf?: { digit?: string };
}

/**
 * A frame this module refused to build.
 *
 * A class rather than a bare `Error` because the caller on the other end of a
 * live call has to tell "I could not encode this" from "the peer sent me
 * something I do not understand", and the first is a bug here while the second
 * is a bad peer.
 */
export class MediaFrameError extends Error {
  constructor(reason: string) {
    super(`Media frame refused: ${reason}`);
    this.name = "MediaFrameError";
  }
}

/**
 * Read a frame, or refuse it.
 *
 * Returns null rather than throwing: a stream carries whatever a peer sends, and
 * one unreadable frame is not a reason to end a call in progress. The caller
 * decides what an unreadable frame means; for a `media` frame it is a dropped
 * 20ms of audio, and dropping it is right.
 */
export function parseMediaStreamFrame(raw: string): MediaStreamFrame | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_FRAME_CHARS) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const event = record.event;
  if (typeof event !== "string") return null;
  if (!(MEDIA_STREAM_EVENTS as readonly string[]).includes(event)) return null;

  const streamSid = record.streamSid;
  if (typeof streamSid !== "string" || streamSid.length === 0) return null;
  if (streamSid.length > MAX_STREAM_SID_LENGTH) return null;

  const frame: MediaStreamFrame = { event: event as MediaStreamEvent, streamSid };

  switch (frame.event) {
    case "start": {
      const start = record.start;
      if (typeof start !== "object" || start === null) return null;
      const source = start as Record<string, unknown>;
      const tracks = source.tracks;
      frame.start = {
        streamSid,
        tracks: Array.isArray(tracks)
          ? tracks.filter((t): t is string => typeof t === "string")
          : [],
        customParameters: readCustomParameters(source.customParameters),
      };
      return frame;
    }
    case "connected":
      frame.connected = { streamSid };
      return frame;
    case "media": {
      const media = record.media;
      if (typeof media !== "object" || media === null) return null;
      const { track, payload } = media as Record<string, unknown>;
      if (typeof payload !== "string" || payload.length === 0) return null;
      if (payload.length > MAX_AUDIO_CHARS) return null;
      if (decodeMediaAudio(payload) === null) return null;
      frame.media = { track: typeof track === "string" ? track : "inbound", payload };
      return frame;
    }
    case "stop": {
      const stop = record.stop;
      const source = (typeof stop === "object" && stop !== null ? stop : {}) as Record<string, unknown>;
      frame.stop = {
        ...(typeof source.accountSid === "string" ? { accountSid: source.accountSid } : {}),
        ...(typeof source.callSid === "string" ? { callSid: source.callSid } : {}),
      };
      return frame;
    }
    case "dtmf": {
      const dtmf = record.dtmf;
      const source = (typeof dtmf === "object" && dtmf !== null ? dtmf : record) as Record<
        string,
        unknown
      >;
      frame.dtmf = typeof source.digit === "string" ? { digit: source.digit.slice(0, 8) } : {};
      return frame;
    }
  }
}

/**
 * The `<Stream url>` query, as short strings.
 *
 * A handful of keys, short values, control characters dropped. It arrives from
 * whoever opened the socket, so it is treated as text to be displayed and never
 * as a command: there is no branch below that looks a key up in a table of
 * things to do.
 */
function readCustomParameters(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const read: Record<string, string> = {};
  let kept = 0;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_CUSTOM_PARAMETERS) break;
    if (typeof entry !== "string") continue;
    if (key.length === 0 || key.length > MAX_CUSTOM_KEY_LENGTH) continue;
    read[key] = entry.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_CUSTOM_VALUE_LENGTH);
    kept += 1;
  }

  return read;
}

const MAX_CUSTOM_PARAMETERS = 8;
const MAX_CUSTOM_KEY_LENGTH = 64;
const MAX_CUSTOM_VALUE_LENGTH = 128;

/**
 * The audio in a frame, as bytes.
 *
 * Null for anything that is not exactly base64 of at most {@link MAX_AUDIO_BYTES}
 * bytes. Strict on both counts: the character set and length are checked, and the
 * decoded bytes are re-encoded and compared, because a forgiving decoder turns a
 * corrupt frame into audio that plays.
 */
export function decodeMediaAudio(payload: string): Uint8Array | null {
  if (typeof payload !== "string" || payload.length === 0) return null;
  if (payload.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;

  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) return null;

  return Buffer.from(bytes).toString("base64") === payload ? bytes : null;
}

/**
 * A frame to send back to Twilio: audio, or a mark.
 *
 * This is the outbound direction, and it is the reason this module is more than
 * a parser. A stream that only reads is not a conversation: the agent's audio
 * has to reach the call, addressed by the `streamSid` of the stream it belongs
 * to, and Twilio buffers until a `mark` says the turn is finished.
 *
 * Throws {@link MediaFrameError} rather than returning null. This side is
 * written by the code that owns the socket, so a refusal here is a bug in that
 * code and should stop it rather than quietly send a frame with no audio.
 */
export function encodeMediaFrame(input: {
  streamSid: string;
  /** Base64 mu-law, as it came off the vendor socket. */
  payload?: string;
  /** Commits the audio sent so far. */
  mark?: string;
}): string {
  const { streamSid, payload, mark } = input;

  if (typeof streamSid !== "string" || streamSid.length === 0) {
    throw new MediaFrameError("no stream identity");
  }
  if (streamSid.length > MAX_STREAM_SID_LENGTH) {
    throw new MediaFrameError("stream identity too long");
  }

  if (payload !== undefined) {
    if (decodeMediaAudio(payload) === null) {
      throw new MediaFrameError("audio is not base64 within the size limit");
    }
    return JSON.stringify({ event: "media", streamSid, media: { payload } });
  }

  if (mark !== undefined) {
    if (mark.length === 0 || mark.length > MAX_MARK_LENGTH) {
      throw new MediaFrameError("mark name is not usable");
    }
    return JSON.stringify({ event: "mark", streamSid, mark: { name: mark } });
  }

  throw new MediaFrameError("nothing to send");
}
