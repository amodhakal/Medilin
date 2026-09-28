import type { AgentSide, SocketStatus } from "@/hooks/useAgentRelay";
import { Waveform } from "./Waveform";

/**
 * One agent, as a card.
 *
 * The two cards were near-identical inline blocks about seventy lines each,
 * which is why the height bug in the waveform existed twice and why fixing it
 * meant finding it twice. The differences between them are a colour, a glyph,
 * two strings, and an idle hint, so those are the props and everything else
 * lives here once.
 */

interface Accent {
  /** Card background and border while this side holds the floor. */
  card: string;
  icon: string;
  iconBorder: string;
  badge: string;
  speakingText: string;
  currentText: string;
  wave: string;
}

const ACCENT: Record<AgentSide, Accent> = {
  patient: {
    card: "bg-cyan-950/30 border-cyan-500/60 shadow-xl shadow-cyan-500/10",
    icon: "🤖",
    iconBorder: "bg-cyan-500/10 border-cyan-500/30",
    badge: "bg-cyan-500/20 text-cyan-300",
    speakingText: "text-cyan-100",
    currentText: "text-cyan-100",
    wave: "bg-cyan-400",
  },
  receptionist: {
    card: "bg-blue-950/30 border-blue-500/60 shadow-xl shadow-blue-500/10",
    icon: "🏥",
    iconBorder: "bg-blue-500/10 border-blue-500/30",
    badge: "bg-blue-500/20 text-blue-300",
    speakingText: "text-blue-100",
    currentText: "text-blue-100",
    wave: "bg-blue-400",
  },
};

/** A short, honest word for a socket the operator is watching. */
const STATUS_TEXT: Record<SocketStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting",
  open: "Connected",
  closed: "Disconnected",
  failed: "Connection failed",
};

const STATUS_CLASS: Record<SocketStatus, string> = {
  idle: "bg-slate-800 text-slate-400 border-slate-700",
  connecting: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  open: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  closed: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  failed: "bg-red-500/10 text-red-300 border-red-500/20",
};

const STATUS_DOT: Record<SocketStatus, string> = {
  idle: "bg-slate-500",
  connecting: "bg-sky-400 animate-pulse",
  open: "bg-emerald-400",
  closed: "bg-amber-400",
  failed: "bg-red-400",
};

export interface AgentCardProps {
  side: AgentSide;
  title: string;
  subtitle: string;
  status: SocketStatus;
  speaking: boolean;
  currentText: string;
  /** Shown in place of a line, once a line is not there. */
  idleHint: string;
}

export function AgentCard({
  side,
  title,
  subtitle,
  status,
  speaking,
  currentText,
  idleHint,
}: AgentCardProps) {
  const accent = ACCENT[side];

  return (
    <div
      className={`rounded-2xl p-6 transition-all duration-300 backdrop-blur-xl border ${
        speaking ? accent.card : "bg-slate-900/60 border-slate-800"
      }`}
    >
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-12 h-12 shrink-0 rounded-xl border flex items-center justify-center text-2xl shadow-inner ${accent.iconBorder}`}
          >
            {accent.icon}
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-lg text-white truncate">{title}</h3>
            <p className="text-xs text-slate-400 truncate">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${STATUS_CLASS[status]}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status]}`} />
            {STATUS_TEXT[status]}
          </span>
          {speaking && (
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium animate-pulse ${accent.badge}`}
            >
              Speaking
            </span>
          )}
        </div>
      </div>

      <div className="min-h-[100px] bg-slate-950/50 rounded-xl p-4 border border-slate-800/80 flex flex-col justify-center">
        {currentText ? (
          <p className={`text-base leading-relaxed ${accent.currentText}`}>{currentText}</p>
        ) : (
          <p className="text-slate-600 italic text-sm text-center">{idleHint}</p>
        )}
      </div>

      {speaking && <Waveform barClassName={accent.wave} />}
    </div>
  );
}
