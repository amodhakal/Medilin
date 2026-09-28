import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_LANGUAGE,
  LIVE_LANGUAGE_SLUGS,
  LANGUAGE_SLUGS,
  PENDING_LANGUAGE_SLUGS,
  getLanguage,
  htmlLang,
  messagesFor,
} from "./registry";

/**
 * Reading direction, and what a language's presence does and does not buy.
 *
 * Right-to-left support here is three things rather than one: the `dir`
 * attribute comes from the registry, the stylesheet uses logical properties
 * throughout, and a directional glyph is mirrored. The first is testable by
 * rendering; the second and third are a property of globals.css, checked at the
 * bottom of this file.
 */

const stylesheet = await Bun.file(
  new URL("../app/globals.css", import.meta.url),
).text();

describe("language direction", () => {
  test("every language declares a direction", () => {
    for (const slug of LANGUAGE_SLUGS) {
      expect(["ltr", "rtl"]).toContain(getLanguage(slug).direction);
    }
  });

  test("a right-to-left language is declared right-to-left, not inferred", () => {
    // Arabic and Hebrew are registered RTL. The direction is read from the
    // registry rather than derived from the locale subtag, because derivation
    // is a table of exceptions -- Azerbaijani is written both ways, Serbian is
    // Latin script in Bosnia -- and this app is not maintaining one.
    const rtl = LANGUAGE_SLUGS.filter((slug) => getLanguage(slug).direction === "rtl");
    expect(rtl.length).toBeGreaterThan(0);
    expect(rtl).toContain("arabic");
    expect(rtl).toContain("hebrew");
    for (const slug of rtl) {
      expect(getLanguage(slug).direction).toBe("rtl");
    }
  });

  test("the picker marks each endonym with its own lang and dir", () => {
    // Rendered from the same registry the picker maps over, so this is the
    // markup the patient gets.
    for (const slug of LANGUAGE_SLUGS) {
      const language = getLanguage(slug);
      const html = renderToStaticMarkup(
        <h2 lang={language.locale} dir={language.direction}>
          {language.name}
        </h2>,
      );

      expect(html).toContain(`lang="${language.locale}"`);
      expect(html).toContain(`dir="${language.direction}"`);
      expect(html).toContain(htmlLang(language));
    }
  });

  test("the picker declares an RTL endonym as RTL", () => {
    const arabic = getLanguage("arabic");
    expect(arabic.direction).toBe("rtl");
    const html = renderToStaticMarkup(
      <h2 lang={arabic.locale} dir={arabic.direction}>
        {arabic.name}
      </h2>,
    );
    expect(html).toContain('dir="rtl"');
  });
});

describe("the stylesheet does not assume a reading direction", () => {
  const physical = [
    /(^|[\s;{])(margin|padding|border)-(left|right)\s*:/,
    /(^|[\s;{])left\s*:/,
    /(^|[\s;{])right\s*:/,
    /(^|[\s;{])(text-align\s*:\s*(left|right))/,
    /(^|[\s;{])float\s*:\s*(left|right)/,
  ];

  test("uses logical properties rather than left and right", () => {
    for (const pattern of physical) {
      const match = stylesheet.match(pattern);
      expect(match?.[0] ?? null).toBeNull();
    }
  });

  test("uses logical properties where the toast rules need them", () => {
    // The coloured rule down the edge of a toast has to be on the reading
    // start edge, or it ends up on the wrong side of an Arabic message.
    expect(stylesheet).toContain("border-inline-start");
  });

  test("mirrors a directional glyph under [dir=rtl]", () => {
    // A logical property cannot express "this arrow means forward": the glyph
    // itself has to be flipped.
    expect(stylesheet).toContain('[dir="rtl"] .flow-arrow');
    expect(stylesheet).toMatch(/\.flow-arrow\s*\{[\s\S]*?transform:\s*scaleX\(-1\)/);
  });
});

describe("a pending language", () => {
  test("has no page to link to", () => {
    // generateStaticParams is what decides which of these have a URL; if a
    // pending language had one, the page would render a form in a language we
    // cannot translate.
    const live: string[] = [...LIVE_LANGUAGE_SLUGS];
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(live).not.toContain(slug);
    }
  });

  test("renders no strings of its own", () => {
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      const language = getLanguage(slug);
      if (language.status !== "pending") continue;
      expect(language.messages).toBeUndefined();
      expect(messagesFor(slug)).toBe(messagesFor(DEFAULT_LANGUAGE));
    }
  });

  test("still has a name to announce", () => {
    // A picker that only lists what is ready is a picker that tells someone who
    // speaks Arabic that this app is not for them.
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(getLanguage(slug).name.trim().length).toBeGreaterThan(0);
    }
  });
});
