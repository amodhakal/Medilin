import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/auth/cron";
import { logError, logInfo } from "@/lib/logger";
import { runReminderPass } from "@/lib/reminders";

/**
 * The reminder job (#67).
 *
 * There was no vercel.json, no route under /api/cron, and no reader for
 * `CRON_SECRET` -- a variable that has been declared in src/lib/env.ts and
 * commented "Authenticates scheduled jobs hitting /api/cron/*" since before
 * either of those things existed. So the schedule is this file, the guard is
 * src/lib/auth/cron, and the policy is src/lib/reminders; this is the HTTP shape
 * around all three and contains no decisions of its own.
 *
 * **GET, because that is what a cron request is.** Vercel calls the path in
 * vercel.json with a GET and, when `CRON_SECRET` is configured, an
 * `Authorization: Bearer $CRON_SECRET` header. There is no POST variant and no
 * body: a body a platform will not send is a body that will always be empty, and
 * code that reads one is code that has never run.
 *
 * **Guarded, and guarded on the platform's credential.** The endpoint is on the
 * public internet and it sends email to real patients in bulk, so an unauthenticated
 * caller would be a mail relay pointed at the appointment list. An unset
 * `CRON_SECRET` refuses every caller rather than admitting every caller; that
 * decision is in ./lib/auth/cron and it is the reason this route can be deployed
 * without the variable set without becoming an incident.
 *
 * Status codes, and they are about the job rather than about the request:
 *
 *   200  the pass ran. `failed` may be non-zero -- some reminders bounced, which
 *        is normal and is not the job's problem -- and the body says how many.
 *   401  no usable credential. Nothing was read and nothing was sent.
 *   500  the store was unreachable, so nothing was found and nothing was sent.
 *        Not 200: a run that examined nothing and reported success is worse than
 *        one that failed loudly, because the platform will not retry it.
 *
 * The body carries counts and a window name. No appointment, no email address, no
 * time -- a scheduler's request log is retained by the platform and read by
 * whoever has access to the project.
 */

export async function GET(request: Request) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;

  try {
    const summary = await runReminderPass();

    logInfo("cron.reminders_completed", {
      window: summary.window,
      count: summary.sent,
      failed: summary.failed,
    });

    return NextResponse.json({ success: true, ...summary });
  } catch (error) {
    // The durable store is down, so the pass found nothing and sent nothing. The
    // counts are not reported, because there are none: a caller that reads `sent: 0`
    // as "there was nobody to remind" instead of "we could not look" is exactly
    // the failure this status code exists to prevent.
    logError("cron.reminders_failed", error);

    return NextResponse.json(
      { success: false, error: "The reminder pass could not run" },
      { status: 500 },
    );
  }
}

/**
 * Refused rather than executed.
 *
 * A cross-origin form cannot set `Authorization`, so a browser cannot reach this
 * handler -- but a `POST` is not what a cron request is, and answering it with the
 * job's results would be a second way to trigger a bulk send on a method no
 * scheduler uses. 405 rather than 404: the URL exists, and pretending otherwise
 * would only make a misconfigured schedule harder to diagnose.
 */
export async function POST() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
