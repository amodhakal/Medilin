"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { clientLog } from "@/lib/logger/client";

/**
 * The agent↔agent relay, extracted out of the page component.
 *
 * The page used to be one 560-line component holding two raw WebSockets, the
 * transcript, the turn-taking flags, every timer, and the whole call to action
 * in the same `useState` list. Nothing about that could be tested, because
 * testing any of it meant a DOM, a real `WebSocket`, and a real elevenlabs
 * account.
 *
 * So the relay lives here as a plain class with no React in it, and
 * `useAgentRelay` is a thin subscription over the top. The class takes its
 * socket factory and its clock as constructor options, so the whole state
 * machine runs in `bun test` with a plain object standing in for a socket and
 * a hand-advanced clock standing in for `setTimeout`. See
 * `useAgentRelay.test.ts`.
 *
 * Deliberately not fixed here: the two agent ids arrive as props from the
 * server component and are read from configuration there (#15 moves the
 * sockets server-side). What stays is that this module is the only place that
 * knows the vendor URL, which is the part that is worth testing.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Which of the two agents a piece of state belongs to. */
export type AgentSide = "patient" | "receptionist";

/**
 * Per-socket state.
 *
 * The two sockets connect independently, so a single `isConnected` boolean is
 * a claim the page could not support: it went true when both `open` events
 * had fired and stayed true when one of them had closed.
 */
export type SocketStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "failed";

/**
 * Session-level state.
 *
 * `degraded` exists because "live" is not the only interesting thing that can
 * be true of two independent sockets. It means the session started and then
 * one side died, which is neither a clean failure to connect nor a live call.
 */
export type RelayPhase =
  | "idle"
  | "connecting"
  | "live"
  | "degraded"
  | "stopped"
  | "failed";

export interface TranscriptEntry {
  id: number;
  role: AgentSide;
  text: string;
  /**
   * Epoch milliseconds rather than a `Date`.
   *
   * A `Date` is a mutable object in a store that other code holds references
   * into, and a transcript is data, not a view. Numbers also make the entry
   * trivially serializable if the session ever needs to be handed somewhere
   * that is not this object graph.
   */
  at: number;
  /**
   * False while the agent is still streaming this line.
   *
   * A voice agent sends an utterance as a run of partial frames followed by
   * one final. Rendering every partial as its own turn produced a transcript
   * that duplicated and interleaved itself, so a partial now revises the entry
   * it belongs to and only a final, or a silence long enough to mean one is
   * never coming, closes it.
   */
  finalized: boolean;
}

export type PerSide<T> = Record<AgentSide, T>;

export interface RelayState {
  phase: RelayPhase;
  /** Set when the page should show a blocking failure. */
  error: string | null;
  /** Set when the session is up but something dropped. */
  notice: string | null;
  transcript: TranscriptEntry[];
  speaking: PerSide<boolean>;
  currentText: PerSide<string>;
  socket: PerSide<SocketStatus>;
  /** The side currently speaking, or null when neither is. */
  floor: AgentSide | null;
  /**
   * The side a line was handed to and which has not answered yet.
   *
   * This is the whole of the turn state that used to be two booleans. The
   * difference is that it is cleared by a timer as well as by a response, so
   * there is no path through the machine where a line was sent and nothing
   * ever clears the record of it.
   */
  awaiting: AgentSide | null;
  /** Set when a handoff timed out, i.e. the relay had to give up on a turn. */
  stalled: boolean;
}

/**
 * The slice of `WebSocket` the relay touches.
 *
 * Structural on purpose: the real `WebSocket` satisfies it without an adapter,
 * and a test can hand in a plain object. `readyState` is compared against the
 * numeric constants below rather than `WebSocket.OPEN` so that nothing in
 * this module reads the `WebSocket` global, which is what lets the machine run
 * under a runtime that has no sockets at all.
 */
export type RelaySocket = Pick<
  WebSocket,
  "send" | "close" | "readyState" | "onopen" | "onmessage" | "onerror" | "onclose"
>;

/** Injectable timers, so tests control time instead of waiting for it. */
export interface RelayClock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export type RelayLog = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/* `WebSocket.readyState`, spelled out. */
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long a finished line stays on the card before it is handed to the other
 * agent. Long enough to read, short enough that a demo does not stall.
 */
export const DEFAULT_HOLD_MS = 2_500;

/** How long after `open` the opening `contextual_update` goes out. */
export const DEFAULT_CONTEXT_DELAY_MS = 500;

/**
 * How long to wait for a streamed utterance before treating the silence as
 * the end of it.
 *
 * A voice agent streams an utterance as partial frames and then one final
 * frame. The final is not guaranteed: if it is lost, the partials that came
 * before it are still the best account of what was said. Holding the turn open
 * indefinitely waiting for a frame that will not arrive is the deadlock this
 * whole state machine exists to remove, so silence closes the turn.
 */
export const DEFAULT_STREAM_IDLE_MS = 2_000;

/**
 * How long a relayed line waits for the agent it was addressed to.
 *
 * This is the guarantee the old two-boolean scheme could not make. A line was
 * sent, a flag was set, and the flag was cleared only by a matching response
 * — so one lost frame, one refused tool call, or one agent that simply ended
 * its turn left the relay permanently deaf to that side.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;

/** How often a line that could not be sent is retried. */
export const DEFAULT_SEND_RETRY_MS = 1_500;

/**
 * How long a line keeps trying to reach a socket that is not open, before the
 * relay gives up and says so.
 *
 * Bounded on purpose. The alternative — retrying forever — is a spinner that
 * never resolves and a transcript that silently stops growing.
 */
export const DEFAULT_SEND_GIVE_UP_MS = 30_000;

/**
 * Window in which a byte-identical back-to-back line counts as a retransmit.
 *
 * A partial frame that is immediately followed by a final carrying the same
 * text is handled structurally, by the streaming state, and does not need
 * this. What is left is a final frame arriving twice for one utterance,
 * which the vendor does and which used to print the line twice. The window is
 * short and the comparison requires nothing at all in between, so the cost of
 * being wrong is a genuinely repeated sentence read twice in a row.
 */
