import { describe, expect, test } from "bun:test";

import type { LlmClient } from "../gemini";
import { translateHousehold } from "./household";
import type { AppointmentRecord, Dependent } from "@/lib/validation/intake";

/**
 * Translating what everyone in a household said (#69).
 *
 * The primary patient's free text is translated by `translateToEnglish`, which
 * knows about two fields and one person. A household is several people each
 * with their own account, and a clinic that runs in three languages cannot
 * have the second child's fever arriving in Spanish while the first child's
 * arrives in English.
 *
 * The decision these tests hold in place is one call per person rather than one
 * call for the household. A batched call is cheaper, and it is the wrong trade:
 * a reply that returns two translated strings in the wrong order attaches one
 * child's symptoms to the other child, and nothing downstream can detect it --
 * both are well-formed strings in the right language.
 */

const record: AppointmentRecord = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  dob: "1985-12-10",
  insurance: "yes",
  phone: "+1 555 0100",
  appointmentDateTime: "2026-10-01T09:30",
  medical_department: "Pediatrician",
  additionalInfo: "dolor de cabeza",
  language: "spanish",
};

function dependent(overrides: Partial<Dependent> = {}): Dependent {
  return {
    firstName: "Maya",
    lastName: "Lovelace",
    dob: "2018-04-02",
    relationship: "child",
    additionalInfo: "fiebre desde anoche",
    ...overrides,
  };
}

interface Recorded {
  prompt: string;
  responseSchema: unknown;
}

function client(translate: (recorded: Recorded, index: number) => unknown) {
  const calls: Recorded[] = [];

  const fake: LlmClient = {
    async generateJson(request) {
      calls.push(request as Recorded);
      return translate(request as Recorded, calls.length - 1);
    },
  };

  return { fake, calls };
}

