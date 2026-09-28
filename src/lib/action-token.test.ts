import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ACTION_TOKEN_TTL_MS,
  CAPABILITIES,
  isCapability,
  mintActionToken,
  openActionToken,
  sealActionClaims,
} from "./action-token";

/**
 * Patient action tokens (#59).
 *
 * The tracking token in ./phi-token is a bearer credential that never expires
 * and cannot be withdrawn: whoever holds the URL has the record, forever, and
 * the only thing that takes it back is deleting what it points at. That file
 * says so, and this issue is the answer to it.
 *
 * So these are a second, narrower kind of token -- sealed under the same key
 * with the same layout -- and scoped, expiring and revocable. What is asserted
 * here is the crypto and the shape checks; whether a `jti` is still live is the
 * store's question and is covered in ./appointments.
 */

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

const saved = process.env.HIPAA_MASTER_KEY;

beforeAll(() => {
  process.env.HIPAA_MASTER_KEY = KEY;
});

afterAll(() => {
  if (saved === undefined) delete process.env.HIPAA_MASTER_KEY;
  else process.env.HIPAA_MASTER_KEY = saved;
});

const APPOINTMENT_ID = "3f7c1e2a-9b4d-4c58-8a61-2d0e7b5f9c34";
const NOW = Date.parse("2026-09-01T10:00:00.000Z");

function claims(overrides: Partial<Parameters<typeof mintActionToken>[0]> = {}) {
  return {
    appointmentId: APPOINTMENT_ID,
    jti: "cap-1",
    capabilities: [...CAPABILITIES],
    issuedAt: NOW,
    expiresAt: NOW + ACTION_TOKEN_TTL_MS,
    ...overrides,
  };
}

function mint(overrides: Partial<Parameters<typeof mintActionToken>[0]> = {}) {
  return mintActionToken(claims(overrides));
}

describe("mintActionToken", () => {
  test("round-trips through openActionToken", () => {
    const minted = mint();

    expect(openActionToken(minted.token, NOW + 1_000)).toEqual(minted.payload);
  });

  test("carries no part of the patient record", () => {
    // What lands in a URL, a browser history entry and a reverse-proxy access
    // log. The appointment id is in there on purpose -- the server needs it --
    // but nothing else about the patient is.
    const { token } = mint();

    for (const leak of ["Ada", "Lovelace", "ada@example.test", "1985-12-10", "headache"]) {
      expect(token).not.toContain(leak);
    }
  });

  test("is a single URL-safe path segment", () => {
    const { token } = mint();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("/");
    expect(token).not.toContain("..");
  });

  test("is fresh per call", () => {
    // The IV is random, so two grants minted in the same millisecond for the
    // same appointment are different strings. Nothing should be able to
    // correlate two links by comparing them.
    expect(mint().token).not.toBe(mint().token);
  });

  test("is never a tracking token, in either of that file's two formats", () => {
    // phi-token seals with version byte 1, whose low two bits are 01, so its
    // tokens always begin "AQ"; ours is byte 3, whose low two bits are 11, so
    // the second character is always one of "wxyz0-9-_" and never "Q". The
    // reference format is the literal "2.". The two families therefore dispatch
    // on the first two characters in either direction, deterministically, and
    // no format ever reaches the wrong parser.
    //
    // The set is all sixteen base64url characters from index 48: the second
    // character carries the low two bits of the version byte in its high four
    // bits, and the top four bits of the first random IV byte in its low four,
    // so every one of them is reachable. Leaving "-" out of the class failed
    // one run in sixteen.
    const { token } = mint();

    expect(token.startsWith("A")).toBe(true);
    expect(token.startsWith("AQ")).toBe(false);
    expect(token.startsWith("2.")).toBe(false);
    expect(token[1]).toMatch(/[wxyz0-9_-]/);
  });

  test("stores capabilities in the closed set's order, whatever order it was given", () => {
    // So two grants for the same appointment and the same set are equal values,
    // and a caller that reverses the list cannot produce a second representation
    // of the same grant.
    expect(mint({ capabilities: ["cancel", "reschedule"] }).payload.capabilities).toEqual([
      "reschedule",
      "cancel",
    ]);
  });

  test("refuses to mint a token for an id that is not a uuid", () => {
    // The same reason phi-token refuses it: nothing in a token is resolvable by
    // inspection, so a bad id here becomes a link that fails as "not found"
    // rather than as "bad mint", and nobody can tell the two apart.
    expect(() => mint({ appointmentId: "not-a-uuid" })).toThrow(/uuid appointment id/);
    expect(() => mint({ appointmentId: "" })).toThrow(/uuid appointment id/);
  });

  test("refuses to mint without a jti", () => {
    // Without one the grant cannot be authorised or revoked, so the token would
    // be a credential whose live-ness is a matter of opinion.
    expect(() => mint({ jti: "" })).toThrow(/jti/);
  });

  test("refuses to mint a capability set that is empty", () => {
    // A token that grants nothing is a bearer credential with no capability: it
    // can only be leaked, and there is no reason for one to exist.
    expect(() => mint({ capabilities: [] })).toThrow(/at least one capability/);
  });

  test("refuses to mint a capability outside the closed set", () => {
    expect(() => mint({ capabilities: ["delete_everything" as never] })).toThrow(
      /unknown capability/,
    );
  });

  test("refuses to mint a token that expires before it was issued", () => {
    expect(() =>
      mint({ issuedAt: NOW, expiresAt: NOW }),
    ).toThrow(/expires before it was issued/);
    expect(() =>
      mint({ issuedAt: NOW, expiresAt: NOW - 1 }),
    ).toThrow(/expires before it was issued/);
  });

  test("refuses to mint a token with non-numeric timestamps", () => {
    expect(() => mint({ expiresAt: Number.NaN })).toThrow(/numeric issue and expiry/);
  });
});