export const DEFAULT_DEDUPE_WINDOW_MS = 2_000;

/**
 * Backoff before each automatic reconnect attempt, then give up.
 *
 * `open` at the first entry, so a socket that dropped the instant it opened is
 * retried immediately. The tail is bounded: a vendor that is refusing
 * connections should be told so, not hammered, and a demo that has silently
 * been retrying for ten minutes is worse than one that says it is broken.
 */
export const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

/** How many finished transcript lines a reconnected agent is re-told. */
export const RESUME_CONTEXT_LINES = 4;

/**
 * Ceiling on the `pong` delay.
 *
 * `ping_ms` arrives from the network. Passed straight to a timer, a value of
 * 2^31 never fires and a negative one fires immediately, so both the
 * keepalive and the liveness of the socket are at the mercy of the far end.
 */
export const MAX_PING_DELAY_MS = 10_000;

export function otherSide(side: AgentSide): AgentSide {
  return side === "patient" ? "receptionist" : "patient";
}

export function initialRelayState(): RelayState {
  return {
    phase: "idle",
    error: null,
    notice: null,
    transcript: [],
    speaking: { patient: false, receptionist: false },
    currentText: { patient: "", receptionist: "" },
    socket: { patient: "idle", receptionist: "idle" },
    floor: null,
    awaiting: null,
    stalled: false,
  };
}

const realClock: RelayClock = {
  // Casts, because `@types/node` and `lib.dom` both declare a global
  // `setTimeout` and the two disagree on the handle type. `RelayClock` is
  // specified in DOM terms on purpose, so that a test can pass numbers without
  // caring what a Node timer handle looks like.
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

const defaultLog: RelayLog = (level, message, fields) => {
  clientLog(level, message, fields);
};

/**
 * Parse one frame off the vendor socket.
 *
 * `JSON.parse` used to run bare in the message handler. A malformed frame
 * throws inside an event handler, where neither the socket nor React catches
 * it, so a single bad frame from the far end killed the relay with no log
 * line and no other symptom.
 */
function parseFrame(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), MAX_PING_DELAY_MS);
}

/**
 * The vendor conversation endpoint.
 *
 * Kept as a literal because the browser has to open it directly today. The
 * agent ids are configuration and are passed in; they are not in this string.
 * Relocating the sockets server-side is #15 and is out of scope here.
 */
function conversationUrl(agentId: string): string {
  return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;
}

/* -------------------------------------------------------------------------- */
/* The machine                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * All of it optional.
 *
 * The four identity fields are optional because a machine is constructed
 * before it has any configuration, and deliberately so: see the note on
 * `useAgentRelay`. A missing agent id is reported as a failed connect at
 * `start` rather than being papered over with a placeholder, because
 * connecting to `agent_id=` is a request that either fails confusingly at the
 * vendor or, worse, is not obviously not the configured agent.
 */
export interface AgentRelayConfig {
  patientAgentId?: string;
  receptionistAgentId?: string;
  /** Sent to the patient agent to open the call. May contain PHI. */
  patientOpeningContext?: string;
  /** Sent to the receptionist agent to open the call. */
  receptionistOpeningContext?: string;
  /** Merged into the patient socket's conversation init payload. */
  patientDynamicVariables?: Record<string, unknown>;
  createSocket?: (url: string) => RelaySocket;
  clock?: RelayClock;
  connectTimeoutMs?: number;
  holdMs?: number;
  contextDelayMs?: number;
  streamIdleMs?: number;
  responseTimeoutMs?: number;
  sendRetryMs?: number;
  sendGiveUpMs?: number;
  dedupeWindowMs?: number;
  log?: RelayLog;
  /** Injected for deterministic timestamps in tests. */
  now?: () => number;
}

/**
 * Two voice agents relaying to each other.
 *
 * Not a React component, and deliberately so: everything here is either a
 * field on `state` or a side effect on a socket or a clock, both of which can
 * be faked. `useAgentRelay` below is the only part that knows about hooks.
 */
export class AgentRelay {
  private config: AgentRelayConfig;
  private pendingConfig: Partial<AgentRelayConfig> = {};
  private readonly createSocket: (url: string) => RelaySocket;
  private readonly clock: RelayClock;
  private readonly log: RelayLog;
  private readonly now: () => number;

  private state: RelayState = initialRelayState();
  private readonly listeners = new Set<(state: RelayState) => void>();

  private readonly sockets: PerSide<RelaySocket | null> = {
    patient: null,
    receptionist: null,
  };

  /**
   * Every outstanding timer handle.
   *
   * A Set rather than one handle, because several are in flight at once: a
   * `pong`, a `contextual_update`, a per-side connect timeout, and a hold for
   * each side. Any of them outliving `stop` or `dispose` calls `send` on a
   * socket that is closing.
   */
  private readonly timers = new Set<number>();
  private readonly connectTimers: Partial<PerSide<number>> = {};
  private readonly reconnectTimers: Partial<PerSide<number>> = {};
  private readonly reconnectAttempt: PerSide<number> = { patient: 0, receptionist: 0 };

  /**
   * Whether a side has connected at least once this session.
   *
   * Distinguishes a first connection from a re-open, which is the difference
   * between sending the agent its opening brief and telling it the call is
   * already under way.
   */
  private readonly connectedBefore: PerSide<boolean> = { patient: false, receptionist: false };

  /**
   * Set while we are closing a socket we have already given up on.
   *
   * Closing a socket that is still CONNECTING makes the browser fire `error`
   * and `close` for it. Without this, abandoning a slow reconnect attempt
   * would be reported as a failed connection, and `fail` tears down the whole
   * session — so giving up on one attempt would end the call.
   */
  private readonly abandoning: PerSide<boolean> = { patient: false, receptionist: false };
  private readonly holdTimers: Partial<PerSide<number>> = {};
  private readonly streamTimers: Partial<PerSide<number>> = {};
  private responseTimer: number | null = null;

