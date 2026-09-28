import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getClinicName } from "@/config";
import { openTranscript } from "@/lib/transcript/access";
import { toReplayView } from "./replay";

/**
 * The page a past call is replayed on (#57).
 *
 * It answers a question the tracking page does not: not "when am I expected" but
 * "what was actually said". Before this, a call existed for as long as a browser
 * tab did -- `transcript: []` in a client component, growing line by line and gone
 * on reload -- which for a booking call means the clinic and the patient both
 * ended up with no record of what a patient said in order to get help.
 *
 * **The token in the URL is the whole of the authorisation.** The route segment
 * is the same token from `../track/[token]`: a short reference to the stored
 * record, or -- for a link minted before the database was configured -- the
 * record sealed into the URL. There is no session, no account, and nothing to
 * guess, and the page is deliberately the *only* thing that opens with it, so a
 * new access path is not being added for the most sensitive data in the
 * application.
 *
 * **The decision is made in one place.** `openTranscript` is the same function
 * the PDF export goes through, and a page and a download that each resolved a
 * token would drift: one of them would grow a special case, and the difference
 * between the two would be a control nobody had reviewed. Everything this page
 * renders comes back through `toReplayView`, which is an allowlist.
 *
 * **A token that names no appointment does not open a page.** A version 1 token
 * is the record sealed into the URL with nothing behind it, so there is no
 * transcript to address. It gets the same 404 as a truncated or tampered token,
 * and so does a reference to a booking that has been deleted, because telling
 * those apart tells whoever is probing which one they managed.
 *
 * Nothing about the token is logged, here or on any path including the failure
 * path. It is a working credential to a patient's conversation.
 */

export const metadata: Metadata = {
  title: "Call transcript",
  // A bearer link that a search engine could be handed should not end up in one.
  // The URL is the credential; indexing it is publishing it.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Rendered per request, never cached, for the reason `/track` does: the usual
 * Next defaults would let a shared cache keep a page whose URL is the credential,
 * and a transcript is a snapshot of a conversation rather than a live fact.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TranscriptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const session = await openTranscript(token);
  const view = toReplayView(session);
  if (!view) {
    // Truncated, tampered, sealed under a different key, a version 1 token, or a
    // booking that is gone. Five situations and one answer, and no log line,
    // because which of the five it was is not the caller's business and the token
    // itself does not belong in a log.
    notFound();
  }

  const clinic = getClinicName();

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:py-16">
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-700">
            {clinic}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Call transcript
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            What was said on the call for this appointment, in the order it was said.
            {view.lineCount > 0 && (
              <>
                {" "}
                {view.lineCount} {view.lineCount === 1 ? "line" : "lines"}.
              </>
            )}
          </p>
        </header>

        {/* The same card as the tracking page, for the same reason: the state of
            the booking and the fact that this is a transcript are one object a
            reader takes in as a unit. */}
        <article className="mb-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-slate-200 bg-teal-50/60 px-6 py-4">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-teal-900">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-teal-600" />
              {view.status === "cancelled"
                ? "Cancelled"
                : view.status === "completed"
                  ? "Seen"
                  : "Booked"}
            </span>
            <span className="text-xs font-medium uppercase tracking-[0.15em] text-teal-800/70">
              {view.department || "Appointment"}
            </span>
          </div>

          <dl className="divide-y divide-slate-100">
            <Fact label="Appointment reference">
              <span className="font-mono text-sm">{view.reference}</span>
            </Fact>
            <Fact label="Call recorded">
              <time dateTime={view.calledAt}>{view.calledAt}</time>
            </Fact>
            {view.language && <Fact label="Language of the call">{view.language}</Fact>}
          </dl>
        </article>

        {view.entries.length === 0 ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-slate-900">Nothing was recorded</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              This appointment is on file, but no conversation was captured for it. If you
              spoke to us, telephone the clinic and they will be able to confirm what was
              agreed.
            </p>
          </section>
        ) : (
          <ol className="space-y-4" aria-label="Call transcript">
            {view.entries.map((entry) => (
              <li
                key={entry.seq}
                className={
                  entry.speaker === "Receptionist"
                    ? "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:ml-10"
                    : "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:mr-10"
                }
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span
                    className={
                      entry.speaker === "Receptionist"
                        ? "text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-600"
                        : "text-[11px] font-semibold uppercase tracking-[0.15em] text-teal-700"
                    }
                  >
                    {entry.speaker}
                  </span>
                  <time
                    dateTime={entry.at}
                    title={`${entry.at} (UTC)`}
                    className="text-[11px] tabular-nums text-slate-400"
                  >
                    {entry.clock} UTC
                  </time>
                </div>
                <p className="text-[15px] leading-relaxed text-slate-800">{entry.text}</p>
                {entry.interrupted && (
                  <p className="mt-2 text-[11px] text-slate-400">
                    The agent was interrupted here, so this line is not the whole sentence.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}

        <footer className="mt-10 border-t border-slate-200 pt-6 text-sm leading-relaxed text-slate-500">
          <p>
            This is a record of a conversation about your health. Anyone with this link can
            read it, so do not post it somewhere public.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            {/* The export is behind the same authorisation as this page, and it is
                built on the server: the PDF bytes are assembled from the same
                audited lines rather than in the browser, so a download is a request
                this server authorised rather than a document the client drew. */}
            <a
              href={`/api/transcript/${token}/pdf`}
              className="font-medium text-teal-800 underline underline-offset-4 hover:text-teal-900"
              rel="nofollow"
            >
              Download as PDF
            </a>
            <Link
              href="/"
              className="font-medium text-slate-600 underline underline-offset-4 hover:text-slate-800"
            >
              Make a different request
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-[13rem_1fr] sm:gap-4">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500 sm:pt-1.5">
        {label}
      </dt>
      <dd className="text-slate-900">{children}</dd>
    </div>
  );
}
