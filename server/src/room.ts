/**
 * room.ts — rooms, presence, relay, heartbeat. The stateful core of the
 * server, sitting between transport (ws.ts) and the wire contract
 * (protocol.ts).
 *
 * What this layer guarantees — and deliberately does NOT:
 *  - The server is a PRESENCE-HOLDING RELAY, not an authority. Per peer it
 *    keeps: identity (clientId/name/color), the connection, the last-known
 *    cursor {x,y,seq}, the last seq counter, lastSeen, a rate-limit bucket,
 *    and drop counters. No world state, no history.
 *  - Broadcasts serialize each message ONCE and write it to every peer
 *    except the sender (O(peers) socket writes, zero self-echo).
 *  - Peer identity is (clientId, connection). A hello from a NEW connection
 *    evicts the old one — others see leave("replaced") then join — and a
 *    zombie close event from the old socket can never evict the newer peer
 *    (removal is guarded by connection identity).
 *  - Ordering honesty: TCP delivers each connection's messages in order, so
 *    per-sender ordering is preserved end-to-end without extra machinery.
 *    The per-client `seq` counter (shared across moves AND reactions) is a
 *    defensive guard against duplicates/replays — server and clients drop
 *    seq <= lastSeq.
 *  - Liveness: browsers send nothing at app level while idle, so the
 *    heartbeat uses WS-level pings (auto-ponged by every browser). Any
 *    inbound message or pong refreshes lastSeen; silence past the timeout
 *    → hard destroy + leave("timeout").
 *  - Rate limit: token bucket per peer on sequenced actions (move/react).
 *    Excess is dropped silently and counted; hello/ping are never limited.
 *
 * All timings are injectable for tests.
 */
import {
  encodeMessage,
  PEER_COLORS,
  type HelloMsg,
  type LeaveReason,
  type MoveMsg,
  type PeerSnapshot,
  type ReactMsg,
  type SayMsg,
  type WelcomeMsg,
} from "./protocol.js";
import type { WsConnection } from "./ws.js";

// -- options -------------------------------------------------------------------

export interface HeartbeatOptions {
  /** WS-ping a peer at most this often. Default 10s. */
  readonly pingMs?: number;
  /** Sweep interval: check timeouts / send due pings. Default 5s. */
  readonly sweepMs?: number;
  /** Silence past this → evict with leave("timeout"). Default 25s. */
  readonly timeoutMs?: number;
}

export interface RateLimitOptions {
  /** Bucket capacity (burst size). Default 120. */
  readonly capacity?: number;
  /** Sustained refill per second. Default 120. */
  readonly refillPerSec?: number;
}

export interface RoomManagerOptions {
  readonly heartbeat?: HeartbeatOptions;
  readonly rateLimit?: RateLimitOptions;
}

export type ActionResult = "relayed" | "not_joined" | "stale" | "rate_limited";

export interface PeerStats {
  relayed: number;
  stale: number;
  rateLimited: number;
}

// -- token bucket ----------------------------------------------------------------

/** Classic token bucket: burst up to `capacity`, sustained `refillPerSec`. */
class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  tryTake(now: number = Date.now()): boolean {
    const elapsedSec = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// -- peer ------------------------------------------------------------------------

interface Peer {
  readonly conn: WsConnection;
  readonly roomId: string;
  readonly clientId: string;
  readonly name: string;
  readonly color: number;
  lastSeq: number;
  cursor: { x: number; y: number; seq: number } | undefined;
  lastSeen: number;
  lastPingAt: number;
  readonly bucket: TokenBucket;
  readonly stats: PeerStats;
}

// -- room --------------------------------------------------------------------------

class Room {
  readonly peers = new Map<string, Peer>();

  constructor(readonly id: string) {}

  /**
   * Write an ALREADY-SERIALIZED message to every peer except one.
   * One stringify happens at the call site; this is a pure write fan-out.
   */
  broadcast(text: string, exceptClientId?: string): void {
    for (const [id, peer] of this.peers) {
      if (id === exceptClientId) continue;
      peer.conn.send(text);
    }
  }

