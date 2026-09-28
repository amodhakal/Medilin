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
    expect(result).toEqual({
      attempted: true,
      ok: true,
      vendor: "twilio",
      scheme: "hmac-sha256-body",
    });
  });

  test("rejects a forged Twilio signature", async () => {
    setVendorSecrets(SECRET, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await load();
    const headers = new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64("forgery", RAW_BODY) });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({
      attempted: true,
      ok: false,
      vendor: "twilio",
      scheme: "hmac-sha256-body",
    });
  });

  test("verifies an ElevenLabs signature when the secret is configured", async () => {
    setVendorSecrets(undefined, SECRET);
    const { verifyVendorWebhook, ELEVENLABS_SIGNATURE_HEADER } = await load();
    const headers = new Headers({
      [ELEVENLABS_SIGNATURE_HEADER]: `v0=${hmacHex(SECRET, RAW_BODY)}`,
    });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({
      attempted: true,
      ok: true,
      vendor: "elevenlabs",
      scheme: "hmac-sha256-body",
    });
  });

  test("does not attempt vendor verification when no vendor header is present", async () => {
    setVendorSecrets(SECRET, SECRET);
    const { verifyVendorWebhook } = await load();
    const result = verifyVendorWebhook(new Headers(), RAW_BODY);
    expect(result).toEqual({ attempted: false, ok: false, vendor: null, scheme: null });
  });

  test("does not attempt vendor verification when the matching secret is unconfigured", async () => {
    // Falls back to the internal secret in the route: an unconfigured vendor
    // must not read as "attempted and failed".
    setVendorSecrets(undefined, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await load();
    const headers = new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64(SECRET, RAW_BODY) });
    const result = verifyVendorWebhook(headers, RAW_BODY);
    expect(result).toEqual({ attempted: false, ok: false, vendor: null, scheme: null });
  });

  test("header names are the documented vendor headers", async () => {
    const { TWILIO_SIGNATURE_HEADER, ELEVENLABS_SIGNATURE_HEADER } = await load();
    expect(TWILIO_SIGNATURE_HEADER).toBe("x-twilio-signature");
    expect(ELEVENLABS_SIGNATURE_HEADER).toBe("elevenlabs-signature");
  });
});

/**
 * Twilio's actual signature scheme (#3).
 *
 * The block above is #65's, and it is not what Twilio sends. That implementation
 * is HMAC-SHA256 over a raw JSON body; a real Twilio callback is
 * `application/x-www-form-urlencoded` and is signed with HMAC-SHA1 over the URL
 * with the sorted parameters concatenated onto it. A real callback verified the
 * first way is always rejected, which is what the module note there now says out
 * loud.
 *
 * The vector below is Twilio's own worked example, transcribed from their
 * security documentation, including the published digest. It is the only test in
 * this repository that can be wrong in a way no amount of agreeing with itself
 * would catch: everything else compares this code against this code, and this
 * compares it against the vendor.
 */