  /**
   * Per-socket handshake bookkeeping.
   *
   * `settled` is whether the connect attempt has concluded, `opened` is
   * whether the socket ever reached `open`. They answer different questions
   * and conflating them is what used to make the failure path unreachable: an
   * `error` arriving after `open` cannot reject an already-fulfilled promise,
   * and an `error` arriving before it is a connect failure, not a warning.
   */
  private readonly settled: PerSide<boolean> = { patient: false, receptionist: false };
  private readonly opened: PerSide<boolean> = { patient: false, receptionist: false };

  /**
   * The turn.
   *
   * One object rather than the pair of booleans this replaced. The booleans
   * (`waitingForAResponseRef` / `waitingForBResponseRef`) were set optimistically
   * when a line went out and cleared only by the matching response, so a single
   * frame the relay did not get left the flag set and the relay deaf to that
   * side for the rest of the session. Nothing in the design could clear it.
   *
   * `awaiting` is the side a line was handed to, `text` is the line itself, and
   * there is always a timer that clears it: the response timeout. A turn can
   * therefore be lost, but it cannot be lost *silently or permanently*, which
   * is the whole difference.
   */
  private awaiting: { to: AgentSide; text: string } | null = null;

  /**
   * A line that has not yet reached the socket it was addressed to.
   *
   * Kept rather than dropped. The old `sendMessageToAgent` checked
   * `readyState === OPEN` and returned quietly if it was not, and the caller
   * had already marked its turn as handed off, so the line vanished and the
   * relay sat waiting for a reply to a message that was never sent.
   */
  private outbox: { to: AgentSide; text: string; since: number } | null = null;

  /** The utterance each side is currently streaming, as a transcript id. */
  private readonly streaming: PerSide<number | null> = {
    patient: null,
    receptionist: null,
  };

  /** The most recent finalized line per side, for retransmit suppression. */
  private readonly lastFinal: PerSide<{ id: number; text: string; at: number } | null> = {
    patient: null,
    receptionist: null,
  };

  /** The most recent utterance per side, held for the handoff after the hold. */
  private readonly committed: PerSide<{ text: string } | null> = {
    patient: null,
    receptionist: null,
  };

  private nextEntryId = 0;
  private disposed = false;
  /** Set while this machine is closing sockets on purpose. */
  private stopping = false;

  /**
   * Build a machine. This must stay free of side effects.
   *
   * Verified, not assumed — see `constructing a relay touches nothing` in
   * `useAgentRelay.test.ts`, and the comment on `useAgentRelay` for why it
   * matters under the React Compiler.
   */
  constructor(config: AgentRelayConfig = {}) {
    this.config = config;
    this.createSocket = config.createSocket ?? ((url) => new WebSocket(url) as RelaySocket);
    this.clock = config.clock ?? realClock;
    this.log = config.log ?? defaultLog;
    this.now = config.now ?? (() => Date.now());
  }

  /* ------------------------------ observation ---------------------------- */

  /**
   * Replace the configuration.
   *
   * Applied on the next `start`, never mid-call: the opening contexts and the
   * agent ids are baked into an in-flight conversation, and swapping them
   * halfway through would change who the two agents think they are talking to.
   * A reconfigure during a live session is therefore recorded and ignored
   * until the session ends.
   */
  reconfigure(config: Partial<AgentRelayConfig>): void {
    this.pendingConfig = { ...this.pendingConfig, ...config };
  }

  /** Fold in anything `reconfigure` was given since the last `start`. */
  private commitConfig(): void {
    if (Object.keys(this.pendingConfig).length === 0) return;
    this.config = { ...this.config, ...this.pendingConfig };
    this.pendingConfig = {};
  }

  getState(): RelayState {
    return this.state;
  }

