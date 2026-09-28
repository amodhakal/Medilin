import Link from "next/link";

/**
 * Shown for a management link that does not open.
 *
 * Its own boundary, for the reason /track/[token]/not-found has its own: the app's
 * default is "This page could not be found", which is a statement about a URL and
 * not about the person's appointment. This one says the link is not usable and
 * what to do about it, which is the only thing someone holding a dead link can act
 * on.
 *
 * It cannot say *why* the link failed, and that is the point rather than a
 * limitation. Truncated, tampered, sealed under a different key, from a different
 * token family, and past its expiry are five different situations, and telling
 * them apart tells whoever is probing which one they managed. The same reasoning is
 * why `spendPatientAction` collapses its own refusals to four reasons.
 *
 * Deliberately no link to the tracking page. That page needs a different token, so
 * offering it would be offering a link that cannot work.
 */
export default function RescheduleNotFound() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased flex items-center">
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          Appointment
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          This link does not open
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          A link to change an appointment is sealed, and it works for a week. This one may have
          run out, may have been copied incompletely, or may not be a link we made. We cannot say
          which, and we will not try.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          If you were sent this link, ask the clinic for a fresh one. If you made the request
          yourself, you can make it again.
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
