import { describe, expect, test } from "bun:test";

import type { AgentSide, RelaySocket } from "@/hooks/useAgentRelay";
import { createAgentSocketFactory, type VoiceCredential } from "./agent-socket";

/**
 * The browser's agent socket, tested.
 *
 * A `WebSocket` in a test is not available, so the factory takes a socket
 * constructor. What is being pinned down here is the property #15 is about,
 * from the browser's side: what this module is capable of putting in a URL. It
 * is handed a side and a session token, it asks the server, and the only string
 * it can ever open is one the server signed and has not yet expired. There is
 * no agent id in this file, and the tests would not notice if one were added --
 * which is exactly why one of them reads the module's own source.
 */

const SIDES = ["patient", "receptionist"] as const;

/** A `WebSocket` that records its URL and can be driven from a test. */
class FakeWebSocket implements RelaySocket {
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  readonly sent: string[] = [];
  closeCount = 0;

  constructor(readonly url: string) {}

  send = (data: string): void => {
    this.sent.push(data);
  };

  close = (): void => {
    this.closeCount += 1;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, { code: 1000 } as CloseEvent);
  };

  private get self(): WebSocket {
    return this as unknown as WebSocket;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.call(this.self, new Event("open"));
  }

  emitMessage(data: string): void {
    this.onmessage?.call(
      this.self,
      new MessageEvent("message", { data }),
    );
  }

  emitError(): void {
    this.onerror?.call(this.self, new Event("error"));
  }
}

interface Harness {
  open(side: AgentSide): RelaySocket;
  warm(sides?: readonly AgentSide[]): void;
  sockets(): FakeWebSocket[];
  mints: string[];
  faults: string[];
  latest(): FakeWebSocket;
  socketFor(url: string): FakeWebSocket;
  settle(): Promise<void>;
}

