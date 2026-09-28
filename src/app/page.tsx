import Link from "next/link";

import { PROTOTYPE_NOTICE, homeMetadata } from "@/i18n/metadata";
import { LowBandwidthToggle } from "@/i18n/display-preferences";
import { voiceMessages } from "@/app/voice/copy";
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

/**
 * The voice path's own label, from its own dictionary.
 *
 * Read from `@/app/voice/copy` rather than added to the intake registry on
 * purpose: the registry's message set is the one every language surface in this
 * app is written against, and a screen that has not shipped should not be able
 * to add a key to it and fail the build for a translator who has not been asked
 * yet. The voice screens carry their own closed key set instead, checked the
 * same way.
 */
const voiceCopy = voiceMessages(DEFAULT_LANGUAGE);

export default function HomePage() {
  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col justify-between p-6 sm:p-10">
      {/* Header */}
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center font-bold text-xl text-white shadow-sm">
            M
          </div>
          <span className="text-xl font-bold tracking-tight text-ink">
            Medilin
          </span>
        </div>
        <div className="flex items-center gap-4">
          <LowBandwidthToggle label={t.lowBandwidth} />
          <div className="text-xs font-medium text-notice-ink bg-notice-soft border border-notice-rule px-3.5 py-1.5 rounded-full">
            {PROTOTYPE_NOTICE}
          </div>
        </div>
      </header>

      {/* Main Hero Content */}
      <main id="main" className="w-full max-w-4xl mx-auto text-center my-auto py-12">
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight mb-6 text-ink leading-tight">
          Intelligent Medical <br />
          <span className="text-accent">Voice Assistant</span>
        </h1>

        <p className="text-ink-soft text-lg sm:text-xl max-w-2xl mx-auto mb-12 font-normal leading-relaxed">
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
                className="text-lg font-bold text-ink transition-colors"
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
                  className="bg-surface-sunken border border-rule rounded-2xl p-6 flex flex-col justify-between"
                >
                  <div>
                    <div className="text-3xl mb-4 opacity-60" aria-hidden="true">
                      {language.flag}
                    </div>
                    {endonym}
                    <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
                      {t.notYetBookable}
                    </p>
                  </div>

                  <div className="mt-8 flex items-center">
                    <span className="inline-flex items-center rounded-full border border-rule px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-soft">
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
                className="group bg-surface border border-rule hover:border-accent rounded-2xl p-6 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between"
              >
                <div>
                  <div className="text-3xl mb-4" aria-hidden="true">
                    {language.flag}
                  </div>
                  <div className="group-hover:text-accent">{endonym}</div>
                  <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
                    {language.description}
                  </p>
                </div>

                <div className="mt-8 flex items-center text-xs font-semibold text-accent">
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

        {/*
          The way in without reading (#61).

          Placed under the picker rather than inside it, and as a link rather
          than a card, for a reason: the picker is a choice between languages
          and a patient who cannot read this page in any of them is not helped
          by a fourteenth card they cannot read. This says what it does in
          English, leads to a screen whose only input is speech, and is
          reachable without touching anything above it.
        */}
        <p className="mt-12 text-sm text-ink-muted">
          <Link
            href="/voice"
            className="inline-flex items-center gap-2 text-accent font-semibold hover:text-accent-strong hover:underline tap-target"
          >
            {voiceCopy.title}
            <span className="flow-arrow" aria-hidden="true">
              &rarr;
            </span>
          </Link>
        </p>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-6xl mx-auto py-6 text-center text-xs text-ink-muted border-t border-rule">
        &copy; {new Date().getFullYear()} Medilin Systems. Powered by ElevenLabs Conversational AI & Gemini.
      </footer>
    </div>
  );
}
