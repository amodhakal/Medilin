import { describe, expect, test } from "bun:test";
import {
  decodeMediaAudio,
  encodeMediaFrame,
  MAX_FRAME_CHARS,
  parseMediaStreamFrame,
  type MediaStreamFrame,
} from "./media-frames";

/**
 * The bidirectional half of a Twilio media stream.
 *
 * Twilio speaks JSON text frames over a WebSocket: it sends `start`,
 * `connected`, then a `media` frame for every 20ms of inbound audio, then
 * `stop`. A conversation needs the other direction too -- a frame carrying audio
 * back to the call, addressed by `streamSid` -- and that frame is the one this
 * module exists to produce.
 *
 * It is here, and unused by any route in this application, on purpose. Nothing
 * in this repository can hold the socket: see ./media-stream for the deployment
 * argument. What is here is the part of the protocol that is genuinely this
 * application's to own -- the codec, bounded and validated -- so that the
 * service which does hold the socket is a pump and not a second implementation
 * of a wire format. It is tested here because untested protocol code in a
 * service nobody here deploys is untested protocol code.
 *
 * Two rules shape everything below. A frame is attacker-influenced in the sense
 * that anything that can open the socket can send one, so every field is
 * length-bounded before it is used. And audio is base64: it is the one field
 * that is large and opaque, so it is the one field with a size ceiling that is
 * checked *before* decoding rather than after.
 */

const START: MediaStreamFrame = {
  event: "start",
  streamSid: "MZ1234567890",
  start: { streamSid: "MZ1234567890", tracks: ["inbound"], customParameters: {} },
};

/** One 20ms frame of 8kHz mu-law: 160 bytes, base64 of that. */
function mediaFrame(payload: string) {
  return JSON.stringify({
    event: "media",
    streamSid: "MZ1234567890",
    media: { track: "inbound", payload },
  });
}

describe("parseMediaStreamFrame", () => {
  test("reads a start frame with its stream identity", () => {
    expect(parseMediaStreamFrame(JSON.stringify(START))).toEqual(START);
  });

  test("reads a media frame and leaves the audio alone", () => {
    const payload = Buffer.from("0123456789abcdefghij").toString("base64");
    const frame = parseMediaStreamFrame(mediaFrame(payload));

    expect(frame?.event).toBe("media");
    expect(frame?.streamSid).toBe("MZ1234567890");
    expect(frame?.media).toEqual({ track: "inbound", payload });
  });

  test("reads a stop frame", () => {
    expect(
      parseMediaStreamFrame(JSON.stringify({ event: "stop", streamSid: "MZ1", stop: {} })),
    ).toEqual({ event: "stop", streamSid: "MZ1", stop: {} });
  });

  test("refuses a frame with no event, because there is nothing to do with it", () => {
    expect(parseMediaStreamFrame(JSON.stringify({ streamSid: "MZ1" }))).toBeNull();
  });

  test("refuses a frame whose event is not one of the five", () => {
    // An open socket is reachable by whoever can reach the bridge, and an
    // unknown event is a request this code would have to guess at.
    for (const event of ["connected_", "", "MEDIA", "<script>", "disconnect"]) {
      expect(parseMediaStreamFrame(JSON.stringify({ event, streamSid: "MZ1" }))).toBeNull();
    }
  });

  test("refuses a frame with no stream identity", () => {
    // Every reply is addressed by streamSid. A frame without one cannot be
    // answered, and answering the wrong stream is speaking over another call.
    expect(parseMediaStreamFrame(JSON.stringify({ event: "start", start: {} }))).toBeNull();
    expect(
      parseMediaStreamFrame(JSON.stringify({ event: "media", streamSid: 42, media: {} })),
    ).toBeNull();
  });

  test("refuses text that is not JSON rather than throwing", () => {
    // Twilio will not send this. A proxy will.
    expect(parseMediaStreamFrame("not json")).toBeNull();
    expect(parseMediaStreamFrame("")).toBeNull();
    expect(parseMediaStreamFrame("null")).toBeNull();
    expect(parseMediaStreamFrame("[1,2,3]")).toBeNull();
  });

  test("refuses a frame larger than the ceiling, before parsing it", () => {
    // 20ms of audio is 160 bytes and about 216 characters of base64. The
    // ceiling is generous by an order of magnitude, and a frame past it is not a
    // media frame: it is a request to make this process allocate.
    const oversized = mediaFrame("A".repeat(MAX_FRAME_CHARS + 1));
    expect(oversized.length).toBeGreaterThan(MAX_FRAME_CHARS);
    expect(parseMediaStreamFrame(oversized)).toBeNull();
  });

  test("refuses a media frame with an audio payload past the ceiling", () => {
    expect(parseMediaStreamFrame(mediaFrame("A".repeat(MAX_AUDIO_CHARS + 1)))).toBeNull();
  });

  test("refuses a media frame with no audio payload", () => {
    expect(parseMediaStreamFrame(mediaFrame(""))).toBeNull();
  });

  test("bounds a stream identity rather than passing a megabyte of it through", () => {
    const frame = parseMediaStreamFrame(
      JSON.stringify({ event: "stop", streamSid: "M".repeat(4_000), stop: {} }),
    );

    expect(frame).toBeNull();
  });
});

