import type { AgentSide } from "@/hooks/useAgentRelay";

/**
 * Which lines of a live call still have to be written down.
 *
 * The relay's transcript is the only witness to a booking call, and it lives in
 * a client component, so the browser is the thing that has to send it to the
 * server. This module is that decision and nothing else -- no fetch, no timers,
 * no React -- because "when is a line worth sending" is the part with the subtle
 * answers, and the answers are worth pinning down away from a socket.
 *
 * Three of those answers are load-bearing.
 *
 * **Only finished lines.** A voice agent streams an utterance as a run of
 * partial frames and then one final one, and the relay revises the entry in
 * place until it is complete. Sending every partial would put "how how how are
 * you are are are you" into a patient's medical record. A line is offered once
 * the relay has finished it, and the store's keying by position means a client
 * that does re-send a draft corrects the line rather than duplicating it.
 *
 * **The order of the call, not the order the render saw them finish.** A long
 * utterance from one agent can finalise after a short one from the other, so the
 * order the browser notices them in is not the order they were said. The batch
 * goes out in the relay's own entry order, which is also what the store orders
 * by, so the two agree even when the writes interleave.
 *
 * **A truncated batch is a prefix.** A call longer than the endpoint's batch
 * ceiling sends its beginning first and the rest on the next flush, because the
 * next flush recomputes from what is still unsent. Dropping the tail instead
 * would lose the booking, which is the one part of a call anybody wants.
 */

/**
 * The largest batch the endpoint accepts. Mirrors `MAX_BATCH` in
 * `src/app/api/transcript/route.ts`; the server is the authority and this is the
 * client not making it a 400 on every flush.
 */
export const MAX_TRANSCRIPT_BATCH = 200;

/** One line, in the shape the endpoint's schema wants. */
export interface PendingTranscriptLine {
  seq: number;
  role: AgentSide;
  text: string;
  at: number;
}

export interface RelayTranscriptEntry {
  id: number;
  role: AgentSide;
  text: string;
  at: number;
  finalized: boolean;
}

/**
 * The lines to send now.
 *
 * `alreadySent` is the caller's own record of what the store has acknowledged.
 * Lines that were sent are never offered again, so a call that re-renders on
 * every frame does not re-send its transcript on every frame.
 */
export function pendingTranscriptLines(
  entries: readonly RelayTranscriptEntry[],
  alreadySent: ReadonlySet<number>,
): PendingTranscriptLine[] {
  const pending: PendingTranscriptLine[] = [];

  for (const entry of entries) {
    if (!entry.finalized) continue;
    if (alreadySent.has(entry.id)) continue;

    const text = entry.text.trim();
    // A voice agent sends an empty `agent_response` for a breath, and an empty
    // line is a hole where a sentence was.
    if (text === "") continue;

    pending.push({ seq: entry.id, role: entry.role, text: entry.text, at: entry.at });
  }

  // Sorted rather than taken in the order they arrive, so the guarantee above
  // does not depend on the relay happening to append in order. A call has tens of
  // lines, so the sort costs nothing measurable and it is the difference between
  // "the batch is in call order" being true and being true by accident.
  pending.sort((a, b) => a.seq - b.seq);

  // A prefix, so a call longer than the ceiling sends its beginning first and the
  // rest on the next flush rather than losing the part anybody wants.
  return pending.slice(0, MAX_TRANSCRIPT_BATCH);
}
