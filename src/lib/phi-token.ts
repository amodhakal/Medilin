import "server-only";

import * as crypto from "crypto";
import { ALGORITHM, IV_LENGTH, getMasterKey } from "./encryption";

/**
 * Opaque, self-contained tokens for patient records.
 *
 * The spectate URL used to carry the record itself, base64-ish encoded, in a
 * query parameter. That put name, email, phone, date of birth, insurance, and
 * symptom text into browser history, into the Referer header of any outbound
 * request, into every reverse-proxy and CDN access log on the path, and into
 * the README's recommended "copy this out of your console" workflow.
 *
 * A plain identifier would fix the exposure, but the appointment store is an
 * in-memory Map, so on Vercel a request can land on an instance that has never
 * seen the write and the page would break. Making the URL an id without first
 * landing durable storage trades a privacy bug for an availability bug.
 *
 * So the token is the record itself, encrypted. This is the transitional
 * mechanism:
 *
 *   - No plaintext PHI in the URL, so logs and history are safe now.
 *   - No database required, so it works across serverless instances now.
 *   - Useless to anyone who has it, since opening it needs HIPAA_MASTER_KEY,
 *     which is server-side only.
 *
 * It is deliberately not the long-term design. A token is as long as the
 * record, it cannot be revoked, and it is a bearer credential that never
 * expires. When storage lands (#17, #42) this becomes a short id plus a
 * server-side lookup, and this module goes away.
 *
 * Layout, before base64url:
 *
 *   version (1) | iv (12) | authTag (16) | ciphertext
 *
 * Single-key AES-256-GCM rather than the DEK-wrapping envelope in
 * encryption.ts. There is no key to wrap here: one short-lived token, one
 * operation, and wrapping a DEK would only make the token longer.
 */

const VERSION = 1;
const AUTH_TAG_LENGTH = 16;

export function sealRecord(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

/**
 * Decrypt a token, or return null.
 *
 * Every failure mode collapses to null on purpose: a truncated token, a
 * tampered token, a token sealed under a different key, and a token from a
 * different version are all "this is not a valid link" to a caller. Callers
 * must not distinguish them, and must not surface the underlying reason.
 */
export function openRecord(token: string): string | null {
  try {
    const raw = Buffer.from(token, "base64url");

    if (raw.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
    if (raw[0] !== VERSION) return null;

    const iv = raw.subarray(1, 1 + IV_LENGTH);
    const authTag = raw.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
