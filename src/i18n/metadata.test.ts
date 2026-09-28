import { describe, expect, test } from "bun:test";

import { DEFAULT_LANGUAGE, LANGUAGE_SLUGS, getLanguage } from "./registry";
import {
  PROTOTYPE_NOTICE,
  SITE_URL,
  alternateLanguages,
  hrefLang,
  homeMetadata,
  languageMetadata,
  languagePath,
  openGraphLocale,
  rootMetadata,
  sitemapEntries,
} from "./metadata";

describe("root metadata", () => {
  test("sends no referrer", () => {
    // The spectate URL used to carry the patient record. Nothing should be
    // referring this app anywhere, ever, and the setting that guarantees that
    // is asserted here rather than left in a JSX literal.
    expect(rootMetadata.referrer).toBe("no-referrer");
  });

  test("keeps the app out of search indexes", () => {
    expect(rootMetadata.robots).toEqual({ index: false, follow: true });
  });

  test("has an absolute base URL, or every relative URL is unresolvable", () => {
    expect(() => new URL(rootMetadata.metadataBase as string)).not.toThrow();
    expect(SITE_URL).not.toMatch(/\/+$/);
  });

  test("states that this is a prototype in the title and the description", () => {
    const title = JSON.stringify(rootMetadata.title);
    expect(`${title} ${rootMetadata.description}`).toContain(PROTOTYPE_NOTICE);
  });

  test("templates a per-page title onto the site name", () => {
    expect(rootMetadata.title).toMatchObject({
      default: expect.stringContaining("Medilin"),
      template: expect.stringContaining("%s"),
    });
  });
});

describe("home metadata", () => {
  test("is canonical to the root and points at every language", () => {
    expect(homeMetadata().alternates?.canonical).toBe("/");
    expect(homeMetadata().alternates?.languages).toEqual(alternateLanguages());
  });

  test("keeps the root title rather than inheriting the template", () => {
    expect(homeMetadata().title).toBeUndefined();
  });
});

describe("language metadata", () => {
  test("titles every language in that language", () => {
    for (const slug of LANGUAGE_SLUGS) {
      const metadata = languageMetadata(slug);
      expect(metadata.title).toBe(getLanguage(slug).messages.title);
      expect(String(metadata.description)).toContain(
        getLanguage(slug).messages.subtitle,
      );
    }
  });

  test("has a non-empty title and description for every language", () => {
    for (const slug of LANGUAGE_SLUGS) {
      const metadata = languageMetadata(slug);
      expect(String(metadata.title).trim().length).toBeGreaterThan(0);
      expect(String(metadata.description).trim().length).toBeGreaterThan(0);
    }
  });

  test("is canonical to the language's own address", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(languageMetadata(slug).alternates?.canonical).toBe(`/language/${slug}`);
    }
  });

  test("declares every language as an alternate on every language", () => {
    const alternates = alternateLanguages();
    for (const slug of LANGUAGE_SLUGS) {
      expect(languageMetadata(slug).alternates?.languages).toEqual(alternates);
    }
  });

  test("uses an Open Graph locale with a region", () => {
    expect(languageMetadata("english").openGraph?.locale).toBe("en_US");
    expect(languageMetadata("spanish").openGraph?.locale).toBe("es_US");
    expect(languageMetadata("portuguese").openGraph?.locale).toBe("pt_BR");
  });

  test("falls back to a region for an untagged locale", () => {
    expect(openGraphLocale({ ...getLanguage("spanish"), locale: "es" })).toBe("es_US");
    expect(openGraphLocale({ ...getLanguage("spanish"), locale: "es-MX" })).toBe("es_MX");
  });

  test("has a unique hreflang per language", () => {
    const tags = LANGUAGE_SLUGS.map((slug) => hrefLang(slug));
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("alternate languages", () => {
  test("covers every registered language", () => {
    const alternates = alternateLanguages();
    for (const slug of LANGUAGE_SLUGS) {
      expect(alternates[hrefLang(slug)]).toBe(`/language/${slug}`);
    }
  });

  test("points x-default at the default language", () => {
    expect(alternateLanguages()["x-default"]).toBe(languagePath(DEFAULT_LANGUAGE));
  });

  test("has no entry for a language we do not offer", () => {
    expect(alternateLanguages()).not.toHaveProperty("de");
  });
});

describe("language paths", () => {
  test("is the route the language page actually serves", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(languagePath(slug)).toMatch(/^\/language\/[a-z-]+$/);
    }
  });

  test("is unique per language", () => {
    const paths = LANGUAGE_SLUGS.map(languagePath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("sitemap entries", () => {
  test("covers the home page and every language", () => {
    expect(sitemapEntries().map((entry) => entry.path)).toEqual([
      "/",
      ...LANGUAGE_SLUGS.map(languagePath),
    ]);
  });

  test("names the language of each entry", () => {
    for (const entry of sitemapEntries()) {
      expect(LANGUAGE_SLUGS).toContain(entry.language);
    }
  });
});
