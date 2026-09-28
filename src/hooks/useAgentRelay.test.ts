import { describe, expect, test } from "bun:test";
import {
  AgentRelay,
  type AgentRelayConfig,
  type RelayClock,
  type RelaySocket,
  initialRelayState,
  otherSide,
  MAX_PING_DELAY_MS,
} from "./useAgentRelay";

/**
 * The relay, tested.
 *
 * No DOM and no `WebSocket`. The machine takes a socket factory and a clock as
 * constructor options precisely so that this file exists: every assertion
 * below is about logic that was previously reachable only by opening two real
 * sockets to a paid third-party API and waiting on real time.
 */

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

class FakeClock implements RelayClock {
  private nextHandle = 1;
  private readonly due = new Map<number, { at: number; fn: () => void }>();
  private current = 0;

  setTimeout(fn: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.due.set(handle, { at: this.current + Math.max(0, ms), fn });
    return handle;
  }

  clearTimeout(handle: number): void {
    this.due.delete(handle);
  }

  /** Advance time, running everything that comes due, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const ready = [...this.due.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      const next = ready[0];
      if (!next) break;
      const [handle, entry] = next;
      this.due.delete(handle);
      this.current = entry.at;
      entry.fn();
    }
    this.current = target;
  }

  get pending(): number {
    return this.due.size;
  }
}

class FakeSocket implements RelaySocket {
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  readonly sent: string[] = [];
  readonly closed: number[] = [];

  send = (data: string): void => {
    this.sent.push(data);
  };

  close = (): void => {
    this.closed.push(1);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emitClose(1000, true);
  };

  /* Drivers, so a test reads as a sequence of things happening to a socket. */
  private readonly self = this as unknown as WebSocket;

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.call(this.self, new Event("open"));
  }

  emitFrame(frame: unknown): void {
    this.onmessage?.call(
      this.self,
      new MessageEvent("message", {
        data: typeof frame === "string" ? frame : JSON.stringify(frame),
      })
    );
  }

  emitRaw(data: unknown): void {
    this.onmessage?.call(this.self, new MessageEvent("message", { data }));
  }

  emitError(): void {
    this.onerror?.call(this.self, new Event("error"));
  }

  emitClose(code: number, wasClean = false): void {
    this.readyState = 3;
    this.onclose?.call(this.self, { code, wasClean } as CloseEvent);
  }

  /** Everything this socket was asked to send, parsed. */
  frames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }

  ofType(type: string): { type: string; [key: string]: unknown }[] {
    return this.frames().filter((frame) => frame.type === type);
  }
}

interface Harness {
  relay: AgentRelay;
  clock: FakeClock;
  sockets: { patient: FakeSocket; receptionist: FakeSocket };
  /** The socket created for a given agent id. */
  socketFor(agentId: string): FakeSocket;
  openBoth(): void;
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
}

function makeRelay(overrides: Partial<AgentRelayConfig> = {}): Harness {
  const clock = new FakeClock();
  const logs: Harness["logs"] = [];
  const byAgentId = new Map<string, FakeSocket>();

  const createSocket = (url: string): RelaySocket => {
    const agentId = new URL(url).searchParams.get("agent_id") ?? "";
    const socket = new FakeSocket();
    byAgentId.set(agentId, socket);
    return socket;
  };

  const relay = new AgentRelay({
    patientAgentId: "agent_patient_1",
    receptionistAgentId: "agent_receptionist_1",
    patientOpeningContext: "You are the patient.",
    receptionistOpeningContext: "You are the receptionist.",
    createSocket,
    clock,
    now: () => 1_700_000_000_000,
    log: (level, message, fields) => {
      logs.push({ level, message, fields });
    },
    ...overrides,
  });

  const socketFor = (agentId: string): FakeSocket => {
    const socket = byAgentId.get(agentId);
    if (!socket) throw new Error(`no socket was opened for ${agentId}`);
    return socket;
  };

  return {
    relay,
    clock,
    logs,
    socketFor,
    sockets: {
      get patient() {
        return socketFor("agent_patient_1");
      },
      get receptionist() {
        return socketFor("agent_receptionist_1");
      },
    },
    /**
     * Start, open both sockets, and let each one echo the init payload back,
     * which is what the vendor does and what releases the opening context.
     */
    openBoth() {
      relay.start();
      for (const agentId of ["agent_patient_1", "agent_receptionist_1"]) {
        const socket = socketFor(agentId);
        socket.emitOpen();
        socket.emitFrame({ type: "conversation_initiation_client_data" });
      }
    },
  };
}

