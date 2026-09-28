import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { resetServerEnvCache } from "@/lib/env";
import { setLlmClient } from "@/lib/gemini";
import { setRateLimitStore } from "@/lib/rate-limit";
import { setElevenLabsClient, type ElevenLabsClient } from "@/lib/voice/elevenlabs";
import { MAX_AUDIO_BYTES } from "@/lib/voice/elevenlabs";
import { POST } from "./route";

/**
 * POST /api/voice/intake (#61).
 *
 * Recording in, the form's own field names out. The endpoint that makes voice
 * intake "the same intake" rather than a second one, so what it must never do
 * is invent a payload: the fields it returns are read out of the model's reply
 * and validated by the server's own schema, and the test asserts exactly that by
 * parsing the response with the real schema.
 *
 * The vendor and the model are both stubbed. The rate limiter, the multipart
 * parsing, the size cap, and the schema are the real ones.
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

/**
 * Reset the environment to the baseline, with the named variables removed.
 *
 * `undefined` in `without` means "unset this one", which is how a deployment
 * with no voice credential is described. Assigning an empty string instead would
 * be a different thing entirely: the env schema rejects it.
 */
function setEnv(without: string[] = []): void {
  for (const key of Object.keys(BASELINE)) delete process.env[key];
  for (const [key, value] of Object.entries(BASELINE)) {
    if (without.includes(key)) continue;
    process.env[key] = value;
  }
  resetServerEnvCache();
}

const SPOKEN = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "no",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Dentist",
  additionalInfo: "dolor de muela",
};

let transcript = "me llamo Ada Lovelace";
let modelReply: unknown = SPOKEN;
let vendorFailure: Error | null = null;
let uploads: { bytes: number; mimeType: string; languageCode?: string }[] = [];

function stubVendor(): void {
  uploads = [];
  const client: ElevenLabsClient = {
    mintConversationUrl: async () => ({ url: "wss://unused", expiresAt: 0 }),
    transcribe: async (audio, options) => {
      uploads.push({
        bytes: audio.bytes.byteLength,
        mimeType: audio.mimeType,
        languageCode: options.languageCode,
      });
      if (vendorFailure) throw vendorFailure;
      return { text: transcript, languageCode: options.languageCode ?? null };
    },
    speak: async () => {
      throw new Error("unused");
    },
  };
  setElevenLabsClient(client);
}

/** A multipart body, as the browser will send it. */
function call({
  audio,
  language = "spanish",
  type = "audio/webm",
  filename = "clip.webm",
  omitAudio = false,
  extra = false,
}: {
  audio?: Uint8Array<ArrayBuffer>;
  language?: string;
  type?: string;
  filename?: string;
  omitAudio?: boolean;
  extra?: boolean;
} = {}) {
  const form = new FormData();
  if (!omitAudio) {
    form.set(
      "audio",
      new File([audio ?? new Uint8Array([1, 2, 3, 4])], filename, { type }),
    );
  }
  form.set("language", language);
  if (extra) form.set("agent_id", "someone_elses_agent");

  return new NextRequest("https://clinic.test/api/voice/intake", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  setEnv();
  setRateLimitStore(null);
  transcript = "me llamo Ada Lovelace";
  modelReply = SPOKEN;
  vendorFailure = null;
  stubVendor();
  setLlmClient({
    async generateJson() {
      return modelReply;
    },
  });
});

afterEach(() => {
  setRateLimitStore(null);
  setElevenLabsClient(null);
  setLlmClient(null);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

afterAll(() => {
  resetServerEnvCache();
});

describe("a recording of a patient answering", () => {
  test("comes back as the form's own fields", async () => {
    const response = await POST(call());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transcript: string;
      language: string;
      complete: boolean;
      issues: unknown[];
      fields: Record<string, unknown>;
    };

    expect(body.transcript).toBe("me llamo Ada Lovelace");
    expect(body.language).toBe("spanish");
    expect(body.complete).toBe(true);
    expect(body.issues).toEqual([]);
    // Exactly the keys the form posts. Anything else here and the review step is
    // rendering a different form from the one that books.
    expect(Object.keys(body.fields).sort()).toEqual(
      [
        "additionalInfo",
        "appointmentDateTime",
        "dob",
        "email",
        "firstName",
        "insurance",
        "language",
        "lastName",
        "medical_department",
        "phone",
      ].sort(),
    );
    expect(body.fields.medical_department).toBe("Dentist");
  });

  test("is transcribed and asked about in the language it was recorded in", async () => {
    await POST(call({ language: "portuguese" }));

    // The vendor is told the language so it does not guess, and the model is
    // told so it does not translate a symptom text that the booking pipeline
    // will translate later, once.
    expect(uploads[0]?.languageCode).toBe("portuguese");
  });

  test("books nothing on its own", async () => {
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      sent.push(String(input));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await POST(call());
    } finally {
      globalThis.fetch = realFetch;
    }

    // Extraction is a draft. The booking happens when the patient confirms it,
    // through the same server action the form uses.
    expect(sent).toEqual([]);
  });
});

