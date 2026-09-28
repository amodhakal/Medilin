"use client";

import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "@/hooks/useAgentRelay";

/**
 * The running transcript.
 *
 * Auto-scroll moved in here with the markup, and onto a ref rather than
 * `document.getElementById`. The id had to match a string literal in a
 * different file, so renaming either side silently broke the scroll with no
 * error anywhere.
 */
export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [entries]);

  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 backdrop-blur-xl mb-8 flex-1 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
          Real-time Conversation Transcript
        </h2>
        <span className="text-xs text-slate-500 tabular-nums">
          {entries.length} {entries.length === 1 ? "line" : "lines"} exchanged
        </span>
      </div>

      <div
        ref={scrollerRef}
        className="space-y-4 max-h-72 overflow-y-auto pr-2"
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
                  {entry.role === "receptionist" ? "🏥 Hospital Receptionist" : "🤖 Patient Caller Agent"}
                </span>
                <time className="text-[10px] text-slate-500 tabular-nums">
                  {new Date(entry.at).toLocaleTimeString()}
                </time>
              </div>
              <p className="text-sm leading-relaxed">{entry.text}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
