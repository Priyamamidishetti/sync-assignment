/**
 * connection.ts — the client sync engine: native WebSocket transport,
 * identity, throttling, reconnect, inbound validation, and the peer store.
 * Framework-agnostic: React never touches a socket; the renderer reads
 * state only through the public API below.
 *
 *  - Own cursor: local prediction, zero added latency (FR-29).
 *  - Moves: ≤30 Hz, leading + trailing, trailing guaranteed (FR-13).
 *  - seq: ONE monotonic counter shared by move/react, NEVER reset while the
 *    page lives. Receivers recreate peer entries on join/leave ("identity
 *    epochs"), resetting their per-peer baselines — so a reloaded sender
 *    (counter back at 0) can never be wedge-frozen by a stale baseline.
 *  - Disconnect detection: onclose/onerror PLUS an app-level watchdog —
 *    we ping every 5 s; 3 consecutive pings with zero inbound traffic while
 *    visible ⇒ half-open socket ⇒ force-close ⇒ reconnect. (Browsers can
 *    take minutes to notice a dead TCP path on their own, and the server's
 *    WS-level pings are invisible to page JS.)
 *  - Reconnect: exponential backoff 500ms → ×2 → 8 s cap, ±30 % jitter,
 *    unlimited attempts, reset on welcome. Same persisted clientId ⇒ the
 *    server evicts our old connection (FR-6) ⇒ exactly one cursor.
 *  - Inbound: everything goes through parseServerMessage; malformed input
 *    is counted and dropped, never crashes (FR-32).
 */
import {
  encodeMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type PeerInfo,
  type ReactionEmoji,
  type ServerMessage,
} from "@protocol";
import { LeadingTrailingThrottle } from "./throttle";
import { backoffDelay } from "./backoff";

export type ConnectionState = "connecting" | "online" | "reconnecting";

export interface RemoteCursor {
  readonly x: number;
  readonly y: number;
  readonly seq: number;
  /** performance.now() when this update ARRIVED locally (Phase 4 key). */
  readonly at: number;
}

export interface RemotePeer {
  readonly clientId: string;
  name: string;
  color: number;
  cursor: RemoteCursor | null;
}

export type RoomEvent =
  | { type: "state"; state: ConnectionState; attempt: number }
  | { type: "ready"; you: PeerInfo }
  | { type: "peers" }
  | { type: "reaction"; from: string; x: number; y: number; emoji: ReactionEmoji; seq: number }
  | { type: "server-error"; code: ErrorCode; detail: string }
  | { type: "stats"; rttMs: number };

export interface RoomSessionOptions {
  readonly url: string;
  readonly roomId: string;
  readonly clientId: string;
  readonly name?: string;
  readonly moveHz?: number; // default 30
  readonly pingIntervalMs?: number; // default 5000
  /** Dev: log the measured move send rate every 5 s. */
  readonly debugRateLog?: boolean;
  readonly onEvent: (event: RoomEvent) => void;
}

/** Same-origin WebSocket URL — works behind Vite's dev proxy and the
 *  single-port static build alike. */
