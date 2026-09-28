"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * The link to this session, in the page.
 *
 * The workflow this replaces: start a call, then open devtools and copy the
 * URL out of the address bar by hand, to send to whoever asked for the demo.
 * That was the only way to get at it, and the README recommended it.
 *
 * Two things this deliberately does not do.
 *
 * It does not log the URL. The route segment is a sealed record, so the link
 * is a bearer credential to the patient's appointment: anyone who opens it
 * sees the decrypted record on a server that holds the key. It is worth
 * copying deliberately, and not worth writing to a log drain that a third
 * party may be reading.
 *
 * It reads its own `location.href` and nothing else. The page does not parse
 * the URL for patient data — the record arrives as a prop from the server
 * component, which is the whole point of the sealed token. Reading its own
 * address is not the same operation, and there is nothing in this component
 * that could be pointed at a different URL by a link.
 */
/**
 * Nothing to subscribe to: the address does not change under us without a
 * navigation, which unmounts the page anyway.
 */
const noopSubscribe = () => () => {};

export function SessionLink() {
  /**
   * Read through `useSyncExternalStore` rather than setting state from an
   * effect.
   *
   * `location` does not exist during the server render, so the naive version
   * — `useEffect` plus `setHref` — renders nothing on the server, renders the
   * link on the first client pass, and costs an extra render every mount. This
   * reads it as the external value it is: the server snapshot is the empty
   * string, and React swaps in the real address once hydration is done.
   */
  const href = useSyncExternalStore(
    noopSubscribe,
    () => window.location.href,
    () => ""
  );

  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied("done");
    } catch {
      // A clipboard permission prompt, an insecure origin, or a browser with
      // no clipboard at all. The full URL is on screen either way, so it can
      // still be selected by hand; say that rather than failing silently.
      setCopied("failed");
    }
  }, [href]);

  // Server render and first hydration pass. The link appears immediately
  // after, with no layout shift to speak of and no extra render.
  if (!href) return null;

  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs uppercase tracking-wider font-semibold text-cyan-400">
          This session&rsquo;s link
        </h2>
        <span className="text-[11px] text-slate-500">
          Anyone with this link can open the appointment behind this call.
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-400">
          {href}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 text-xs font-semibold px-4 py-2 transition-colors cursor-pointer"
        >
          {copied === "done"
            ? "Copied"
            : copied === "failed"
            ? "Copy failed — select it above"
            : "Copy link"}
        </button>
      </div>
    </section>
  );
}
