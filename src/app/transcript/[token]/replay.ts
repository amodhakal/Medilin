import type { TranscriptSession } from "@/lib/transcript/access";

/**
 * What a transcript replay is allowed to show.
 *
 * Kept apart from the page, and free of `server-only` and of any Next import, so
 * it can be unit tested -- the same arrangement as `../track/[token]/summary.ts`,
 * and for the same reason: this is the security boundary of the page, and a
 * boundary enforced only by which fields a component happens to reach for is not
 * a boundary.
 *
 * A transcript link is the token from the tracking page, in a URL that gets
 * forwarded, screenshotted and opened on shared machines. So the page shows the
 * conversation -- which is the whole point, and is unavoidably PHI -- and beside
 * it only the facts the tracking page already shows: the state of the booking,
 * the department, the language of the call, and when it happened.
 *
 * Not rendered here, deliberately, even though the page has the whole record:
 *
 *   name, date of birth, contact details    strong identifiers, and none of them
 *                                          is needed to read a conversation
 *   intake notes                            the patient's own written description
 *                                          of their symptoms. The transcript is
 *                                          the same information in the agents'
 *                                          words; the written version adds
 *                                          nothing a reader needs and is one
 *                                          more thing to leak.
 *
 * The timestamps are rendered as UTC and labelled as UTC. This is a server
 * component, so anything else would be formatted in the timezone of whichever
 * instance rendered it, and a replay of a clinic call would have lines out of
 * order for half the world.
 */

export interface ReplayEntry {
  /** Stable key for the list, and the line's position in the conversation. */
  seq: number;
  speaker: "Patient" | "Receptionist";
  /** Machine-readable, for the `<time>` element. */
  at: string;
  /** What a reader sees: `HH:MM:SS`, UTC. */
  clock: string;
  text: string;
  /** True when the agent's stream stopped and the line was closed unfinished. */
  interrupted: boolean;
}

export interface ReplayView {
  /** The appointment this is. Identifies a record; opens nothing. */
  reference: string;
  status: string;
  department: string;
  language: string;
  /** When the appointment was requested, which is when the call was about. */
  calledAt: string;
  lineCount: number;
  entries: ReplayEntry[];
}

/**
 * A ceiling on one line of the page.
 *
 * The store bounds a line at `MAX_TRANSCRIPT_TEXT_LENGTH`; this is a rendering
 * bound on top of it, and it exists because a single utterance that somehow
 * reached four thousand characters should not be able to make the page unusable.
 */
export const MAX_REPLAY_TEXT_LENGTH = 2_000;

/**
 * Narrow a session to what this page renders.
 *
 * An explicit allowlist rather than a cast, for the reason the spectate page
 * does it: the session carries the whole patient record, and the caller must not
 * be able to reach a field this module never intended to expose.
 *
 * Null means "this is not a session", which the page treats exactly as it treats
 * a token it cannot resolve -- so a malformed record produces a 404 rather than
 * a page that renders.
 */
export function toReplayView(session: TranscriptSession | null | undefined): ReplayView | null {
  if (!session || typeof session !== "object") return null;

  const { appointment, lines } = session;
  if (!appointment || typeof appointment !== "object") return null;
  if (!Array.isArray(lines)) return null;

  return {
    reference: text(appointment.id, 64),
    status: text(appointment.status, 32),
    department: text(appointment.patientInfo?.medical_department, 100),
    language: text(appointment.patientInfo?.language, 32),
    calledAt: isoOf(appointment.createdAt),
    lineCount: lines.length,
    entries: lines
      .filter(isLine)
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((line) => ({
        seq: line.seq,
        speaker: line.role === "receptionist" ? "Receptionist" : "Patient",
        at: isoOf(line.at),
        clock: line.at.toISOString().slice(11, 19),
        text: line.text.slice(0, MAX_REPLAY_TEXT_LENGTH),
        interrupted: !line.finalized,
      })),
  };
}

function isLine(value: unknown): value is TranscriptSession["lines"][number] {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Partial<TranscriptSession["lines"][number]>;
  return (
    typeof line.seq === "number" &&
    Number.isInteger(line.seq) &&
    (line.role === "patient" || line.role === "receptionist") &&
    typeof line.text === "string" &&
    line.at instanceof Date &&
    !Number.isNaN(line.at.getTime()) &&
    typeof line.finalized === "boolean"
  );
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** An ISO timestamp, or an empty string rather than an `Invalid Date` in the markup. */
function isoOf(value: unknown): string {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : "";
}
