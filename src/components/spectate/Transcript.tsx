"use client";

import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@/hooks/useAgentRelay";

/**
 * The running transcript.
 *
 * Auto-scroll moved in here with the markup, and onto a ref rather than
 * `document.getElementById`. The id had to match a string literal in a
 * different file, so renaming either side silently broke the scroll with no
 * error anywhere.
 *
 * Expandable, because a 288px window with its own scrollbar is unreadable
 * once a call gets going, and the operator's job during a spectate demo is to
 * read what was said. The expanded panel takes over the viewport rather than
 * pushing the page down, so the two agent cards stay visible above it.
 */
export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [entries]);

  // Escape leaves the expanded panel, because a full-viewport overlay that
  // can only be left by finding a button in it is a trap for the keyboard.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const heading = (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
        Conversation transcript
      </h2>
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500 tabular-nums">
          {entries.length} {entries.length === 1 ? "line" : "lines"}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-1.5 transition-colors cursor-pointer"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
    </div>
  );

  const body = (
    <div
      ref={scrollerRef}
      className={
        expanded
          ? "space-y-4 overflow-y-auto pr-2"
          : "space-y-4 max-h-72 overflow-y-auto pr-2"
      }
      // A live region, so a screen reader hears the call rather than only
      // finding it when the user goes looking.
      role="log"
      aria-live="polite"
      aria-label="Conversation transcript"
      tabIndex={0}
    >
      {entries.length === 0 ? (
        <p className="text-center py-12 text-slate-600 italic text-sm">
          The conversation appears here once the call starts.
        </p>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            className={`p-4 rounded-xl border transition-all ${
              entry.role === "receptionist"
                ? "bg-blue-950/20 border-blue-500/30 text-blue-100 ml-4 sm:ml-12"
                : "bg-cyan-950/20 border-cyan-500/30 text-cyan-100 mr-4 sm:mr-12"
            }`}
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold tracking-wide uppercase">
                {entry.role === "receptionist"
                  ? "🏥 Hospital Receptionist"
                  : "🤖 Patient Caller Agent"}
              </span>
              <time className="text-[10px] text-slate-500 tabular-nums">
                {new Date(entry.at).toLocaleTimeString()}
              </time>
            </div>
            <p className="text-sm leading-relaxed">
              {entry.text}
              {/* A partial utterance: the agent is still deciding what it is
                  going to say, and this entry will be revised in place rather
                  than replaced by a new one. */}
              {!entry.finalized && (
                <span className="ml-1 text-slate-400" aria-label="still speaking">
                  …
                </span>
              )}
            </p>
          </div>
        ))
      )}
    </div>
  );

  if (expanded) {
    return (
      <section className="fixed inset-0 z-50 flex flex-col bg-[#070a12]">
        <div className="max-w-5xl mx-auto w-full flex-1 flex flex-col px-6 py-8">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">
              Conversation transcript
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500 tabular-nums">
                {entries.length} {entries.length === 1 ? "line" : "lines"}
              </span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-1.5 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">{body}</div>
        </div>
      </section>
    );
  }

  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-xl mb-8 flex-1 flex flex-col">
      {heading}
      {body}
    </section>
  );
}
