"use client";

import { useSyncExternalStore } from "react";

/**
 * The low-bandwidth mode.
 *
 * A patient booking an appointment is often on a phone, on a prepaid plan, in
 * a clinic's waiting room with one bar of signal, or on a metered connection
 * where the operating system has told the browser to be careful. None of that
 * is visible to this app, and none of it is something a person in a waiting
 * room is going to go and find a setting for.
 *
 * So the mode has two ways in. The browser's own network hints turn it on
 * without being asked, and the patient can turn it on or off themselves if the
 * browser guessed wrong. An explicit choice is remembered and always wins over
 * the guess, because a hint that says "2g" once should not lock a fast
 * connection into a degraded page forever.
 *
 * What it changes is a `data-bandwidth` attribute on the document element and
 * a stylesheet that keys off it. The alternative -- a `lowBandwidth` prop
 * threaded through every component -- would mean every element that renders a
 * shadow or a transition has to know about a network condition, which is a
 * coupling in the wrong direction.
 *
 * This lives in src/i18n because that is where the files this work is allowed
 * to touch live. It is not a translation concern and it should move to
 * something like src/components/ or src/lib/display/ on its own.
 */

export type BandwidthPreference = "low" | "full";

/** The attribute value, and the value stored in localStorage. */
export const BANDWIDTH_ATTRIBUTE = "bandwidth";
export const BANDWIDTH_STORAGE_KEY = "medilin.bandwidth";

/** Internal event, so the toggle and the document attribute stay in step. */
const BANDWIDTH_EVENT = "medilin:bandwidth";

/**
 * What the browser will tell us about the connection, if anything.
 *
 * The Network Information API is Chromium-only and its shape has changed
 * across versions, so this is read defensively and typed as the subset this
 * app understands. Everywhere else `navigator.connection` is undefined and
 * the mode is whatever the patient last chose.
 */
export interface NetworkHints {
  /** The user or the OS asked the browser to reduce data use. */
  saveData?: boolean;
  /** "slow-2g" | "2g" | "3g" | "4g" on the versions that report it. */
  effectiveType?: string;
  /** Present on the Chromium implementation of the Network Information API. */
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

export function readNetworkHints(): NetworkHints {
  if (typeof navigator === "undefined") return {};

  const connection = (navigator as Navigator & { connection?: NetworkHints })
    .connection;

  return connection ?? {};
}

/**
 * Whether to start in the reduced mode.
 *
 * `stored` is the patient's own choice and outranks everything. Otherwise the
 * browser's hints decide, and only for the two connection classes where
 * shipping the web font and a stack of shadows is genuinely the wrong call.
 * "3g" is left alone: it is a label the browser assigns, and treating it as
 * broken would put half the audience in a mode they did not ask for.
 */
export function shouldReduceData(
  hints: NetworkHints,
  stored: BandwidthPreference | null,
): BandwidthPreference {
  if (stored === "low" || stored === "full") return stored;

  if (hints.saveData === true) return "low";
  if (hints.effectiveType === "slow-2g" || hints.effectiveType === "2g") return "low";

  return "full";
}

/** A stored preference, or null if there is not a readable one. */
export function readStoredPreference(): BandwidthPreference | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(BANDWIDTH_STORAGE_KEY);
    return stored === "low" || stored === "full" ? stored : null;
  } catch {
    // Private browsing in some browsers throws on localStorage access. A
    // preference that cannot be remembered is still a preference that works for
    // this page view.
    return null;
  }
}

function applyPreference(preference: BandwidthPreference): void {
  document.documentElement.setAttribute(
    "data-bandwidth",
    preference === "low" ? "low" : "full",
  );
  // Tell the toggle. Two components read the preference -- the one that
  // applies it and the one the patient presses -- and a document event is
  // cheaper and less fragile than lifting the state to the layout.
  window.dispatchEvent(new Event(BANDWIDTH_EVENT));
}

/**
 * The current preference, read fresh on every call.
 *
 * Read rather than remembered: the network can change under us, a tab can be
 * shared, and the value is a string, so there is no referential identity to
 * keep stable for `useSyncExternalStore`.
 */
function currentPreference(): BandwidthPreference {
  return shouldReduceData(readNetworkHints(), readStoredPreference());
}

function subscribeToPreference(onChange: () => void): () => void {
  const hints = readNetworkHints();

  window.addEventListener(BANDWIDTH_EVENT, onChange);
  // The connection can be upgraded mid-visit -- someone walks out of a stairwell
  // -- and the mode should follow it out of "low" on its own.
  hints.addEventListener?.("change", onChange);

  return () => {
    window.removeEventListener(BANDWIDTH_EVENT, onChange);
    hints.removeEventListener?.("change", onChange);
  };
}

/** The server has no connection and no localStorage. */
function preferenceOnServer(): null {
  return null;
}

/**
 * Applies the preference to the document.
 *
 * Mounted once in the root layout and renders nothing. It has to be a client
 * component and it has to run after hydration, which means the attribute lands
 * a frame late: there is one paint of the full-fat page. The alternative is an
 * inline script in the document head, and that is `dangerouslySetInnerHTML`,
 * which is not a trade this app makes for a frame of shadow. The parts that
 * matter for a motion-sensitive or low-vision patient -- `prefers-reduced-motion`,
 * `prefers-contrast` and `forced-colors` -- are pure media queries and apply
 * from the first paint with no JavaScript at all.
 */
export function DisplayPreferences() {
  const preference = useSyncExternalStore(
    subscribeToPreference,
    currentPreference,
    preferenceOnServer,
  );

  // The store is the source of truth for the attribute. Writing it during
  // render is the one thing that has to happen on the client and cannot happen
  // in an effect, because the effect would be a second, lagging copy. Null is
  // the server's answer and there is nothing to apply before hydration.
  if (preference !== null && typeof document !== "undefined") {
    applyPreference(preference);
  }

  return null;
}

/**
 * The patient's own control.
 *
 * One label, and the state in `aria-pressed`. A button whose text changes
 * between "Reduce data use" and "Data use reduced" is announcing a different
 * action each time it is read out, which is a toggle described as a pair of
 * buttons. The dot is the same information again, for anyone who cannot hear
 * `aria-pressed`.
 */
export function LowBandwidthToggle({ label }: { label: string }) {
  const preference = useSyncExternalStore(
    subscribeToPreference,
    currentPreference,
    preferenceOnServer,
  );

  const reduced = preference === "low";

  // Before hydration there is no preference to report, and rendering the "off"
  // state would be a lie for a patient on a metered connection.
  if (preference === null) return null;

  return (
    <button
      type="button"
      onClick={() => {
        const next: BandwidthPreference = reduced ? "full" : "low";
        try {
          window.localStorage.setItem(BANDWIDTH_STORAGE_KEY, next);
        } catch {
          // See readStoredPreference: unrememberable is not unusable.
        }
        applyPreference(next);
      }}
      aria-pressed={reduced}
      className="inline-flex items-center gap-2 text-xs font-semibold text-accent hover:text-accent-strong transition-colors tap-target"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 w-3.5 rounded-full border-2 ${
          reduced ? "bg-accent border-accent" : "bg-transparent border-rule-strong"
        }`}
      />
      {label}
    </button>
  );
}
