import type { AgentSide, RelaySocket } from "@/hooks/useAgentRelay";

/**
 * The socket the relay opens, once the vendor is only reachable through us.
 *
 * The relay used to build `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=X`
 * in the browser, from an id the page had been given. This module replaces that
 * with the only string a browser is allowed to dial: a signed URL that this
 * application's server obtained with its own API key, and that stops working in
 * a minute. There is no agent id in this file, and `agent-socket.test.ts` reads
 * this file to keep it that way.
 *
 * ## Why a socket that is not a socket
 *
 * `AgentRelay` opens a socket synchronously, arms a connect timeout, and treats
 * a socket that is not `OPEN` as undeliverable. Everything the relay does with
 * reconnects, outboxes, and stalled turns depends on those three facts, and all
 * of it is tested against a plain object. So this is not a rewrite of the
 * relay: it is an object with the same shape that happens to do a round trip
 * before it has a real socket to delegate to.
 *
 * The client sees exactly what it saw before -- a connecting socket, an `open`,
 * frames, a `close` -- and the relay's own tests do not change because there is
 * nothing for them to change.
 *
 * ## The latency cost, and what is done about it
 *
 * There is a round trip to this app's own server before the vendor socket
 * exists, where before there was none. `warm()` moves it: credentials are
 * fetched while the patient is reading the page, so the wait lands on page load
 * rather than on the Start button. That is most of it -- the vendor handshake
 * was always going to happen after the click.
 *
 * A byte-pump WebSocket proxy would remove the round trip as well as the agent
 * id, and is the complete fix for #15. It is not here because it needs a
 * long-lived Node process holding a vendor socket per session, and this
 * application is deployed to a serverless platform with no custom server and no
 * state between invocations. The tradeoff is written up in the PR; the argument
 * is not that a proxy is wrong, it is that it is not deployable here.
 */

export interface VoiceCredential {
  /** The signed `wss://` URL the server minted. */
  url: string;
  /** When the server considers it spent, in epoch milliseconds. */
  expiresAt: number;
}

/** Asks this app's server for a credential. Never sees an agent id. */
export type CredentialMinter = (side: AgentSide) => Promise<VoiceCredential>;

export type SocketConstructor = (url: string) => RelaySocket;

export interface AgentSocketFactory {
  /** A socket for one side, connecting now and opening when the server answers. */
  open(side: AgentSide): RelaySocket;
  /**
   * Fetch credentials ahead of time.
   *
   * Takes the sides to warm because the caller knows which ones this page can
   * use: a deployment without voice has none, and warming a side it will never
   * open is a request the server will refuse.
   */
  warm(sides?: readonly AgentSide[]): void;
  /** Forget every cached credential. Ends of session, and tests. */
  clear(): void;
}

/**
 * How much of a credential's life must be left before it is worth using.
 *
 * Ten seconds. A socket that opens on a signature with two seconds left is a
 * connect timeout the patient watches, and the relay reports it as the agent
 * being unreachable, which is a lie about a vendor that was working.
 */
export const MIN_REMAINING_MS = 10_000;

const SIDES: readonly AgentSide[] = ["patient", "receptionist"];

/** `WebSocket` close codes, spelled out so this module reads no global. */
const CLOSE_CLEAN = 1000;
const CLOSE_ABNORMAL = 1006;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export function createAgentSocketFactory({
  mint,
  createWebSocket = (url: string) => new WebSocket(url) as RelaySocket,
  now = () => Date.now(),
  minRemainingMs = MIN_REMAINING_MS,
  onFault = () => {},
}: {
  mint: CredentialMinter;
  createWebSocket?: SocketConstructor;
  now?: () => number;
  minRemainingMs?: number;
  /** `(side:reason)` -- for `clientLog`. Never carries the URL or the token. */
  onFault?: (fault: string) => void;
}): AgentSocketFactory {
  const cached = new Map<AgentSide, VoiceCredential>();
  const inFlight = new Map<AgentSide, Promise<VoiceCredential | null>>();

  /**
   * One credential, shared.
   *
   * The relay opens both sides at once and, on a reconnect, may open the same
   * side twice before the first attempt resolves. Without this, each of those
   * is a separate request to our own server and a separate chance to be
   * throttled by it -- the failure mode of a design whose whole point was to
   * make the credential cheap.
   */
  const credential = (side: AgentSide): Promise<VoiceCredential | null> => {
    const held = cached.get(side);
    if (held && held.expiresAt - now() > minRemainingMs) return Promise.resolve(held);

    const pending = inFlight.get(side);
    if (pending) return pending;

    const request = (async () => {
      try {
        const minted = await mint(side);
        cached.set(side, minted);
        return minted;
      } catch {
        // Reported, not cached, and not rethrown. A failure here becomes a
        // failed connect on the socket below, which the relay already knows how
        // to report and retry. Caching the failure would make the relay's own
        // backoff the only thing that could recover, and it has no way to clear
        // a cache it does not know exists.
        onFault(`${side}:mint_failed`);
        return null;
      } finally {
        inFlight.delete(side);
      }
    })();

    inFlight.set(side, request);
    return request;
  };

  return {
    open(side: AgentSide): RelaySocket {
      return new DeferredAgentSocket(side, credential, createWebSocket, onFault);
    },

    warm(sides: readonly AgentSide[] = SIDES): void {
      for (const side of sides) void credential(side);
    },

    clear(): void {
      cached.clear();
    },
  };
}

