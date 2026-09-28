import type { RelayPhase } from "@/hooks/useAgentRelay";

/**
 * The one control that matters on this page.
 *
 * What it offers depends entirely on the phase, and getting that wrong is
 * user-visible: while `connecting` there is nothing useful to press, and after
 * a `degraded` session the only honest action is to end the call, because the
 * surviving socket is talking to a room nobody is listening to.
 */
export function CallControls({
  phase,
  onStart,
  onStop,
}: {
  phase: RelayPhase;
  onStart: () => void;
  onStop: () => void;
}) {
  if (phase === "connecting") {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className="bg-slate-800 text-slate-400 font-bold px-10 py-4 rounded-2xl text-base flex items-center gap-3 cursor-progress"
      >
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        Connecting the two agents
      </button>
    );
  }

  if (phase === "live" || phase === "degraded") {
    return (
      <button
        type="button"
        onClick={onStop}
        className="bg-red-600 hover:bg-red-500 text-white font-bold px-10 py-4 rounded-2xl shadow-xl shadow-red-600/25 transition-all duration-300 cursor-pointer text-base flex items-center gap-2"
      >
        <span aria-hidden="true">🛑</span> End call
      </button>
    );
  }

  if (phase === "stopped") return null;

  return (
    <button
      type="button"
      onClick={onStart}
      className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold px-10 py-4 rounded-2xl shadow-xl shadow-cyan-500/25 transition-all duration-300 cursor-pointer text-base flex items-center gap-3"
    >
      <span className="text-xl" aria-hidden="true">
        🎙️
      </span>
      Start the call
    </button>
  );
}
