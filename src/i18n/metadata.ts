import type { Metadata } from "next";

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_SLUGS,
  getLanguage,
  htmlLang,
  type LanguageDefinition,
  type LanguageSlug,
} from "./registry";

/**
 * Document metadata, in one place.
 *
 * The root layout carried `title: "Medilin"` and nothing else, so every page
 * in a multilingual app advertised itself as "Medilin" in every language, with
 * no description, no canonical URL, and no hreflang links for the language
 * picker to be a picker. Meanwhile the `<html lang>` attribute was hardcoded to
 * `en` on a page that is entirely in Spanish or Portuguese, which tells a
 * screen reader to read Portuguese text with English pronunciation rules.
 *
 * The referrer policy is the one that is not cosmetic. The spectate URL used to
 * carry the whole patient record, so any outbound request from that page sent
 * the record in its Referer header to the receiving server's access log. The
 * URL is a sealed token now, so there is nothing to leak, but a page that
 * handles a medical record should say `no-referrer` regardless: it costs
 * nothing, and it is the setting that has to already be right on the day
 * something PHI-shaped ends up in a URL again.
 */

/**
 * The public origin, for canonical URLs, hreflang links, and Open Graph.
 *
 * NEXT_PUBLIC_SITE_URL is read directly because src/lib/env.ts, which owns the
 * validated environment, is outside this change's file ownership. It should
 * move there as a required or defaulted variable so the origin is validated
 * like everything else; until then a missing value degrades to localhost, which
 * is the safe direction to fail.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

export const SITE_NAME = "Medilin";

/** Stated on the home page and in every description. See README on scope. */
export const PROTOTYPE_NOTICE = "Prototype — not for clinical use";

const DESCRIPTION = `Book a doctor's appointment by voice. ${PROTOTYPE_NOTICE}.`;

/** The route a language lives at. Single source for links and canonicals. */
export function languagePath(slug: LanguageSlug): string {
  return `/language/${slug}`;
}

/**
 * `hreflang` for a language, and the Open Graph `locale`.
 *
 * `lang` takes the primary subtag ("pt"), because the document is written in
 * one language. Open Graph wants a region too, so an untagged locale gets the
 * most probable region for the language rather than an empty "_".
 */
export function hrefLang(slug: LanguageSlug): string {
  return htmlLang(getLanguage(slug));
}

export function openGraphLocale(language: LanguageDefinition): string {
  const [tag, region] = language.locale.split("-");
  return region ? `${tag}_${region}` : `${tag}_US`;
}

/**
 * Every language's address, keyed by hreflang, plus `x-default`.
 *
 * This is what makes the language picker a set of real alternate documents
 * rather than three internal links, and it is why the alternates are generated
 * from the registry instead of being written out per page.
 */
export function alternateLanguages(): Record<string, string> {
  const alternates: Record<string, string> = {};

  for (const slug of LANGUAGE_SLUGS) {
    alternates[hrefLang(slug)] = languagePath(slug);
  }

  alternates["x-default"] = languagePath(DEFAULT_LANGUAGE);
  return alternates;
}

/**
 * Root metadata.
 *
 * Exported from here rather than written inline in the layout so the referrer
 * policy is a value a test can assert on, instead of a line of JSX that
 * nothing checks.
 */
export const rootMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — ${PROTOTYPE_NOTICE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  // See the note at the top of this file. Not decorative.
  referrer: "no-referrer",
  robots: {
    // This intake form posts real names, dates of birth, and symptom text into
    // an in-memory store with no database behind it, on a deployment that is
    // not a deployment. It should not be in a search index. Flip to `index:
    // true` when the intake path is genuinely production, or scope this to the
    // public pages once the prototype notice comes off.
    index: false,
    follow: true,
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${PROTOTYPE_NOTICE}`,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary",
    title: `${SITE_NAME} — ${PROTOTYPE_NOTICE}`,
    description: DESCRIPTION,
  },
};

export function homeMetadata(): Metadata {
  return {
    ...rootMetadata,
    title: undefined,
    alternates: {
      canonical: "/",
      languages: alternateLanguages(),
    },
  };
}

/** Per-language document metadata, from the registry. */
export function languageMetadata(slug: LanguageSlug): Metadata {
  const language = getLanguage(slug);
  const { messages } = language;
  const path = languagePath(slug);

  return {
    title: messages.title,
    description: `${messages.subtitle} ${PROTOTYPE_NOTICE}.`,
    alternates: {
      canonical: path,
      languages: alternateLanguages(),
    },
    openGraph: {
      ...rootMetadata.openGraph,
      title: messages.title,
      description: messages.subtitle,
      url: path,
      locale: openGraphLocale(language),
    },
    twitter: {
      card: "summary",
      title: messages.title,
      description: messages.subtitle,
    },
  };
}

/** Every language URL, for a sitemap written by whoever owns the route file. */
export function sitemapEntries(): Array<{ path: string; language: LanguageSlug }> {
  return [
    { path: "/", language: DEFAULT_LANGUAGE },
    ...LANGUAGE_SLUGS.map((slug) => ({ path: languagePath(slug), language: slug })),
  ];
}
