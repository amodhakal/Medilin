import { notFound } from "next/navigation";

import { LANGUAGE_SLUGS, isLanguageSlug } from "@/i18n/registry";
import IntakeForm from "./IntakeForm";

/**
 * /language/[slug]
 *
 * A server component, so the slug can be resolved before any of the form is
 * sent to the browser.
 *
 * This used to be a client component that resolved the slug with
 * `slug as Language || "english"`: an unchecked cast, so every string in the
 * world typechecked, and a fallback, so every string in the world rendered a
 * working English form. Nothing told a patient that the language they clicked
 * did not exist, and a stale or mistyped link looked identical to a real one.
 *
 * Now the registry is the only thing that can name a language, an unrecognised
 * slug is a 404 with a page that says so, and the known slugs are prerendered.
 */
export function generateStaticParams(): Array<{ slug: string }> {
  return LANGUAGE_SLUGS.map((slug) => ({ slug }));
}

export default async function LanguagePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isLanguageSlug(slug)) {
    notFound();
  }

  return <IntakeForm slug={slug} />;
}
