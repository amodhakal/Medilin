import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "crypto";
import { resetServerEnvCache } from "@/lib/env";

/**
 * Vendor webhook signature verification (#65).
 *
 * The route guard used to be only the internal shared secret: anyone who
 * learned it could forge a "vendor" event. Vendor callbacks must prove they
 * hold the vendor secret, via HMAC-SHA256 over the raw body compared in
 * constant time.
 */

const BASELINE: Record<string, string> = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  INTERNAL_API_SECRET: "s".repeat(32),
};

for (const [key, value] of Object.entries(BASELINE)) {
  process.env[key] = value;
}
resetServerEnvCache();

const saved = new Map<string, string | undefined>([
  ["TWILIO_WEBHOOK_SECRET", process.env.TWILIO_WEBHOOK_SECRET],
  ["ELEVENLABS_WEBHOOK_SECRET", process.env.ELEVENLABS_WEBHOOK_SECRET],
]);

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
});

function setVendorSecrets(twilio?: string, elevenlabs?: string) {
  if (twilio === undefined) delete process.env.TWILIO_WEBHOOK_SECRET;
  else process.env.TWILIO_WEBHOOK_SECRET = twilio;
  if (elevenlabs === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  else process.env.ELEVENLABS_WEBHOOK_SECRET = elevenlabs;
  resetServerEnvCache();
}

const SECRET = "whsec_test_secret_32_chars_minimum!!";
const RAW_BODY = JSON.stringify({ type: "call.ended", call_id: "call_123" });

function hmacHex(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function hmacBase64(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

// Imported lazily per test so env reseeding above takes effect through the
// resetServerEnvCache seam (modules under test read env at call time).
async function load() {
  return import("./verify");
}

describe("verifyHmacSha256Signature", () => {
  test("accepts a correct hex signature", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(verifyHmacSha256Signature(hmacHex(SECRET, RAW_BODY), SECRET, RAW_BODY)).toBe(true);
  });

  test("accepts a correct base64 signature (Twilio-style encoding)", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(verifyHmacSha256Signature(hmacBase64(SECRET, RAW_BODY), SECRET, RAW_BODY)).toBe(true);
  });

  test("accepts a v0= prefixed signature (ElevenLabs-style encoding)", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(
      verifyHmacSha256Signature(`v0=${hmacHex(SECRET, RAW_BODY)}`, SECRET, RAW_BODY),
    ).toBe(true);
  });

  test("accepts t=timestamp,v0= composite signatures", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(
      verifyHmacSha256Signature(
        `t=1759612800,v0=${hmacHex(SECRET, RAW_BODY)}`,
        SECRET,
        RAW_BODY,
      ),
    ).toBe(true);
  });

  test("rejects a tampered body", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(
      verifyHmacSha256Signature(hmacHex(SECRET, RAW_BODY), SECRET, `${RAW_BODY} `),
    ).toBe(false);
  });

  test("rejects a wrong secret without throwing", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(verifyHmacSha256Signature(hmacHex("wrong-secret", RAW_BODY), SECRET, RAW_BODY)).toBe(
      false,
    );
  });

  test("rejects missing or empty inputs without throwing", async () => {
    const { verifyHmacSha256Signature } = await load();
    expect(verifyHmacSha256Signature(null, SECRET, RAW_BODY)).toBe(false);
    expect(verifyHmacSha256Signature("", SECRET, RAW_BODY)).toBe(false);
    expect(verifyHmacSha256Signature(hmacHex(SECRET, RAW_BODY), "", RAW_BODY)).toBe(false);
  });

  test("rejects different-length inputs without throwing", async () => {
    // timingSafeEqual throws on length mismatch; the wrapper must hash or
    // length-gate first so a short forgery is a false, not a 500.
    const { verifyHmacSha256Signature } = await load();
    expect(verifyHmacSha256Signature("abc", SECRET, RAW_BODY)).toBe(false);
    expect(verifyHmacSha256Signature(hmacHex(SECRET, RAW_BODY).slice(0, -2), SECRET, RAW_BODY)).toBe(
      false,
    );
  });

  test("never echoes the secret in thrown errors", async () => {
    const { verifyHmacSha256Signature } = await load();
    let message = "";
    try {
      // @ts-expect-error deliberate misuse: a non-string where a header value
      // is expected, which makes decodeCandidate throw on .trim().
      verifyHmacSha256Signature(42, SECRET, RAW_BODY);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(SECRET);
  });
});

describe("verifyVendorWebhook", () => {
  test("verifies a Twilio signature when the secret is configured", async () => {
    setVendorSecrets(SECRET, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await load();
    const headers = new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64(SECRET, RAW_BODY) });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({ attempted: true, ok: true, vendor: "twilio" });
  });

  test("rejects a forged Twilio signature", async () => {
    setVendorSecrets(SECRET, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await load();
    const headers = new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64("forgery", RAW_BODY) });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({ attempted: true, ok: false, vendor: "twilio" });
  });

  test("verifies an ElevenLabs signature when the secret is configured", async () => {
    setVendorSecrets(undefined, SECRET);
    const { verifyVendorWebhook, ELEVENLABS_SIGNATURE_HEADER } = await load();
    const headers = new Headers({
      [ELEVENLABS_SIGNATURE_HEADER]: `v0=${hmacHex(SECRET, RAW_BODY)}`,
    });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({ attempted: true, ok: true, vendor: "elevenlabs" });
  });

  test("does not attempt vendor verification when no vendor header is present", async () => {
    setVendorSecrets(SECRET, SECRET);
    const { verifyVendorWebhook } = await load();
    const result = verifyVendorWebhook(new Headers(), RAW_BODY);
    expect(result).toEqual({ attempted: false, ok: false, vendor: null });
  });

  test("does not attempt vendor verification when the matching secret is unconfigured", async () => {
    // Falls back to the internal secret in the route: an unconfigured vendor
    // must not read as "attempted and failed".
    setVendorSecrets(undefined, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await load();
    const headers = new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64(SECRET, RAW_BODY) });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({ attempted: false, ok: false, vendor: null });
  });

  test("header names are the documented vendor headers", async () => {
    const { TWILIO_SIGNATURE_HEADER, ELEVENLABS_SIGNATURE_HEADER } = await load();
    expect(TWILIO_SIGNATURE_HEADER).toBe("x-twilio-signature");
    expect(ELEVENLABS_SIGNATURE_HEADER).toBe("elevenlabs-signature");
  });
});
