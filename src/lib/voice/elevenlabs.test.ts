import { afterEach, describe, expect, test } from "bun:test";

import { resetServerEnvCache } from "@/lib/env";
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  MAX_AUDIO_BYTES,
  MAX_SPEECH_CHARACTERS,
  MAX_SIGNED_URL_TTL_SECONDS,
  MIN_SIGNED_URL_TTL_SECONDS,
  SIGNED_CONVERSATION_ENDPOINT,
  SPEECH_ENDPOINT,
  STT_ENDPOINT,
  TRANSCRIPTION_MODEL,
  TTS_MODEL,
  VendorRequestError,
  VoiceNotConfiguredError,
  createElevenLabsClient,
  getElevenLabsClient,
  type ElevenLabsClient,
  isVoiceConfigured,
  setElevenLabsClient,
  type VoiceAudio,
  type VendorCall,
  type VendorFetch,
} from "./elevenlabs";

/**
 * The ElevenLabs credential client, tested.
 *
 * There are no live credentials in CI, so the transport is injected: this file
 * asserts on the requests the client *would* make, which is the part that
 * decides whether an agent id or the API key leaves the server.
 *
 * The property under test throughout is negative. A client that leaks is
 * indistinguishable from one that works until somebody reads the network tab,
 * so the tests that matter here are the ones that fail if the key or a
 * long-lived identifier ends up anywhere a browser could see it.
 */

const VALID = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const saved = new Map<string, string | undefined>();
for (const key of [...Object.keys(VALID), "ELEVENLABS_API_KEY"]) {
  saved.set(key, process.env[key]);
}

function setEnv(values: Partial<typeof VALID> & { ELEVENLABS_API_KEY?: string }): void {
  for (const key of Object.keys(VALID)) delete process.env[key];
  Object.assign(process.env, VALID, values);
  resetServerEnvCache();
}

/** A transport that records what it was asked and replies with `body`. */
function recordingFetch(
  body: unknown = {
    url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_patient&signature=abc&expires=1",
  },
  init: { ok?: boolean; status?: number; bytes?: Uint8Array } = {},
): { fetchImpl: VendorFetch; calls: VendorCall[] } {
  const calls: VendorCall[] = [];
  const bytes = init.bytes ?? new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const fetchImpl: VendorFetch = async (url, request) => {
    calls.push({ url, ...request });
    const status = init.status ?? 200;
    return {
      ok: init.ok ?? status < 400,
      status,
      json: async () => body,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
    };
  };
  return { fetchImpl, calls };
}

/** A recording as the client accepts one. */
const CLIP: VoiceAudio = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/webm",
  filename: "clip.webm",
};