  subscribe(listener: (state: RelayState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------- lifecycle ----------------------------- */

  /**
   * Open both sockets.
   *
   * Concurrent rather than sequential. The page used to `await` the patient
   * socket and only then build the receptionist one, while the patient socket
   * had already been told to open the call; every line the patient agent
   * produced in that window was relayed into a socket that did not exist yet
   * and dropped on the floor by the `readyState` check.
   */
  start(): void {
    if (this.disposed) return;
    if (this.state.phase === "connecting" || this.state.phase === "live") return;

    this.stopping = false;
    this.commitConfig();
    this.clearTimers();
    this.resetTurn();
    this.patch({
      phase: "connecting",
      error: null,
      notice: null,
      speaking: { patient: false, receptionist: false },
      currentText: { patient: "", receptionist: "" },
      floor: null,
      awaiting: null,
      stalled: false,
    });

    // Checked up front, so a missing configuration is one stated failure
    // rather than whichever side happened to be opened last overwriting the
    // other's message.
    for (const side of ["patient", "receptionist"] as const) {
      if (!this.agentIdFor(side)) {
        this.fail(side, `No ${label(side)} agent is configured.`);
        return;
      }
    }

    this.connectedBefore.patient = false;
    this.connectedBefore.receptionist = false;
    this.reconnectAttempt.patient = 0;
    this.reconnectAttempt.receptionist = 0;

    this.openSide("patient");
    this.openSide("receptionist");
  }

  /**
   * Re-open one side's socket.
   *
   * The transcript is deliberately left alone. It is the only record of the
   * call, and a dropped connection is not a reason to throw it away — but it
   * does mean the vendor's conversation on that side is new, so
   * `resumeContext` tells the agent what was already said.
   */
  reconnect(side: AgentSide): void {
    if (this.disposed || this.stopping) return;
    this.clearReconnectTimer(side);
    this.reconnectAttempt[side] = 0;
    this.patch({
      error: null,
      notice: null,
      socket: { ...this.state.socket, [side]: "connecting" },
    });
    this.openSide(side);
  }

  /** Re-open whichever sides are not up. */
  reconnectAll(): void {
    for (const side of ["patient", "receptionist"] as const) {
      if (this.state.socket[side] !== "open") this.reconnect(side);
    }
  }

  /** End the call deliberately. */
  stop(): void {
    if (this.disposed) return;
    this.stopping = true;
    this.clearTimers();
    this.resetTurn();
    this.closeSockets();
    this.patch({
      phase: "stopped",
      error: null,
      notice: null,
      speaking: { patient: false, receptionist: false },
      currentText: { patient: "", receptionist: "" },
      socket: { patient: "closed", receptionist: "closed" },
      floor: null,
      awaiting: null,
      stalled: false,
    });
  }

  /**
   * Unmount. Closes sockets and drops every timer.
   *
   * There was no equivalent in the page, so leaving a live call leaked both
   * sockets and left the relay running against them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopping = true;
    this.clearTimers();
    this.resetTurn();
    this.closeSockets();
    this.listeners.clear();
  }

  /* -------------------------------- sockets ------------------------------ */

  /**
   * Try this side again, on a bounded backoff.
   *
   * Automatic, because the common case is a laptop lid closing and a demo that
   * needs a person to notice and press a button. Bounded, because a vendor
   * that is refusing connections should be reported rather than retried
   * forever; the last attempt leaves the card saying it gave up, and the
   * operator can still press Reconnect by hand.
   */
  private scheduleReconnect(side: AgentSide): void {
    const attempt = this.reconnectAttempt[side];
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      this.log("warn", "spectate.reconnect_exhausted", { resource: resourceFor(side) });
      this.patch({
        socket: { ...this.state.socket, [side]: "failed" },
        notice: `Could not reconnect the ${label(side)} agent.`,
      });
      return;
    }

    const delay = RECONNECT_DELAYS_MS[attempt] ?? 0;
    this.reconnectAttempt[side] = attempt + 1;
    this.patch({ socket: { ...this.state.socket, [side]: "reconnecting" } });

    this.reconnectTimers[side] = this.schedule(() => {
      delete this.reconnectTimers[side];
      if (this.disposed || this.stopping) return;
      this.openSide(side);
    }, delay);
  }

  /**
   * Close a socket we are done with, and swallow the events it fires doing it.
   *
   * `close` on a CONNECTING socket produces `error` and `close`, both of which
   * the handlers below would otherwise read as a real failure.
   */
  private abandonAttempt(side: AgentSide, socket: RelaySocket): void {
    this.abandoning[side] = true;
    this.sockets[side] = null;
    socket.close();
    this.abandoning[side] = false;
  }

  private clearReconnectTimer(side: AgentSide): void {
    const handle = this.reconnectTimers[side];
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    delete this.reconnectTimers[side];
  }

  private agentIdFor(side: AgentSide): string | undefined {
    return side === "patient" ? this.config.patientAgentId : this.config.receptionistAgentId;
  }

  private openSide(side: AgentSide): void {
    // Checked in `start` as well. Belt and braces: an id that vanished between
    // the preflight and here would otherwise open a socket against nothing.
    const agentId = this.agentIdFor(side);
    if (!agentId) {
      this.fail(side, `No ${label(side)} agent is configured.`);
      return;
    }

    const socket = this.createSocket(conversationUrl(agentId));
    this.sockets[side] = socket;
    this.settled[side] = false;
    this.opened[side] = false;
    this.patch({
      socket: {
        ...this.state.socket,
        [side]: this.connectedBefore[side] ? "reconnecting" : "connecting",
      },
    });

    this.attach(side, socket);

    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      delete this.connectTimers[side];
      this.log("warn", "spectate.agent_open_timeout", { resource: resourceFor(side) });
      this.abandonAttempt(side, socket);
      if (this.connectedBefore[side]) {
        // A re-open that never opened is a failed attempt, not a failed call.
        // The session carries on and the backoff gets another go.
        this.patch({ socket: { ...this.state.socket, [side]: "closed" } });
        this.scheduleReconnect(side);
        return;
      }
      this.fail(side, `The ${label(side)} agent took too long to connect.`);
    }, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    this.timers.add(handle);
    this.connectTimers[side] = handle;
  }

  private attach(side: AgentSide, socket: RelaySocket): void {
    socket.onopen = () => {
      this.markOpen(side, socket);
    };

    socket.onmessage = (event) => {
      this.handleFrame(side, event.data);
    };

    socket.onerror = () => {
      // A WebSocket `error` event carries no detail in any engine and is not
      // an `Error`, so there is nothing honest to put in the log. Which side
      // of `open` it landed on is the useful part.
      if (this.abandoning[side]) return;
      if (this.opened[side]) {
        this.log("warn", "spectate.agent_socket_error", { resource: resourceFor(side) });
        return;
      }
      this.log("error", "spectate.websocket_error", { resource: resourceFor(side) });
      this.fail(side, `Could not reach the ${label(side)} agent.`);
    };

    socket.onclose = (event) => {
      if (this.abandoning[side]) return;
      if (!this.opened[side]) {
        this.fail(
          side,
          `The ${label(side)} agent closed before it connected (code ${event.code}).`
        );
        return;
      }

      this.patch({
        speaking: { ...this.state.speaking, [side]: false },
        socket: { ...this.state.socket, [side]: "closed" },
        floor: this.state.floor === side ? null : this.state.floor,
      });

      // `close` fires `onclose` whether we ended it or the peer did, and the
      // event does not say which. Without this flag, pressing Stop reported a
      // dropped connection on the way out.
      if (this.stopping || this.disposed) return;

      this.log("warn", "spectate.agent_disconnected", {
        resource: resourceFor(side),
        statusCode: event.code,
      });

      if (this.state.phase === "live" || this.state.phase === "degraded") {
        this.patch({
          phase: "degraded",
          notice: `The ${label(side)} agent's connection dropped.`,
        });
        this.requeueUnanswered(side);
        this.scheduleReconnect(side);
      } else {
        this.patch({ socket: { ...this.state.socket, [side]: "closed" } });
      }
    };
  }