function harness(
  options: {
    mint?: (side: AgentSide) => Promise<VoiceCredential>;
    now?: () => number;
    minRemainingMs?: number;
  } = {},
): Harness {
  const sockets: FakeWebSocket[] = [];
  const mints: string[] = [];
  const faults: string[] = [];
  const clock = 1_700_000_000_000;

  const factory = createAgentSocketFactory({
    mint: async (side) => {
      mints.push(side);
      return {
        url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=opaque&signature=sig-${side}`,
        expiresAt: clock + 60_000,
      };
    },
    now: () => clock,
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    onFault: (fault) => faults.push(fault),
    ...options,
  });

  return {
    open: (side) => factory.open(side),
    warm: (sides) => factory.warm(sides),
    sockets: () => sockets,
    mints,
    faults,
    latest: () => {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("no socket was opened");
      return socket;
    },
    socketFor: (url) => {
      const socket = sockets.find((candidate) => candidate.url === url);
      if (!socket) throw new Error(`no socket for ${url}`);
      return socket;
    },
    // Two turns of the microtask queue: the factory awaits a credential, and a
    // test that creates a socket and then reads the sockets array is otherwise
    // racing the promise it just started.
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("opening a side", () => {
  test("is not open until the server has handed over a signed URL", async () => {
    const h = harness();
    const socket = h.open("patient");

    // The relay treats "connecting" as not usable, and its connect timeout is
    // armed from the moment the socket is created, so this is the state the
    // whole design depends on.
    expect(socket.readyState).toBe(0);
    expect(h.sockets()).toHaveLength(0);

    await h.settle();

    expect(h.sockets()).toHaveLength(1);
    expect(h.latest().url).toBe(
      "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=opaque&signature=sig-patient",
    );
  });

  test("opens exactly the URL the server signed, for the side that was asked for", async () => {
    const h = harness();

    h.open("receptionist");
    await h.settle();

    expect(h.mints).toEqual(["receptionist"]);
    expect(h.latest().url).toContain("signature=sig-receptionist");
  });

  test("reports the socket as open when the vendor opens it", async () => {
    const h = harness();
    const socket = h.open("patient");
    await h.settle();

    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    h.latest().emitOpen();

    expect(opened).toBe(true);
    expect(socket.readyState).toBe(1);
  });

  test("passes the vendor's frames straight through, unmodified", async () => {
    // The relay parses the vendor's protocol. Anything this layer did to a
    // frame -- buffering, wrapping, re-encoding -- would be a frame the relay
    // cannot read, and it would be the relay's tests that had to change.
    const h = harness();
    const socket = h.open("patient");
    await h.settle();

    const frames: unknown[] = [];
    socket.onmessage = (event) => frames.push(event.data);
    const raw = '{"type":"agent_response","agent_response_event":{"agent_response":"hola"}}';
    h.latest().emitMessage(raw);

    expect(frames).toEqual([raw]);
  });

  test("forwards a send to the vendor socket once it is open", async () => {
    const h = harness();
    const socket = h.open("patient");
    await h.settle();
    h.latest().emitOpen();

    socket.send('{"type":"user_message","text":"hola"}');

    expect(h.latest().sent).toEqual(['{"type":"user_message","text":"hola"}']);
  });
});

describe("a server that will not issue a session", () => {
  test("surfaces as a failed connection rather than a socket that hangs open", async () => {
    // The relay's connect timeout would eventually fire, but ten seconds of a
    // spinner is a worse answer than an immediate one, and a relay that
    // reconnects would do it again.
    const h = harness({
      mint: async () => {
        throw new Error("Not a valid voice session");
      },
    });
    const socket = h.open("patient");

    const events: string[] = [];
    socket.onerror = () => events.push("error");
    socket.onclose = (event) => events.push(`close:${event.code}`);

    await h.settle();

    expect(events).toEqual(["error", "close:1006"]);
    expect(socket.readyState).toBe(3);
    expect(h.sockets()).toHaveLength(0);
    expect(h.faults).toEqual(["patient:mint_failed"]);
  });
});

describe("a socket the relay gives up on", () => {
  test("never opens a vendor socket after it was closed", async () => {
    const h = harness();
    const socket = h.open("patient");
    socket.close();

    await h.settle();

    // The relay abandons a connect attempt it has stopped waiting for. The
    // credential is still in flight, and a vendor conversation opened now would
    // be a live paid session that nobody is listening to and nothing closes.
    expect(h.sockets()).toHaveLength(0);
    expect(socket.readyState).toBe(3);
  });

  test("closes the vendor socket it already opened", async () => {
    const h = harness();
    const socket = h.open("patient");
    await h.settle();
    h.latest().emitOpen();

    socket.close();

    expect(h.latest().closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  test("reports a close that happens with no vendor socket as a clean close", async () => {
    // Code 1000, not 1006: this is our own doing, and the relay distinguishes a
    // deliberate close from a dropped connection by that number.
    const h = harness();
    const socket = h.open("patient");
    const codes: number[] = [];
    socket.onclose = (event) => codes.push(event.code);

    socket.close();

    expect(codes).toEqual([1000]);
  });
});

describe("warming the credentials", () => {
  test("mints ahead of the call so Start does not wait on a round trip", async () => {
    // The one cost of this design is a request before the socket opens. Doing it
    // while the patient is reading the page removes it from the path that is
    // measured.
    const h = harness();

    h.warm(SIDES);
    expect(h.sockets()).toHaveLength(0);

    await h.settle();
    expect(h.mints).toEqual(["patient", "receptionist"]);
    // Warming fetches credentials; it does not open sockets.
    expect(h.sockets()).toHaveLength(0);
  });

  test("is used by the next open rather than minting twice", async () => {
    const h = harness();

    h.warm(["patient"]);
    await h.settle();
    h.open("patient");
    await h.settle();

    expect(h.mints).toEqual(["patient"]);
    expect(h.sockets()).toHaveLength(1);
  });

  test("shares one mint between two callers that ask at the same moment", async () => {
    const h = harness();

    // The relay opens both sides at once, so this is the real sequence, not a
    // stress test: without the shared promise this is two vendor calls and two
    // chances to be throttled.
    h.open("patient");
    h.open("patient");
    await h.settle();

    expect(h.mints).toEqual(["patient"]);
  });

  test("does not reuse a credential that has run out", async () => {
    let clock = 1_700_000_000_000;
    let mints = 0;
    const h = harness({
      now: () => clock,
      minRemainingMs: 10_000,
      mint: async () => {
        mints += 1;
        return {
          url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=opaque&signature=sig-${mints}`,
          expiresAt: clock + 60_000,
        };
      },
    });

    h.open("patient");
    await h.settle();
    expect(mints).toBe(1);

    // A signature with under the margin left is not worth using: the socket
    // would open and then the vendor would refuse the conversation. Minting
    // again costs one request and buys a session that is still alive when the
    // patient is.
    clock += 55_000;
    h.open("patient");
    await h.settle();

    expect(mints).toBe(2);
  });

  test("keeps working after a warm that failed", async () => {
    let attempts = 0;
    const h = harness({
      mint: async (side) => {
        attempts += 1;
        if (attempts === 1) throw new Error("no session");
        return {
          url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=opaque&signature=sig-${side}`,
          expiresAt: 1_700_000_060_000,
        };
      },
    });

    h.warm(["patient"]);
    await h.settle();
    expect(h.faults).toEqual(["patient:mint_failed"]);

    // A failed warm is not cached as a failure. The relay retries on its own
    // backoff, and the retry has to be able to succeed.
    h.open("patient");
    await h.settle();

    expect(attempts).toBe(2);
    expect(h.sockets()).toHaveLength(1);
  });

  test("survives a warm that throws synchronously", async () => {
    const h = harness({
      mint: (side) => {
        if (side === "patient") throw new Error("offline");
        return Promise.resolve({
          url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=opaque&signature=sig",
          expiresAt: 1_700_000_060_000,
        });
      },
    });

    h.warm(SIDES);
    await h.settle();

    expect(h.faults).toEqual(["patient:mint_failed"]);
    expect(() => h.open("receptionist")).not.toThrow();
  });
});

describe("what this module is capable of putting in a URL", () => {
  test("has no agent id and no vendor path to read", async () => {
    // A structural check, and a deliberately unfashionable one. The guarantee
    // #15 wants is not "nothing passes an id today" but "there is nowhere in
    // the browser half of this feature for an id to come from". Reading the
    // source is the only assertion that keeps holding when someone adds a
    // parameter next year and means well.
    const source = await Bun.file(
      new URL("./agent-socket.ts", import.meta.url).pathname,
    ).text();

    expect(source).not.toMatch(/ELEVENLABS_AGENT_/);
    expect(source).not.toMatch(/agentId/);
    expect(source).not.toMatch(/process\.env/);
  });
});
