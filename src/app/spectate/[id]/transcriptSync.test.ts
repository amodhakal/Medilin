import { describe, expect, test } from "bun:test";
import { MAX_TRANSCRIPT_BATCH, pendingTranscriptLines } from "./transcriptSync";

/**
 * Which lines of a live call still have to be written down.
 *
 * The relay's transcript is the only witness to a booking call, and it lives in a
 * client component, so the browser has to be the thing that sends it to the
 * server. This module is that decision and nothing else -- no fetch, no timers,
 * no React -- because "when is a line worth sending" is the part with the subtle
 * answers, and the answers are worth pinning down away from a socket.
 */

function entry(overrides: Partial<{ id: number; role: "patient" | "receptionist"; text: string; at: number; finalized: boolean }> = {}) {
  return {
    id: 0,
    role: "patient" as const,
    text: "My left eye has been painful since Tuesday.",
    at: 1_757_000_000_000,
    finalized: true,
    ...overrides,
  };
}

describe("pendingTranscriptLines", () => {
  test("offers the lines that have finished and have not been sent", () => {
    expect(pendingTranscriptLines([entry()], new Set())).toEqual([
      { seq: 0, role: "patient", text: "My left eye has been painful since Tuesday.", at: 1_757_000_000_000 },
    ]);
  });

  test("offers nothing twice", () => {
    // The obvious failure: a call that gets re-rendered, and every line is sent
    // again on every frame. The store would collapse the duplicates -- a line is
    // keyed by its position -- but the request is still the wrong answer.
    const sent = new Set([0, 1]);

    expect(pendingTranscriptLines([entry(), entry({ id: 1 })], sent)).toEqual([]);
  });

  test("does not offer a line the agent is still speaking", () => {
    // A partial frame is a draft of a sentence, and a transcript that stored
    // every partial would replay a call as "how how how are you are are are
    // you". A line is offered once the relay has finished it.
    expect(pendingTranscriptLines([entry({ finalized: false })], new Set())).toEqual([]);
  });

  test("offers a line that was sent as a draft once it is finished", () => {
    // Which is the whole of the streaming case from this side: the draft was
    // never sent, so there is nothing to correct, and the finished line is a new
    // line at the same position.
    const pending = pendingTranscriptLines([entry({ id: 3, finalized: true })], new Set([3]));

    expect(pending).toEqual([]);
  });

  test("keeps the order of the call rather than the order the render saw them finish", () => {
    // A long utterance from one agent can finalise after a short one from the
    // other, so the order the browser notices them in is not the order they were
    // said. The position is the relay's own entry id and it is what the store
    // orders by, so the batch goes out in that order.
    const pending = pendingTranscriptLines(
      [entry({ id: 2 }), entry({ id: 0 }), entry({ id: 1 })],
      new Set(),
    );

    expect(pending.map((line) => line.seq)).toEqual([0, 1, 2]);
  });

  test("never sends a batch bigger than the endpoint will take", () => {
    const many = Array.from({ length: 300 }, (_unused, id) => entry({ id }));

    expect(pendingTranscriptLines(many, new Set())).toHaveLength(MAX_TRANSCRIPT_BATCH);
  });

  test("sends the oldest lines first when it has to cut a batch short", () => {
    // A truncated batch has to be a prefix of the call, or a long call would
    // lose its beginning to a ceiling. The rest goes out on the next flush,
    // because the next flush recomputes from what is still unsent.
    const many = Array.from({ length: 300 }, (_unused, id) => entry({ id }));

    const pending = pendingTranscriptLines(many, new Set());

    expect(pending[0].seq).toBe(0);
    expect(pending[pending.length - 1].seq).toBe(MAX_TRANSCRIPT_BATCH - 1);
  });

  test("has nothing to say about a call that has not started", () => {
    expect(pendingTranscriptLines([], new Set())).toEqual([]);
  });

  test("keeps the timestamp the relay recorded, not the moment of the request", () => {
    // A line is worth 400ms of skew and not a second of it: the number the relay
    // stamped is when the sentence was finished, and re-deriving it here would
    // make a replay's timestamps depend on the network.
    const at = 1_757_000_123_456;

    expect(pendingTranscriptLines([entry({ at })], new Set())[0].at).toBe(at);
  });

  test("skips a line with nothing in it rather than sending an empty one", () => {
    // A voice agent sends an empty `agent_response` for a breath, and an empty
    // line in a transcript is a hole where a sentence was.
    expect(pendingTranscriptLines([entry({ text: "" })], new Set())).toEqual([]);
    expect(pendingTranscriptLines([entry({ text: "   " })], new Set())).toEqual([]);
  });
});
