import "server-only";

import * as crypto from "crypto";
import {
  PATIENT_ACTIONS,
  isPatientAction,
  type PatientAction,
} from "@/lib/appointments/store";
import { ALGORITHM, IV_LENGTH, getMasterKey } from "./encryption";

/**
 * The link a patient reschedules or cancels through (#59).
 *
 * `src/lib/phi-token.ts` ends by naming what it does not do, and this is the
 * answer to that paragraph:
 *
 *   > it is still a bearer credential that never expires, and it can be revoked
 *   > by deleting the row rather than by anything about the token. Revocation,
 *   > expiry, and a token that is not the URL are #59's problem.
 *
 * So these are a second, narrower kind of token. Same key, same AEAD, same
 * three-line envelope layout, so there is no new cryptography here and no new
 * secret for an operator to configure. Different in the three ways the comment
 * asks for.
 *
 *   **Scoped.** It names one appointment and which of `PATIENT_ACTIONS` may be
 *   applied to it. It cannot open a record: there is no `read` in the set, and
 *   reading is what the tracking link already does. A link that leaked out of
 *   an inbox can no longer show anybody's date of birth.
 *
 *   **Expiring.** `expiresAt` is inside the ciphertext and checked against the
 *   server's clock, so a link pasted into a group chat two years ago is a link
 *   that stopped working a fortnight after it was minted. The window is
 *   `ACTION_TOKEN_TTL_MS` and nothing else decides it.
 *
 *   **Revocable.** Every token carries a `jti`, and whether that `jti` is still
 *   live is a question for the appointment store, which is where
 *   `spendActionGrant` lives. Cancelling an appointment withdraws its grants, so
 *   an outstanding link cannot bring a cancelled appointment back -- which is
 *   the specific abuse a "cancel" button without revocation makes trivially
 *   available.
 *
 * Two things it deliberately does **not** claim.
 *
 * It does not identify the holder. There is no account behind a link, and
 * inventing one would put a fiction in the audit trail. The actor recorded for
 * an action taken with one of these is `patient:link`, which says the change
 * came through a management link and not who typed the button.
 *
 * It does not authenticate itself against the store. The AEAD proves the
 * ciphertext was produced with `HIPAA_MASTER_KEY`, which proves it came from
 * this application and not from a stranger. It does not prove *we minted it* --
 * any code holding the key could seal a token naming any appointment, and any
 * copy of the key on a developer's laptop could too. That is why the sealed
 * claims are duplicated as a durable row: authenticated, then authorised, in
 * that order and never the other way round.
 *
 * **Version byte 3**, and that is what keeps the two token families apart.
 * phi-token seals with byte 1, whose low two bits are 01, so its tokens always
 * base64url-encode to a leading "AQ"; byte 3's are 11, so the second character is
 * always one of "wxyz0-9_". Its reference format is the literal string "2.". A
 * token of ours therefore never begins "AQ" or "2.", and the two families can be
 * dispatched on the first two characters in either direction without a format
 * ever being handed to the wrong parser.
 *
 * Layout, before base64url, identical to the sealed record in phi-token:
 *
 *   version (3) | iv (12) | authTag (16) | ciphertext
 */

/**
 * How long a management link stays usable.
 *
 * Long enough to be useful -- a patient who books an appointment a fortnight
 * out and wants to move it should not find the link dead -- and short enough
 * that a link forwarded into a group chat in March is inert by April. Seven
 * days is the interval between when someone books and when they remember to
 * check what they booked; past that, the confirmation email is the artefact a
 * patient actually keeps.
 *
 * A reschedule mints a replacement, so the expiry is not a countdown to
 * uselessness: a patient who uses their link on day six gets a fresh week.
 */
export const ACTION_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

const ACTION_VERSION = 3;
const AUTH_TAG_LENGTH = 16;

/**
 * What a token says.
 *
 * Numeric timestamps rather than ISO strings, because these are compared and
 * subtracted rather than displayed, and `Date.parse` on the way back in is one
 * more thing that could disagree with the value that was signed.
 */
export interface ActionClaims {
  /** The appointment this link is about, and the only one it can touch. */
  appointmentId: string;
  /** Unique per minted token. What the store authorises and revokes by. */
  jti: string;
  capabilities: PatientAction[];
  issuedAt: number;
  expiresAt: number;
}

export interface MintedActionToken {
  token: string;
  payload: ActionClaims;
}

/**
 * The same expression as `UUID_SOURCE` in ./phi-token, and it has to stay the
 * same: both modules decide whether an id could resolve, and a token accepted
 * by one and refused by the other would be a link that mints and then never
 * opens. Duplicated rather than imported so this branch does not rewrite a file
 * the token above already owns.
 */
const UUID_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);

export function isCapability(value: unknown): value is PatientAction {
  return isPatientAction(value);
}

/** The closed set, re-exported so a caller does not import the store to name one. */
export { PATIENT_ACTIONS as CAPABILITIES };
export type { PatientAction as Capability };