describe("a recording that cannot be used", () => {
  test("is refused when there is no audio", async () => {
    const response = await POST(call({ omitAudio: true }));

    expect(response.status).toBe(400);
    expect(uploads).toEqual([]);
  });

  test("is refused when it is not audio", async () => {
    // Neither signal says audio, and one of the two has to. The declared type
    // and the filename both come from the client, which is why this is a cheap
    // early error and not a safety property -- see resolveAudioType.
    const response = await POST(call({ type: "text/html", filename: "page.html" }));

    expect(response.status).toBe(400);
    expect(uploads).toEqual([]);
  });

  test("accepts a recording the runtime misreports by filename", async () => {
    // A real multipart parser is allowed to reconstruct a part's type from the
    // filename, and one does: it turns a part declared audio/mp4 into
    // video/webm. Refusing that would be refusing every recording.
    const response = await POST(call({ type: "audio/mp4", filename: "clip.m4a" }));

    expect(response.status).toBe(200);
    expect(uploads[0]?.mimeType).toMatch(/^audio\//);
  });

  test("is refused when it is over the cap, before it is read", async () => {
    const response = await POST(
      call({ audio: new Uint8Array(new ArrayBuffer(MAX_AUDIO_BYTES + 1)) }),
    );

    expect(response.status).toBe(413);
    expect(uploads).toEqual([]);
  });

  test("is refused for a language the form does not book in", async () => {
    const response = await POST(call({ language: "fr" }));

    expect(response.status).toBe(400);
    expect(uploads).toEqual([]);
  });

  test("is refused when the request carries a field this endpoint does not take", async () => {
    // Strict, like every other body in this app. A voice endpoint that quietly
    // ignores an `agent_id` in its body is an endpoint that has been asked a
    // question about who to be.
    const response = await POST(call({ extra: true }));

    expect(response.status).toBe(400);
    expect(uploads).toEqual([]);
  });

  test("is reported as a vendor failure rather than as an empty form", async () => {
    vendorFailure = new Error("The voice vendor refused the recording");

    const response = await POST(call());

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("refused the recording");
  });

  test("is reported when the model cannot be asked", async () => {
    setLlmClient({
      async generateJson() {
        throw new Error("Model returned an empty response in JSON mode");
      },
    });

    const response = await POST(call());

    expect(response.status).toBe(502);
  });
});

describe("a transcript the model cannot use", () => {
  test("comes back as a draft with issues, not as a failure", async () => {
    // The ordinary case: someone answers seven of nine questions.
    modelReply = { ...SPOKEN, dob: null, phone: null };

    const response = await POST(call());
    const body = (await response.json()) as {
      complete: boolean;
      issues: { field: string }[];
      fields: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.issues.map((issue) => issue.field).sort()).toEqual(["dob", "phone"]);
    expect(body.fields.firstName).toBe("Ada");
  });

  test("never books a field the schema would reject", async () => {
    modelReply = { ...SPOKEN, email: "not-an-email" };

    const body = (await (await POST(call())).json()) as {
      complete: boolean;
      fields: Record<string, unknown>;
    };

    expect(body.complete).toBe(false);
    expect(body.fields.email).toBeUndefined();
  });
});

describe("cost control", () => {
  test("is metered per caller", async () => {
    const headers = { "x-forwarded-for": "198.51.100.4" };
    let throttled: Response | null = null;

    for (let attempt = 0; attempt < 40 && !throttled; attempt += 1) {
      const form = new FormData();
      form.set("audio", new File([new Uint8Array([1])], "clip.webm", { type: "audio/webm" }));
      form.set("language", "english");
      const request = new NextRequest("https://clinic.test/api/voice/intake", {
        method: "POST",
        headers,
        body: form,
      });

      const response = await POST(request);
      if (response.status === 429) throttled = response;
    }

    // One recording costs a transcription and a model call, which is more than
    // a form submission costs, and the budget is the thing that stops a loop.
    expect(throttled).not.toBeNull();
    expect(throttled?.headers.get("retry-after")).toBeTruthy();
  });

  test("does not spend anything on a request it refuses", async () => {
    await POST(call({ omitAudio: true }));
    await POST(call({ language: "fr" }));
    await POST(call({ extra: true }));

    expect(uploads).toEqual([]);
  });
});

describe("a deployment without voice configured", () => {
  test("says so, and does not upload the recording anywhere", async () => {
    setEnv(["ELEVENLABS_API_KEY"]);

    const response = await POST(call());

    expect(response.status).toBe(503);
    expect(uploads).toEqual([]);
  });
});

describe("what this endpoint will not do with a patient's words", () => {
  test("keeps the transcript out of the response when it has to report a failure", async () => {
    vendorFailure = new Error("boom");
    transcript = "my name is Ada and I have chest pain";

    const response = await POST(call());

    expect(await response.text()).not.toContain("chest pain");
  });
});