/**
 * A socket that is not connected yet.
 *
 * Holds every state the relay reads: `readyState`, the four handlers, `send`,
 * and `close`. Everything the relay knows how to do -- time out, abandon, queue
 * a line for a socket that is not there, treat a close as the end of the call
 * or as a dropped connection -- works against this exactly as it did against a
 * real `WebSocket`, because the relay cannot tell the difference and should not
 * have to.
 */
class DeferredAgentSocket implements RelaySocket {
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  private inner: RelaySocket | null = null;
  private closed = false;

  constructor(
    private readonly side: AgentSide,
    private readonly credential: (side: AgentSide) => Promise<VoiceCredential | null>,
    private readonly createWebSocket: SocketConstructor,
    private readonly onFault: (fault: string) => void,
  ) {
    // Not awaited: the caller gets the socket now and the vendor later, and the
    // relay's connect timeout starts now, which is the honest measurement.
    void this.connect();
  }

  get readyState(): number {
    if (this.inner) return this.inner.readyState;
    return this.closed ? SOCKET_CLOSED : SOCKET_CONNECTING;
  }

  private async connect(): Promise<void> {
    const minted = await this.credential(this.side);

    if (this.closed) {
      // Abandoned while the request was in flight. A vendor conversation opened
      // now would be a live, billed session that no one is listening to and
      // nothing will ever close.
      return;
    }

    if (!minted) {
      this.fail();
      return;
    }

    const socket = this.createWebSocket(minted.url);
    this.inner = socket;
    this.forward(socket);
  }

  private forward(socket: RelaySocket): void {
    socket.onopen = (event) => this.onopen?.call(this as unknown as WebSocket, event);
    socket.onmessage = (event) => this.onmessage?.call(this as unknown as WebSocket, event);
    socket.onerror = (event) => this.onerror?.call(this as unknown as WebSocket, event);
    socket.onclose = (event) => this.onclose?.call(this as unknown as WebSocket, event);
  }

  /**
   * No credential, so no socket.
   *
   * Reported as an `error` followed by an abnormal `close`, which is what a
   * browser does when a connection cannot be made. The relay reads that as a
   * connect failure and says the agent could not be reached, then either backs
   * off or gives up -- both of which are the right behaviour, and neither of
   * which the relay would do if this only went quiet.
   */
  private fail(): void {
    if (this.closed) return;
    this.closed = true;

    this.onerror?.call(this as unknown as WebSocket, new Event("error"));
    this.onclose?.call(this as unknown as WebSocket, {
      code: CLOSE_ABNORMAL,
      wasClean: false,
    } as CloseEvent);
  }

  send = (data: string): void => {
    // Unreachable from the relay, which only sends to a socket it has read as
    // `OPEN`. Guarded rather than assumed, because a dropped frame here would
    // be a line lost with no error and no log.
    if (!this.inner || this.inner.readyState !== SOCKET_OPEN) {
      this.onFault(`${this.side}:send_while_connecting`);
      return;
    }
    this.inner.send(data);
  };

  close = (): void => {
    if (this.closed) return;
    this.closed = true;

    if (this.inner) {
      this.inner.close();
      return;
    }

    // Never connected, so there is nothing to close. A real `WebSocket` still
    // fires `close`, and with code 1000: this is our own doing, and the relay
    // treats 1006 during a deliberate shutdown as a dropped connection.
    this.onclose?.call(this as unknown as WebSocket, {
      code: CLOSE_CLEAN,
      wasClean: true,
    } as CloseEvent);
  };
}
