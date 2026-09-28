import { describe, expect, test } from "bun:test";

import {
  DEPENDENT_RELATIONSHIPS,
  MAX_DEPENDENTS,
  MEDICAL_DEPARTMENTS,
  SUPPORTED_LANGUAGES,
  dependentSchema,
} from "@/lib/validation/intake";
import {
  DEFAULT_LANGUAGE,
  DEPARTMENT_OPTIONS,
  DEPENDENT_FIELD_LABELS,
  ENGLISH_MESSAGES,
  FIELD_LABELS,
  INTAKE_FIELDS,
  LANGUAGES,
  LANGUAGE_SLUGS,
  LIVE_LANGUAGE_SLUGS,
  MAX_HOUSEHOLD_SIZE,
  PENDING_LANGUAGE_SLUGS,
  RELATIONSHIP_OPTIONS,
  formatMessage,
  getLanguage,
  htmlLang,
  isLanguageSlug,
  isLiveLanguage,
  messagesFor,
  resolveBookableLanguage,
  type MessageKey,
} from "./registry";

describe("language registry", () => {
  const ui: string[] = [...LANGUAGE_SLUGS];

  test("the slugs the UI offers are exactly the slugs it has entries for", () => {
    expect([...ui].sort()).toEqual(Object.keys(LANGUAGES).sort());
  });

  test("the slugs the UI offers are exactly the live slugs plus the pending ones", () => {
    const live: string[] = [...LIVE_LANGUAGE_SLUGS];
    const pending: string[] = [...PENDING_LANGUAGE_SLUGS];
    expect([...live, ...pending].sort()).toEqual(ui.sort());
    expect(live.length + pending.length).toBe(LANGUAGE_SLUGS.length);
  });

  test("the bookable languages are exactly the ones the server accepts", () => {
    const server: string[] = [...SUPPORTED_LANGUAGES];
    const live: string[] = [...LIVE_LANGUAGE_SLUGS];
    expect(live.sort()).toEqual(server.sort());
  });

  test("the default language is registered", () => {
    expect(isLanguageSlug(DEFAULT_LANGUAGE)).toBe(true);
  });

  test("every language carries the metadata a card needs to render it", () => {
    for (const slug of LANGUAGE_SLUGS) {
      const language = getLanguage(slug);
      // BCP-47, enough of it: a language, an optional script, an optional
      // region. "zh-Hans" is a real tag and has to pass.
      expect(language.locale).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
      expect(["ltr", "rtl"]).toContain(language.direction);
      expect(language.name.trim().length).toBeGreaterThan(0);
      expect(language.flag.trim().length).toBeGreaterThan(0);
    }
  });

  test("every bookable language has a blurb, because a card shows one", () => {
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      const language = getLanguage(slug);
      expect(language.status).toBe("live");
      if (language.status !== "live") continue;
      expect(language.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("no pending language claims to have a dictionary", () => {
    // A partial dictionary is allowed for translating ahead of time, but it is
    // never rendered: messagesFor answers for a live language only. What must
    // not happen is a pending language quietly becoming renderable.
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(getLanguage(slug).status).toBe("pending");
      expect(messagesFor(slug)).toBe(LANGUAGES[DEFAULT_LANGUAGE].messages);
    }
  });

  test("the flag is paired with a text name, never used alone", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(getLanguage(slug).name).not.toBe("");
      expect(getLanguage(slug).flag).not.toBe("");
    }
  });

  test("every language translates every key, with a non-empty string", () => {
    const keys = Object.keys(ENGLISH_MESSAGES);
    expect(keys.length).toBeGreaterThan(0);

    for (const slug of LIVE_LANGUAGE_SLUGS) {
      const messages = messagesFor(slug);
      expect(Object.keys(messages).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const value = messages[key as keyof typeof ENGLISH_MESSAGES];
        expect(typeof value).toBe("string");
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("no language ships a copy of the English strings untranslated", () => {
    // A language can legitimately share a token ("No", a date format), but a
    // language whose entire dictionary is English is a stub that shipped.
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      if (slug === DEFAULT_LANGUAGE) continue;
      const translated = Object.keys(ENGLISH_MESSAGES).filter(
        (key) =>
          messagesFor(slug)[key as keyof typeof ENGLISH_MESSAGES] !==
          ENGLISH_MESSAGES[key as keyof typeof ENGLISH_MESSAGES],
      );
      expect(translated.length).toBeGreaterThan(0);
    }
  });

});

describe("language lookup", () => {
  test("accepts every registered slug", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(isLanguageSlug(slug)).toBe(true);
    }
  });

  test("accepts a pending language as registered, but not as bookable", () => {
    // Registered means the picker can mention it. Bookable means there is a
    // form. Conflating the two is how a half-translated language ends up
    // serving a form in the wrong language.
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(isLanguageSlug(slug)).toBe(true);
      expect(isLiveLanguage(slug)).toBe(false);
      expect(resolveBookableLanguage(slug)).toBeNull();
    }
  });

  test("resolves a bookable language with its slug and its strings", () => {
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      const bookable = resolveBookableLanguage(slug);
      expect(bookable).not.toBeNull();
      if (!bookable) continue;
      expect(bookable.slug).toBe(slug);
      expect(bookable.language.messages).toBe(messagesFor(slug));
    }
  });

  test("resolves nothing for a slug that is not registered at all", () => {
    for (const slug of ["klingon", "", "English", "__proto__"]) {
      expect(resolveBookableLanguage(slug)).toBeNull();
    }
  });

  test("rejects anything that is not a registered slug", () => {
    for (const candidate of ["", "klingon", "ENGLISH", " english", "english ", "en", "/"]) {
      expect(isLanguageSlug(candidate)).toBe(false);
    }
  });

  test("rejects inherited Object members", () => {
    // LANGUAGES is a plain object literal, so an unchecked index with one of
    // these returns a function and the caller renders "[object Object]".
    for (const candidate of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isLanguageSlug(candidate)).toBe(false);
    }
  });

  test("messagesFor falls back to the default for an unknown slug", () => {
    expect(messagesFor("klingon")).toBe(LANGUAGES[DEFAULT_LANGUAGE].messages);
  });

  test("messagesFor returns the requested language for a bookable slug", () => {
    expect(messagesFor("spanish")).toBe(LANGUAGES.spanish.messages);
    expect(messagesFor("portuguese")).toBe(LANGUAGES.portuguese.messages);
  });
});

