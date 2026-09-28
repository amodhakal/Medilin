import Link from "next/link";

/**
 * Shown for a token that does not open.
 *
 * Its own boundary rather than the app's, because the app's default is "This
 * page could not be found", which is a statement about a URL rather than about
 * the person's appointment. This one says the link is not usable and what to do
 * about it, which is the only thing someone holding a dead link can act on.
 *
 * It cannot say *why* the link failed. Truncated, tampered, sealed under a
 * different key, and from an older version are four different situations, and
 * telling them apart tells whoever is probing which one they managed. One
 * message covers all four, and so does the 404 status that comes with it.
 */
export default function TrackNotFound() {
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
          Appointment links are sealed, and a sealed link only opens on the server that made
          it. This one is incomplete, was cut short in transit, or was made by a different
          version of the site. We cannot say which, and we will not try.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          If you were sent this link, ask for a fresh one. If you made the request yourself,
          you can make it again.
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
