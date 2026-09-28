import { afterEach, describe, expect, test } from "bun:test";

import { resetServerEnvCache } from "@/lib/env";
import { sealRecord } from "@/lib/phi-token";
import {
  VOICE_SIDES,
  VoiceSessionRefusedError,
  agentIdForSide,
  isBookedAppointment,
  isVoiceSide,
  issueVoiceSession,
} from "./session";
import { setElevenLabsClient, type ElevenLabsClient } from "./elevenlabs";
import { VoiceNotConfiguredError } from "./errors";

/**
 * Who may have a voice session, tested.
 *
 * The rule this file exists for: an agent id is readable only by this module,
 * and a signed conversation URL is issued only to a caller that can present the
 * sealed token for a booked appointment. Everything else here is the
 * bookkeeping that keeps that rule from being kept by accident.
 */

const VALID = {
  GEMINI_KEY: "gemini-test-key",
  RESEND_KEY: "resend-test-key",
  HIPAA_MASTER_KEY: "a".repeat(64),
  ELEVENLABS_AGENT_PATIENT_ID: "agent_patient",
  ELEVENLABS_AGENT_RECEPTIONIST_ID: "agent_receptionist",
  ELEVENLABS_API_KEY: "sk-elevenlabs-test",
  INTERNAL_API_SECRET: "s".repeat(32),
};

const saved = new Map<string, string | undefined>();
for (const key of Object.keys(VALID)) saved.set(key, process.env[key]);

function setEnv(values: Partial<typeof VALID> = {}): void {
  for (const key of Object.keys(VALID)) delete process.env[key];
  Object.assign(process.env, VALID, values);
  resetServerEnvCache();
}

const RECORD = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  language: "english",
};

function tokenFor(record: unknown = RECORD): string {
  return sealRecord(JSON.stringify(record));
}

function stubClient(
  behaviour: ElevenLabsClient["mintConversationUrl"] = async ({ agentId }) => ({
    url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&signature=sig`,
    expiresAt: 1_700_000_060_000,
  }),
): { asked: string[] } {
  const asked: string[] = [];
  setElevenLabsClient({
    mintConversationUrl: async (request) => {
      asked.push(request.agentId);
      return behaviour(request);
    },
    transcribe: async () => {
      throw new Error("not used here");
    },
    speak: async () => {
      throw new Error("not used here");
    },
  });
  return { asked };
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCache();
  setElevenLabsClient(null);
});

describe("isVoiceSide", () => {
  test("names exactly the two sides the spectate page uses", () => {
    expect([...VOICE_SIDES]).toEqual(["patient", "receptionist"]);
    for (const side of VOICE_SIDES) expect(isVoiceSide(side)).toBe(true);
  });

  test("rejects anything else, including inherited object properties", () => {
    // The narrowing is what lets `agentIdForSide` be a total function, so it
    // has to be a real check and not a `includes`.
    for (const value of ["", "Patient", "patient ", "agent", "constructor", "toString"]) {
      expect(isVoiceSide(value)).toBe(false);
    }
  });
});

describe("agentIdForSide", () => {
  test("resolves each side to its own configured agent", () => {
    setEnv({});
    expect(agentIdForSide("patient")).toBe("agent_patient");
    expect(agentIdForSide("receptionist")).toBe("agent_receptionist");
  });
});

describe("isBookedAppointment", () => {
  test("accepts the sealed token for a booked record", () => {
    setEnv({});
    expect(isBookedAppointment(tokenFor())).toBe(true);
  });

  test("refuses anything that does not decrypt to a record with an identity", () => {
    setEnv({});

    // Every one of these is "not a session" for the same reason: there is no
    // appointment behind it, so there is nothing to attach vendor spend to.
    const refused = [
      "",
      "not-a-token",
      tokenFor({ firstName: "Ada" }),
      tokenFor({ firstName: "Ada", lastName: "Lovelace" }),
      tokenFor({ ...RECORD, email: "" }),
      tokenFor({ ...RECORD, firstName: "" }),
      tokenFor({ ...RECORD, lastName: 7 }),
      tokenFor([1, 2, 3]),
      tokenFor("a string"),
    ];

    for (const token of refused) expect(isBookedAppointment(token)).toBe(false);
  });

  test("refuses a token sealed under another key", () => {
    setEnv({});
    const forged = sealRecord(JSON.stringify(RECORD));
    process.env.HIPAA_MASTER_KEY = "b".repeat(64);
    resetServerEnvCache();

    expect(isBookedAppointment(forged)).toBe(false);
  });

  test("refuses a tampered token", () => {
    setEnv({});
    const token = tokenFor();
    const tampered = `${token.slice(0, -4)}${token.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;

    expect(isBookedAppointment(tampered)).toBe(false);
  });
});

describe("issueVoiceSession", () => {
  test("mints for the agent the side names and never sees the other one", async () => {
    setEnv({});
    const { asked } = stubClient();

    const session = await issueVoiceSession({ side: "receptionist", sessionToken: tokenFor() });

    expect(asked).toEqual(["agent_receptionist"]);
    expect(session.url).toContain("signature=sig");
  });

  test("refuses a caller with no appointment token, before spending a vendor call", async () => {
    setEnv({});
    const { asked } = stubClient();

    await expect(
      issueVoiceSession({ side: "patient", sessionToken: "not-a-token" }),
    ).rejects.toBeInstanceOf(VoiceSessionRefusedError);
    expect(asked).toEqual([]);
  });

  test("refuses when voice is not configured rather than calling the vendor", async () => {
    setEnv({ ELEVENLABS_API_KEY: undefined });
    const { asked } = stubClient();

    await expect(
      issueVoiceSession({ side: "patient", sessionToken: tokenFor() }),
    ).rejects.toBeInstanceOf(VoiceNotConfiguredError);
    expect(asked).toEqual([]);
  });

  test("lets a vendor failure through as a vendor failure", async () => {
    setEnv({});
    stubClient(async () => {
      throw new Error("The voice vendor refused the request");
    });

    // Not wrapped: a caller that has to tell "the vendor said no" apart from
    // "you are not allowed" has nothing to go on if both arrive as one error.
    await expect(
      issueVoiceSession({ side: "patient", sessionToken: tokenFor() }),
    ).rejects.toThrow(/voice vendor/);
  });
});
