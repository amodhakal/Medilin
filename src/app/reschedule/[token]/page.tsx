import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClinicName } from "@/config";
import { MIN_LEAD_MS, SLOT_MINUTES } from "@/app/api/_lib/schedule";
import { openActionToken } from "@/lib/action-token";
import { getAppointment } from "@/lib/appointments";
import { AUDIT_ACTORS } from "@/lib/audit";
import { formatRequestedAt } from "@/app/track/[token]/summary";
import { ActionPanel } from "./ActionPanel";
import { isManageable, toManageSummary } from "./manage";

/**
 * The page a patient reschedules or cancels on (#59).
 *
 * It exists because nothing did. There was a booking form and a tracking page, and
 * between them a patient who could not make the time they had asked for had
 * nothing but a telephone. The route is new rather than a tab on /track/[token]
 * because the two have different blast radii: the tracking link is a *read* that
 * must keep working forever, because it is in everybody's inbox already, and this
 * one is a *write* that is single-use and expires. Putting a cancel button on the
 * tracking page would make the most widely forwarded link in the system the most
 * powerful one in it.
 *
 * **The page does not spend the link.** Rendering shows the appointment; acting on
 * it posts to /api/appointment-actions, and that is where the grant is claimed.
 * A page that spent its own token on render would burn the patient's link the
 * moment they looked at it, so opening an email twice would cancel their ability
 * to use it at all -- and search-engine prefetch, a mail client, or a `Referer`
 * leak would be enough to do it for them.
 *
 * So the page reads through `getAppointment` with the `link-bearer` actor, exactly
 * as the tracking page does, and shows the result only when the token names a real
 * appointment in a state a patient can still change. What the link may *do* is
 * decided later, by the store, on the request that acts.
 *
 * That means a link that has been spent, or withdrawn by a cancellation, still
 * renders this page -- and shows the appointment, and shows the form, which will
 * then be refused. The alternative is to make the page spend the grant to find
 * out, which is the bug above. So the honest thing is to say plainly, in the form
 * itself, that each link works once.
 *
 * Nothing about the token is logged, on any path, including the failure path. A
 * token is a working credential for changing or cancelling an appointment, so one
 * in a log puts the log -- and whatever third party collects it -- one step from
 * being able to cancel somebody's clinic booking.
 */

export const metadata: Metadata = {
  title: "Change your appointment",
  // The URL is the credential here, more than anywhere else in the app: this is
  // the link that can cancel. A search engine that is handed one should not end up
  // keeping it.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Rendered per request, never cached, for the reason /track does.
 *
 * The usual Next defaults would let a shared cache keep a page whose URL is the
 * credential, and after a reschedule that page's content is wrong anyway: it is a
 * snapshot of a time that has moved.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ReschedulePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Opened here only to find out *which* appointment to show. Opening a token is
  // not a claim on it, and the claims -- expiry, capability, and whether it has
  // been spent -- are made by the store on the request that acts.
  const claims = openActionToken(token);
  if (!claims) notFound();

  const appointment = await getAppointment(claims.appointmentId, AUDIT_ACTORS.linkBearer);
  if (!appointment) notFound();

  const summary = toManageSummary(appointment);
  if (!summary) notFound();

  const when = formatRequestedAt(summary.appointmentDateTime);
  const clinic = getClinicName();
  const manageable = isManageable(summary.status);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 antialiased">
      <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:py-16">
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-700">
            {clinic}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            {summary.firstName}&rsquo;s appointment
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            You can move this to a different time, or cancel it. Both take effect straight
            away and we will email {summary.firstName} to say so.
          </p>
        </header>

        <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-slate-200 bg-teal-50/60 px-6 py-4">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-teal-900">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-teal-600" />
              {summary.status === "cancelled"
                ? "Cancelled"
                : summary.status === "completed"
                  ? "Seen"
                  : "Booked"}
            </span>
            <span className="text-xs font-medium uppercase tracking-[0.15em] text-teal-800/70">
              {summary.department}
            </span>
          </div>

          <dl className="divide-y divide-slate-100">
            <div className="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-[11rem_1fr] sm:gap-4">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500 sm:pt-1.5">
                Currently
              </dt>
              <dd className="text-slate-900">
                <span className="text-lg font-medium">{when?.date ?? summary.appointmentDateTime}</span>
                {when?.time && (
                  <span className="ml-2 text-lg font-medium tabular-nums">{when.time}</span>
                )}
              </dd>
            </div>
          </dl>

          {/*
            The form, or the reason there is not one.

            The terminal states still get a real page rather than a redirect: a
            patient who cancelled three weeks ago and clicked a link from an old
            email should be told what happened, not sent somewhere that looks like
            a mistake.
          */}
          {manageable ? (
            <ActionPanel
              token={token}
              clinicName={clinic}
              currentSlot={summary.appointmentDateTime}
              minLeadMs={MIN_LEAD_MS}
              stepMinutes={SLOT_MINUTES}
            />
          ) : (
            <div className="bg-slate-50 px-6 py-5">
              <p className="text-sm leading-relaxed text-slate-600">
                This appointment is {summary.status === "cancelled" ? "cancelled" : "already over"},
                so there is nothing to change. If that is not what you expected, please telephone
                the clinic.
              </p>
            </div>
          )}
        </article>

        {/*
          The same list of omissions as the tracking page, and for the same reason
          plus one: this page's URL can change or cancel the appointment, so it is
          the link most likely to be passed around by someone who has no idea what
          it is.
        */}
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-sm font-semibold text-slate-900">What this page does not show</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Your date of birth, contact details, insurance, and the description of your symptoms
            are on file with the clinic. None of them are needed to change a time, and this link
            can cancel your appointment, so it is worth keeping to yourself rather than forwarding.
          </p>
        </section>

        <footer className="mt-10 border-t border-slate-200 pt-6 text-sm leading-relaxed text-slate-500">
          <p>
            Each of these links works once. After you move or cancel, we email you a new one, so
            you are never left without a way to reach your appointment.
          </p>
          <p className="mt-4">
            Anyone holding this link can change or cancel this appointment. Do not post it
            somewhere public.
          </p>
        </footer>
      </div>
    </main>
  );
}