/** The rejection, typed. Every use of it is asserting on a failure. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
  setElevenLabsClient(null);
});

describe("mintConversationUrl", () => {
  test("asks the vendor for a signed conversation URL, authenticated server-side", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch();
    const client = createElevenLabsClient({ fetchImpl });

    const minted = await client.mintConversationUrl({ agentId: "agent_patient" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SIGNED_CONVERSATION_ENDPOINT);
    expect(calls[0].method).toBe("POST");
    // The API key is a server secret. It is in the header and nowhere else.
    expect(calls[0].headers["xi-api-key"]).toBe("sk-elevenlabs-test");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toBe('{"agent_id":"agent_patient","expires_in_secs":60}');
    expect(minted.url).toContain("signature=");
  });

  test("asks for a short expiry by default and returns when it lapses", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch();
    const now = 1_700_000_000_000;
    const client = createElevenLabsClient({ fetchImpl, now: () => now });

    const minted = await client.mintConversationUrl({ agentId: "agent_patient" });

    const body = JSON.parse(calls[0].body as string) as { expires_in_secs: number };
    // A URL that is good for hours is a long-lived credential with an expiry
    // printed on it. The whole point of minting per session is that the window
    // is small enough to be useless once the session is over.
    expect(body.expires_in_secs).toBe(DEFAULT_SIGNED_URL_TTL_SECONDS);
    expect(DEFAULT_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(minted.expiresAt).toBe(now + DEFAULT_SIGNED_URL_TTL_SECONDS * 1000);
  });

  test("clamps an over-long expiry rather than passing it on", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch();
    const client = createElevenLabsClient({ fetchImpl });

    await client.mintConversationUrl({ agentId: "agent_patient", ttlSeconds: 86_400 });

    const body = JSON.parse(calls[0].body as string) as { expires_in_secs: number };
    expect(body.expires_in_secs).toBe(MAX_SIGNED_URL_TTL_SECONDS);
  });

  test("clamps an expiry that is already too short to be useful", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch();
    const client = createElevenLabsClient({ fetchImpl });

    await client.mintConversationUrl({ agentId: "agent_patient", ttlSeconds: 1 });

    const body = JSON.parse(calls[0].body as string) as { expires_in_secs: number };
    expect(body.expires_in_secs).toBe(MIN_SIGNED_URL_TTL_SECONDS);
  });

  test("refuses a URL that is not a signed conversation URL on the vendor", async () => {
    setEnv({});
    // A vendor that answered with the wrong shape, or an intercepting proxy
    // that answered with its own, would otherwise have its URL handed straight
    // to a browser to dial. The client checks what it is about to publish.
    const rejected = [
      "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_patient",
      "wss://attacker.test/v1/convai/conversation?agent_id=agent_patient&signature=x",
      "wss://evil.api.elevenlabs.io.attacker.test/convai?signature=x",
      "https://api.elevenlabs.io/v1/convai/conversation?signature=x",
      "not a url",
      "",
    ];

    for (const url of rejected) {
      const { fetchImpl } = recordingFetch({ url });
      const client = createElevenLabsClient({ fetchImpl });

      await expect(
        client.mintConversationUrl({ agentId: "agent_patient" }),
      ).rejects.toBeInstanceOf(VendorRequestError);
    }
  });

  test("refuses a vendor reply that is not an object with a url", async () => {
    setEnv({});

    for (const body of [null, "signed", { url: 42 }, { signed_url: "wss://api.elevenlabs.io/x" }]) {
      const { fetchImpl } = recordingFetch(body);
      const client = createElevenLabsClient({ fetchImpl });

      await expect(
        client.mintConversationUrl({ agentId: "agent_patient" }),
      ).rejects.toBeInstanceOf(VendorRequestError);
    }
  });

  test("reports a vendor refusal without quoting what the vendor said", async () => {
    setEnv({});
    // A vendor error body can echo the request, which here includes the API key
    // and the agent id. It is exactly the text that must not reach a log drain
    // or a response body.
    const { fetchImpl } = recordingFetch(
      { detail: "invalid key sk-elevenlabs-test for agent agent_patient" },
      { ok: false, status: 401 },
    );
    const client = createElevenLabsClient({ fetchImpl });

    const error = await rejection(
      client.mintConversationUrl({ agentId: "agent_patient" }),
    );

    expect(error).toBeInstanceOf(VendorRequestError);
    const vendor = error as VendorRequestError;
    expect(vendor.status).toBe(401);
    expect(vendor.message).not.toContain("sk-elevenlabs-test");
    expect(vendor.message).not.toContain("agent_patient");
    expect(vendor.message).not.toContain("invalid key");
  });

  test("does not return the API key as part of a minted session", async () => {
    setEnv({});
    const { fetchImpl } = recordingFetch();
    const client = createElevenLabsClient({ fetchImpl });

    const minted = await client.mintConversationUrl({ agentId: "agent_patient" });

    expect(JSON.stringify(minted)).not.toContain("sk-elevenlabs-test");
  });

  test("refuses to mint without an API key rather than sending an empty one", async () => {
    setEnv({ ELEVENLABS_API_KEY: undefined });
    const { fetchImpl, calls } = recordingFetch();
    const client = createElevenLabsClient({ fetchImpl });

    await expect(
      client.mintConversationUrl({ agentId: "agent_patient" }),
    ).rejects.toBeInstanceOf(VoiceNotConfiguredError);
    expect(calls).toEqual([]);
  });
});

describe("isVoiceConfigured", () => {
  test("is true when the key is present and false when it is not", () => {
    setEnv({});
    expect(isVoiceConfigured()).toBe(true);

    setEnv({ ELEVENLABS_API_KEY: undefined });
    expect(isVoiceConfigured()).toBe(false);

    setEnv({ ELEVENLABS_API_KEY: "" });
    expect(isVoiceConfigured()).toBe(false);
  });
});

describe("getElevenLabsClient", () => {
  test("is one instance for the process, and can be replaced", () => {
    setEnv({});

    const first = getElevenLabsClient();
    expect(getElevenLabsClient()).toBe(first);

    const stub: ElevenLabsClient = {
      mintConversationUrl: async () => ({ url: "", expiresAt: 0 }),
      transcribe: async () => {
        throw new Error("unused");
      },
      speak: async () => {
        throw new Error("unused");
      },
    };
    setElevenLabsClient(stub);
    expect(getElevenLabsClient()).toBe(stub);
  });

  test("does not build a client over an absent key", () => {
    // Constructing one is cheap but logging about the missing key is not, and
    // `next build` imports these modules: a throw at import time would fail the
    // build rather than telling an operator which variable is missing. The
    // check is at the call, not at the constructor.
    setEnv({ ELEVENLABS_API_KEY: undefined });
    expect(() => getElevenLabsClient()).not.toThrow();
  });
});

describe("transcribe", () => {
  test("uploads the audio as multipart form data, authenticated server-side", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch({ text: "me llamo Ada" });
    const client = createElevenLabsClient({ fetchImpl });

    const transcript = await client.transcribe(CLIP, { languageCode: "es" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(STT_ENDPOINT);
    expect(calls[0].headers["xi-api-key"]).toBe("sk-elevenlabs-test");
    // The API key must not be smuggled into the body as well as the header,
    // and a JSON body cannot carry a recording at all.
    expect(calls[0].body).toBeInstanceOf(FormData);

    const form = calls[0].body as FormData;
    expect(form.get("model_id")).toBe(TRANSCRIPTION_MODEL);
    expect(form.get("language_code")).toBe("es");
    expect((form.get("file") as File).name).toBe("clip.webm");
    expect(transcript.text).toBe("me llamo Ada");
  });

  test("leaves the language out when the caller has none", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch({ text: "hello" });
    const client = createElevenLabsClient({ fetchImpl });

    await client.transcribe(CLIP, {});

    const form = calls[0].body as FormData;
    // A guessed language is worse than none: the vendor's own detection is
    // better than a wrong guess, and a wrong guess silently mis-transcribes a
    // name.
    expect(form.has("language_code")).toBe(false);
  });

  test("does not ask for audio event tags nobody wants", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch({ text: "hola" });
    const client = createElevenLabsClient({ fetchImpl });

    await client.transcribe(CLIP, {});

    const form = calls[0].body as FormData;
    expect(form.get("tag_audio_events")).toBe("false");
  });

  test("refuses a recording larger than the cap, without uploading it", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch({ text: "" });
    const client = createElevenLabsClient({ fetchImpl });

    await expect(
      client.transcribe({ ...CLIP, bytes: new Uint8Array(MAX_AUDIO_BYTES + 1) }, {}),
    ).rejects.toBeInstanceOf(VendorRequestError);
    expect(calls).toEqual([]);
  });

  test("treats a vendor answer with no text as a failure, not as silence", async () => {
    setEnv({});

    for (const body of [{}, { text: "" }, { text: 42 }, null, "ok"]) {
      const { fetchImpl } = recordingFetch(body);
      const client = createElevenLabsClient({ fetchImpl });

      // An empty transcript that looked like success would send a patient
      // through a review step with nothing in it, and the next error would be
      // "no fields could be extracted", which is a much worse thing to say.
      await expect(client.transcribe(CLIP, {})).rejects.toBeInstanceOf(VendorRequestError);
    }
  });

  test("refuses without a key rather than sending an unauthenticated recording", async () => {
    setEnv({ ELEVENLABS_API_KEY: undefined });
    const { fetchImpl, calls } = recordingFetch({ text: "hola" });
    const client = createElevenLabsClient({ fetchImpl });

    await expect(client.transcribe(CLIP, {})).rejects.toBeInstanceOf(VoiceNotConfiguredError);
    expect(calls).toEqual([]);
  });
});

describe("speak", () => {
  test("asks for audio and returns the bytes", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch(undefined, {
      bytes: new Uint8Array([0x49, 0x44, 0x33]),
    });
    const client = createElevenLabsClient({ fetchImpl });

    const audio = await client.speak("Su cita es el martes");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(SPEECH_ENDPOINT);
    expect(calls[0].url).toContain("/v1/text-to-speech/");
    expect(calls[0].headers["xi-api-key"]).toBe("sk-elevenlabs-test");

    const body = JSON.parse(calls[0].body as string) as { text: string; model_id: string };
    expect(body.text).toBe("Su cita es el martes");
    expect(body.model_id).toBe(TTS_MODEL);
    expect([...audio]).toEqual([0x49, 0x44, 0x33]);
  });

  test("refuses text longer than the cap rather than paying for it", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch(undefined);
    const client = createElevenLabsClient({ fetchImpl });

    await expect(client.speak("x".repeat(MAX_SPEECH_CHARACTERS + 1))).rejects.toBeInstanceOf(
      VendorRequestError,
    );
    expect(calls).toEqual([]);
  });

  test("refuses empty text", async () => {
    setEnv({});
    const { fetchImpl, calls } = recordingFetch(undefined);
    const client = createElevenLabsClient({ fetchImpl });

    await expect(client.speak("   ")).rejects.toBeInstanceOf(VendorRequestError);
    expect(calls).toEqual([]);
  });

  test("reports a vendor refusal as a vendor failure", async () => {
    setEnv({});
    const { fetchImpl } = recordingFetch({ detail: "quota exceeded" }, { ok: false, status: 429 });
    const client = createElevenLabsClient({ fetchImpl });

    const error = await rejection(client.speak("hola"));
    expect(error).toBeInstanceOf(VendorRequestError);
    expect((error as VendorRequestError).status).toBe(429);
  });
});
