import Link from "next/link";

/**
 * `/track` with no token.
 *
 * Not a redirect and not a search box. There is nothing to search for — the
 * token *is* the appointment, and without it the server has no record to look
 * up — so the only thing this page can honestly do is say that.
 */
export const metadata = {
  title: "Appointment",
  robots: { index: false, follow: false },
};

export default function TrackIndex() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased flex items-center">
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          Appointment
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Open the link you were sent
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          There is no appointment to look up from this address. Your appointment is sealed
          into the link itself, and it only opens on the server that sealed it.
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
