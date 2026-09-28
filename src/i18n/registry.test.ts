import { describe, expect, test } from "bun:test";

import { MEDICAL_DEPARTMENTS, SUPPORTED_LANGUAGES } from "@/lib/validation/intake";
import {
  DEFAULT_LANGUAGE,
  DEPARTMENT_OPTIONS,
  ENGLISH_MESSAGES,
  LANGUAGES,
  LANGUAGE_SLUGS,
  LIVE_LANGUAGE_SLUGS,
  PENDING_LANGUAGE_SLUGS,
  formatMessage,
  getLanguage,
  htmlLang,
  isLanguageSlug,
  isLiveLanguage,
  messagesFor,
  resolveBookableLanguage,
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
    const known = ["seconds"];
    for (const slug of LIVE_LANGUAGE_SLUGS) {
      for (const value of Object.values(messagesFor(slug))) {
        for (const match of value.matchAll(/\{(\w+)\}/g)) {
          expect(known).toContain(match[1]);
        }
      }
    }
  });
});
