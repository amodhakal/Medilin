import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetServerEnvCache } from "@/lib/env";
import { setRateLimitStore } from "@/lib/rate-limit";
import { setElevenLabsClient, MAX_SPEECH_CHARACTERS, type ElevenLabsClient } from "@/lib/voice/elevenlabs";
import { POST } from "./route";

/**
 * POST /api/voice/speak (#61).
 *
 * The read-back half of voice intake: a patient who has just spoken their
 * details may want to hear them read back before confirming, and a person
 * answering out loud is a person who has just made a mistake.
 *
 * It is also the endpoint most likely to be used as a general text-to-speech
 * service on somebody's metered account, so most of this file is about refusing.
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

const saved = new Map<string, string | undefined>();
for (const key of Object.keys(BASELINE)) saved.set(key, process.env[key]);

function setEnv(without: string[] = []): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  for (const [key, value] of Object.entries(BASELINE)) {
    if (without.includes(key)) continue;
    process.env[key] = value;
  }
  resetServerEnvCache();
}

let spoken: string[] = [];
let speakFails: Error | null = null;

function stubVendor(): void {
  spoken = [];
  const client: ElevenLabsClient = {
    mintConversationUrl: async () => ({ url: "wss://unused", expiresAt: 0 }),
    transcribe: async () => {
      throw new Error("unused");
    },
    speak: async (text) => {
      spoken.push(text);
      if (speakFails) throw speakFails;
      return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    },
  };
  setElevenLabsClient(client);
}

function call(body: unknown) {
  return new NextRequest("https://clinic.test/api/voice/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setEnv();
  setRateLimitStore(null);
  speakFails = null;
  stubVendor();
});

afterEach(() => {
  setRateLimitStore(null);
  setElevenLabsClient(null);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("reading a summary aloud", () => {
  test("returns audio the browser can play", async () => {
    const response = await POST(call({ text: "Su cita es el martes a las 9:30" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]),
    );
    expect(spoken).toEqual(["Su cita es el martes a las 9:30"]);
  });

  test("trims what it was given rather than reading the padding aloud", async () => {
    await POST(call({ text: "  hola  " }));

    expect(spoken).toEqual(["hola"]);
  });
});

describe("a request that is not a read-aloud", () => {
  test("is refused without spending anything", async () => {
    for (const body of [
      {},
      { text: "" },
      { text: "   " },
      { text: 42 },
      { text: "hi", voice: "someone-elses-voice" },
      { text: "x".repeat(MAX_SPEECH_CHARACTERS + 1) },
    ]) {
      const response = await POST(call(body));
      expect(response.status).toBe(400);
    }
    expect(spoken).toEqual([]);
  });

  test("is refused when the body is not JSON at all", async () => {
    const request = new NextRequest("https://clinic.test/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hola",
    });

    expect((await POST(request)).status).toBe(400);
    expect(spoken).toEqual([]);
  });
});

describe("a deployment that cannot speak", () => {
  test("says so without calling the vendor", async () => {
    setEnv(["ELEVENLABS_API_KEY"]);

    const response = await POST(call({ text: "hola" }));

    expect(response.status).toBe(503);
    expect(spoken).toEqual([]);
  });

  test("reports a vendor failure as a vendor failure", async () => {
    speakFails = new Error("The voice vendor refused the request");

    const response = await POST(call({ text: "hola" }));

    expect(response.status).toBe(502);
    // The vendor's own words are not echoed: they can echo the request, and the
    // request is what the patient just said.
    expect(await response.text()).not.toContain("refused the request");
  });
});

describe("cost control", () => {
  test("is metered per caller", async () => {
    const headers = { "x-forwarded-for": "203.0.113.77" };
    let throttled: Response | null = null;

    for (let attempt = 0; attempt < 40 && !throttled; attempt += 1) {
      const request = new NextRequest("https://clinic.test/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ text: "hola" }),
      });

      const response = await POST(request);
      if (response.status === 429) throttled = response;
    }

    expect(throttled).not.toBeNull();
    expect(spoken.length).toBeLessThanOrEqual(40);
  });
});