describe("decodeMediaAudio", () => {
  test("round-trips the bytes a frame carries", () => {
    // 20ms of 8kHz mu-law audio: the payload is opaque, and the only thing that
    // matters is that it comes back out as the same bytes.
    const audio = new Uint8Array(160);
    for (let index = 0; index < audio.length; index += 1) audio[index] = index % 256;
    const payload = Buffer.from(audio).toString("base64");

    expect(decodeMediaAudio(payload)).toEqual(audio);
  });

  test("is null for audio that is not base64, rather than a partial decode", () => {
    // Buffer.from is famously forgiving: it decodes what it can and drops the
    // rest, which turns a corrupt frame into audio that is subtly wrong.
    expect(decodeMediaAudio("!!!not base64!!!")).toBeNull();
    expect(decodeMediaAudio("")).toBeNull();
  });

  test("refuses audio that decodes to more than one frame of audio", () => {
    expect(decodeMediaAudio(Buffer.alloc(200_000).toString("base64"))).toBeNull();
  });
});

describe("encodeMediaFrame", () => {
  test("is the frame Twilio expects back, addressed by stream identity", () => {
    const payload = Buffer.from([1, 2, 3, 4]).toString("base64");

    const frame = encodeMediaFrame({ streamSid: "MZ1234567890", payload });

    expect(JSON.parse(frame)).toEqual({
      event: "media",
      streamSid: "MZ1234567890",
      media: { payload },
    });
  });

  test("sends a mark, which is how audio sent so far is committed", () => {
    // Twilio buffers until a mark, so a stream that never marks never plays.
    // Whether the bridge sends one per turn is its business; that the frame can
    // be produced here is this module's.
    expect(JSON.parse(encodeMediaFrame({ streamSid: "MZ1", mark: "turn-1" }))).toEqual({
      event: "mark",
      streamSid: "MZ1",
      mark: { name: "turn-1" },
    });
  });

  test("refuses a frame with no stream identity or nothing to send", () => {
    // Deliberately misused: the point is that the builder checks, and a type
    // system is not what checks.
    expect(() =>
      encodeMediaFrame({ payload: "AAA=" } as unknown as { streamSid: string }),
    ).toThrow();

    expect(() => encodeMediaFrame({ streamSid: "MZ1" })).toThrow();
  });

  test("refuses audio past the ceiling rather than putting it on the wire", () => {
    expect(() =>
      encodeMediaFrame({ streamSid: "MZ1", payload: "A".repeat(MAX_AUDIO_CHARS + 1) }),
    ).toThrow();
  });
});

/** The audio ceiling, spelled once here so the bounds read as one rule. */
const MAX_AUDIO_CHARS = 8_192;