export function defaultWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export class RoomSession {
  private readonly moveThrottle: LeadingTrailingThrottle<{ x: number; y: number }>;
  private readonly moveHz: number;
  private readonly pingIntervalMs: number;

  private ws: WebSocket | null = null;
  private stopped = false;
  private state: ConnectionState = "connecting";
  private attempt = 0;
  private seqCounter = 0;
  private readonly peers = new Map<string, RemotePeer>();
  private youInfo: PeerInfo | null = null;
  private lastLocalCursor: { x: number; y: number } | null = null;
  private lastInboundAt = 0;
  private unansweredPings = 0;
  private lastRttMs: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private devTimer: ReturnType<typeof setInterval> | null = null;
  private movesSentWindow = 0;

  /** Counted, never fatal: inbound messages the protocol parser rejected. */
  invalidServerMessages = 0;

  constructor(private readonly opts: RoomSessionOptions) {
    this.moveHz = opts.moveHz ?? 30;
    this.pingIntervalMs = opts.pingIntervalMs ?? 5_000;
    this.moveThrottle = new LeadingTrailingThrottle<{ x: number; y: number }>(
      1000 / this.moveHz,
      (v) => {
        this.rawSend({ t: "move", x: v.x, y: v.y, seq: this.nextSeq() });
        this.movesSentWindow++;
      },
    );
  }

  start(): void {
    if (this.stopped) return;
    if (this.ws !== null || this.reconnectTimer !== null) return;
    this.setState("connecting");
    if (this.opts.debugRateLog === true) this.startRateLog();
    this.connect();
  }

  // -- reads (UI + renderer) ---------------------------------------------------

  get connectionState(): ConnectionState {
    return this.state;
  }
  get currentAttempt(): number {
    return this.attempt;
  }
  get you(): PeerInfo | null {
    return this.youInfo;
  }
  get rttMs(): number | null {
    return this.lastRttMs;
  }
  get roomId(): string {
    return this.opts.roomId;
  }

  peerList(): RemotePeer[] {
    return [...this.peers.values()];
  }

  /**
   * THE RENDERING SEAM. Phase 3: last-known position (snapping — known
   * debt, by design). Phase 4: this becomes the interpolator's output.
   * The renderer depends only on this method, so Phase 4 changes nothing
   * in render.ts.
   */
  peerPosition(peer: RemotePeer): { x: number; y: number } | null {
    return peer.cursor !== null ? { x: peer.cursor.x, y: peer.cursor.y } : null;
  }

  // -- outbound -------------------------------------------------------------------

  sendMove(x: number, y: number): void {
    this.lastLocalCursor = { x, y };
    this.moveThrottle.push({ x, y });
  }

  sendReact(x: number, y: number, emoji: ReactionEmoji): void {
    // Discrete and human-rate-bounded → immediate, no throttle.
    this.rawSend({ t: "react", x, y, emoji, seq: this.nextSeq() });
  }

  close(): void {
    this.stopped = true;
    this.moveThrottle.cancel();
    this.stopPingLoop();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.devTimer !== null) {
      clearInterval(this.devTimer);
      this.devTimer = null;
    }
    if (this.ws !== null) {
      this.ws.onclose = null; // deliberate close — don't treat as a drop
      this.ws.close();
      this.ws = null;
    }
  }

  // -- transport ---------------------------------------------------------------------

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Protocol handshake: hello now; "online" only after welcome.
      this.rawSend({
        t: "hello",
        v: PROTOCOL_VERSION,
        roomId: this.opts.roomId,
        clientId: this.opts.clientId,
        ...(this.opts.name !== undefined ? { name: this.opts.name } : {}),
      });
    };
    ws.onmessage = (ev: MessageEvent) => this.onInbound(String(ev.data));
    ws.onerror = () => {
      /* transport errors always surface via onclose, which follows */
    };
    ws.onclose = () => {
      this.ws = null;
      this.stopPingLoop();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private rawSend(msg: ClientMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(msg));
    }
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  // -- inbound -------------------------------------------------------------------------

  private onInbound(raw: string): void {
    this.lastInboundAt = performance.now();
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.invalidServerMessages += 1;
      console.warn(`[live-room] dropped malformed server message (${parsed.code}): ${parsed.detail}`);
      return;
    }
    this.handle(parsed.message);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.youInfo = msg.you;
        // The snapshot is authoritative: rebuild the whole peer map. This
        // is also an identity-epoch reset for OUR view of every peer.
        this.peers.clear();
        const now = performance.now();
        for (const snap of msg.peers) {
          this.peers.set(snap.clientId, {
            clientId: snap.clientId,
            name: snap.name,
            color: snap.color,
            cursor:
              snap.x !== undefined && snap.y !== undefined && snap.seq !== undefined
                ? { x: snap.x, y: snap.y, seq: snap.seq, at: now }
                : null,
          });
        }
        this.attempt = 0; // success — backoff resets
        this.unansweredPings = 0;
        this.setState("online");
        this.startPingLoop();
        this.emit({ type: "ready", you: msg.you });
        this.emit({ type: "peers" });
        // Reconnect restore: our pointer hasn't moved while we were offline —
        // one unthrottled move repopulates our cursor for everyone else.
        if (this.lastLocalCursor !== null) {
          this.rawSend({
            t: "move",
            x: this.lastLocalCursor.x,
            y: this.lastLocalCursor.y,
            seq: this.nextSeq(),
          });
        }
        return;
      }
      case "join": {
        if (msg.clientId === this.opts.clientId) return; // defensive: never happens
        // Fresh entry = identity epoch for this peer (resets its seq baseline;
        // also makes rapid leave→join flapping idempotent, FR-6 tolerance).
        this.peers.set(msg.clientId, {
          clientId: msg.clientId,
          name: msg.name,
          color: msg.color,
          cursor: null,
        });
        this.emit({ type: "peers" });
        return;
      }
      case "leave": {
        if (this.peers.delete(msg.clientId)) this.emit({ type: "peers" });
        return;
      }
      case "cursor": {
        const peer = this.peers.get(msg.from);
        if (peer === undefined) return; // unknown peer (race) — ignore
        if (peer.cursor !== null && msg.seq <= peer.cursor.seq) return; // stale/dup, FR-14
        peer.cursor = { x: msg.x, y: msg.y, seq: msg.seq, at: performance.now() };
        this.emit({ type: "peers" });
        return;
      }
      case "reaction": {
        // Emitted now; burst rendering lands in Phase 5.
        this.emit({ type: "reaction", from: msg.from, x: msg.x, y: msg.y, emoji: msg.emoji, seq: msg.seq });
        return;
      }
      case "pong": {
        this.lastRttMs = performance.now() - msg.clientTime;
        this.emit({ type: "stats", rttMs: this.lastRttMs });
        return;
      }
      case "error": {
        console.warn(`[live-room] server error ${msg.code}: ${msg.detail}`);
        this.emit({ type: "server-error", code: msg.code, detail: msg.detail });
        return;
      }
    }
  }

  // -- liveness: app-level ping + watchdog -------------------------------------------------

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => this.pingTick(), this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private pingTick(): void {
    if (this.stopped || this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    if (document.hidden) return; // timers are throttled; server liveness rides on WS pings anyway
    this.rawSend({ t: "ping", clientTime: performance.now() });
    // Watchdog: 3 consecutive pings with no inbound at all in between, while
    // visible ⇒ half-open connection. Force-close; onclose drives reconnect.
    const silence = performance.now() - this.lastInboundAt;
    this.unansweredPings = silence > this.pingIntervalMs ? this.unansweredPings + 1 : 0;
    if (this.unansweredPings >= 3) {
      console.warn("[live-room] watchdog: no inbound for ~3 ping intervals — forcing reconnect");
      this.ws.close();
    }
  }

  // -- misc ------------------------------------------------------------------------------------

  private startRateLog(): void {
    this.devTimer = setInterval(() => {
      if (this.state === "online" && this.movesSentWindow > 0) {
        console.debug(
          `[live-room] move send rate: ${(this.movesSentWindow / 5).toFixed(1)} Hz (cap ${this.moveHz} Hz)`,
        );
      }
      this.movesSentWindow = 0;
    }, 5_000);
  }

  private nextSeq(): number {
    // ONE counter for moves AND reactions. Never reset while the page lives.
    return (this.seqCounter += 1);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "state", state, attempt: this.attempt });
  }

  private emit(event: RoomEvent): void {
    try {
      this.opts.onEvent(event);
    } catch (err) {
      console.error("[live-room] event handler threw (isolated from the engine):", err);
    }
  }
}