/** Drive a full patient line, all the way to the receptionist's reply. */
function exchange(harness: Harness, patientLine: string, receptionistLine: string): void {
  harness.sockets.patient.emitFrame({
    type: "agent_response",
    agent_response_event: { agent_response: patientLine },
  });
  harness.clock.advance(2_500);
  harness.sockets.receptionist.emitFrame({
    type: "agent_response",
    agent_response_event: { agent_response: receptionistLine },
  });
  harness.clock.advance(2_500);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

describe("otherSide", () => {
  test("maps each side to the other", () => {
    expect(otherSide("patient")).toBe("receptionist");
    expect(otherSide("receptionist")).toBe("patient");
  });
});

describe("initialRelayState", () => {
  test("starts idle, with no transcript and both sockets idle", () => {
    const state = initialRelayState();
    expect(state.phase).toBe("idle");
    expect(state.transcript).toEqual([]);
    expect(state.socket).toEqual({ patient: "idle", receptionist: "idle" });
    expect(state.error).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Connect                                                                     */
/* -------------------------------------------------------------------------- */

describe("connecting", () => {
  test("does not report live until both sockets have opened", () => {
    const harness = makeRelay();
    harness.relay.start();

    // The bug from #24: the promise resolved inside the function body, so the
    // page believed it was live before either socket existed.
    expect(harness.relay.getState().phase).toBe("connecting");

    harness.sockets.patient.emitOpen();
    expect(harness.relay.getState().phase).toBe("connecting");
    expect(harness.relay.getState().socket.patient).toBe("open");

    harness.sockets.receptionist.emitOpen();
    expect(harness.relay.getState().phase).toBe("live");
  });

  test("opens both sockets without waiting for the first", () => {
    const harness = makeRelay();
    harness.relay.start();
    // Sequential opening meant lines the patient agent produced in the gap
    // were relayed into a socket that did not exist yet.
    expect(() => harness.sockets.receptionist).not.toThrow();
  });

  test("sends the conversation init payload on open", () => {
    const harness = makeRelay();
    harness.openBoth();

    const patientInit = harness.sockets.patient.ofType(
      "conversation_initiation_client_data"
    );
    expect(patientInit).toHaveLength(1);

    const receptionistInit = harness.sockets.receptionist.ofType(
      "conversation_initiation_client_data"
    );
    expect(receptionistInit).toHaveLength(1);
  });

  test("forwards the patient dynamic variables but not to the receptionist", () => {
    const harness = makeRelay({
      patientDynamicVariables: { patient_info: '{"firstName":"Ada"}' },
    });
    harness.openBoth();

    const patientInit = harness.sockets.patient.frames()[0];
    expect(patientInit?.dynamic_variables).toEqual({
      patient_info: '{"firstName":"Ada"}',
    });
    expect(harness.sockets.receptionist.frames()[0]?.dynamic_variables).toBeUndefined();
  });

  test("sends the opening context after the init handshake", () => {
    const harness = makeRelay();
    harness.openBoth();

    expect(harness.sockets.patient.ofType("contextual_update")).toHaveLength(0);
    harness.clock.advance(500);

    expect(harness.sockets.patient.ofType("contextual_update")).toHaveLength(1);
    expect(harness.sockets.patient.ofType("contextual_update")[0]?.text).toBe(
      "You are the patient."
    );
    expect(harness.sockets.receptionist.ofType("contextual_update")[0]?.text).toBe(
      "You are the receptionist."
    );
  });

  test("clears the connect timeout once a socket opens", () => {
    const harness = makeRelay();
    harness.openBoth();
    expect(harness.clock.pending).toBe(2); // only the two context timers

    harness.clock.advance(60_000);
    expect(harness.relay.getState().phase).toBe("live");
  });

  test("fails the session when a socket errors before opening", () => {
    const harness = makeRelay();
    harness.relay.start();
    harness.sockets.patient.emitError();

    const state = harness.relay.getState();
    expect(state.phase).toBe("failed");
    expect(state.error).toContain("patient caller");
    expect(state.socket.patient).toBe("failed");
  });

  test("fails the session when a socket closes before opening", () => {
    const harness = makeRelay();
    harness.relay.start();
    harness.sockets.receptionist.emitClose(1006);

    expect(harness.relay.getState().phase).toBe("failed");
    expect(harness.relay.getState().error).toContain("receptionist");
  });

  test("fails a socket that never opens at all", () => {
    const harness = makeRelay({ connectTimeoutMs: 10_000 });
    harness.relay.start();
    harness.clock.advance(10_000);

    expect(harness.relay.getState().phase).toBe("failed");
    expect(harness.sockets.patient.closed.length).toBeGreaterThan(0);
  });

  test("closes the socket that did open when the other one fails", () => {
    const harness = makeRelay();
    harness.relay.start();
    harness.sockets.patient.emitOpen();
    harness.sockets.receptionist.emitError();

    expect(harness.sockets.patient.closed.length).toBeGreaterThan(0);
    expect(harness.relay.getState().phase).toBe("failed");
  });

  test("ignores a second start while a session is up", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.relay.start();
    expect(harness.sockets.patient.closed).toHaveLength(0);
    expect(harness.relay.getState().phase).toBe("live");
  });
});

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

describe("frames", () => {
  test("drops an unparseable frame without killing the relay", () => {
    const harness = makeRelay();
    harness.openBoth();

    // JSON.parse used to run bare in the handler, so one bad frame from the
    // far end threw where nothing could catch it and the relay went silent.
    harness.sockets.patient.emitRaw("{not json");
    expect(harness.relay.getState().phase).toBe("live");
    expect(harness.logs.some((l) => l.message === "spectate.unparseable_frame")).toBe(true);

    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "still here" },
    });
    expect(harness.relay.getState().transcript).toHaveLength(1);
  });

  test("drops a non-string and a non-object frame", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitRaw(42);
    harness.sockets.patient.emitRaw("null");
    harness.sockets.patient.emitRaw("[1,2,3]");
    expect(harness.relay.getState().transcript).toHaveLength(0);
  });

  test("ignores an agent_response with no text", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitFrame({ type: "agent_response", agent_response_event: {} });
    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "" },
    });
    expect(harness.relay.getState().transcript).toHaveLength(0);
  });

  test("ignores an unknown frame type", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitFrame({ type: "something_new", payload: 1 });
    expect(harness.relay.getState().phase).toBe("live");
  });

  test("answers a ping after the requested delay", () => {
    const harness = makeRelay();
    harness.openBoth();

    harness.sockets.patient.emitFrame({
      type: "ping",
      ping_event: { event_id: "evt_1", ping_ms: 3_000 },
    });

    harness.clock.advance(2_999);
    expect(harness.sockets.patient.ofType("pong")).toHaveLength(0);
    harness.clock.advance(1);
    expect(harness.sockets.patient.ofType("pong")[0]?.event_id).toBe("evt_1");
  });

  test("clamps an absurd ping delay rather than scheduling it", () => {
    const harness = makeRelay();
    harness.openBoth();

    harness.sockets.patient.emitFrame({
      type: "ping",
      ping_event: { event_id: "evt_2", ping_ms: 2 ** 31 },
    });
    harness.clock.advance(MAX_PING_DELAY_MS);
    expect(harness.sockets.patient.ofType("pong")).toHaveLength(1);
  });

  test("clamps a negative ping delay to an immediate pong", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitFrame({
      type: "ping",
      ping_event: { event_id: "evt_3", ping_ms: -5_000 },
    });
    harness.clock.advance(0);
    expect(harness.sockets.patient.ofType("pong")).toHaveLength(1);
  });

  test("ignores a ping with no event id", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitFrame({ type: "ping", ping_event: { ping_ms: 10 } });
    harness.clock.advance(1_000);
    expect(harness.sockets.patient.ofType("pong")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Turn taking (behaviour carried over from the component)                    */
/* -------------------------------------------------------------------------- */

describe("turn taking", () => {
  test("shows the line as it arrives, then clears it after the hold", () => {
    const harness = makeRelay();
    harness.openBoth();

    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "Hello?" },
    });

    let state = harness.relay.getState();
    expect(state.speaking.patient).toBe(true);
    expect(state.currentText.patient).toBe("Hello?");
    expect(state.floor).toBe("patient");

    harness.clock.advance(2_500);
    state = harness.relay.getState();
    expect(state.speaking.patient).toBe(false);
    expect(state.currentText.patient).toBe("");
    expect(state.floor).toBeNull();
  });

  test("relays the patient's line to the receptionist after the hold", () => {
    const harness = makeRelay();
    harness.openBoth();

    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "I need a dentist" },
    });
    expect(harness.sockets.receptionist.ofType("user_message")).toHaveLength(0);

    harness.clock.advance(2_500);
    const relayed = harness.sockets.receptionist.ofType("user_message");
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.text).toBe("I need a dentist");
  });

  test("relays the receptionist's reply back to the patient", () => {
    const harness = makeRelay();
    harness.openBoth();
    exchange(harness, "I need a dentist", "Of course, what time?");

    const replies = harness.sockets.patient.ofType("user_message");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe("Of course, what time?");
  });

  test("records both sides in the transcript, in order", () => {
    const harness = makeRelay();
    harness.openBoth();
    exchange(harness, "I need a dentist", "What time works?");

    const transcript = harness.relay.getState().transcript;
    expect(transcript.map((e) => [e.role, e.text])).toEqual([
      ["patient", "I need a dentist"],
      ["receptionist", "What time works?"],
    ]);
    expect(transcript[0]?.id).not.toBe(transcript[1]?.id);
    expect(transcript[0]?.at).toBe(1_700_000_000_000);
  });

  test("does not send the same line to a side that is already answering", () => {
    const harness = makeRelay();
    harness.openBoth();

    // The patient speaks twice before the hold elapses. The second hold sees
    // the flag already set and stays quiet, so the receptionist gets one line,
    // not two. This is the "no duplicate transcripts" property the flags buy,
    // and #25 has to keep it.
    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "first" },
    });
    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "second" },
    });
    harness.clock.advance(2_500);

    const relayed = harness.sockets.receptionist.ofType("user_message");
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.text).toBe("first");
  });
});