describe("language metadata", () => {
  test("htmlLang is the primary subtag of the locale", () => {
    expect(htmlLang(LANGUAGES.english)).toBe("en");
    expect(htmlLang(LANGUAGES.spanish)).toBe("es");
    expect(htmlLang(LANGUAGES.portuguese)).toBe("pt");
  });

  test("htmlLang is the first subtag for a region-tagged locale", () => {
    expect(htmlLang({ ...LANGUAGES.english, locale: "pt-BR" })).toBe("pt");
  });
});

describe("department options", () => {  test("cover exactly the departments the intake schema accepts", () => {
    expect(DEPARTMENT_OPTIONS.map((option) => option.value)).toEqual([
      ...MEDICAL_DEPARTMENTS,
    ]);
  });

  test("every option has a message to label it with", () => {
    for (const option of DEPARTMENT_OPTIONS) {
      expect(ENGLISH_MESSAGES[option.messageKey].trim().length).toBeGreaterThan(0);
    }
  });

  test("the placeholder is not offered as a department", () => {
    expect(DEPARTMENT_OPTIONS.map((option) => option.value)).not.toContain("");
  });
});

/**
 * Household booking (#69).
 *
 * The dependency that matters is the same one the departments have: the values
 * the dropdown sends are the server's constant, and the labels are this
 * registry's messages, so a relationship the form cannot offer is a relationship
 * the schema refuses and vice versa. Everything else here is about a patient
 * being able to book for their child in a language they can read.
 */
