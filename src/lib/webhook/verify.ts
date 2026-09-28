import "server-only";

import * as crypto from "crypto";
import { getServerEnv } from "@/lib/env";

/**
 * Vendor webhook signature verification (#65).
 *
 * The internal shared secret proves a request came from this app's own
 * handlers. Vendor callbacks -- Twilio status updates, ElevenLabs agent
 * events -- come from outside, so they prove themselves with HMAC-SHA256
 * over the raw request body, keyed by a per-vendor secret.
 *
 * Two deliberate choices:
 *   - The HMAC is computed over the raw body text, before JSON parsing.
 *     Re-serialising a parsed body does not round-trip byte-for-byte
 *     (whitespace, key order), so verifying after parsing would reject
 *     legitimately signed requests.
 *   - Comparison is constant-time. A plain `===` leaks the matching prefix
 *     length through timing, which lets a forgery be refined byte by byte.
 *
 * This module never logs. The secrets and the body both pass through here,
 * and the body of a vendor event can carry the same patient-shaped fields
 * the redaction allowlist exists to keep out of logs.
 *
 * ## Two schemes, and which one is real
 *
 * There are two things in this file and they are not the same thing, and until
 * #3 they were described as though they were.
 *
 * `verifyHmacSha256Signature` and the `elevenlabs` branch of
 * `verifyVendorWebhook` are #65's: HMAC-SHA256 over the raw request body. That
 * is what ElevenLabs signs and it is verified. It is **not** what Twilio signs.
 *
 * Twilio signs with HMAC-SHA1, keyed by the account's AuthToken, over the URL it
 * requested with every POST parameter's name and value concatenated onto the
 * end in alphabetical order. The body is form-encoded, not JSON, and the URL is
 * part of the signed string -- so a signature cannot be verified from a body
 * alone, which is why a request verified the SHA-256 way is *always* rejected
 * by a real Twilio callback. That is now stated in the return value rather than
 * left to be discovered: `verifyVendorWebhook` reports which scheme it applied,
 * and `/api/webhook` -- the route a deployment predating #3 points its callback
 * at -- still reports `hmac-sha256-body`, which is the truth about it. The
 * routes that interoperate with Twilio live in /api/twilio and pass the URL.
 *
 * The key is the account AuthToken, not `TWILIO_WEBHOOK_SECRET`. That is
 * Twilio's design and it is worth stating plainly: being able to forge a Twilio
 * webhook here means holding the same secret that authorises the Twilio REST
 * API. `TWILIO_WEBHOOK_SECRET` is left doing the job #65 gave it, and is not
 * used for Twilio's real scheme, because a value that is not the one Twilio
 * signs with cannot verify anything.
 */

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
export const ELEVENLABS_SIGNATURE_HEADER = "elevenlabs-signature";
/** Some ElevenLabs clients send the `x-` prefixed variant. */
export const ELEVENLABS_SIGNATURE_HEADER_ALT = "x-elevenlabs-signature";

export type WebhookVendor = "twilio" | "elevenlabs";

/**
 * Which rule a verification was actually performed under.
 *
 * `hmac-sha256-body` is #65's scheme and is real for ElevenLabs. For Twilio it
 * is the wrong scheme, and a callback verified under it will never match a
 * genuine one -- so the answer is reported rather than left implicit, and
 * `twilio-url-sorted` is Twilio's real scheme.
 */
export type WebhookScheme = "hmac-sha256-body" | "twilio-url-sorted";

export interface VendorVerification {
  /**
   * True when a vendor signature was present *and* its secret is configured,
   * i.e. verification was actually possible. False means the route must fall
   * back to the internal shared secret, not that verification failed.
   */
  attempted: boolean;
  ok: boolean;
  vendor: WebhookVendor | null;
  /**
   * The scheme that was applied, or null when nothing was attempted. Present
   * because a caller that cannot tell the two Twilio results apart cannot tell
   * a working configuration from a misconfigured one.
   */
  scheme: WebhookScheme | null;
}

/**
 * Compute the expected HMAC-SHA256 digest of a raw body.
 *
 * Exported for tests and for clients that need to sign fixtures; the route
 * itself only verifies.
 */
export function computeHmacSha256(secret: string, rawBody: string): Buffer {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
}

