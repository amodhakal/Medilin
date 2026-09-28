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
export type SocketStatus = "idle" | "connecting" | "open" | "closed" | "failed";

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
  /** The side currently holding the floor, or null when neither is. */
  floor: AgentSide | null;
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

/** How long a side keeps the floor before its line is handed to the other. */
export const DEFAULT_HOLD_MS = 2_500;

/** How long after `open` the opening `contextual_update` goes out. */
export const DEFAULT_CONTEXT_DELAY_MS = 500;

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

export interface AgentRelayConfig {
  patientAgentId: string;
  receptionistAgentId: string;
  /** Sent to the patient agent to open the call. May contain PHI. */
  patientOpeningContext: string;
  /** Sent to the receptionist agent to open the call. */
  receptionistOpeningContext: string;
  /** Merged into the patient socket's conversation init payload. */
  patientDynamicVariables?: Record<string, unknown>;
  createSocket?: (url: string) => RelaySocket;
  clock?: RelayClock;
  connectTimeoutMs?: number;
  holdMs?: number;
  contextDelayMs?: number;
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
   * Turn-taking flags, one per side: "I have sent this side something and am
   * waiting for it to answer."
   *
   * Carried over from the component verbatim, including the property that
   * makes it fragile: they are set optimistically on send and cleared only by
   * the matching response, so a line that is never answered wedges the relay
   * forever. Replaced by an explicit turn state machine in #25; kept here so
   * this branch is a pure move and the behaviour change is reviewable on its
   * own.
   */
  private awaitingResponse: PerSide<boolean> = { patient: false, receptionist: false };

  private nextEntryId = 0;
  private disposed = false;
  /** Set while this machine is closing sockets on purpose. */
  private stopping = false;

  constructor(config: AgentRelayConfig) {
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
    this.patch({
      phase: "connecting",
      error: null,
      notice: null,
      speaking: { patient: false, receptionist: false },
      currentText: { patient: "", receptionist: "" },
      floor: null,
    });

    this.openSide("patient");
    this.openSide("receptionist");
  }

  /** End the call deliberately. */
  stop(): void {
    if (this.disposed) return;
    this.stopping = true;
    this.clearTimers();
    this.closeSockets();
    this.patch({
      phase: "stopped",
      error: null,
      notice: null,
      speaking: { patient: false, receptionist: false },
      currentText: { patient: "", receptionist: "" },
      socket: { patient: "closed", receptionist: "closed" },
      floor: null,
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
    this.closeSockets();
    this.listeners.clear();
  }

  /* -------------------------------- sockets ------------------------------ */

  private openSide(side: AgentSide): void {
    const agentId =
      side === "patient" ? this.config.patientAgentId : this.config.receptionistAgentId;

    const socket = this.createSocket(conversationUrl(agentId));
    this.sockets[side] = socket;
    this.settled[side] = false;
    this.opened[side] = false;
    this.patch({ socket: { ...this.state.socket, [side]: "connecting" } });

    this.attach(side, socket);

    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      delete this.connectTimers[side];
      this.log("warn", "spectate.agent_open_timeout", { resource: resourceFor(side) });
      socket.close();
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
      if (this.opened[side]) {
        this.log("warn", "spectate.agent_socket_error", { resource: resourceFor(side) });
        return;
      }
      this.log("error", "spectate.websocket_error", { resource: resourceFor(side) });
      this.fail(side, `Could not reach the ${label(side)} agent.`);
    };

    socket.onclose = (event) => {
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

      if (this.state.phase === "live") {
        this.patch({
          phase: "degraded",
          notice: `The ${label(side)} agent's connection dropped.`,
        });
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

    this.log("info", "spectate.agent_connected", { resource: resourceFor(side) });
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
        const context =
          side === "patient"
            ? this.config.patientOpeningContext
            : this.config.receptionistOpeningContext;
        const delay = this.config.contextDelayMs ?? DEFAULT_CONTEXT_DELAY_MS;
        this.schedule(() => {
          this.sockets[side]?.send(
            JSON.stringify({ type: "contextual_update", text: context })
          );
        }, delay);
        break;
      }

      case "agent_response": {
        const event = frame.agent_response_event as { agent_response?: unknown } | undefined;
        const text = event?.agent_response;
        if (typeof text !== "string" || text.length === 0) break;
        this.onAgentResponse(side, text);
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
   * A side said something: show it, record it, and hand it on after the hold.
   *
   * This is the old component logic moved verbatim, with one exception that
   * matters for #25 rather than here: a side that is handed a line while its
   * socket is not open silently loses it. The flag-based scheme treats that
   * as "already sent", so the relay never retries and the conversation is over.
   */
  private onAgentResponse(side: AgentSide, text: string): void {
    this.appendTranscript(side, text);
    this.patch({
      currentText: { ...this.state.currentText, [side]: text },
      speaking: { ...this.state.speaking, [side]: true },
      floor: side,
    });

    // The side has now spoken, so it is no longer waiting to be spoken to.
    this.awaitingResponse[side] = false;

    const listener = otherSide(side);
    this.schedule(() => {
      this.patch({
        currentText: { ...this.state.currentText, [side]: "" },
        speaking: { ...this.state.speaking, [side]: false },
        floor: this.state.floor === side ? null : this.state.floor,
      });

      if (this.awaitingResponse[listener]) return;
      this.awaitingResponse[listener] = true;
      this.sendTo(listener, text);
    }, this.config.holdMs ?? DEFAULT_HOLD_MS);
  }

  /**
   * Send a line to one side.
   *
   * Returns whether it went. Callers currently ignore the answer, which is the
   * dropped-message half of the deadlock in #25.
   */
  private sendTo(side: AgentSide, text: string): boolean {
    const socket = this.sockets[side];
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.log("warn", "spectate.relay_dropped", {
        resource: resourceFor(side),
        status: socket ? socket.readyState : SOCKET_CONNECTING,
      });
      return false;
    }
    socket.send(JSON.stringify({ type: "user_message", text }));
    return true;
  }

  /* --------------------------------- plumbing ---------------------------- */

  private appendTranscript(role: AgentSide, text: string): void {
    const entry: TranscriptEntry = {
      id: this.nextEntryId++,
      role,
      text,
      at: this.now(),
    };
    this.patch({ transcript: [...this.state.transcript, entry] });
  }

  private schedule(fn: () => void, delayMs: number): void {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      if (this.disposed) return;
      fn();
    }, delayMs);
    this.timers.add(handle);
  }

  private clearConnectTimer(side: AgentSide): void {
    const handle = this.connectTimers[side];
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(handle);
    delete this.connectTimers[side];
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.clock.clearTimeout(handle);
    this.timers.clear();
    this.connectTimers.patient = undefined;
    this.connectTimers.receptionist = undefined;
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

  const [relay] = useState(
    () =>
      new AgentRelay({
        patientAgentId,
        receptionistAgentId,
        patientOpeningContext,
        receptionistOpeningContext,
        patientDynamicVariables,
      })
  );

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

  return { state, start, stop };
}
