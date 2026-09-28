import { describe, expect, test } from "bun:test";

import { LIVE_LANGUAGE_SLUGS } from "@/i18n/registry";
import { intakeSchema } from "@/lib/validation/intake";
import { INTAKE_FIELDS, FIELD_LABELS, DEPARTMENT_OPTIONS } from "@/i18n/registry";
import { VOICE_MESSAGE_KEYS, voiceMessages, type VoiceMessages } from "./copy";

/**
 * The voice intake screens' copy and their form.
 *
 * Two things are worth a test here and neither of them is a string comparison.
 *
 * The first is that a language we book in can answer every string on the voice
 * screens. The registry enforces this for the form; this module has to enforce
 * it for itself, and a test that walks the keys is the half of that `satisfies`
 * cannot do at runtime.
 *
 * The second is that the review step is the form. It is a form whose inputs
 * carry the intake schema's field names, and a name that drifts is a field the
 * patient fills in that the server never receives -- or worse, one the server
 * receives and attributes to something else. So the names are compared against
 * the schema rather than eyeballed.
 */

describe("copy", () => {
  test("covers every language the form can book in", () => {
    const copy: VoiceMessages = voiceMessages("english");
    expect(VOICE_MESSAGE_KEYS.length).toBeGreaterThan(10);

    for (const slug of LIVE_LANGUAGE_SLUGS) {
      const messages = voiceMessages(slug);
      for (const key of VOICE_MESSAGE_KEYS) {
        expect(typeof messages[key]).toBe("string");
        expect(messages[key].trim().length).toBeGreaterThan(0);
      }
      expect(Object.keys(messages).sort()).toEqual([...VOICE_MESSAGE_KEYS].sort());
    }
    expect(copy).toBeTruthy();
  });

  test("is not English on a non-English page", () => {
    // A missing translation that fell back to English would compile -- the type
    // only says the key exists -- and would be a Spanish page with a Spanish
    // form and English buttons. Every string is different from the English one
    // in at least one of the two other languages.
    const spanish = voiceMessages("spanish");
    const english = voiceMessages("english");

    const identical = VOICE_MESSAGE_KEYS.filter((key) => spanish[key] === english[key]);
    expect(identical).toEqual([]);
  });

  test("falls back to English for an unknown language rather than to nothing", () => {
    // The failure this guards is the registry's: `COPY[slug]` on an arbitrary
    // string returns a member of Object.prototype, and a screen of
    // "[object Object]" is what that renders.
    for (const slug of ["klingon", "", "ENGLISH", "constructor", "toString", "__proto__"]) {
      expect(voiceMessages(slug)).toBe(voiceMessages("english"));
    }
  });
});

describe("the review form", () => {
  test("names its inputs exactly as the intake schema does", () => {
    // Every field a patient fills in, and nothing else. The review step builds a
    // FormData from these inputs and hands it to the same server action the form
    // calls, so a name that is not a schema key is a field the server drops
    // silently rather than rejecting.
    const asked: string[] = [...INTAKE_FIELDS];
    expect(asked.sort()).toEqual(
      Object.keys(intakeSchema.shape)
        .filter((key) => key !== "language")
        .sort(),
    );
  });

  test("has a label for every field it renders", () => {
    for (const field of INTAKE_FIELDS) {
      expect(FIELD_LABELS[field]).toBeTruthy();
    }
  });

  test("offers exactly the departments the schema accepts", () => {
    // The dropdown values come from the registry, which is itself derived from
    // the schema. Compared here so that a department added in one place and not
    // the other fails a test rather than producing a record the booking pipeline
    // rejects.
    const offered: string[] = DEPARTMENT_OPTIONS.map((option) => option.value);
    const accepted: string[] = intakeSchema.shape.medical_department.options;
    expect(offered.sort()).toEqual(accepted.sort());
  });
});