  private markOpen(side: AgentSide, socket: RelaySocket): void {
    this.opened[side] = true;
    this.settled[side] = true;
    this.clearConnectTimer(side);

    if (this.disposed) {
      // Disposed between construction and `open`. Nothing to talk to.
      socket.close();
      return;
    }

    const resumed = this.connectedBefore[side];
    this.connectedBefore[side] = true;
    this.reconnectAttempt[side] = 0;
    this.clearReconnectTimer(side);

    this.log(
      "info",
      resumed ? "spectate.agent_reconnected" : "spectate.agent_connected",
      { resource: resourceFor(side) }
    );
    this.patch({ socket: { ...this.state.socket, [side]: "open" } });

    const init: Record<string, unknown> = {
      type: "conversation_initiation_client_data",
    };
    if (side === "patient" && this.config.patientDynamicVariables) {
      init.dynamic_variables = this.config.patientDynamicVariables;
    }
    socket.send(JSON.stringify(init));

    if (this.isLive()) {
      this.patch({ phase: "live", error: null, notice: null });
    }
  }

  /**
   * A side failed to connect, before it was ever usable.
   *
   * Failing one side fails the session: the two agents are a conversation, and
   * a live socket relaying into a dead one just loses lines. Both sockets are
   * closed, because a half-open one is a session the page no longer believes
   * in but the vendor still bills.
   */
  private fail(side: AgentSide, reason: string): void {
    if (this.settled[side] && this.state.phase === "failed") return;
    this.settled[side] = true;
    this.clearConnectTimer(side);

    if (this.disposed) return;

    this.log("error", "spectate.agent_connect_failed", { resource: resourceFor(side) });
    this.closeSockets();
    this.patch({
      phase: "failed",
      error: reason,
      notice: null,
      speaking: { patient: false, receptionist: false },
      currentText: { patient: "", receptionist: "" },
      socket: {
        patient: side === "patient" ? "failed" : "closed",
        receptionist: side === "receptionist" ? "failed" : "closed",
      },
      floor: null,
    });
  }

  private closeSockets(): void {
    this.stopping = true;
    const live = [this.sockets.patient, this.sockets.receptionist];
    this.sockets.patient = null;
    this.sockets.receptionist = null;
    for (const socket of live) socket?.close();
  }

  private isLive(): boolean {
    return (
      this.state.socket.patient === "open" && this.state.socket.receptionist === "open"
    );
  }

  /* --------------------------------- frames ------------------------------ */

  private handleFrame(side: AgentSide, raw: unknown): void {
    if (this.disposed) return;

    const frame = parseFrame(raw);
    if (!frame) {
      this.log("warn", "spectate.unparseable_frame", { resource: resourceFor(side) });
      return;
    }

    switch (frame.type) {
      case "conversation_initiation_client_data": {
        // A fresh vendor conversation on this socket. The first one gets the
        // agent's brief; a re-open gets the conversation so far, because
        // otherwise the agent opens with its greeting again and the operator
        // is watching a booking call restart halfway through.
        const context = this.contextFor(side);
        const delay = this.config.contextDelayMs ?? DEFAULT_CONTEXT_DELAY_MS;
        this.schedule(() => {
          this.sockets[side]?.send(
            JSON.stringify({ type: "contextual_update", text: context })
          );
        }, delay);
        break;
      }

      case "agent_response": {
        const event = frame.agent_response_event as
          | { agent_response?: unknown; is_final_response?: unknown }
          | undefined;
        const text = event?.agent_response;
        if (typeof text !== "string" || text.length === 0) break;
        // `is_final_response` marks the end of an utterance. A vendor that
        // omits it is treated as final, which is the old behaviour and the
        // safe default; a vendor that sends `false` is streaming, and treating
        // each partial as its own turn is what duplicated the transcript.
        const isFinal = event?.is_final_response !== false;
        this.onAgentResponse(side, text, isFinal);
        break;
      }

      case "ping": {
        const ping = frame.ping_event as { event_id?: unknown; ping_ms?: unknown } | undefined;
        const eventId = ping?.event_id;
        if (typeof eventId !== "string") break;
        const delay = clampDelay(typeof ping?.ping_ms === "number" ? ping.ping_ms : 0);
        this.schedule(() => {
          this.sockets[side]?.send(JSON.stringify({ type: "pong", event_id: eventId }));
        }, delay);
        break;
      }

      default:
        break;
    }
  }

  /* ------------------------------ turn taking ---------------------------- */

  /**
   * The brief a socket's agent gets when its conversation opens.
   *
   * A reconnected socket gets a short recap of the finished lines instead of
   * the opening brief. The recap is bounded: the whole transcript would grow
   * without limit and would eventually be larger than the agent's context.
   */
  private contextFor(side: AgentSide): string {
    const opening =
      (side === "patient"
        ? this.config.patientOpeningContext
        : this.config.receptionistOpeningContext) ?? "";

    const spoken = this.connectedBefore[side] ? this.resumeContext() : "";
    return [opening, spoken].filter(Boolean).join("\n\n");
  }

  private resumeContext(): string {
    const recent = this.state.transcript
      .filter((entry) => entry.finalized)
      .slice(-RESUME_CONTEXT_LINES);
    if (recent.length === 0) return "";

    const lines = recent
      .map((entry) => `${entry.role === "patient" ? "Patient" : "Receptionist"}: ${entry.text}`)
      .join("\n");

    return (
      "The connection dropped and has been re-established. This call is already " +
      "under way, so do not greet again and do not ask who you are speaking to. " +
      "The conversation so far:\n" +
      lines
    );
  }