describe("translateHousehold", () => {
  test("translates what each person said", async () => {
    const { fake, calls } = client(() => ({ additionalInfo: "fever since last night" }));

    const result = await translateHousehold(
      { ...record, dependents: [dependent()] },
      fake,
    );

    expect(result.dependents?.[0].additionalInfo).toBe("fever since last night");
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("fiebre desde anoche");
  });

  test("asks once per person, not once for the household", async () => {
    // The whole point of the loop. A batched call risks a reply whose two
    // strings are swapped, which is a mis-attribution between two children and
    // not something any schema or test can see.
    const { fake, calls } = client((_recorded, index) => ({
      additionalInfo: `translation ${index}`,
    }));

    const result = await translateHousehold(
      {
        ...record,
        dependents: [
          dependent({ firstName: "Maya" }),
          dependent({ firstName: "Byron" }),
          dependent({ firstName: "Cleo" }),
        ],
      },
      fake,
    );

    expect(calls).toHaveLength(3);
    expect(result.dependents?.map((person) => person.additionalInfo)).toEqual([
      "translation 0",
      "translation 1",
      "translation 2",
    ]);
  });

  test("never mixes one person's answer into another", async () => {
    // Each call answers about the text it was given, so a model that returns
    // something unrelated to the person still cannot move a translation between
    // cards.
    const { fake } = client((recorded) => {
      const isMaya = recorded.prompt.includes("Maya") || true;
      return { additionalInfo: isMaya ? "fever" : "headache" };
    });

    const result = await translateHousehold(
      {
        ...record,
        dependents: [
          dependent({ firstName: "Maya", additionalInfo: "fiebre" }),
          dependent({ firstName: "Byron", additionalInfo: "dolor de cabeza" }),
        ],
      },
      fake,
    );

    // Whatever came back, every card kept a valid, non-empty string and none
    // was dropped. The names are not in the prompt by design -- a dependent's
    // name is not needed to translate their symptoms, and the first name is the
    // one field of a child's record with the least business in a prompt.
    expect(result.dependents).toHaveLength(2);
    for (const person of result.dependents ?? []) {
      expect(person.additionalInfo.length).toBeGreaterThan(0);
    }
  });

  test("spends nothing when there is no household", async () => {
    const { fake, calls } = client(() => ({ additionalInfo: "fever" }));

    await translateHousehold(record, fake);

    expect(calls).toEqual([]);
  });

  test("spends nothing on a person who said nothing", async () => {
    // The same short circuit `translateToEnglish` has. A dependent with an empty
    // reason is a normal submission, not a translation task.
    const { fake, calls } = client(() => ({ additionalInfo: "fever" }));

    const result = await translateHousehold(
      {
        ...record,
        dependents: [
          dependent({ additionalInfo: "" }),
          dependent({ firstName: "Byron", additionalInfo: "   " }),
        ],
      },
      fake,
    );

    expect(calls).toEqual([]);
    // Whitespace-only is normalised to empty by the dependent schema on the way
    // back through validation, so the stored note is "" rather than the three
    // spaces that were typed. Same rule as every other free-text field.
    expect(result.dependents?.map((person) => person.additionalInfo)).toEqual(["", ""]);
  });

  test("does not put a dependent's name or date of birth in the prompt", async () => {
    const { fake, calls } = client(() => ({ additionalInfo: "fever since last night" }));

    await translateHousehold(
      { ...record, dependents: [dependent()] },
      fake,
    );

    expect(calls[0].prompt).not.toContain("Maya");
    expect(calls[0].prompt).not.toContain("2018-04-02");
  });

  test("translates in the language the household was submitted in", async () => {
    const { fake, calls } = client(() => ({ additionalInfo: "fever" }));

    await translateHousehold({ ...record, language: "portuguese", dependents: [dependent()] }, fake);

    expect(calls[0].prompt).toContain("from portuguese to English");
  });

  test("keeps the account holder's own text untouched", async () => {
    // This module is about the household. The primary patient has already been
    // through `translateToEnglish` and rewriting their field again would be a
    // second translation of a first one.
    const { fake } = client(() => ({ additionalInfo: "fever" }));

    const result = await translateHousehold({ ...record, dependents: [dependent()] }, fake);

    expect(result.additionalInfo).toBe("dolor de cabeza");
    expect(result.firstName).toBe("Ada");
    expect(result.email).toBe("ada@example.test");
    expect(result.medical_department).toBe("Pediatrician");
  });

  test("returns the record unchanged when the reply is unusable", async () => {
    // Falling back to the submitted text is right: an untranslated symptom note
    // in the wrong language is a problem a clinician can recognise, whereas a
    // dropped person from a booking is not.
    for (const reply of [
      { additionalInfo: "" },
      { additionalInfo: 42 },
      { additionalInfo: "x".repeat(2001) },
      { other: "fever" },
      "not an object",
      null,
    ]) {
      const { fake } = client(() => reply);
      const result = await translateHousehold({ ...record, dependents: [dependent()] }, fake);

      expect(result.dependents?.[0].additionalInfo).toBe("fiebre desde anoche");
    }
  });

  test("trims what comes back", async () => {
    const { fake } = client(() => ({ additionalInfo: "  fever since last night  " }));

    const result = await translateHousehold({ ...record, dependents: [dependent()] }, fake);

    expect(result.dependents?.[0].additionalInfo).toBe("fever since last night");
  });

  test("ignores an attempt to rewrite the record through a translation", async () => {
    // The same reasoning as `applyTranslation`: JSON mode constrains the shape,
    // not the intent. Only `additionalInfo` on a dependent is ever read.
    const { fake } = client(() => ({
      additionalInfo: "fever since last night",
      firstName: "Mallory",
      email: "attacker@example.test",
      medical_department: "Psychiatrist",
    }));

    const result = await translateHousehold({ ...record, dependents: [dependent()] }, fake);

    expect(result.dependents?.[0].firstName).toBe("Maya");
    // A dependent has no email, phone, or slot of their own, and a reply that
    // tries to give them one has not added it.
    expect(Object.keys(result.dependents?.[0] ?? {})).not.toContain("email");
    expect(result.email).toBe("ada@example.test");
    expect(result.medical_department).toBe("Pediatrician");
  });

  test("lets a transport failure fail the booking, as it does for one patient", () => {
    // A reply that is merely unusable falls back to the submitted text, above.
    // A call that fails outright does not, and the asymmetry is deliberate: the
    // account holder's own translation propagates too, so the booking fails and
    // the patient is told to try again with nothing lost. Swallowing it here
    // would store a household where one person is silently untranslated and no
    // log says so.
    const failing: LlmClient = {
      async generateJson() {
        throw new Error("Translation failed after 3 attempts: unavailable");
      },
    };

    expect(
      translateHousehold({ ...record, dependents: [dependent()] }, failing),
    ).rejects.toThrow(/unavailable/);
  });

  test("leaves the household absent when it was absent", async () => {
    // A single-patient booking must not acquire a `dependents` key on the way
    // through, or the sealed token grows for everyone. See dependentsField.
    const { fake } = client(() => ({ additionalInfo: "fever" }));

    const result = await translateHousehold(record, fake);

    expect(result).not.toHaveProperty("dependents");
  });

  test("keeps the people in the order they were submitted", async () => {    const { fake } = client((_recorded, index) => ({ additionalInfo: `t${index}` }));

    const result = await translateHousehold(
      {
        ...record,
        dependents: [
          dependent({ firstName: "Maya" }),
          dependent({ firstName: "Byron" }),
        ],
      },
      fake,
    );

    expect(result.dependents?.map((person) => person.firstName)).toEqual(["Maya", "Byron"]);
  });
});
