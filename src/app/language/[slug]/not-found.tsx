import Link from "next/link";

import { LIVE_LANGUAGE_SLUGS, getLanguage, messagesFor } from "@/i18n/registry";

/**
 * The 404 for an unrecognised language slug.
 *
 * Next.js renders this boundary with no access to the route params, so it
 * cannot know which language was asked for and cannot answer in that
 * language. It uses the default language's strings and offers every language
 * the registry knows about, which is the honest version of "that language does
 * not exist": the address was wrong, not the patient.
 */
export default function LanguageNotFound() {
  // A not-found boundary receives no route params, so it cannot know which
  // language was asked for and answers in the default language.
  const t = messagesFor("english");

  return (
    <main id="main" className="min-h-screen bg-paper text-ink flex items-center justify-center p-6">
      <div className="w-full max-w-xl text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">
          404
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink mt-2 mb-3">
          {t.notFoundTitle}
        </h1>
        <p className="text-sm text-ink-muted leading-relaxed mb-8">{t.notFoundBody}</p>

        <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
          {t.pickLanguage}
        </h2>
        <ul className="flex flex-wrap justify-center gap-3">
          {LIVE_LANGUAGE_SLUGS.map((slug) => {
            const language = getLanguage(slug);
            return (
              <li key={slug}>
                <Link
                  href={`/language/${slug}`}
                  lang={language.locale}
                  dir={language.direction}
                  className="inline-flex items-center gap-2 bg-surface border border-rule hover:border-accent rounded-xl px-4 py-2.5 text-sm font-semibold text-ink hover:text-accent transition-colors"
                >
                  <span aria-hidden="true">{language.flag}</span>
                  {language.name}
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mt-8">
          <Link
            href="/"
            className="text-xs font-semibold text-accent hover:text-accent-strong tap-target"
          >
            &larr; {t.back}
          </Link>
        </p>
      </div>
    </main>
  );
}
