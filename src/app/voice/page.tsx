import Link from "next/link";

import { PROTOTYPE_NOTICE } from "@/i18n/metadata";
import { LowBandwidthToggle } from "@/i18n/display-preferences";
import {
  DEFAULT_LANGUAGE,
  LIVE_LANGUAGE_SLUGS,
  messagesFor,
  resolveBookableLanguage,
} from "@/i18n/registry";
import { isVoiceConfigured } from "@/lib/voice/elevenlabs";
import { voiceMessages } from "./copy";

/**
 * /voice -- pick a language, then talk instead of typing.
 *
 * A second entry point rather than a mode on /language/[slug], and the reason
 * is the order of the decisions. On the form page the language is chosen first
 * and the method second, which for somebody who cannot read the form at all is
 * the wrong way round: the only choice they can make is the one they can speak.
 *
 * It lists bookable languages and nothing else, from the same registry the form
 * uses, so a language that is announced-but-pending has no page here either.
 * With no voice credential configured the link is not offered at all -- the
 * button would lead to a screen that can only say it is unavailable, and a dead
 * control in the tab order is worse than no control.
 */
export default function VoiceIndexPage() {
  const available = isVoiceConfigured();
  const t = messagesFor(DEFAULT_LANGUAGE);
  const copy = voiceMessages(DEFAULT_LANGUAGE);

  /**
   * One card per bookable language.
   *
   * Resolved rather than read straight out of the registry so that a language
   * without a dictionary has no card here, and so that a card is only ever built
   * from a language that has both a form and a page. The two lists are the same
   * list -- `LIVE_LANGUAGE_SLUGS` is derived from the registry -- so a card
   * cannot point at a page that 404s.
   */
  const cards = LIVE_LANGUAGE_SLUGS.flatMap((slug) => {
    const bookable = resolveBookableLanguage(slug);
    return bookable ? [{ slug, language: bookable.language }] : [];
  });

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col justify-between p-6 sm:p-10">
      <header className="w-full max-w-6xl mx-auto flex items-center justify-between py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center font-bold text-xl text-white shadow-sm">
            M
          </div>
          <span className="text-xl font-bold tracking-tight text-ink">Medilin</span>
        </div>
        <div className="flex items-center gap-4">
          <LowBandwidthToggle label={t.lowBandwidth} />
          <div className="text-xs font-medium text-notice-ink bg-notice-soft border border-notice-rule px-3.5 py-1.5 rounded-full">
            {PROTOTYPE_NOTICE}
          </div>
        </div>
      </header>

      <main id="main" className="w-full max-w-4xl mx-auto text-center my-auto py-12">
        <p className="inline-block text-xs font-semibold text-ink-soft bg-surface-sunken border border-rule rounded-full px-3.5 py-1.5 mb-6">
          {copy.title}
        </p>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight mb-6 text-ink leading-tight">
          Book an appointment <span className="text-accent">out loud</span>
        </h1>

        <p className="text-ink-soft text-lg sm:text-xl max-w-2xl mx-auto mb-12 font-normal leading-relaxed">
          {copy.subtitle}
        </p>

        {/*
          No voice credential, no screen. Every card here leads to a recording
          button that can only fail, and three dead controls are worse than one
          honest sentence and a link to the form that works.
        */}
        {available ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-3xl mx-auto text-start">
          {cards.map(({ slug, language }) => {
            return (
              <Link
                key={slug}
                href={`/voice/${slug}`}
                className="group bg-surface border border-rule hover:border-accent rounded-2xl p-6 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between"
              >
                <div>
                  <div className="text-3xl mb-4" aria-hidden="true">
                    {language.flag}
                  </div>
                  <h2
                    lang={language.locale}
                    dir={language.direction}
                    className="text-lg font-bold text-ink transition-colors group-hover:text-accent"
                  >
                    {language.name}
                  </h2>
                  <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
                    {language.description}
                  </p>
                </div>

                <div className="mt-8 flex items-center text-xs font-semibold text-accent">
                  {copy.record}
                  <span className="flow-arrow" aria-hidden="true">
                    &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
        ) : (
          <div className="max-w-xl mx-auto bg-surface border border-rule rounded-3xl p-8 shadow-sm">
            <h2 className="text-lg font-bold text-ink mb-2">{copy.unavailableTitle}</h2>
            <p className="text-sm text-ink-soft">{copy.unavailableBody}</p>
          </div>
        )}

        {/*
          The way out, always. A patient who opened this because the form was
          hard to read needs a route to the form that does not require anything
          of them, and a browser that cannot record is not an error state.
        */}
        <p className="mt-12 text-sm text-ink-muted">
          {copy.useTheForm}:{" "}
          <Link href="/language/english" className="text-accent font-semibold hover:underline">
            {t.title}
          </Link>
        </p>
      </main>

      <footer className="w-full max-w-6xl mx-auto py-6 text-center text-xs text-ink-muted border-t border-rule">
        {new Date().getFullYear()} Medilin Systems. Powered by ElevenLabs Conversational AI &amp;
        Gemini.
      </footer>
    </div>
  );
}
