"use client";

import { useSyncExternalStore } from "react";
import { timeUntilDescription } from "./summary";

/**
 * "in about 3 hours", rendered in the browser.
 *
 * Split out of the server component for one reason: it needs a clock, and the
 * only clock that can interpret a zoneless wall-clock time correctly is the
 * viewer's. The server has no idea which zone the patient picked nine thirty
 * in, and guessing is how a status page ends up telling someone their
 * appointment is tomorrow.
 *
 * Read through `useSyncExternalStore` rather than `useEffect` plus
 * `setState`, for the reason the rest of this app does: no cascading render on
 * mount, and no hydration mismatch. The server snapshot is null, so the
 * server-rendered HTML simply has no countdown in it; the real one appears
 * immediately after hydration, and the space is reserved so nothing shifts.
 */
export function TimeUntil({ requestedAt }: { requestedAt: string }) {
  const description = useSyncExternalStore(
    subscribeToNothing,
    () => timeUntilDescription(requestedAt, new Date()),
    () => null
  );

  if (!description) return <span className="text-slate-400">&nbsp;</span>;

  return (
    <span
      className={
        description.imminent
          ? "font-semibold text-amber-700"
          : "font-medium text-emerald-700"
      }
    >
      {description.text}
    </span>
  );
}

function subscribeToNothing() {
  return () => {};
}