describe("openActionToken", () => {
  test("returns null once it has expired", () => {
    const { token } = mint();

    // The window is half-open, `[issued, expires)`, so a token is usable right
    // up to its expiry and not at it. The boundary can therefore be asserted
    // exactly rather than "somewhere near".
    expect(openActionToken(token, NOW + ACTION_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(openActionToken(token, NOW + ACTION_TOKEN_TTL_MS)).toBeNull();
    expect(openActionToken(token, NOW + ACTION_TOKEN_TTL_MS + 1)).toBeNull();
  });

  test("returns null for a token sealed under a different key", () => {
    const { token } = mint();

    process.env.HIPAA_MASTER_KEY = OTHER;
    expect(openActionToken(token, NOW + 1_000)).toBeNull();
    process.env.HIPAA_MASTER_KEY = KEY;

    expect(openActionToken(token, NOW + 1_000)).not.toBeNull();
  });

  test("returns null for a tampered ciphertext", () => {
    const raw = Buffer.from(mint().token, "base64url");
    raw[raw.length - 1] ^= 0xff;

    expect(openActionToken(raw.toString("base64url"), NOW + 1_000)).toBeNull();
  });

  test("returns null for a tampered auth tag", () => {
    const raw = Buffer.from(mint().token, "base64url");
    raw[20] ^= 0xff;

    expect(openActionToken(raw.toString("base64url"), NOW + 1_000)).toBeNull();
  });

  test("returns null for a tampered IV", () => {
    const raw = Buffer.from(mint().token, "base64url");
    raw[3] ^= 0xff;

    expect(openActionToken(raw.toString("base64url"), NOW + 1_000)).toBeNull();
  });

  // Authenticity is not validity. These four are sealed under this key by
  // anything else in the process, so the AEAD passes and the shape check is the
  // only thing standing between them and a granted capability.
  test.each([
    [
      "a capability outside the closed set",
      { capabilities: ["delete_everything"], jti: "cap-1" },
    ],
    ["an empty capability set", { capabilities: [], jti: "cap-1" }],
    ["an expiry that precedes its issue", { jti: "cap-1", issuedAt: NOW, expiresAt: NOW - 60_000 }],
    ["an appointment id that is not a uuid", { appointmentId: "not-a-uuid", jti: "cap-1" }],
    ["no jti to revoke by", { jti: "" }],
  ])("refuses a payload that is authentic but not a grant: %s", (_label, overrides) => {
    const forged = sealActionClaims(claims(overrides as Partial<Parameters<typeof mintActionToken>[0]>));

    expect(openActionToken(forged, NOW)).toBeNull();
  });

  test.each([
    ["a bare JSON string", JSON.stringify("reschedule")],
    ["an array", JSON.stringify([1, 2, 3])],
    ["a null", JSON.stringify(null)],
    ["a payload with no fields", JSON.stringify({})],
    ["a payload whose timestamps are strings", JSON.stringify({ appointmentId: APPOINTMENT_ID, jti: "c", capabilities: ["cancel"], issuedAt: "1", expiresAt: "2" })],
  ])("returns null for %s that a valid token was not built from", (_label, payload) => {
    expect(openActionToken(sealActionClaims(JSON.parse(payload)), NOW)).toBeNull();
  });

  test.each([
    ["an empty string", ""],
    ["a short string", "abc"],
    ["not base64 at all", "!!!!"],
    ["a truncated token", "AAAA"],
    ["a tracking reference", `2.${APPOINTMENT_ID}`],
  ])("returns null for %s", (_label, token) => {
    expect(openActionToken(token, NOW + 1_000)).toBeNull();
  });

  test("refuses a token whose version byte is a tracking token's", () => {
    // The dispatch guarantee, asserted from the other side: retag a sealed
    // reference as version 3 and it still does not open, because a reference is
    // not ciphertext and there is nothing to decrypt.
    const retagged = Buffer.concat([
      Buffer.from([3]),
      Buffer.from(`2.${APPOINTMENT_ID}`, "utf8"),
    ]).toString("base64url");

    expect(openActionToken(retagged, NOW)).toBeNull();
  });
});

describe("isCapability", () => {
  test("is the closed set, checked at runtime", () => {
    expect(isCapability("reschedule")).toBe(true);
    expect(isCapability("cancel")).toBe(true);
    expect(isCapability("delete")).toBe(false);
    expect(isCapability(undefined)).toBe(false);
    expect(isCapability(7)).toBe(false);
  });

  test("describes what a patient may do to their own appointment, and nothing else", () => {
    // Deliberately two, and deliberately not `read`. The tracking link already
    // does that; a management link that could also read would be a second,
    // wider way in for no added capability.
    expect([...CAPABILITIES].sort()).toEqual(["cancel", "reschedule"]);
  });
});
