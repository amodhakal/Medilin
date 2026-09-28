import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ToastContainer } from "react-toastify";

import { LIVE_LANGUAGE_SLUGS, resolveBookableLanguage } from "@/i18n/registry";
import { languageMetadata } from "@/i18n/metadata";
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
  // Bookable languages only. A pending language is announced on the picker and
  // has no page, so prerendering a route for it would be a page that exists
  // only to say it does not.
  return LIVE_LANGUAGE_SLUGS.map((slug) => ({ slug }));
}

/**
 * Per-language document metadata.
 *
 * The title, description, canonical URL, hreflang set, and Open Graph locale
 * all come from the registry, so a language cannot be added to the picker
 * without also getting a title. The alternates point at every language, which
 * is what tells a search engine these are translations of one form rather than
 * four unrelated pages.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const metadata = languageMetadata(slug);
  if (!metadata) {
    notFound();
  }

  return metadata;
}

export default async function LanguagePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const bookable = resolveBookableLanguage(slug);
  if (!bookable) {
    notFound();
  }

  return (
    <>
      <IntakeForm slug={bookable.slug} language={bookable.language} />
      {/*
        The toast container lives here rather than in the root layout, because
        this is the only page that raises toasts and because it is the only
        place that knows the reading direction. react-toastify mirrors its own
        layout when told the container is RTL, which a global container in the
        root layout -- where `<html lang>` is fixed to English and the language
        is not known -- could not do.
      */}
      {/* `rtl` mirrors react-toastify's own layout. The wrapper is for
          `dir`: the library has no prop for it, and without it the logical
          properties in the toast rules -- the coloured rule down the inline
          start edge -- would resolve against the document's direction, which
          is English, on a page in Arabic. */}
      <div dir={bookable.language.direction}>
        <ToastContainer
          position="top-center"
          draggable={false}
          closeOnClick={false}
          pauseOnFocusLoss
          closeButton
          autoClose={8000}
          newestOnTop
          role="alert"
          rtl={bookable.language.direction === "rtl"}
        />
      </div>
    </>
  );
}