/**
 * Seal a set of claims.
 *
 * Separated from `mintActionToken` and exported so the shape checks in
 * `openActionToken` can be tested against payloads that mint() would refuse to
 * produce -- which is the only way to reach the case that matters: ciphertext
 * that is perfectly authentic and is still not a grant. Real callers want
 * `mintActionToken`, which validates first.
 */
export function sealActionClaims(payload: unknown): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    Buffer.from([ACTION_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

/**
 * Mint a management link.
 *
 * Validates before sealing, and throws rather than returning something that
 * looks like a link. Every rejection here is a bug in the caller rather than
 * hostile input: the id comes from a store that mints uuids, and the
 * capabilities come from a closed set. Emitting a token that could not be
 * honoured would put a live-looking URL into a patient's inbox that fails at
 * the worst possible moment, and it would fail as "not found" -- which is
 * indistinguishable from the record having been deleted.
 */
export function mintActionToken(claims: ActionClaims): MintedActionToken {
  if (!UUID_PATTERN.test(claims.appointmentId)) {
    throw new Error(
      "A patient action link can only be minted for a uuid appointment id; refusing " +
        "to mint a link that could not be resolved.",
    );
  }

  if (typeof claims.jti !== "string" || claims.jti === "") {
    throw new Error("A patient action link needs a jti to be revocable by.");
  }

  if (claims.capabilities.length === 0) {
    // A token granting nothing is a bearer credential with no capability: it can
    // only be leaked, and there is no reason for one to exist.
    throw new Error(
      "A patient action link needs at least one capability; refusing to mint a " +
        "credential that authorises nothing.",
    );
  }

  for (const capability of claims.capabilities) {
    if (!isPatientAction(capability)) {
      throw new Error(
        `Refusing to mint a patient action link for an unknown capability: ${JSON.stringify(capability)}`,
      );
    }
  }

  if (!Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt)) {
    throw new Error("A patient action link needs numeric issue and expiry times.");
  }

  if (claims.expiresAt <= claims.issuedAt) {
    throw new Error(
      "Refusing to mint a patient action link that expires before it was issued.",
    );
  }

  // Capabilities are stored in the closed set's order rather than the caller's,
  // so two grants for the same appointment and the same set are equal values.
  const capabilities = PATIENT_ACTIONS.filter((action) =>
    claims.capabilities.includes(action),
  );

  const payload: ActionClaims = {
    appointmentId: claims.appointmentId,
    jti: claims.jti,
    capabilities,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };

  return { token: sealActionClaims(payload), payload };
}

/**
 * Open a management link, or return null.
 *
 * Every failure collapses to null, exactly as `openRecord` does: truncated,
 * tampered, sealed under another key, from another token family, past its
 * expiry, or authentic-but-not-actually-a-grant. A caller must not be able to
 * tell those apart, and must not surface the reason -- the reasons are a map of
 * what an attacker has tried.
 *
 * `now` is injected rather than read so the expiry boundary can be asserted
 * exactly, and so this stays a pure function of its arguments in a module that
 * is otherwise hard to test.
 */
export function openActionToken(
  token: string,
  now: number = Date.now(),
): ActionClaims | null {
  let payload: unknown;

  try {
    const raw = Buffer.from(token, "base64url");

    if (raw.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH + 1) return null;
    if (raw[0] !== ACTION_VERSION) return null;

    const iv = raw.subarray(1, 1 + IV_LENGTH);
    const authTag = raw.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), iv);
    decipher.setAuthTag(authTag);

    payload = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    );
  } catch {
    return null;
  }

  const claims = toActionClaims(payload);
  if (!claims) return null;

  // The server's clock, not the token's. A token that names its own expiry in
  // the past was refused at mint time; the check here is what stops a token
  // whose window has simply elapsed while it sat in an inbox.
  if (claims.expiresAt <= now) return null;

  return claims;
}

/**
 * Narrow an authenticated payload to claims we would have minted.
 *
 * Authenticity is not validity. Something sealed under this key by another part
 * of the process -- a test, a script, an older build -- decrypts perfectly and
 * can carry a capability outside the closed set, an expiry before its issue, or
 * no capabilities at all. Each of those is a way for a token to authorise
 * something the issuing side never agreed to, so every field is re-checked here
 * rather than trusted because the ciphertext verified.
 */
function toActionClaims(value: unknown): ActionClaims | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;

  if (typeof source.appointmentId !== "string" || !UUID_PATTERN.test(source.appointmentId)) {
    return null;
  }

  if (typeof source.jti !== "string" || source.jti === "") return null;

  if (
    typeof source.issuedAt !== "number" ||
    !Number.isFinite(source.issuedAt) ||
    typeof source.expiresAt !== "number" ||
    !Number.isFinite(source.expiresAt)
  ) {
    return null;
  }

  if (source.expiresAt <= source.issuedAt) return null;

  if (!Array.isArray(source.capabilities) || source.capabilities.length === 0) {
    return null;
  }

  for (const capability of source.capabilities) {
    if (!isPatientAction(capability)) return null;
  }

  return {
    appointmentId: source.appointmentId,
    jti: source.jti,
    capabilities: source.capabilities as PatientAction[],
    issuedAt: source.issuedAt,
    expiresAt: source.expiresAt,
  };
}
