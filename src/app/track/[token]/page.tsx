import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getClinicName } from "@/config";
import { resolveRecord } from "@/lib/phi-token";
import { formatRequestedAt, toTrackSummary } from "./summary";
import { TimeUntil } from "./TimeUntil";

/**
 * The public appointment page.
 *
 * Reached by link, and the link is the whole of the authorisation: the route
 * segment is a token from src/lib/phi-token -- the record sealed under the
 * server-side key, or a short reference to the record in the store -- so
 * opening it needs HIPAA_MASTER_KEY or a database, neither of which ever leaves
 * the server. There is no session, no email confirmation step, and no identifier
 * to guess.
 *
 * The reason it is worth having separately from `/spectate/[id]` is that the
 * two answer different questions to different people. The spectate link is
 * given to whoever is running the demo, who wants the two agents talking. This
 * one is for the person whose appointment it is, who wants to know when they
 * are expected and nothing else. The spectate link shows ten fields of the
 * record; this shows four and is designed to survive being forwarded.
 *
 * Nothing about the token is logged, on any path, including the failure path.
 * A token is a bearer credential to an encrypted patient record, so writing one
 * to a log puts the log — and whatever third party is collecting it — one step
 * from a name, a date of birth, and a symptom description.
 *
 * The reference form of the token is a uuid rather than 256 bits of
 * authenticated ciphertext, so it is shorter and it is not tamper-evident; what
 * it gains is that the record is not in the URL at all, and that a link can be
 * withdrawn by deleting what it points at. Enumeration is not the risk either
 * way: it is 122 bits of uuidv4 against a link nobody would guess.
 */

export const metadata: Metadata = {
  title: "Your appointment",
  // A bearer link that a search engine could be handed should not end up in
  // one. The URL is the credential; indexing it is publishing it.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Rendered per request, never cached.
 *
 * The usual Next defaults would let a shared cache keep a page whose URL is
 * the credential. `dynamic` stops the build from prerendering it, `revalidate`
 * stops any router cache from holding it, and the headers stop the browser
 * and any intermediary from storing it.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Two security headers are still missing and belong here.
 *
 *   X-Frame-Options: DENY
 *   Referrer-Policy: no-referrer
 *
 * The page is a link target from an email or a message, it carries nobody's
 * session, and its own URL is the credential to the appointment. Framing it
 * would let another site put it in an iframe over a visitor who has already
 * been shown the details, and a leaked Referer would hand the token to
 * whatever the page ever links to.
 *
 * They are not set here because a `headers()` export from a page or layout is
 * not applied to a dynamically rendered route — verified against a running
 * production build, where neither appeared in the response while the caching
 * headers Next produced did. Response headers for a route need a `headers()`
 * block in `next.config.ts` or a `middleware.ts`, neither of which this work
 * touches. Recorded here rather than left as a silent gap.
 *
 * What is set, and verified on a running build: `Cache-Control: private,
 * no-cache, no-store, max-age=0, must-revalidate` from the two exports above,
 * and `robots: noindex, nofollow, nocache` from the metadata.
 */

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const plaintext = await resolveRecord(token);
  if (!plaintext) {
    // Truncated, tampered, sealed under a different key, or from an older
    // version. Deliberately indistinguishable to the caller, and deliberately
    // not logged: which of the four it was tells an attacker what they got,
    // and the token itself does not belong in a log.
    notFound();
  }

  let record: unknown;
  try {
    record = JSON.parse(plaintext);
  } catch {
    notFound();
  }

  const summary = toTrackSummary(record);
  if (!summary) notFound();

  const when = formatRequestedAt(summary.requestedAt);
  // `toTrackSummary` already accepted this shape, so this cannot be null
  // without a bug; the fallback is here rather than a cast so that one does
  // not become a crash on a patient-facing page.
  const date = when?.date ?? summary.requestedAt;
  const time = when?.time ?? "";
  const clinic = getClinicName();

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:py-16">
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-700">
            {clinic}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Your appointment request
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            Hello {summary.firstName}. This is what we have on file for the request you made.
          </p>
        </header>

        {/*
          The slip. A clinic appointment card, perforated along one edge,
          because that is the artefact this actually is — something torn off a
          pad and handed to you. The status band is punched into the top of it
          rather than floating above it, so the state and the detail are one
          object you can read as a unit.
        */}
        <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-slate-200 bg-teal-50/60 px-6 py-4">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-teal-900">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-teal-600"
              />
              Requested — awaiting the clinic
            </span>
            {/*
              Deliberately no reference number.

              The obvious candidate is the first few characters of the token,
              and it is the wrong one: that is a fragment of a bearer
              credential, in the DOM, in a screenshot, copied by anyone who
              finds it useful. The record has no identifier of its own, and
              inventing one out of the credential is how a page ends up
              publishing it. #42's durable store is what a real reference
              number should come from.
            */}
            <span className="text-xs font-medium uppercase tracking-[0.15em] text-teal-800/70">
              Sent to {clinic}
            </span>
          </div>

          <dl className="divide-y divide-slate-100">
            <Row label="Department">
              <span className="text-lg font-medium">{summary.department}</span>
            </Row>

            <Row label="Date">
              <span className="text-lg font-medium">{date}</span>
            </Row>

            <Row label="Time you asked for">
              <span className="text-lg font-medium tabular-nums">{time}</span>
              <span className="ml-2 text-sm">
                <TimeUntil requestedAt={summary.requestedAt} />
              </span>
            </Row>

            {summary.language && (
              <Row label="Language">
                <span className="text-lg font-medium capitalize">{summary.language}</span>
              </Row>
            )}
          </dl>

          {/* The perforation. Two layers so the notches read as holes rather
              than as a dashed rule, and so they line up with the row edges. */}
          <div
            aria-hidden="true"
            className="h-4 bg-[radial-gradient(circle_at_0.5rem_50%,#e2e8f0_0.3rem,transparent_0.31rem)] bg-[length:1rem_1rem] bg-repeat-x"
          />

          <div className="bg-slate-50 px-6 py-5">
            <p className="text-sm leading-relaxed text-slate-600">
              We have your request. The clinic confirms appointments directly, and the
              confirmation goes to the address you gave us. This page does not change once
              that happens.
            </p>
          </div>
        </article>

        {/*
          Why the list stops here. A person reading a status page wants to know
          what is being held about them, and the honest answer is shorter than
          the record.
        */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-900">
            What this page does not show
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Your date of birth, contact details, insurance, and the description of your
            symptoms are on file with the clinic. None of them are needed to tell you when
            you are expected, and this link is easy to forward by accident, so they stay
            off the page.
          </p>
        </section>

        <footer className="mt-10 border-t border-slate-200 pt-6 text-sm text-slate-500">
          <p className="leading-relaxed">
            Anyone with this link can see the details above. Do not post it somewhere
            public.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/" className="font-medium text-teal-800 underline underline-offset-4 hover:text-teal-900">
              Make a different request
            </Link>
            {/*
              The same sealed token opens the spectate session, which is the
              operator's view of the same record. Offered here because whoever
              holds this link is holding that one; the page is unlisted and
              marked noindex, so it is not a way in.
            */}
            <Link
              href={`/spectate/${token}`}
              className="font-medium text-slate-600 underline underline-offset-4 hover:text-slate-800"
            >
              Open the live call demo
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500 sm:pt-1.5">
        {label}
      </dt>
      <dd className="text-slate-900">{children}</dd>
    </div>
  );
}