function decodeCandidate(provided: string): Buffer[] {
  // Vendors encode the same digest differently: hex (`v0=<hex>` for
  // ElevenLabs-style HMAC) or base64 (Twilio-style). A hex digest is also
  // valid base64 alphabet, so hex is tried only when the whole candidate
  // parses as hex, and each decoding is compared as bytes, not strings.
  const candidates: Buffer[] = [];
  const trimmed = provided.trim();

  // Strip composite envelopes (`t=...,v0=...`, `sha256=...`, `v0=...`) down
  // to the signature itself.
  const match = /(?:^|,)v0=([^,]+)$/.exec(trimmed) ?? /^(?:sha256=)?(.+)$/.exec(trimmed);
  const bare = (match?.[1] ?? trimmed).trim();

  if (/^[0-9a-fA-F]+$/.test(bare) && bare.length % 2 === 0 && bare.length > 0) {
    try {
      candidates.push(Buffer.from(bare, "hex"));
    } catch {
      // Fall through to base64 below.
    }
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(bare) && bare.length % 4 === 0 && bare.length > 0) {
    try {
      candidates.push(Buffer.from(bare, "base64"));
    } catch {
      // No usable decoding; verification fails closed below.
    }
  }

  return candidates;
}

/**
 * Verify an HMAC-SHA256 signature over a raw body.
 *
 * Returns false -- never throws -- for missing inputs, undecodable
 * signatures, and mismatches. In particular a short or malformed forgery is
 * a `false`, not a `timingSafeEqual` length-mismatch throw that would
 * surface as a 500.
 */
export function verifyHmacSha256Signature(
  provided: string | null | undefined,
  secret: string | null | undefined,
  rawBody: string,
): boolean {
  if (!provided || !secret) return false;

  const expected = computeHmacSha256(secret, rawBody);
  const candidates = decodeCandidate(provided);

  return candidates.some(
    (candidate) => candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected),
  );
}

/**
 * Decide whether an inbound request carries a verifiable vendor signature.
 *
 * Reads headers only; the caller supplies the already-read raw body. When
 * neither vendor's header-and-secret pair is complete, reports
 * `{ attempted: false }` so the route falls back to the internal secret.
 *
 * `options.url` is the difference between the two Twilio answers. Supply the
 * exact URL the vendor requested, together with the request's content type, and
 * a Twilio signature is checked the way Twilio computes it. Omit them -- which
 * is what /api/webhook does, because it has no way to know the URL it was
 * reached on -- and a Twilio signature falls back to the SHA-256-over-body rule,
 * which a genuine Twilio callback will not satisfy.
 */
export function verifyVendorWebhook(
  headers: Headers,
  rawBody: string,
  options: { url?: string; contentType?: string | null } = {},
): VendorVerification {
  const env = getServerEnv();

  const twilioSignature = headers.get(TWILIO_SIGNATURE_HEADER);
  if (twilioSignature) {
    if (options.url !== undefined && isFormEncoded(options.contentType)) {
      // Twilio's own key. Not TWILIO_WEBHOOK_SECRET: a value that is not the one
      // Twilio signed with verifies nothing, and falling back to it would turn
      // "not configured" into "configured and rejecting every callback".
      const authToken = env.TWILIO_AUTH_TOKEN?.trim();
      if (authToken) {
        return {
          attempted: true,
          ok: verifyTwilioSignature(
            twilioSignature,
            authToken,
            options.url,
            readFormParams(rawBody),
          ),
          vendor: "twilio",
          scheme: "twilio-url-sorted",
        };
      }
    }

    if (env.TWILIO_WEBHOOK_SECRET) {
      return {
        attempted: true,
        ok: verifyHmacSha256Signature(twilioSignature, env.TWILIO_WEBHOOK_SECRET, rawBody),
        vendor: "twilio",
        scheme: "hmac-sha256-body",
      };
    }
  }

  const elevenLabsSignature =
    headers.get(ELEVENLABS_SIGNATURE_HEADER) ?? headers.get(ELEVENLABS_SIGNATURE_HEADER_ALT);
  if (elevenLabsSignature && env.ELEVENLABS_WEBHOOK_SECRET) {
    return {
      attempted: true,
      ok: verifyHmacSha256Signature(elevenLabsSignature, env.ELEVENLABS_WEBHOOK_SECRET, rawBody),
      vendor: "elevenlabs",
      scheme: "hmac-sha256-body",
    };
  }

  return { attempted: false, ok: false, vendor: null, scheme: null };
}

/**
 * The URL the vendor actually requested, for a signature that covers one.
 *
 * Twilio signs the URL it called, so a route that wants to verify a Twilio
 * signature has to know that URL and not the one the framework hands it: behind
 * a proxy the runtime sees `http://localhost:3000/...` and Twilio signed
 * `https://clinic.example/...`. The forwarded headers are what close that gap.
 *
 * They are also client-settable, and that is fine, which is worth being explicit
 * about because it reads like it should not be. A header can only change *which*
 * URL is checked. It cannot make a wrong signature right: a forged header
 * produces a URL the genuine signature was not computed over, and the request is
 * refused. The failure mode of trusting it is a legitimate callback being
 * rejected when a proxy rewrites the host, which is a support ticket rather than
 * a vulnerability.
 */
