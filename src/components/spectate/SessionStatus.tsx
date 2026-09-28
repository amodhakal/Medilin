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
 * `role="status"` rather than `role="alert"`: a dropped socket is worth saying
 * once, not interrupting for.
 */
export function ConnectionNotice({
  notice,
  onDismiss,
  socket,
}: {
  notice: string;
  onDismiss: () => void;
  socket: { patient: SocketStatus; receptionist: SocketStatus };
}) {
  const down = socket.patient !== "open" ? "patient" : "receptionist";

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-100 flex flex-wrap items-center justify-between gap-3"
    >
      <span>
        {notice} The {down} agent is no longer connected, so anything it says will not reach the
        other side.
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
