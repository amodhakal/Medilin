import "server-only";

import * as crypto from "crypto";
import { AUDIT_ACTORS } from "@/lib/audit";
import { getAppointment, isDurableAppointmentStore } from "@/lib/appointments";
import { ALGORITHM, IV_LENGTH, getMasterKey } from "./encryption";

/**
 * Opaque tokens for patient records.
 *
 * The spectate URL used to carry the record itself, base64-ish encoded, in a
 * query parameter. That put name, email, phone, date of birth, insurance, and
 * symptom text into browser history, into the Referer header of any outbound
 * request, into every reverse-proxy and CDN access log on the path, and into
 * the README's recommended "copy this out of your console" workflow.
 *
 * Two token formats, because two different facts are now true.
 *
 * **Version 1, the sealed record.** The record, encrypted, in the URL. It needs
 * no database, so it works across serverless instances and keeps working
 * forever: the ciphertext is the record, and nothing about it expires or is
 * stored. It was the answer while appointments were a `Map` in the module,
 * where a plain identifier would have been a privacy fix traded for an
 * availability bug -- a request can land on an instance that never saw the
 * write.
 *
 * **Version 2, a short reference.** `2.` and a uuid. The record is read from
 * the appointment store instead of from the URL. This is what the module above
 * said would replace version 1, and it can now: the durable store outlives the
 * process, so a link resolves from any instance. It is also 38 characters
 * instead of a few hundred, which matters for a URL that gets pasted into a
 * message.
 *
 * Which one is minted is decided by `sealForDelivery` from the store that is
 * actually in use, and the in-memory store still gets version 1 -- a reference
 * to a `Map` entry only resolves in the process that wrote it, so minting
 * version 2 there would trade a working link for a broken one. Both are read by
 * `resolveRecord` for as long as version 1 links exist in inboxes, which is
 * every link already sent to a patient.
 *
 * What version 2 does *not* fix, and version 1 did: it is still a bearer
 * credential that never expires, and it can be revoked by deleting the row
 * rather than by anything about the token. Revocation, expiry, and a token that
 * is not the URL are #59's problem. What it does fix is that the record is not
 * in the URL at all, so a URL is no longer a copy of a patient's data, and
 * there is one place a record can be deleted from.
 *
 * Version 1 layout, before base64url:
 *
 *   version (1) | iv (12) | authTag (16) | ciphertext
 *
 * Single-key AES-256-GCM rather than the DEK-wrapping envelope in
 * encryption.ts. There is no key to wrap here: one short-lived token, one
 * operation, and wrapping a DEK would only make the token longer.
 *
 * Version 2 is not authenticated in the way version 1 is -- there is no tag to
 * tamper with. A modified reference is not a forged record; it is a different
 * uuid, which is a miss, and `resolveRecord` answers null for it exactly as it
 * does for a tampered ciphertext. The format is matched strictly for the same
 * reason: a reference is the one string here that is not ciphertext, so it is
 * the one string that must not be handed to the store unchecked.
 */

const SEALED_VERSION = 1;
const REFERENCE_VERSION = 2;
const AUTH_TAG_LENGTH = 16;

/** What a version 2 token looks like: the version, a dot, and a uuid. */
const REFERENCE_PREFIX = `${REFERENCE_VERSION}.`;
const UUID_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const REFERENCE_PATTERN = new RegExp(`^${REFERENCE_PREFIX}${UUID_SOURCE}$`);

export function sealRecord(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    Buffer.from([SEALED_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

/**
 * Decrypt a sealed token, or return null.
 *
 * Every failure mode collapses to null on purpose: a truncated token, a
 * tampered token, a token sealed under a different key, and a token from a
 * different version are all "this is not a valid link" to a caller. Callers
 * must not distinguish them, and must not surface the underlying reason.
 *
 * This is the sealed format only. A version 2 reference is not a sealed token
 * and returns null here; `resolveRecord` is what a caller with a token from a
 * URL should call.
 */
export function openRecord(token: string): string | null {
  try {
    const raw = Buffer.from(token, "base64url");

    if (raw.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
    if (raw[0] !== SEALED_VERSION) return null;

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

/**
 * Mint the token that goes in a patient's link.
 *
 * The whole format decision, in one place, so no call site has to know which
 * store is installed. A reference is only mintable when a reference would
 * resolve, and the test is the store rather than the environment: a store
 * installed through `setAppointmentStore` answers for itself.
 */
export function sealForDelivery(plaintext: string, appointmentId: string): string {
  return isDurableAppointmentStore() ? sealReference(appointmentId) : sealRecord(plaintext);
}

/**
 * A short reference to a stored record.
 *
 * Throws rather than emitting a token that could not be resolved, because a
 * reference is not sealed: nothing about it is self-validating, so an id that is
 * not a uuid would produce a link that is broken in a way that looks like a
 * wrong id rather than a bad mint.
 */
export function sealReference(appointmentId: string): string {
  if (!new RegExp(`^${UUID_SOURCE}$`).test(appointmentId)) {
    throw new Error(
      "A record reference can only be minted for a uuid appointment id; refusing to " +
        "mint a link that could not be resolved.",
    );
  }

  return `${REFERENCE_PREFIX}${appointmentId}`;
}

/**
 * The record behind a token from a URL, or null.
 *
 * Both formats, decided by the prefix, and both answered the same way: null for
 * anything that is not a link to a record that exists. A version 2 reference
 * that does not match the format is a miss rather than a lookup, so a crafted
 * path segment cannot become a key the store is asked about.
 *
 * A cancelled appointment still resolves. The record is still the patient's, the
 * status is on the record, and a link that stopped working the moment someone
 * cancelled would tell a patient their request had vanished.
 *
 * A version 1 token is not audited. The record comes out of the ciphertext, so
 * there is no store read to attribute, and no appointment id to attribute it to.
 * That gap closes with itself: version 2 tokens exist only when the durable
 * store does, and in that configuration every read of a record goes through the
 * store and is recorded. Links minted before the database was configured stay
 * unaudited until they expire, which is another reason #59 should give tokens a
 * lifetime.
 */
export async function resolveRecord(token: string): Promise<string | null> {
  if (token.startsWith(REFERENCE_PREFIX)) {
    if (!REFERENCE_PATTERN.test(token)) return null;

    // `linkBearer` because that is genuinely all the trail can know: this is a
    // bearer link with no account behind it, and the pages cannot tell each other
    // apart from in here. Telling a patient's own read from the demo operator's
    // is a property of the token, and a token that carries a purpose and an
    // expiry is what #59 needs anyway.
    const appointment = await getAppointment(
      token.slice(REFERENCE_PREFIX.length),
      AUDIT_ACTORS.linkBearer,
    );
    return appointment ? JSON.stringify(appointment.patientInfo) : null;
  }

  return openRecord(token);
}