export function publicRequestUrl(request: Request): string {
  const url = new URL(request.url);

  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto === "http" || proto === "https") url.protocol = `${proto}:`;

  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) url.host = host;

  return url.toString();
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

function isFormEncoded(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === FORM_CONTENT_TYPE;
}

/**
 * A form body, as ordered name/value pairs.
 *
 * `URLSearchParams` rather than `Object.fromEntries`, because a repeated name is
 * not a single value: Twilio signs every value of a repeated name, and
 * collapsing two of them into one drops the second from the signed string --
 * which is exactly the shape of a forgery, a genuine signature with an extra
 * parameter smuggled in behind a duplicate.
 */
function readFormParams(rawBody: string): [string, string][] {
  return [...new URLSearchParams(rawBody)];
}

/**
 * Twilio's parameters, as an object, an ordered list of pairs, or the form they
 * were read from.
 *
 * All three because a form is the honest source of truth and a `Record` is what
 * a test or a hand-built call is easier to write. `URLSearchParams` has no
 * enumerable own properties, so treating one as a `Record` silently signs over
 * nothing at all -- which would make every form signature valid and every
 * tampered form undetectable.
 */
export type TwilioSignatureParams =
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>
  | URLSearchParams;

function toPairs(params: TwilioSignatureParams): [string, string][] {
  if (params instanceof URLSearchParams) return [...params];
  if (Array.isArray(params)) {
    return params.map(([name, value]) => [name, value] as [string, string]);
  }
  return Object.entries(params as Record<string, string>);
}

/**
 * The string Twilio signs, and the signature of it.
 *
 * HMAC-SHA1 over the URL with every parameter's name and value concatenated onto
 * the end, in ascending order of the name, base64-encoded. Exported because the
 * test suite checks this against the digest in Twilio's own published worked
 * example -- a check that is worth nothing if the only thing it compares is this
 * function against itself.
 *
 * Names are sorted with `<`/`>` on UTF-16 code units, which is what Twilio means
 * by "Unix-style case-sensitive sorting order": uppercase sorts before
 * lowercase. Values of a repeated name are sorted among themselves, as the
 * vendor's own validator does.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  ...params: TwilioSignatureParams[]
): string {
  const names = new Set<string>();
  for (const group of params) for (const [name] of toPairs(group)) names.add(name);

  let signed = url;
  for (const name of [...names].sort()) {
    const values: string[] = [];
    for (const group of params) {
      for (const [candidate, value] of toPairs(group)) {
        if (candidate === name) values.push(value);
      }
    }
    for (const value of values.sort()) signed += name + value;
  }

  return crypto.createHmac("sha1", authToken).update(signed, "utf8").digest("base64");
}

/**
 * Verify a Twilio signature, in constant time, without ever throwing.
 *
 * Two URLs are tried, as Twilio's own validator does: the one it was given, and
 * the same URL with a default port removed. Which of the two Twilio signs is not
 * consistent across their edge, and a validator that picks one rejects a
 * proportion of genuine callbacks -- a failure that looks exactly like an attack
 * and is indistinguishable from one.
 *
 * A missing header, a missing token, an unparseable URL, or a candidate of the
 * wrong length is a `false`. A short forgery must never reach `timingSafeEqual`
 * and become a 500 on a route Twilio retries.
 */
export function verifyTwilioSignature(
  provided: string | null | undefined,
  authToken: string | null | undefined,
  url: string,
  params: TwilioSignatureParams = {},
): boolean {
  if (!provided || !authToken) return false;

  const candidate = Buffer.from(provided, "base64");
  if (candidate.length === 0) return false;

  return urlVariants(url).some((candidateUrl) => {
    const expected = Buffer.from(
      computeTwilioSignature(authToken, candidateUrl, params),
      "base64",
    );
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}

/**
 * The three spellings of one URL a vendor might have signed.
 *
 * A default port present, a default port absent, and whatever was given. `URL`
 * silently discards a default port when it parses, so both variants are rebuilt
 * from the parsed parts rather than assigned -- assigning `port = "443"` to an
 * https URL is a no-op, which is exactly the kind of thing that makes a
 * validator quietly accept half of the genuine callbacks and reject the rest.
 */
function urlVariants(url: string): string[] {
  const variants = [url];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return variants;
  }

  const port = parsed.protocol === "https:" ? ":443" : parsed.protocol === "http:" ? ":80" : "";
  if (port === "") return variants;

  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  variants.push(`${parsed.protocol}//${parsed.hostname}${port}${rest}`);
  if (parsed.port !== "") {
    variants.push(`${parsed.protocol}//${parsed.hostname}${rest}`);
  }

  return [...new Set(variants)];
}
