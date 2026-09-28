"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { earliestSelectableSlot } from "./manage";

/**
 * The reschedule and cancel controls (#59).
 *
 * A client component because it posts to an endpoint and then has to say what
 * happened -- and because the outcome is a *change to a record*, so a plain form
 * submission and a full page reload would be the wrong shape for it. It must be
 * able to distinguish four results and say something true about each: the clinic
 * moved the time, the clinic moved it but the email did not go out, the link is
 * spent, and the appointment is no longer active.
 *
 * Two things it deliberately does not do.
 *
 * It does not send the token in the URL. It is in the request *body*, because a
 * token in a path lands in the access log of every proxy between here and the
 * patient, in the browser history, and in the `Referer` of anything the response
 * ever links to. The page's own URL cannot avoid it -- a page has nowhere else to
 * put one -- which is why the copy on this page tells the patient not to forward
 * it.
 *
 * It does not report a failed email as a failed change. The appointment has moved
 * and the record is durable; the email is a courtesy copy of it. Telling a patient
 * "that did not work" when it did is how they book a second appointment on top of
 * the first, and the clinic ends up with two.
 *
 * It cannot undo anything either. There is no confirmation step in front of
 * cancel, and that is a judgement worth arguing about: an extra click on the
 * *irreversible* action and not on the reversible one is deliberate, but the
 * counter-argument -- that a mis-clicked cancel on a shared machine is a lost
 * appointment -- is a real one. The link is single-use, so a mis-click is not
 * undoable through this page at all.
 */

interface Props {
  token: string;
  clinicName: string;
  /** The slot on the record now, pre-selected so the common case is one click. */
  currentSlot: string;
  /** The clinic's minimum notice, which the form uses as the input's floor. */
  minLeadMs: number;
  stepMinutes: number;
}

type State =
  | { phase: "idle" }
  | { phase: "working"; action: "reschedule" | "cancel" }
  | {
      phase: "done";
      action: "reschedule" | "cancel";
      /** What the clinic agreed, not what was asked for. */
      appointmentDateTime: string | null;
      /** Root-relative, from the response. Null after a cancel, or on failure. */
      nextPath: string | null;
      confirmationEmailSent: boolean;
    }
  | { phase: "refused"; message: string };

const ENDPOINT = "/api/appointment-actions";

export function ActionPanel({
  token,
  clinicName,
  currentSlot,
  minLeadMs,
  stepMinutes,
}: Props) {
  const router = useRouter();
  const [slot, setSlot] = useState(currentSlot);
  const [state, setState] = useState<State>({ phase: "idle" });
  const [confirmedCancel, setConfirmedCancel] = useState(false);

  // Read once, in the browser, rather than during the server render.
  //
  // The server render and the browser disagree about what time it is by however
  // long the response took, and only the browser's clock is the patient's own --
  // the same argument TimeUntil makes on the tracking page for the same reason.
  // `useState`'s initialiser runs once per mount, so this is not a clock read
  // during render, and it is not re-read when the component re-renders. The input
  // carries `suppressHydrationWarning` because the server had no honest value to
  // put there and the attribute is corrected immediately after hydration.
  const [earliestSlot] = useState(() => earliestSelectableSlot(Date.now(), minLeadMs));

  const working = state.phase === "working";

  async function send(action: "reschedule" | "cancel") {
    setState({ phase: "working", action });

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "reschedule"
            ? { token, action, appointmentDateTime: slot }
            : { token, action },
        ),
      });

      const body = (await response.json()) as {
        success: boolean;
        error?: string;
        appointmentDateTime?: string;
        nextPath?: string | null;
        confirmationEmailSent?: boolean;
      };

      if (!response.ok || !body.success) {
        setState({
          phase: "refused",
          // The server's own words when it gave any. A 502 has none, and inventing
          // one here would be a message this component made up about a failure it
          // knows nothing about.
          message: body.error ?? "We could not make that change. Please try again.",
        });
        return;
      }

      setState({
        phase: "done",
        action,
        appointmentDateTime: body.appointmentDateTime ?? null,
        nextPath: body.nextPath ?? null,
        confirmationEmailSent: body.confirmationEmailSent === true,
      });
    } catch {
      setState({
        phase: "refused",
        message: "We could not reach the clinic. Check your connection and try again.",
      });
    }
  }

  /*
   * The success panel. The replacement link is followed rather than shown: the
   * patient arrived here to do one thing, and handing them a URL to copy is a worse
   * version of what they just did. If there is no replacement -- a cancel, or a
   * store that could not mint one -- they stay on a page that says what happened,
   * which is the only thing left that is true.
   */
  if (state.phase === "done") {
    if (state.action === "reschedule" && state.nextPath) {
      return (
        <div className="bg-teal-50/60 px-6 py-5">
          <p className="text-sm leading-relaxed text-teal-900">
            Moved. {clinicName} will see you at the new time
            {state.appointmentDateTime ? ` (${state.appointmentDateTime.replace("T", " ")})` : ""}.
            {!state.confirmationEmailSent &&
              " We could not send the confirmation email, so please note the new time here."}
          </p>
          <button
            type="button"
            onClick={() => router.push(state.nextPath!)}
            className="mt-4 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800"
          >
            Continue
          </button>
        </div>
      );
    }

    return (
      <div className="bg-teal-50/60 px-6 py-5">
        <p className="text-sm leading-relaxed text-teal-900">
          {state.action === "cancel"
            ? `Cancelled. ${clinicName} has been told, and there is nothing further to do.`
            : "Done."}
          {!state.confirmationEmailSent && " We could not send the confirmation email."}
        </p>
      </div>
    );
  }

  if (state.phase === "refused") {
    return (
      <div className="bg-amber-50 px-6 py-5">
        <p className="text-sm leading-relaxed text-amber-900">{state.message}</p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-4 rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100"
        >
          Check the appointment again
        </button>
      </div>
    );
  }

  return (
    <div className="bg-slate-50 px-6 py-5">
      <label className="block text-sm font-semibold text-slate-900" htmlFor="slot">
        Ask for a different time
      </label>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">
        Pick a slot and we will confirm the nearest one we can. {clinicName} will always move you
        later, never earlier.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          id="slot"
          type="datetime-local"
          value={slot}
          min={earliestSlot}
          step={stepMinutes * 60}
          disabled={working}
          suppressHydrationWarning
          onChange={(event) => setSlot(event.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
        />
        <button
          type="button"
          disabled={working || slot === ""}
          onClick={() => send("reschedule")}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60"
        >
          {working && state.action === "reschedule" ? "Moving…" : "Move it"}
        </button>
      </div>

      {/* The destructive half. Hidden behind a second click, and the second click
          is the only confirmation there is -- there is nothing to undo once the
          grant is spent and every other link to this appointment is withdrawn. */}
      <div className="mt-8 border-t border-slate-200 pt-6">
        {!confirmedCancel ? (
          <button
            type="button"
            disabled={working}
            onClick={() => setConfirmedCancel(true)}
            className="text-sm font-semibold text-red-700 underline underline-offset-4 hover:text-red-800 disabled:opacity-60"
          >
            Cancel this appointment instead
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-slate-700">
              This cannot be undone from here, and every other link to this appointment will stop
              working. You will be able to make a new request afterwards.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={working}
                onClick={() => send("cancel")}
                className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-800 disabled:opacity-60"
              >
                {working && state.action === "cancel" ? "Cancelling…" : "Yes, cancel it"}
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() => setConfirmedCancel(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
