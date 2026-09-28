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
 */

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
export const ELEVENLABS_SIGNATURE_HEADER = "elevenlabs-signature";
/** Some ElevenLabs clients send the `x-` prefixed variant. */
export const ELEVENLABS_SIGNATURE_HEADER_ALT = "x-elevenlabs-signature";

export type WebhookVendor = "twilio" | "elevenlabs";

export interface VendorVerification {
  /**
   * True when a vendor signature was present *and* its secret is configured,
   * i.e. verification was actually possible. False means the route must fall
   * back to the internal shared secret, not that verification failed.
   */
  attempted: boolean;
  ok: boolean;
  vendor: WebhookVendor | null;
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
 */
export function verifyVendorWebhook(headers: Headers, rawBody: string): VendorVerification {
  const env = getServerEnv();

  const twilioSignature = headers.get(TWILIO_SIGNATURE_HEADER);
  if (twilioSignature && env.TWILIO_WEBHOOK_SECRET) {
    return {
      attempted: true,
      ok: verifyHmacSha256Signature(twilioSignature, env.TWILIO_WEBHOOK_SECRET, rawBody),
      vendor: "twilio",
    };
  }

  const elevenLabsSignature =
    headers.get(ELEVENLABS_SIGNATURE_HEADER) ?? headers.get(ELEVENLABS_SIGNATURE_HEADER_ALT);
  if (elevenLabsSignature && env.ELEVENLABS_WEBHOOK_SECRET) {
    return {
      attempted: true,
      ok: verifyHmacSha256Signature(elevenLabsSignature, env.ELEVENLABS_WEBHOOK_SECRET, rawBody),
      vendor: "elevenlabs",
    };
  }

  return { attempted: false, ok: false, vendor: null };
}