/* -------------------------------------------------------------------------- */
/* Disconnect                                                                  */
/* -------------------------------------------------------------------------- */

describe("disconnect", () => {
  test("degrades a live session when one socket drops", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.receptionist.emitClose(1006);

    const state = harness.relay.getState();
    expect(state.phase).toBe("degraded");
    expect(state.notice).toContain("receptionist");
    expect(state.socket.receptionist).toBe("closed");
    expect(state.socket.patient).toBe("open");
  });

  test("does not treat its own close as a drop", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.relay.stop();

    expect(harness.relay.getState().phase).toBe("stopped");
    expect(harness.relay.getState().notice).toBeNull();
  });

  test("warns rather than failing on an error after a successful open", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.sockets.patient.emitError();

    expect(harness.relay.getState().phase).toBe("live");
    expect(harness.logs.some((l) => l.message === "spectate.agent_socket_error")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe("reconfigure", () => {
  test("takes effect on the next start", () => {
    const harness = makeRelay();
    harness.relay.start();
    harness.sockets.patient.emitOpen();
    harness.sockets.receptionist.emitOpen();
    harness.relay.stop();

    harness.relay.reconfigure({ patientAgentId: "agent_patient_2" });
    harness.relay.start();

    expect(() => harness.socketFor("agent_patient_2")).not.toThrow();
  });

  test("does not change an in-flight conversation", () => {
    const harness = makeRelay();
    harness.openBoth();

    harness.relay.reconfigure({ patientOpeningContext: "something else" });
    // The context for the current session is already scheduled; the new value
    // must not retitle a call that is already under way.
    harness.clock.advance(500);
    expect(harness.sockets.patient.ofType("contextual_update")[0]?.text).toBe(
      "You are the patient."
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

describe("teardown", () => {
  test("stop closes both sockets and drops every timer", () => {
    const harness = makeRelay();
    harness.openBoth();
    expect(harness.clock.pending).toBe(2);

    harness.relay.stop();
    expect(harness.clock.pending).toBe(0);
    expect(harness.sockets.patient.closed.length).toBeGreaterThan(0);
    expect(harness.sockets.receptionist.closed.length).toBeGreaterThan(0);
    expect(harness.relay.getState().phase).toBe("stopped");
  });

  test("dispose closes both sockets and drops every timer", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.relay.dispose();

    expect(harness.clock.pending).toBe(0);
    expect(harness.sockets.patient.closed.length).toBeGreaterThan(0);
    expect(harness.sockets.receptionist.closed.length).toBeGreaterThan(0);
  });

  test("a timer that fires after unmount does not send", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.clock.advance(500); // opening contexts out
    harness.relay.dispose();

    harness.sockets.patient.emitFrame({
      type: "agent_response",
      agent_response_event: { agent_response: "anyone there?" },
    });
    harness.clock.advance(10_000);

    expect(harness.sockets.receptionist.ofType("user_message")).toHaveLength(0);
  });

  test("dispose is idempotent and stops the machine responding", () => {
    const harness = makeRelay();
    harness.openBoth();
    harness.relay.dispose();
    harness.relay.dispose();
    harness.relay.start();

    expect(harness.relay.getState().phase).toBe("live");
    expect(harness.sockets.patient.closed.length).toBe(1);
  });

  test("notifies subscribers on every change and stops after dispose", () => {
    const harness = makeRelay();
    let notifications = 0;
    const unsubscribe = harness.relay.subscribe(() => {
      notifications += 1;
    });

    harness.openBoth();
    expect(notifications).toBeGreaterThan(0);

    unsubscribe();
    const after = notifications;
    harness.relay.stop();
    expect(notifications).toBe(after);
  });
});
