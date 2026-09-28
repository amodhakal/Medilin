import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetServerEnvCache } from "@/lib/env";
import {
  setElevenLabsClient,
  type ElevenLabsClient,
  type SignedConversation,
} from "@/lib/voice/elevenlabs";
import {
  getMediaStreamBridge,
  isSafeStreamUrl,
  mintMediaStreamSession,
  setMediaStreamBridge,
} from "./media-stream";

/**
 * Where a real media stream is terminated, and who holds the socket.
 *
 * The short version of the architectural argument, which is also the reason this
 * module mints a URL rather than serving a WebSocket:
 *
 * `wss://` needs a process that stays alive. A Twilio media stream runs for as
 * long as the call does -- tens of seconds to several minutes, holding two
 * open sockets -- and this application is deployed to a serverless platform with
 * no custom server, no state between invocations, and an execution model where a
 * request that has returned is over. The same argument is already written down
 * for the ElevenLabs socket in src/lib/voice/elevenlabs.ts, which is why this
 * is not a new constraint and not a new decision: it was settled in #15 and this
 * is the same answer again in a different direction.
 *
 * So the socket belongs to a long-lived service, configured here as
 * TWILIO_MEDIA_STREAM_URL, and this application does the three things it is
 * actually good at: verify Twilio, mint a short-lived signed conversation URL
 * for the receptionist agent it already runs, and put that lease in the
 * `<Stream>` URL. The bridge is a pump. It is not in this repository, and the
 * test suite is what makes that a stated fact rather than a surprise.
 *
 * The reuse is the point. There is no second voice stack here: the same
 * @/lib/voice/elevenlabs client, the same receptionist agent id from
 * ELEVENLABS_AGENT_RECEPTIONIST_ID, the same sixty-second lease, the same
 * client-side secret boundary from #15. What #3 adds is that the peer on the
 * other end of that conversation is a telephone call rather than a browser.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const CONVERSATION_URL =
  "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_receptionist&signature=abc";

const keys = ["TWILIO_MEDIA_STREAM_URL"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [key, value] of Object.entries(BASELINE)) process.env[key] = value;
  for (const key of keys) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetServerEnvCache();
  setMediaStreamBridge(null);
  setElevenLabsClient({
    mintConversationUrl: async (): Promise<SignedConversation> => ({
      url: CONVERSATION_URL,
      expiresAt: 1_800_000_000_000,
    }),
    async transcribe() {
      throw new Error("not used here");
    },
    async speak() {
      throw new Error("not used here");
    },
  } as ElevenLabsClient);
});

afterEach(() => {
  for (const key of keys) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  setMediaStreamBridge(null);
  setElevenLabsClient(null);
  resetServerEnvCache();
});

describe("getMediaStreamBridge", () => {
  test("is null with no stream URL, which is the default deployment", () => {
    expect(getMediaStreamBridge()).toBeNull();
  });

  test("is null for anything that is not a wss URL", () => {
    // The socket carries a call. Over plaintext it is a call anyone on the path
    // can listen to, and over http it is not a socket at all.
    for (const value of [
      "ws://bridge.example/media",
      "http://bridge.example/media",
      "https://bridge.example/media",
      "bridge.example/media",
      "",
    ]) {
      process.env.TWILIO_MEDIA_STREAM_URL = value;
      resetServerEnvCache();
      expect(getMediaStreamBridge()).toBeNull();
    }
  });

  test("is null for a wss URL with credentials in it", () => {
    process.env.TWILIO_MEDIA_STREAM_URL = "wss://user:pass@bridge.example/media";
    resetServerEnvCache();

    expect(getMediaStreamBridge()).toBeNull();
  });

  test("resolves a wss URL, path and all", () => {
    process.env.TWILIO_MEDIA_STREAM_URL = "wss://bridge.example/media";
    resetServerEnvCache();

    expect(getMediaStreamBridge()).toEqual({ url: "wss://bridge.example/media" });
  });
});

describe("isSafeStreamUrl", () => {
  test("accepts an absolute wss URL and refuses everything else", () => {
    expect(isSafeStreamUrl("wss://bridge.example/media")).toBe(true);
    for (const value of [
      "wss://",
      "ws://bridge.example/media",
      "https://bridge.example/media",
      "/media",
      "",
    ]) {
      expect(isSafeStreamUrl(value)).toBe(false);
    }
  });
});

describe("mintMediaStreamSession", () => {
  test("is null with no bridge configured, so the caller can fall back to a greeting", async () => {
    expect(await mintMediaStreamSession()).toBeNull();
  });

  test("is null without an ElevenLabs key, because there is no agent to talk to", async () => {
    // A stream pointed at no agent is a clinic's line connected to silence,
    // which is worse than the greeting it replaced.
    delete process.env.ELEVENLABS_API_KEY;
    resetServerEnvCache();
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    expect(await mintMediaStreamSession()).toBeNull();
  });

  test("puts the receptionist's signed conversation URL in the stream URL", async () => {
    let agentId = "";
    setElevenLabsClient({
      async mintConversationUrl({ agentId: requested }) {
        agentId = requested;
        return { url: CONVERSATION_URL, expiresAt: 1_800_000_000_000 };
      },
      async transcribe() {
        throw new Error("not used here");
      },
      async speak() {
        throw new Error("not used here");
      },
    } as ElevenLabsClient);
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const session = await mintMediaStreamSession();

    // The same agent the spectate page's receptionist side uses, and no patient
    // agent: this is a call from the clinic, not one to a patient.
    expect(agentId).toBe("agent_receptionist");
    expect(session?.streamUrl).toContain("wss://bridge.example/media?");
    expect(session?.streamUrl).toContain(encodeURIComponent(CONVERSATION_URL));
  });

  test("reports the lease's own expiry rather than guessing one", async () => {
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const session = await mintMediaStreamSession();

    expect(session?.expiresAt).toBe(1_800_000_000_000);
  });

  test("carries no appointment token, so nothing in the URL is a patient credential", async () => {
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const session = await mintMediaStreamSession();

    // The bridge is a media pump, not a reader of patient records. A sealed
    // appointment token in a URL that Twilio fetches and logs would be PHI in
    // three more places, for a service that has no use for it.
    expect(session?.streamUrl).not.toContain("appointment");
    expect(session?.streamUrl).not.toContain("spectate");
  });

  test("produces a stream URL that is still a safe wss URL once built", async () => {
    setMediaStreamBridge({ url: "wss://bridge.example/media" });

    const session = await mintMediaStreamSession();

    expect(isSafeStreamUrl(session?.streamUrl ?? "")).toBe(true);
  });
});
