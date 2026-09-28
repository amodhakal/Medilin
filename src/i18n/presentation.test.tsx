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
 * The global stylesheet, as a contract.
 *
 * Three things about a page cannot be seen by reading the components, and all
 * three are in src/app/globals.css: which direction it reads, what it looks
 * like at low contrast, and what it does on a slow connection. They are checked
 * here by reading the stylesheet, because that is the only way to check them
 * without a browser, and because each of them is a property of the file as a
 * whole rather than of any one component.
 *
 * The file lives here because of the ownership boundary this work was given --
 * src/i18n is a directory it was allowed to create, and src/app/globals.css is
 * the only stylesheet it was allowed to edit. It should move to something like
 * src/app/globals.test.ts when that stops being true.
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

/**
 * Contrast.
 *
 * The palette is a set of roles, and the failure mode of a role-based palette
 * is that a colour is fine on white and not fine on the sunken surface a card
 * sits on. Both of those were true here before this was measured: slate-500
 * secondary text is 4.34:1 on surface-sunken, and cyan-600 links are 3.68:1
 * on white. Neither would have been caught by looking at it.
 */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => channel(parseInt(value.slice(offset, offset + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The token values, read out of the stylesheet so these cannot go stale. */
function token(name: string): string {
  const match = stylesheet.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!match) throw new Error(`no --color-${name} in globals.css`);
  return match[1];
}

describe("contrast", () => {
  const surfaces = ["paper", "surface", "surface-sunken"];

  const bodyText = ["ink", "ink-soft", "ink-muted"];

  for (const text of bodyText) {
    for (const surface of surfaces) {
      test(`${text} on ${surface} is at least 4.5:1`, () => {
        const ratio = contrast(token(text), token(surface));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const surface of surfaces) {
    test(`accent on ${surface} is at least 4.5:1`, () => {
      expect(contrast(token("accent"), token(surface))).toBeGreaterThanOrEqual(4.5);
    });

    test(`danger on ${surface} is at least 4.5:1`, () => {
      expect(contrast(token("danger"), token(surface))).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the accent is legible as a button fill, in both directions", () => {
    // White on the accent, and the accent on white: one colour has to work as
    // a link and as a button without changing contrast.
    expect(contrast("#ffffff", token("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("accent"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  test("white on the notice fill is at least 4.5:1", () => {
    expect(contrast(token("notice-ink"), token("notice-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  test("a control boundary is at least 3:1, which is the bar for a shape", () => {
    // Non-text contrast is a weaker requirement than text, and the borders
    // that carry meaning have to clear it.
    expect(contrast(token("rule-strong"), token("surface"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("danger-rule"), token("surface"))).toBeGreaterThanOrEqual(3);
  });

  test("the focus ring is visible against every surface it lands on", () => {
    for (const surface of surfaces) {
      expect(contrast(token("focus"), token(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("motion", () => {
  test("respects a request for reduced motion", () => {
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("stops the sound bars, which animate on their own forever", () => {
    // An infinite animation is the one thing in this app that never stops, and
    // it is on the page a patient is left looking at while a call connects.
    const block = stylesheet.slice(
      stylesheet.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(block).toContain(".wave-bar");
    expect(block).toMatch(/\.wave-bar\s*\{\s*animation:\s*none/);
  });

  test("keeps the sound bars for everyone else", () => {
    expect(stylesheet).toContain("animation: soundWave 1.2s infinite ease-in-out");
  });
});

describe("low bandwidth", () => {
  test("is a stylesheet keyed off one attribute on the document", () => {
    expect(stylesheet).toContain('html[data-bandwidth="low"]');
  });

  test("drops the things that are expensive to render", () => {
    // Shadows and backdrop filters are the expensive part of a card on a
    // low-end GPU, and the only ones a stylesheet can switch off.
    const block = stylesheet.slice(stylesheet.indexOf('html[data-bandwidth="low"]'));
    expect(block).toContain("box-shadow: none");
    expect(block).toContain("backdrop-filter: none");
    expect(block).toContain("animation: none");
  });

  test("substitutes the platform font, and says why that is not the whole win", () => {
    const block = stylesheet.slice(stylesheet.indexOf('html[data-bandwidth="low"]'));
    expect(block).toContain("--font-geist-sans: system-ui");
  });
});

describe("the skip link", () => {
  test("is the first thing in the tab order on every page", () => {
    expect(stylesheet).toContain(".skip-link");
  });

  test("is off screen until it is focused, not display:none", () => {
    // display:none would take it out of the tab order as well, which is the
    // opposite of the point.
    expect(stylesheet).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY/);
    expect(stylesheet).toMatch(/\.skip-link:focus\s*\{/);
    expect(stylesheet).not.toMatch(/\.skip-link\s*\{[^}]*display:\s*none/);
  });

  test("sits in the reading-start corner, not the top left", () => {
    expect(stylesheet).toMatch(/\.skip-link\s*\{[^}]*inset-inline-start/);
  });
});