describe("household relationship options", () => {
  test("cover exactly the relationships the intake schema accepts", () => {
    expect(RELATIONSHIP_OPTIONS.map((option) => option.value)).toEqual([
      ...DEPENDENT_RELATIONSHIPS,
    ]);
  });

  test("every option has a message to label it with", () => {
    for (const option of RELATIONSHIP_OPTIONS) {
      expect(ENGLISH_MESSAGES[option.messageKey].trim().length).toBeGreaterThan(0);
    }
  });

  test("the placeholder is not offered as a relationship", () => {
    // A blank option the server would refuse. The department select has the same
    // guard, and it is a select rather than a radio group for the same reason.
    expect(RELATIONSHIP_OPTIONS.map((option) => option.value)).not.toContain("");
  });

  test("no two relationships share a label", () => {
    // A dropdown with "Other" twice is a form a clinician cannot read back.
    const labels = RELATIONSHIP_OPTIONS.map((option) => ENGLISH_MESSAGES[option.messageKey]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("the household message set", () => {
  const HOUSEHOLD_KEYS = [
    "household",
    "householdIntro",
    "addPerson",
    "removePerson",
    "personHeading",
    "dependentLastNameOptional",
    "dependentRelationship",
    "dependentReason",
    "selectRelationship",
    "householdLimit",
    "householdConfirmed",
  ] as const satisfies readonly MessageKey[];

  test("every household string exists, in every language", () => {
    // Parity is enforced by the key-set test above; this is the more specific
    // version, so that adding a household string and forgetting two languages
    // fails with a message that names household rather than "key 61".
    for (const key of HOUSEHOLD_KEYS) {
      for (const slug of LIVE_LANGUAGE_SLUGS) {
        expect(messagesFor(slug)[key].trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("no household string is left in English in another language", () => {
    for (const key of HOUSEHOLD_KEYS) {
      for (const slug of LIVE_LANGUAGE_SLUGS) {
        if (slug === DEFAULT_LANGUAGE) continue;
        expect(messagesFor(slug)[key]).not.toBe(ENGLISH_MESSAGES[key]);
      }
    }
  });

  test("the person heading takes a number, and the limit takes a count", () => {
    // Both are the only two placeholders household adds, and both are
    // positional: a translation decides where the number goes.
    expect(formatMessage(ENGLISH_MESSAGES.personHeading, { number: 2 })).toContain("2");
    expect(formatMessage(ENGLISH_MESSAGES.householdLimit, { count: 5 })).toContain("5");
    expect(formatMessage(ENGLISH_MESSAGES.householdConfirmed, { count: 3 })).toContain("3");
  });

  test("every household string is a plain sentence with no leftover braces", () => {
    // A key shipped with its placeholder un-filled renders "{number}" to a
    // patient, which is the failure `formatMessage` deliberately makes obvious.
    for (const key of HOUSEHOLD_KEYS) {
      for (const slug of LIVE_LANGUAGE_SLUGS) {
        const value = messagesFor(slug)[key];
        if (key === "personHeading" || key === "householdLimit" || key === "householdConfirmed") {
          continue;
        }
        expect(value).not.toContain("{");
      }
    }
  });
});

describe("the household cap", () => {
  test("the client's cap on a household is the server's cap", () => {
    // The registry holds a literal rather than importing the schema, because it
    // ships to a browser. This is what keeps the two from drifting: a form that
    // stops offering the fifth card, or offers a sixth the server refuses, is a
    // bug nobody finds until a parent is mid-booking.
    expect(MAX_HOUSEHOLD_SIZE).toBe(MAX_DEPENDENTS);
  });
});

describe("household field labels", () => {
  test("the household group and each dependent field have a label", () => {
    for (const [field, messageKey] of Object.entries({
      ...FIELD_LABELS,
      ...DEPENDENT_FIELD_LABELS,
    })) {
      expect(ENGLISH_MESSAGES[messageKey as MessageKey].trim().length).toBeGreaterThan(0);
      expect(field.trim().length).toBeGreaterThan(0);
    }
  });

  test("the household itself is labelable, because the schema accepts it", () => {
    // The invariant formIssues.test.ts enforces over the primary fields, stated
    // for the new key: a field the schema accepts has to be nameable in the
    // error summary, or a rejected household submission cannot be shown to the
    // person who has to fix it.
    expect(Object.hasOwn(FIELD_LABELS, "dependents")).toBe(true);
    expect(INTAKE_FIELDS).toContain("dependents");
  });

  test("every dependent field the schema accepts is labelable", () => {
    const accepted: string[] = Object.keys(dependentSchema.shape);
    expect(Object.keys(DEPENDENT_FIELD_LABELS).sort()).toEqual(accepted.sort());
  });
});

describe("formatMessage", () => {
  test("fills a placeholder", () => {
    expect(formatMessage("Redirecting in {seconds} seconds.", { seconds: 20 })).toBe(
      "Redirecting in 20 seconds.",
    );
  });

  test("fills the same placeholder more than once", () => {
    expect(formatMessage("{n} of {n}", { n: 3 })).toBe("3 of 3");
  });

  test("fills several placeholders", () => {
    expect(formatMessage("{a} then {b}", { a: "one", b: "two" })).toBe("one then two");
  });

  test("leaves a string with no placeholders alone", () => {
    expect(formatMessage("No placeholders here.", {})).toBe("No placeholders here.");
  });

  test("leaves an unsupplied placeholder visible rather than guessing", () => {
    // A missing argument should be obvious on the page, not silently replaced
    // with a word from the wrong language.
    expect(formatMessage("in {seconds}", {})).toBe("in {seconds}");
  });

  test("does not read a placeholder off the prototype chain", () => {
    expect(formatMessage("{constructor} {toString}", {})).toBe(
      "{constructor} {toString}",
    );
  });

  test("renders a number, not a digit soup", () => {
    expect(formatMessage("{n}", { n: 0 })).toBe("0");
  });

  test("every countdown string in every language is fillable", () => {
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      const messages = messagesFor(slug);
      const filled = formatMessage(messages.redirectingIn, { seconds: 20 });
      expect(filled).not.toContain("{");
      expect(filled).toContain("20");
      expect(messages.redirectingInOne).not.toContain("{");
    }
  });

  test("no message is left with a placeholder nobody supplies", () => {
    // A registry of every placeholder the app fills in, not a rule against
    // having placeholders. Household booking added two: which person a card is,
    // and how many people a booking may carry.
    const known = ["seconds", "number", "count"];
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      for (const value of Object.values(messagesFor(slug))) {
        for (const match of value.matchAll(/\{(\w+)\}/g)) {
          expect(known).toContain(match[1]);
        }
      }
    }
  });
});