  /**
   * One utterance from one side.
   *
   * `isFinal` is the vendor's own signal that the utterance is complete. It
   * drives whether this is a new transcript entry or a revision of the one
   * already on screen, which is the difference between a transcript and a
   * log of every word the TTS engine emitted.
   *
   * The three cases:
   *
   *  1. A partial for an utterance already in progress revises that entry.
   *     Appending was the old behaviour and it is what made overlapping
   *     streamed transcripts duplicate themselves, once per partial.
   *  2. A final closes the utterance: it revises the entry, hands the turn
   *     on, and clears the streaming slot so the next utterance starts fresh.
   *  3. A final with no utterance in progress is a new entry, unless it is a
   *     byte-identical repeat of the last line from that side inside the
   *     dedupe window, which is a retransmit rather than a new sentence.
   */
  private onAgentResponse(side: AgentSide, text: string, isFinal: boolean): void {
    const inProgress = this.streaming[side];

    if (inProgress !== null) {
      this.reviseEntry(inProgress, text, isFinal);
      this.armStreamIdle(side, inProgress);
      if (isFinal) {
        this.streaming[side] = null;
        this.lastFinal[side] = { id: inProgress, text, at: this.now() };
        this.commitUtterance(side, text);
      }
      return;
    }

    if (isFinal && this.isRetransmit(side, text)) {
      this.log("info", "spectate.transcript_deduplicated", { resource: resourceFor(side) });
      return;
    }

    const id = this.nextEntryId++;
    this.patch({
      transcript: [
        ...this.state.transcript,
        { id, role: side, text, at: this.now(), finalized: isFinal },
      ],
    });

    if (!isFinal) {
      this.streaming[side] = id;
      this.armStreamIdle(side, id);
      return;
    }

    this.lastFinal[side] = { id, text, at: this.now() };
    this.commitUtterance(side, text);
  }

  /**
   * A final frame immediately after a partial carrying the same text, with
   * nothing in between, is the vendor closing an utterance it already
   * streamed. That is handled structurally by the streaming slot above, so
   * this only has to catch the harder case: a whole final frame arriving
   * twice.
   *
   * Both conditions are load-bearing. The text has to be byte-identical, and
   * it has to be the *last thing in the transcript*: if either agent said
   * anything in between, then this really is a new line that happens to
   * sound like the last one, and dropping it would delete a turn of the
   * conversation to suppress a duplicate. That is the wrong trade for a
   * booking call, where "Yes." twice is a real exchange.
   */
  private isRetransmit(side: AgentSide, text: string): boolean {
    const last = this.lastFinal[side];
    if (!last || last.text !== text) return false;

    const entries = this.state.transcript;
    if (entries.length === 0) return false;
    const newest = entries[entries.length - 1];
    if (newest?.role !== side || newest.text !== text) return false;

    const window = this.config.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    return this.now() - last.at <= window;
  }

  /**
   * A streamed utterance goes quiet: close it and move on.
   *
   * This is the promise the old design could not keep. It used to append every
   * partial as its own turn and hand the floor on 2500ms after the *last* one,
   * so a stream that never sent its final left the transcript permanently
   * "speaking" and the relay waiting on a handoff that was never scheduled.
   */
  private onStreamIdle(side: AgentSide, id: number): void {
    if (this.disposed || this.streaming[side] !== id) return;
    const entry = this.state.transcript.find((candidate) => candidate.id === id);
    if (!entry) return;

    this.streaming[side] = null;
    this.log("warn", "spectate.stream_never_finalized", { resource: resourceFor(side) });
    this.patch({
      transcript: this.state.transcript.map((candidate) =>
        candidate.id === id ? { ...candidate, finalized: true } : candidate
      ),
    });
    this.lastFinal[side] = { id, text: entry.text, at: this.now() };
    this.commitUtterance(side, entry.text);
  }

  /**
   * An utterance is complete: it takes the floor, and after the hold it is
   * handed to the other side.
   *
   * Re-arming the hold per utterance, rather than letting the first hold timer
   * clear the current text of a later one, is what stops two lines from the
   * same side overlapping. The old code scheduled a timer per response and
   * never cancelled any of them, so a second line was wiped off the card by
   * the first line's timer while it was still the current one.
   */
  private commitUtterance(side: AgentSide, text: string): void {
    // Whatever turn we were waiting on this side for is now answered. Cleared
    // here, before the new floor is set, so a stall warning is not left on
    // screen for a turn that has since been answered.
    this.clearTurnFor(side);

    this.committed[side] = { text };
    this.patch({
      currentText: { ...this.state.currentText, [side]: text },
      speaking: { ...this.state.speaking, [side]: true },
      floor: side,
    });

    this.clearHold(side);
    this.holdTimers[side] = this.schedule(() => {
      delete this.holdTimers[side];
      this.releaseFloor(side);
    }, this.config.holdMs ?? DEFAULT_HOLD_MS);
  }

  /** The hold elapsed: take the line off the card and hand it on. */
  private releaseFloor(side: AgentSide): void {
    if (this.committed[side]?.text === undefined) return;
    const text = this.committed[side]?.text ?? "";
    this.committed[side] = null;

    // Only clear the card if this side still holds it. A line that arrived
    // from elsewhere in the meantime has taken the floor and must not be
    // blanked by a timer belonging to an older one.
    if (this.state.floor === side) {
      this.patch({
        currentText: { ...this.state.currentText, [side]: "" },
        speaking: { ...this.state.speaking, [side]: false },
        floor: null,
      });
    }

    this.handoff(side, text);
  }

  /**
   * Hand a finished line to the other agent, and wait for its answer.
   *
   * Every exit from here terminates. The line is either delivered now, or it
   * goes to the outbox and is retried until `sendGiveUpMs` has run out, and
   * either way a response timer is armed that clears `awaiting` whether or not
   * an answer ever arrives.
   */
  private handoff(from: AgentSide, text: string): void {
    const to = otherSide(from);
    if (this.disposed || !text) return;

    this.awaiting = { to, text };
    this.patch({ awaiting: to, stalled: false, notice: null });

    if (this.sendTo(to, text)) {
      this.armResponseTimeout(to);
      return;
    }

    this.outbox = { to, text, since: this.now() };
    this.patch({
      notice: `Holding a line for the ${label(to)} agent until its connection is back.`,
    });
    this.schedule(() => this.flushOutbox(), this.config.sendRetryMs ?? DEFAULT_SEND_RETRY_MS);
  }

