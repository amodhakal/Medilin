import Link from "next/link";

/**
 * Shown for a link that does not open a transcript.
 *
 * Its own boundary rather than the app's, for the reason `../track/[token]`
 * has one: the default is a statement about a URL, and the only thing somebody
 * holding a dead link can act on is being told the link is not usable.
 *
 * It cannot say why. Truncated, tampered, sealed under a different key, minted
 * before the database was configured so that it names no appointment at all, and
 * a booking that has since been deleted are five different situations, and
 * telling them apart tells whoever is probing which one they managed. One
 * message covers all five, and so does the 404 that comes with it.
 */
export default function TranscriptNotFound() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased flex items-center">
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          Call transcript
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          This link does not open
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          Transcript links point at a stored record, and this one does not resolve to
          one. It may be incomplete, may have been made by a different version of the
          site, or the appointment it referred to may no longer be on file. We cannot say
          which, and we will not try.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          Your appointment page is a different link, and it is unaffected by this one.
        </p>
        <Link
          href="/"
          className="mt-8 inline-block rounded-xl bg-teal-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-800"
        >
          Make a new appointment request
        </Link>
      </div>
    </main>
  );
}
