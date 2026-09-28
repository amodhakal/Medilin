import Link from "next/link";

import { PROTOTYPE_NOTICE, homeMetadata } from "@/i18n/metadata";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_SLUGS,
  getLanguage,
  messagesFor,
} from "@/i18n/registry";

export const metadata = homeMetadata();

/**
 * The picker's own copy. The page is in one language -- the default -- and the
 * language names on it are endonyms in `lang` and `dir` of their own.
 */
const t = messagesFor(DEFAULT_LANGUAGE);

export default function HomePage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between p-6 sm:p-10">
      {/* Header */}
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-600 flex items-center justify-center font-bold text-xl text-white shadow-sm">
            M
          </div>
          <span className="text-xl font-bold tracking-tight text-slate-900">
            Medilin
          </span>
        </div>
        <div className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-3.5 py-1.5 rounded-full">
          {PROTOTYPE_NOTICE}
        </div>
      </header>

      {/* Main Hero Content */}
      <main className="w-full max-w-4xl mx-auto text-center my-auto py-12">
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight mb-6 text-slate-900 leading-tight">
          Intelligent Medical <br />
          <span className="text-cyan-600">Voice Assistant</span>
        </h1>

        <p className="text-slate-600 text-lg sm:text-xl max-w-2xl mx-auto mb-12 font-normal leading-relaxed">
          Streamline patient intake with autonomous AI voice agents. Select your preferred language to begin.
        </p>

        {/*
          Language Cards Grid.

          `text-start` rather than `text-left`: the card text is in the
          reader's language, but a page that will host right-to-left languages
          should not need auditing to find the places that assume otherwise.
        */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-3xl mx-auto text-start">
          {LANGUAGE_SLUGS.map((slug) => {
            const language = getLanguage(slug);
            const endonym = (
              // `lang` and `dir` on the endonym itself: it is written in that
              // language, and an endonym in Arabic has to be set right-to-left
              // even when everything around it is not.
              <h2
                lang={language.locale}
                dir={language.direction}
                className="text-lg font-bold text-slate-900 transition-colors"
              >
                {language.name}
              </h2>
            );

            if (language.status === "pending") {
              /*
                Announced, not linked.

                A language we cannot book in yet has no page, so there is
                nothing to link to and nothing to prerender. It is still listed,
                because "we are working on it" is more useful to someone who
                only speaks that language than leaving them to conclude the app
                does not want them. A div rather than a link, so it is not in
                the tab order: a control that does nothing should not be
                reachable by keyboard.
              */
              return (
                <div
                  key={slug}
                  aria-disabled="true"
                  className="bg-slate-100 border border-slate-200 rounded-2xl p-6 flex flex-col justify-between"
                >
                  <div>
                    <div className="text-3xl mb-4 opacity-60" aria-hidden="true">
                      {language.flag}
                    </div>
                    {endonym}
                    <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                      {t.notYetBookable}
                    </p>
                  </div>

                  <div className="mt-8 flex items-center">
                    <span className="inline-flex items-center rounded-full border border-slate-300 px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-600">
                      {t.comingSoon}
                    </span>
                  </div>
                </div>
              );
            }

            return (
              <Link
                key={slug}
                href={`/language/${slug}`}
                className="group bg-white border border-slate-200 hover:border-cyan-600 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between"
              >
                <div>
                  <div className="text-3xl mb-4" aria-hidden="true">
                    {language.flag}
                  </div>
                  <div className="group-hover:text-cyan-700">{endonym}</div>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                    {language.description}
                  </p>
                </div>

                <div className="mt-8 flex items-center text-xs font-semibold text-cyan-700">
                  {t.startIntake}{" "}
                  {/* The arrow points the way the page reads. */}
                  <span className="flow-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-6xl mx-auto py-6 text-center text-xs text-slate-500 border-t border-slate-200">
        &copy; {new Date().getFullYear()} Medilin Systems. Powered by ElevenLabs Conversational AI & Gemini.
      </footer>
    </div>
  );
}
