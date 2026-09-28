import { describe, expect, test } from "bun:test";
import React from "react";

import {
  LIVE_LANGUAGE_SLUGS,
  PENDING_LANGUAGE_SLUGS,
} from "@/i18n/registry";
import LanguagePage, { generateStaticParams } from "./page";

/**
 * The route's whole job is deciding whether a slug names a language. That
 * decision is testable without a browser, so it is tested here: the old
 * version resolved the slug in the browser with a cast, which meant no test
 * could catch it and nothing did.
 */

function render(slug: string) {
  return LanguagePage({ params: Promise.resolve({ slug }) });
}

async function notFoundDigest(slug: string): Promise<string | undefined> {
  try {
    await render(slug);
    return undefined;
  } catch (error) {
    return (error as { digest?: string }).digest;
  }
}

describe("generateStaticParams", () => {
  test("prerenders every bookable language in the registry", () => {
    const params = generateStaticParams();
    expect(params.map((entry) => entry.slug)).toEqual([...LIVE_LANGUAGE_SLUGS]);
  });

  test("prerenders no language we cannot serve a form for", () => {
    const params = generateStaticParams();
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(params.map((entry) => entry.slug)).not.toContain(slug);
    }
  });

  test("prerenders each language once", () => {
    const slugs = generateStaticParams().map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("prerenders nothing that is not a language", () => {
    const registry: string[] = [...LIVE_LANGUAGE_SLUGS];
    for (const entry of generateStaticParams()) {
      expect(registry).toContain(entry.slug);
    }
  });
});

describe("a bookable language slug", () => {
  for (const slug of LIVE_LANGUAGE_SLUGS) {
    test(`renders the ${slug} form`, async () => {
      const element = await render(slug);
      expect(element).toBeTruthy();
      const [form] = React.Children.toArray(element.props.children) as Array<{
        props: { slug: string; language: { status: string } };
      }>;
      expect(form.props.slug).toBe(slug);
      expect(form.props.language.status).toBe("live");
    });
  }
});

describe("an unknown language slug", () => {
  const unknown = [
    "klingon",
    "",
    "en",
    "ENGLISH",
    "english ",
    " english",
    "english/../spanish",
    "spanish%00",
    "constructor",
    "__proto__",
    "toString",
  ];

  for (const slug of unknown) {
    test(`is a 404, not an English form: ${JSON.stringify(slug)}`, async () => {
      expect(await notFoundDigest(slug)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    });
  }

  test("does not serve a form for a language that is registered but pending", async () => {
    // The failure mode a pending language has to be protected from: a URL that
    // says Arabic and a form that is not.
    for (const slug of PENDING_LANGUAGE_SLUGS) {
      expect(await notFoundDigest(slug)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  });

  test("does not fall back to the default language", async () => {
    // The failure mode this issue is about: an unrecognised slug rendering a
    // working form, indistinguishable from a real page.
    let rendered = false;
    try {
      await render("klingon");
      rendered = true;
    } catch {
      rendered = false;
    }
    expect(rendered).toBe(false);
  });
});