  private flushOutbox(): void {
    if (this.disposed || !this.outbox) return;
    const pending = this.outbox;

    if (this.sendTo(pending.to, pending.text)) {
      this.outbox = null;
      // Restore the turn before arming its timeout, or the relay would
      // redeliver the line and then not be waiting for the answer to it.
      this.awaiting = { to: pending.to, text: pending.text };
      this.patch({ awaiting: pending.to, stalled: false });
      this.armResponseTimeout(pending.to);
      return;
    }

    const giveUp = this.config.sendGiveUpMs ?? DEFAULT_SEND_GIVE_UP_MS;
    if (this.now() - pending.since >= giveUp) {
      this.log("warn", "spectate.relay_abandoned", { resource: resourceFor(pending.to) });
      this.outbox = null;
      this.clearResponseTimeout();
      if (this.awaiting?.to !== pending.to) return;
      this.awaiting = null;
      this.patch({
        awaiting: null,
        stalled: true,
        notice: `The ${label(pending.to)} agent never came back, so the call stopped there.`,
      });
      return;
    }

    this.schedule(() => this.flushOutbox(), this.config.sendRetryMs ?? DEFAULT_SEND_RETRY_MS);
  }

  /**
   * Give up on a turn that was delivered but never answered.
   *
   * The old scheme had no equivalent. Its flags were only ever cleared by the
   * response they were waiting for, so this is the branch where the relay used
   * to simply stop talking for the rest of the session, with a card that
   * looked perfectly healthy: the transcript froze, the header still said
   * "Live session", and the next line was silently swallowed by a guard on a
   * flag nothing was ever going to clear.
   *
   * The session is not ended. The turn is dropped, the floor is released, and
   * either agent may speak again — which is the whole difference between a
   * lost turn and a dead call.
   */
  private abandonTurn(side: AgentSide): void {
    this.clearResponseTimeout();
    if (this.awaiting?.to !== side) return;

    this.awaiting = null;
    this.patch({
      awaiting: null,
      stalled: true,
      notice: `The ${label(side)} agent did not respond, so that turn was dropped.`,
    });
  }

  private armResponseTimeout(side: AgentSide): void {
    this.clearResponseTimeout();
    this.responseTimer = this.schedule(() => {
      this.responseTimer = null;
      this.abandonTurn(side);
    }, this.config.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
  }

  /**
   * A side spoke, so whatever we were waiting on it for is answered.
   *
   * Clear the stall on the way through, so a session that recovered does not
   * keep displaying a warning about a turn that has since been answered.
   */
  private clearTurnFor(side: AgentSide): void {
    if (this.awaiting?.to !== side) return;
    this.awaiting = null;
    this.clearResponseTimeout();
    this.clearOutbox();
    this.patch({ awaiting: null, stalled: false, notice: null });
  }

  /**
   * The socket we were waiting on just went away. Put the line back in the
   * outbox.
   *
   * Without this, the line was already marked handed-off and the response
   * timer was counting down against a socket that could never answer, so the
   * turn was lost for the full timeout and the transcript simply stopped. With
   * it, the line waits in the outbox and is delivered the moment that socket is
   * open again, which is what makes #50's reconnect actually worth having.
   */
  private requeueUnanswered(side: AgentSide): void {
    const turn = this.awaiting;
    if (!turn || turn.to !== side) return;

    this.awaiting = null;
    this.clearResponseTimeout();
    this.outbox = { to: turn.to, text: turn.text, since: this.now() };
    this.patch({ awaiting: null });
    this.schedule(() => this.flushOutbox(), this.config.sendRetryMs ?? DEFAULT_SEND_RETRY_MS);
  }

  /**
   * Send a line to one side.
   *
   * Returns whether it went. The answer used to be ignored, which is how a line
   * addressed to a socket that was not open was lost while the relay carried
   * on believing it had been handed over.
   */
  private sendTo(side: AgentSide, text: string): boolean {
    const socket = this.sockets[side];
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.log("warn", "spectate.relay_undeliverable", {
        resource: resourceFor(side),
        status: socket ? socket.readyState : SOCKET_CONNECTING,
      });
      return false;
    }
    socket.send(JSON.stringify({ type: "user_message", text }));
    return true;
  }

  /* --------------------------------- plumbing ---------------------------- */

  private reviseEntry(id: number, text: string, finalized: boolean): void {
    this.patch({
      transcript: this.state.transcript.map((entry) =>
        entry.id === id ? { ...entry, text, finalized } : entry
      ),
    });
  }

  private schedule(fn: () => void, delayMs: number): number {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      if (this.disposed) return;
      fn();
    }, delayMs);
    this.timers.add(handle);
    return handle;
  }

  private clearConnectTimer(side: AgentSide): void {
    const handle = this.connectTimers[side];
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    delete this.connectTimers[side];
  }

  private clearHold(side: AgentSide): void {
    const handle = this.holdTimers[side];
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    delete this.holdTimers[side];
  }

  /** Re-arm the give-up-on-a-silent-stream timer for one side. */
  private armStreamIdle(side: AgentSide, id: number): void {
    this.clearStreamIdle(side);
    this.streamTimers[side] = this.schedule(
      () => {
        delete this.streamTimers[side];
        this.onStreamIdle(side, id);
      },
      this.config.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS
    );
  }

  private clearStreamIdle(side: AgentSide): void {
    const handle = this.streamTimers[side];
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    delete this.streamTimers[side];
  }

  private clearResponseTimeout(): void {
    if (this.responseTimer === null) return;
    this.clock.clearTimeout(this.responseTimer);
    this.timers.delete(this.responseTimer);
    this.responseTimer = null;
  }

  private clearOutbox(): void {
    this.outbox = null;
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.clock.clearTimeout(handle);
    this.timers.clear();
    this.connectTimers.patient = undefined;
    this.connectTimers.receptionist = undefined;
    this.reconnectTimers.patient = undefined;
    this.reconnectTimers.receptionist = undefined;
    this.holdTimers.patient = undefined;
    this.holdTimers.receptionist = undefined;
    this.streamTimers.patient = undefined;
    this.streamTimers.receptionist = undefined;
    this.responseTimer = null;
  }

  /** Forget the turn entirely. Used by `stop` and `dispose`. */
  private resetTurn(): void {
    this.awaiting = null;
    this.outbox = null;
    this.streaming.patient = null;
    this.streaming.receptionist = null;
    this.committed.patient = null;
    this.committed.receptionist = null;
  }

  private patch(next: Partial<RelayState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }
}