  /** Last-known presence for a joiner's welcome. Cursor is all-or-none. */
  snapshot(exceptClientId?: string): PeerSnapshot[] {
    const out: PeerSnapshot[] = [];
    for (const [id, p] of this.peers) {
      if (id === exceptClientId) continue;
      if (p.cursor) {
        out.push({ clientId: id, name: p.name, color: p.color, x: p.cursor.x, y: p.cursor.y, seq: p.cursor.seq });
      } else {
        out.push({ clientId: id, name: p.name, color: p.color });
      }
    }
    return out;
  }

  /** Least-used palette index → distinct colors up to palette size. */
  pickColor(): number {
    const counts = new Array<number>(PEER_COLORS.length).fill(0);
    for (const p of this.peers.values()) counts[p.color]++;
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] < counts[best]) best = i;
    }
    return best;
  }

  uniqueGuestName(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = `Guest-${Math.random().toString(36).slice(2, 6)}`;
      let clash = false;
      for (const p of this.peers.values()) {
        if (p.name === candidate) {
          clash = true;
          break;
        }
      }
      if (!clash) return candidate;
    }
    return `Guest-${Date.now().toString(36)}`; // effectively unique
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }
}

// -- manager -------------------------------------------------------------------------

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** conn → its current peer. O(1) routing + zombie-proof close handling. */
  private readonly sessions = new Map<WsConnection, Peer>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly pingMs: number;
  private readonly timeoutMs: number;
  private readonly rateCapacity: number;
  private readonly rateRefillPerSec: number;

  constructor(options: RoomManagerOptions = {}) {
    const hb = options.heartbeat ?? {};
    this.pingMs = hb.pingMs ?? 10_000;
    this.timeoutMs = hb.timeoutMs ?? 25_000;
    const sweepMs = hb.sweepMs ?? 5_000;
    this.rateCapacity = options.rateLimit?.capacity ?? 120;
    this.rateRefillPerSec = options.rateLimit?.refillPerSec ?? 120;
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref();
  }

  /**
   * Join (or re-join) a room. Handles, in order:
   *   1. duplicate hello, same socket + identity → idempotent re-welcome
   *   2. same socket switching identity/room → drop old entry (leave "closed")
   *   3. same identity on a NEW socket → evict old connection (FR-6):
   *      others see leave("replaced") then join; old socket is closed
   *      with reason "replaced by a newer connection"
   */
  join(roomId: string, conn: WsConnection, msg: HelloMsg): { welcome: WelcomeMsg; evictedOld: boolean } {
    const now = Date.now();

    const prior = this.sessions.get(conn);
    if (prior && prior.roomId === roomId && prior.clientId === msg.clientId) {
      const priorRoom = this.rooms.get(prior.roomId);
      if (priorRoom) {
        // Idempotent: re-send the current snapshot, no broadcast churn.
        return { welcome: this.buildWelcome(priorRoom, prior), evictedOld: false };
      }
    }
    if (prior) {
      this.removePeer(prior, "closed"); // identity/room switch on this socket
    }

    const room = this.getOrCreateRoom(roomId);

    let evictedOld = false;
    const existing = room.peers.get(msg.clientId);
    if (existing && existing.conn !== conn) {
      this.removePeer(existing, "replaced"); // broadcasts leave BEFORE the joiner is added
      existing.conn.close(1000, "replaced by a newer connection");
      evictedOld = true;
    }

    const peer: Peer = {
      conn,
      roomId,
      clientId: msg.clientId,
      name: msg.name ?? room.uniqueGuestName(),
      color: room.pickColor(),
      lastSeq: -1,
      cursor: undefined,
      lastSeen: now,
      lastPingAt: now,
      bucket: new TokenBucket(this.rateCapacity, this.rateRefillPerSec),
      stats: { relayed: 0, stale: 0, rateLimited: 0 },
    };
    room.peers.set(peer.clientId, peer);
    this.sessions.set(conn, peer);

    const welcome = this.buildWelcome(room, peer);
    room.broadcast(
      encodeMessage({ t: "join", clientId: peer.clientId, name: peer.name, color: peer.color }),
      peer.clientId,
    );
    return { welcome, evictedOld };
  }

  /** Relay a sequenced action (move/react/say). Rate-limited and stale-dropped silently. */
  action(conn: WsConnection, msg: MoveMsg | ReactMsg | SayMsg): ActionResult {
    const peer = this.sessions.get(conn);
    if (peer === undefined) return "not_joined";
    peer.lastSeen = Date.now();

    if (!peer.bucket.tryTake()) {
      peer.stats.rateLimited++;
      return "rate_limited";
    }
    if (msg.seq <= peer.lastSeq) {
      peer.stats.stale++;
      return "stale";
    }
    peer.lastSeq = msg.seq;

    const room = this.rooms.get(peer.roomId);
    if (room === undefined) return "not_joined"; // unreachable: rooms GC only when empty

    if (msg.t === "move") {
      peer.cursor = { x: msg.x, y: msg.y, seq: msg.seq };
      room.broadcast(
        encodeMessage({ t: "cursor", from: peer.clientId, x: msg.x, y: msg.y, seq: msg.seq, ts: Date.now() }),
        peer.clientId,
      );
    } else if (msg.t === "react") {
      room.broadcast(
        encodeMessage({ t: "reaction", from: peer.clientId, x: msg.x, y: msg.y, emoji: msg.emoji, seq: msg.seq }),
        peer.clientId,
      );
    } else if (msg.t === "say") {
      room.broadcast(
        encodeMessage({
          t: "chat",
          from: peer.clientId,
          name: peer.name,
          color: peer.color,
          text: msg.text,
          seq: msg.seq,
          ts: Date.now(),
        }),
        peer.clientId,
      );
    }
    peer.stats.relayed++;
    return "relayed";
  }

  /** Liveness signal: a WS pong (or any message) refreshes lastSeen. */
  touch(conn: WsConnection): void {
    const peer = this.sessions.get(conn);
    if (peer !== undefined) peer.lastSeen = Date.now();
  }

  /** Socket 'close' event — maps to leave("closed") if this conn still owns a peer. */
  handleClose(conn: WsConnection): void {
    const peer = this.sessions.get(conn);
    if (peer !== undefined) this.removePeer(peer, "closed");
  }

  stats(): { rooms: number; peers: number } {
    let peers = 0;
    for (const room of this.rooms.values()) peers += room.peers.size;
    return { rooms: this.rooms.size, peers };
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  // -- internals ------------------------------------------------------------------

  private buildWelcome(room: Room, peer: Peer): WelcomeMsg {
    return {
      t: "welcome",
      you: { clientId: peer.clientId, name: peer.name, color: peer.color },
      serverTime: Date.now(),
      peers: room.snapshot(peer.clientId),
    };
  }

  private removePeer(peer: Peer, reason: LeaveReason): void {
    const room = this.rooms.get(peer.roomId);
    if (room === undefined) return;
    // ZOMBIE GUARD: only remove if this peer object is STILL the room's entry
    // for its clientId. A late close event from a replaced connection must
    // never evict the newer peer that took its place.
    if (room.peers.get(peer.clientId) !== peer) return;
    room.peers.delete(peer.clientId);
    if (this.sessions.get(peer.conn) === peer) this.sessions.delete(peer.conn);
    // Broadcast AFTER deletion: the leaver neither receives nor echoes its own leave.
    room.broadcast(encodeMessage({ t: "leave", clientId: peer.clientId, reason }));
    if (room.isEmpty()) this.rooms.delete(room.id); // room GC
  }

  private getOrCreateRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (room === undefined) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private sweep(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      for (const peer of [...room.peers.values()]) {
        if (now - peer.lastSeen >= this.timeoutMs) {
          // Half-open connection: no TCP close, no pongs. Cut it hard.
          this.removePeer(peer, "timeout");
          peer.conn.destroy();
          continue;
        }
        if (now - peer.lastPingAt >= this.pingMs) {
          peer.lastPingAt = now;
          peer.conn.ping(); // browsers auto-pong → touch() refreshes lastSeen
        }
      }
    }
  }
}
