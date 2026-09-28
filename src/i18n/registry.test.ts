import { describe, expect, test } from "bun:test";

import { MEDICAL_DEPARTMENTS, SUPPORTED_LANGUAGES } from "@/lib/validation/intake";
import {
  DEFAULT_LANGUAGE,
  DEPARTMENT_OPTIONS,
  ENGLISH_MESSAGES,
  LANGUAGES,
  LANGUAGE_SLUGS,
  getLanguage,
  htmlLang,
  isLanguageSlug,
  messagesFor,
  resolveLanguage,
} from "./registry";

describe("language registry", () => {
  const ui: string[] = [...LANGUAGE_SLUGS];

  test("the slugs the UI offers are exactly the slugs it has entries for", () => {
    expect([...ui].sort()).toEqual(Object.keys(LANGUAGES).sort());
  });

  test("the slugs the UI offers are exactly the slugs the server accepts", () => {
    const server: string[] = [...SUPPORTED_LANGUAGES];
    expect([...ui].sort()).toEqual(server.sort());
  });

  test("the default language is registered", () => {
    expect(isLanguageSlug(DEFAULT_LANGUAGE)).toBe(true);
  });

  test("every language carries the metadata a page needs to render it", () => {
    for (const slug of LANGUAGE_SLUGS) {
      const language = getLanguage(slug);
      expect(language.locale).toMatch(/^[a-z]{2,3}(-[A-Z]{2})?$/);
      expect(["ltr", "rtl"]).toContain(language.direction);
      expect(language.name.trim().length).toBeGreaterThan(0);
      expect(language.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("every language translates every key, with a non-empty string", () => {
    const keys = Object.keys(ENGLISH_MESSAGES);
    expect(keys.length).toBeGreaterThan(0);

    for (const slug of LANGUAGE_SLUGS) {
      const messages = getLanguage(slug).messages;
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
    for (const slug of LANGUAGE_SLUGS) {
      if (slug === DEFAULT_LANGUAGE) continue;
      const translated = Object.keys(ENGLISH_MESSAGES).filter(
        (key) =>
          getLanguage(slug).messages[key as keyof typeof ENGLISH_MESSAGES] !==
          ENGLISH_MESSAGES[key as keyof typeof ENGLISH_MESSAGES],
      );
      expect(translated.length).toBeGreaterThan(0);
    }
  });

  test("the flag is paired with a text name, never used alone", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(getLanguage(slug).name).not.toBe("");
      expect(getLanguage(slug).flag).not.toBe("");
    }
  });
});

describe("language lookup", () => {
  test("accepts every registered slug", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(isLanguageSlug(slug)).toBe(true);
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

  test("resolveLanguage falls back to the default for an unknown slug", () => {
    expect(resolveLanguage("klingon")).toBe(LANGUAGES[DEFAULT_LANGUAGE]);
    expect(messagesFor("klingon")).toBe(LANGUAGES[DEFAULT_LANGUAGE].messages);
  });

  test("resolveLanguage returns the requested language for a known slug", () => {
    expect(resolveLanguage("spanish")).toBe(LANGUAGES.spanish);
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

describe("department options", () => {
  test("cover exactly the departments the intake schema accepts", () => {
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