function resourceFor(side: AgentSide): string {
  return side === "patient" ? "agent_patient" : "agent_receptionist";
}

function label(side: AgentSide): string {
  return side === "patient" ? "patient caller" : "receptionist";
}

/* -------------------------------------------------------------------------- */
/* The hook                                                                    */
/* -------------------------------------------------------------------------- */

export interface UseAgentRelayOptions {
  patientAgentId: string;
  receptionistAgentId: string;
  /**
   * The opening line handed to the patient agent, built from the record.
   *
   * Constructed by the page rather than here so that everything derived from
   * PHI is assembled in one place and the machine never sees a patient.
   */
  patientOpeningContext: string;
  receptionistOpeningContext: string;
  /** Serialized into the patient socket's init payload. */
  patientDynamicVariables?: Record<string, unknown>;
}

export interface UseAgentRelayResult {
  state: RelayState;
  start: () => void;
  stop: () => void;
  /** Re-open one side's socket without ending the call. */
  reconnect: (side: AgentSide) => void;
  /** Re-open whichever sides are not up. */
  reconnectAll: () => void;
}

/**
 * Subscribe to a relay.
 *
 * The machine is an external store, so this reads through
 * `useSyncExternalStore` rather than holding a `useState` copy of it. That
 * choice is not cosmetic:
 *
 *  * A socket callback is not a React event handler, so the old
 *    subscribe-and-`setState` shape is where tearing comes from. The store
 *    contract is checked by React, and the snapshot is referentially stable
 *    between patches, so a render can never read a half-updated relay.
 *  * It also keeps the state out of the effect. Building the machine in an
 *    effect and then `setState`-ing to publish it costs an extra render on
 *    every mount and needs the instance in a second piece of state to be
 *    callable at all.
 *
 * The machine itself is created by a `useState` initialiser, which is the one
 * place React sanctions for a value that must exist exactly once and must not
 * be torn down by a re-render. Its constructor opens no sockets and schedules
 * no timers; that only happens in `start`, which an event handler calls.
 *
 * Configuration arrives through `reconfigure` rather than a second machine, so
 * a changed prop does not silently leave the old session's sockets running.
 */
export function useAgentRelay(options: UseAgentRelayOptions): UseAgentRelayResult {
  const {
    patientAgentId,
    receptionistAgentId,
    patientOpeningContext,
    receptionistOpeningContext,
    patientDynamicVariables,
  } = options;

  /**
   * The machine, built once.
   *
   * Written as `useState(initialiser)` with no setter, which is the sanctioned
   * way to get a value that must exist exactly once and must not be torn down
   * by a re-render. Note what the React Compiler does with it, because it is
   * the reason this is safe (#54):
   *
   *   useState(() => new AgentRelay(config))  =>  useState(useMemo(() => new AgentRelay(config), [config]))
   *
   * The compiler rewrites the throwaway initialiser into a memo. Two
   * consequences, both benign here and neither obvious:
   *
   *  * A changed config builds a second machine and throws it away, because
   *    `useState` only reads its initialiser on the first render. That is why
   *    config is not passed in at all, and why the effect below is the only
   *    path config takes. Nothing is built that is not used.
   *  * Under StrictMode's double render, the initialiser runs twice and one
   *    machine is discarded. Also only benign because the constructor has no
   *    side effects — it opens no socket and schedules no timer. If someone
   *    later moves socket setup into the constructor, both of the above start
   *    leaking machines, and the compiler will not warn.
   *
   * `constructing a relay touches nothing` in the test file pins that
   * invariant, so the change that breaks it fails the suite.
   *
   * Everything timer-heavy lives inside the machine, which the compiler does
   * not analyse: it only rewrites components and hooks, not class bodies. The
   * relay's `timers` Set, its `awaiting` turn, and its outbox are emitted
   * verbatim. That is the other half of this branch's finding — the
   * extraction in #46 is what made the compiler irrelevant to the risky code,
   * not merely the reaction to it.
   */
  const [relay] = useState(() => new AgentRelay());

  const subscribe = useCallback(
    (onStoreChange: () => void) => relay.subscribe(onStoreChange),
    [relay]
  );

  const getSnapshot = useCallback(() => relay.getState(), [relay]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    relay.reconfigure({
      patientAgentId,
      receptionistAgentId,
      patientOpeningContext,
      receptionistOpeningContext,
      patientDynamicVariables,
    });
  }, [
    relay,
    patientAgentId,
    receptionistAgentId,
    patientOpeningContext,
    receptionistOpeningContext,
    patientDynamicVariables,
  ]);

  useEffect(() => {
    return () => relay.dispose();
  }, [relay]);

  const start = useCallback(() => {
    relay.start();
  }, [relay]);

  const stop = useCallback(() => {
    relay.stop();
  }, [relay]);

  const reconnect = useCallback(
    (side: AgentSide) => {
      relay.reconnect(side);
    },
    [relay]
  );

  const reconnectAll = useCallback(() => {
    relay.reconnectAll();
  }, [relay]);

  return { state, start, stop, reconnect, reconnectAll };
}
