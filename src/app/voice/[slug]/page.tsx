import Link from "next/link";
import { notFound } from "next/navigation";

import { resolveBookableLanguage } from "@/i18n/registry";
import { isVoiceConfigured } from "@/lib/voice/elevenlabs";
import { voiceMessages } from "../copy";
import VoiceIntake from "./VoiceIntake";

/**
 * /voice/[slug] -- book by voice, in one language.
 *
 * A server component, and a thin one. Three decisions happen here rather than in
 * the browser, and each of them is one a patient should not be able to get
 * wrong:
 *
 *   1. The slug is resolved against the registry, so a language we cannot book
 *      in is a 404 here exactly as it is on the form route, and an unrecognised
 *      one never renders a working screen in the wrong language.
 *   2. Whether voice is available at all is decided server-side from the
 *      credential's presence. The page renders the unavailable notice, with the
 *      form one click away, rather than a recording button that can only fail.
 *   3. Nothing about the vendor reaches this tree. The client posts audio to
 *      /api/voice/intake and gets JSON back, and this page's only job is to say
 *      whether that endpoint will answer.
 */
export default async function VoiceIntakePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const bookable = resolveBookableLanguage(slug);
  if (!bookable) {
    notFound();
  }

  const copy = voiceMessages(bookable.slug);
  const available = isVoiceConfigured();

  return (
    <main
      id="main"
      lang={bookable.language.locale.split("-")[0]}
      dir={bookable.language.direction}
      className="min-h-screen bg-paper text-ink flex flex-col items-center justify-center p-6"
    >
      <div className="w-full max-w-xl my-8">
        <div className="mb-6">
          <Link
            href="/voice"
            className="inline-flex items-center gap-2 text-xs text-accent hover:text-accent-strong font-semibold transition-colors tap-target"
          >
            <span className="flow-arrow" aria-hidden="true">
              &larr;
            </span>{" "}
            {copy.back}
          </Link>
        </div>

        {available ? (
          <VoiceIntake
            slug={bookable.slug}
            language={bookable.language}
            messages={copy}
          />
        ) : (
          <div className="bg-surface border border-rule rounded-3xl p-8 shadow-xl text-center">
            <h1 className="text-2xl font-bold tracking-tight text-ink mb-3">
              {copy.unavailableTitle}
            </h1>
            <p className="text-sm text-ink-soft mb-6">{copy.unavailableBody}</p>
            <Link
              href={`/language/${bookable.slug}`}
              className="inline-block bg-accent hover:bg-accent-strong text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors"
            >
              {copy.useTheForm}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