describe("Twilio's signature scheme", () => {
  // https://example.com/myapp.php?foo=1&bar=2
  const TWILIO_URL = "https://example.com/myapp.php?foo=1&bar=2";
  const TWILIO_TOKEN = "12345";
  const TWILIO_PARAMS: Record<string, string> = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  };
  /** Twilio's published digest for exactly that URL, token and parameter set. */
  const TWILIO_PUBLISHED = "L/OH5YylLD5NRKLltdqwSvS0BnU=";

  async function loadTwilio() {
    return import("./verify");
  }

  test("matches the digest Twilio publishes for its documented example", async () => {
    const { computeTwilioSignature } = await loadTwilio();

    expect(computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS)).toBe(TWILIO_PUBLISHED);
  });

  test("accepts that published digest", async () => {
    const { verifyTwilioSignature } = await loadTwilio();

    expect(verifyTwilioSignature(TWILIO_PUBLISHED, TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS)).toBe(
      true,
    );
  });

  test("rejects a parameter that was changed after signing", async () => {
    // The failure this whole scheme exists to catch: a request that reuses a
    // genuine signature with a different body. Verified over the SHA256 path a
    // tampered body is a different raw string; here the parameter set is what
    // changed, so the concatenation is what has to change with it.
    const { verifyTwilioSignature } = await loadTwilio();

    expect(
      verifyTwilioSignature(TWILIO_PUBLISHED, TWILIO_TOKEN, TWILIO_URL, {
        ...TWILIO_PARAMS,
        To: "+18005559999",
      }),
    ).toBe(false);
  });

  test("rejects a different auth token without throwing", async () => {
    const { verifyTwilioSignature } = await loadTwilio();

    expect(verifyTwilioSignature(TWILIO_PUBLISHED, "54321", TWILIO_URL, TWILIO_PARAMS)).toBe(false);
  });

  test("rejects a signature of the wrong length without throwing", async () => {
    const { verifyTwilioSignature } = await loadTwilio();

    // timingSafeEqual throws on a length mismatch; a short forgery has to be a
    // false rather than a 500 on a route Twilio retries.
    expect(verifyTwilioSignature("abc", TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS)).toBe(false);
  });

  test("rejects missing inputs without throwing", async () => {
    const { verifyTwilioSignature } = await loadTwilio();

    expect(verifyTwilioSignature(null, TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS)).toBe(false);
    expect(verifyTwilioSignature(TWILIO_PUBLISHED, "", TWILIO_URL, TWILIO_PARAMS)).toBe(false);
    expect(verifyTwilioSignature(TWILIO_PUBLISHED, TWILIO_TOKEN, "", TWILIO_PARAMS)).toBe(false);
  });

  test("sorts parameter names, so arrival order cannot change the answer", async () => {
    const { computeTwilioSignature } = await loadTwilio();

    const reversed = Object.fromEntries(Object.entries(TWILIO_PARAMS).reverse());

    expect(computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, reversed)).toBe(TWILIO_PUBLISHED);
  });

  test("includes the URL's own query string in what it signs", async () => {
    // A signature is over a request, not over a body: a callback replayed
    // against a different path with the same form is a different request.
    const { verifyTwilioSignature } = await loadTwilio();

    expect(
      verifyTwilioSignature(
        TWILIO_PUBLISHED,
        TWILIO_TOKEN,
        "https://example.com/myapp.php?foo=9&bar=2",
        TWILIO_PARAMS,
      ),
    ).toBe(false);
  });

  test("accepts the URL with an explicit default port, which Twilio also sends", async () => {
    // Twilio's own validator signs the URL twice, with and without the port,
    // because which one it sends is not consistent across their edge.
    const { computeTwilioSignature, verifyTwilioSignature } = await loadTwilio();
    const withPort = computeTwilioSignature(
      TWILIO_TOKEN,
      "https://example.com:443/myapp.php?foo=1&bar=2",
      TWILIO_PARAMS,
    );

    expect(verifyTwilioSignature(withPort, TWILIO_TOKEN, TWILIO_URL, TWILIO_PARAMS)).toBe(true);
  });

  test("keeps repeated parameters, and orders them, as Twilio does", async () => {
    const { computeTwilioSignature } = await loadTwilio();

    const single = computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, { Tag: "b" });
    const repeated = computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, { Tag: "a" }, { Tag: "b" });

    // Distinct inputs must not collapse into one, or a second value for a key
    // would be dropped from the signature and could be changed freely.
    expect(repeated).not.toBe(single);
  });

  test("reads parameters out of a form, which is where they actually come from", async () => {
    // `URLSearchParams` has no enumerable own properties, so treating one as a
    // plain object signs over *nothing* -- which verifies every forged form and
    // rejects nothing. Caught here because the alternative is a check that
    // agrees with itself and is wrong.
    const { computeTwilioSignature, verifyTwilioSignature } = await loadTwilio();
    const form = new URLSearchParams({ Tag: "b", CallSid: "CA1" });

    const signature = computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, form);

    expect(signature).toBe(
      computeTwilioSignature(TWILIO_TOKEN, TWILIO_URL, { Tag: "b", CallSid: "CA1" }),
    );
    expect(verifyTwilioSignature(signature, TWILIO_TOKEN, TWILIO_URL, form)).toBe(true);
    expect(verifyTwilioSignature(signature, TWILIO_TOKEN, TWILIO_URL, { Tag: "b" })).toBe(false);
  });
});

/**
 * Choosing the scheme, and telling the truth about which one ran.
 *
 * `verifyVendorWebhook` is used by /api/webhook, which is where a deployment that
 * predates #3 points its Twilio callback URL. That route has no way to know the
 * URL Twilio requested -- the signature covers it, and the route is not given
 * it -- so it keeps verifying with HMAC-SHA256 over the raw body and a real
 * Twilio callback still fails there. `scheme` is how a caller finds out which
 * rule was applied, instead of having to infer it.
 */
describe("verifyVendorWebhook", () => {
  test("reports the SHA-256 body scheme when it is the only one that can run", async () => {
    setVendorSecrets(SECRET, undefined);
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await import("./verify");

    const result = verifyVendorWebhook(
      new Headers({ [TWILIO_SIGNATURE_HEADER]: hmacBase64(SECRET, RAW_BODY) }),
      RAW_BODY,
    );

    expect(result).toEqual({
      attempted: true,
      ok: true,
      vendor: "twilio",
      scheme: "hmac-sha256-body",
    });
  });

  test("uses Twilio's URL scheme when it is given the URL Twilio requested", async () => {
    setVendorSecrets(undefined, undefined);
    process.env.TWILIO_AUTH_TOKEN = "12345";
    resetServerEnvCache();
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER, computeTwilioSignature } = await import(
      "./verify"
    );

    const url = "https://example.com/myapp.php?foo=1&bar=2";
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+14158675310" };
    const body = new URLSearchParams(params).toString();

    const result = verifyVendorWebhook(
      new Headers({ [TWILIO_SIGNATURE_HEADER]: computeTwilioSignature("12345", url, params) }),
      body,
      { url, contentType: "application/x-www-form-urlencoded" },
    );

    expect(result).toEqual({ attempted: true, ok: true, vendor: "twilio", scheme: "twilio-url-sorted" });
  });

  test("still reports no attempt for an unconfigured vendor", async () => {
    setVendorSecrets(undefined, undefined);
    delete process.env.TWILIO_AUTH_TOKEN;
    resetServerEnvCache();
    const { verifyVendorWebhook, TWILIO_SIGNATURE_HEADER } = await import("./verify");

    const result = verifyVendorWebhook(
      new Headers({ [TWILIO_SIGNATURE_HEADER]: "anything" }),
      "",
      { url: "https://example.com/a", contentType: "application/x-www-form-urlencoded" },
    );

    expect(result).toEqual({ attempted: false, ok: false, vendor: null, scheme: null });
  });
});
