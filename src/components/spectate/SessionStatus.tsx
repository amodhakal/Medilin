import type { RelayPhase, SocketStatus } from "@/hooks/useAgentRelay";

/**
 * The header badge, and the banner for a session that is up but not whole.
 *
 * The two sockets connect independently, so one badge claiming
 * "Live Session Active" for the pair was a statement the page could not
 * support. It now reports the session phase, and each card reports its own
 * socket underneath.
 */

type BadgeTone = "live" | "degraded" | "ended" | "ready";

function toneFor(phase: RelayPhase): BadgeTone {
  if (phase === "live") return "live";
  if (phase === "degraded") return "degraded";
  if (phase === "stopped") return "ended";
  return "ready";
}

const TONE_CLASS: Record<BadgeTone, string> = {
  live: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  degraded: "bg-amber-500/10 text-amber-300 border border-amber-500/20",
  ended: "bg-slate-800 text-slate-300 border border-slate-700",
  ready: "bg-slate-800 text-slate-400 border border-slate-700",
};

const DOT_CLASS: Record<BadgeTone, string> = {
  live: "bg-emerald-400 animate-pulse",
  degraded: "bg-amber-400",
  ended: "bg-slate-400",
  ready: "bg-slate-500",
};

const LABEL: Record<BadgeTone, string> = {
  live: "Live session",
  degraded: "Connection lost",
  ended: "Call ended",
  ready: "Ready to connect",
};

export function SessionBadge({ phase }: { phase: RelayPhase }) {
  const tone = toneFor(phase);
  return (
    <span
      className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold ${TONE_CLASS[tone]}`}
    >
      <span className={`w-2 h-2 rounded-full ${DOT_CLASS[tone]}`} />
      {LABEL[tone]}
    </span>
  );
}

/**
 * A non-blocking notice, with the one action that makes sense.
 *
 * `role="status"` rather than `role="alert"`: a dropped socket or a lost turn
 * is worth saying once, not interrupting for.
 *
 * Two quite different failures arrive here and are worded differently, because
 * the operator's next move is different. A dropped socket means half the call
 * is gone and the session should end. A dropped turn means one line was lost
 * and the call carries on, which is worth knowing but is not an emergency —
 * conflating the two would train the reader to ignore this banner.
 */
export function SessionNotice({
  notice,
  stalled,
  socket,
  onDismiss,
}: {
  notice: string;
  /** True when a turn was lost but the call is still going. */
  stalled: boolean;
  socket: { patient: SocketStatus; receptionist: SocketStatus };
  onDismiss: () => void;
}) {
  if (stalled) {
    return (
      <div
        role="status"
        className="mb-6 rounded-2xl border border-slate-700 bg-slate-900/70 px-5 py-3.5 text-sm text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        <span className="text-slate-500" aria-hidden="true">
          ⟳
        </span>
        <span>{notice}</span>
      </div>
    );
  }

  const down = socket.patient !== "open" ? "patient caller" : "receptionist";

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-100 flex flex-wrap items-center justify-between gap-3"
    >
      <span>
        {notice} Nothing the {down} agent says will reach the other side from here.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-lg bg-amber-400/90 hover:bg-amber-300 text-slate-950 text-xs font-semibold px-4 py-2 transition-colors cursor-pointer"
      >
        End call
      </button>
    </div>
  );
}
