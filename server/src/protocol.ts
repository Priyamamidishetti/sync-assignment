/**
 * Wire protocol for "live-room" — the single source of truth shared by
 * client and server.
 *
 * Design rules (see ARCHITECTURE.md §2):
 *  - Transport: one JSON text frame per message over a raw WebSocket.
 *  - One connection = one room; `roomId` travels only in `hello`.
 *  - Client→Server tags name intents (verbs); Server→Client tags name
 *    state (nouns). Tags are unique across both directions, so a message
 *    is unambiguous by `t` alone.
 *  - Coordinates are normalized [0,1] floats, so peers with different
 *    viewport sizes see the same shared space.
 *  - `seq` is a per-client monotonic counter; receivers drop updates
 *    with seq <= lastSeq (out-of-order / stale protection).
 *  - Decoders return a *sanitized copy*: unknown extra fields are
 *    dropped, not rejected, and never relayed.
 *
 * This module is pure TypeScript — no Node or DOM APIs — so it compiles
 * into both the server (tsc/tsx) and the client (Vite) bundles.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

/**
 * Hard cap on one encoded message. Enforced again, byte-accurately, at the
 * frame layer (Phase 1). Here we check `string.length` as a cheap
 * approximation before JSON.parse — the frame-layer check is authoritative.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Server-assigned peer colors. The wire carries a palette index. */
export const PEER_COLORS = [
  "#f25c54", "#f4a259", "#f8e16c", "#8ac926", "#37a896",
  "#2ab3c1", "#5b8ee6", "#7b6cf6", "#c65cc0", "#e05680",
] as const;

/** Allowlist of reaction emoji. The wire carries the string itself. */
export const REACTION_EMOJIS = ["🔥", "😂", "❤️", "🎉", "👏", "🤯", "🙌", "💀"] as const;

// ---------------------------------------------------------------------------
// Shared field types
// ---------------------------------------------------------------------------

export type ClientId = string; // 1..64 printable chars, client-generated & persisted
export type RoomId = string;   // 1..64 printable chars
export type PeerName = string; // 1..24 printable chars (code points); server assigns if absent
export type PeerColorIndex = number; // 0 .. PEER_COLORS.length - 1
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** All codes the protocol can report. `rate_limited`/`not_joined` are server-only. */
export const ERROR_CODES = [
  "bad_json",      // payload is not valid JSON
  "not_object",    // top-level JSON value is not an object
  "unknown_type",  // `t` missing or not a recognized tag for that direction
  "malformed",     // known tag, field validation failed
  "oversized",     // encoded message exceeds MAX_MESSAGE_BYTES
  "bad_version",   // hello.v !== PROTOCOL_VERSION
  "rate_limited",  // server-only: per-connection message budget exceeded
  "not_joined",    // server-only: action sent before a valid hello
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const LEAVE_REASONS = ["closed", "timeout", "replaced"] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface HelloMsg {
  readonly t: "hello";
  /** Must equal PROTOCOL_VERSION. */
  readonly v: number;
  readonly roomId: RoomId;
  readonly clientId: ClientId;
  /** Optional display name; server assigns one when absent. */
  readonly name?: PeerName;
}

/** Continuous cursor state. Client throttles to ≤ 30 Hz (leading + trailing). */
export interface MoveMsg {
  readonly t: "move";
  readonly x: number; // [0,1]
  readonly y: number; // [0,1]
  readonly seq: number; // per-client monotonic, safe integer
}

export interface ReactMsg {
  readonly t: "react";
  readonly x: number;
  readonly y: number;
  readonly emoji: ReactionEmoji;
  readonly seq: number;
}

/** App-level liveness/RTT probe (distinct from WS protocol-level pings). */
export interface PingMsg {
  readonly t: "ping";
  readonly clientTime: number; // performance.now()-style ms, fractional allowed
}

export type ClientMessage = HelloMsg | MoveMsg | ReactMsg | PingMsg;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface PeerInfo {
  readonly clientId: ClientId;
  readonly name: PeerName;
  readonly color: PeerColorIndex;
}

/**
 * A peer in the joiner's welcome snapshot. The cursor triple `x/y/seq` is
 * all-present or all-absent (a peer that has never moved has no cursor).
 */
export interface PeerSnapshot {
  readonly clientId: ClientId;
  readonly name: PeerName;
  readonly color: PeerColorIndex;
  readonly x?: number;
  readonly y?: number;
  readonly seq?: number;
}

/** Full room state for a new joiner: their own identity + last-known peers. */
export interface WelcomeMsg {
  readonly t: "welcome";
  readonly you: PeerInfo;
  readonly serverTime: number; // Date.now() ms — initial clock-offset estimate
  readonly peers: readonly PeerSnapshot[];
}

export interface JoinMsg extends PeerInfo {
  readonly t: "join";
}

export interface LeaveMsg {
  readonly t: "leave";
  readonly clientId: ClientId;
  readonly reason: LeaveReason;
}

/** Relayed cursor state. `ts` is the server receive time (ms epoch). */
export interface CursorMsg {
  readonly t: "cursor";
  readonly from: ClientId;
  readonly x: number;
  readonly y: number;
  readonly seq: number;
  readonly ts: number;
}

export interface ReactionMsg {
  readonly t: "reaction";
  readonly from: ClientId;
  readonly x: number;
  readonly y: number;
  readonly emoji: ReactionEmoji;
  readonly seq: number;
}

export interface PongMsg {
  readonly t: "pong";
  readonly clientTime: number; // echoed from the ping
  readonly serverTime: number;
}

export interface ErrorMsg {
  readonly t: "error";
  readonly code: ErrorCode;
  readonly detail: string; // ≤ 200 chars, human-readable
}

export type ServerMessage =
  | WelcomeMsg | JoinMsg | LeaveMsg | CursorMsg | ReactionMsg | PongMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

export interface ParseOk<T> {
  readonly ok: true;
  readonly message: T;
}

export interface ParseFail {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly detail: string;
}

export type ParseResult<T> = ParseOk<T> | ParseFail;

/** Exhaustiveness helper for consumer switches over message unions. */
export function assertNever(x: never): never {
  throw new Error(`unhandled message: ${JSON.stringify(x)}`);
}

// ---------------------------------------------------------------------------
// Field validators (private)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Length in code points (emoji count as one, unlike String.length). */
const codePointLength = (s: string): number => [...s].length;

const isPrintable = (s: string): boolean => {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === undefined || c < 0x20 || c === 0x7f) return false;
  }
  return true;
};

/** String, printable, code-point length within [min, max]. */
const str = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const n = codePointLength(v);
  return n >= min && n <= max && isPrintable(v) ? v : null;
};

/** Normalized coordinate: finite number in [0,1]. */
const coord = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;

/** Non-negative safe integer (seq counters). */
const uint = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Non-negative finite number (timestamps; fractional ms allowed). */
const nonneg = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const emoji = (v: unknown): ReactionEmoji | null =>
  typeof v === "string" && (REACTION_EMOJIS as readonly string[]).includes(v)
    ? (v as ReactionEmoji)
    : null;

const colorIndex = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < PEER_COLORS.length
    ? v
    : null;

const malformed = (field: string): ParseFail =>
  ({ ok: false, code: "malformed", detail: field });

// ---------------------------------------------------------------------------
// Decoders (private) — return a sanitized, typed copy or a ParseFail
// ---------------------------------------------------------------------------

const decodeHello = (v: Obj): ParseResult<HelloMsg> => {
  const version = uint(v.v);
  if (version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "bad_version",
      detail: `hello.v=${String(v.v)} expected ${PROTOCOL_VERSION}`,
    };
  }
  const roomId = str(v.roomId, 1, 64);
  if (roomId === null) return malformed("hello.roomId");
  const clientId = str(v.clientId, 1, 64);
  if (clientId === null) return malformed("hello.clientId");
  let name: PeerName | undefined;
  if (v.name !== undefined) {
    const n = str(v.name, 1, 24);
    if (n === null) return malformed("hello.name");
    name = n;
  }
  return {
    ok: true,
    message:
      name === undefined
        ? { t: "hello", v: version, roomId, clientId }
        : { t: "hello", v: version, roomId, clientId, name },
  };
};

const decodeMove = (v: Obj): ParseResult<MoveMsg> => {
  const x = coord(v.x); if (x === null) return malformed("move.x");
  const y = coord(v.y); if (y === null) return malformed("move.y");
  const seq = uint(v.seq); if (seq === null) return malformed("move.seq");
  return { ok: true, message: { t: "move", x, y, seq } };
};

const decodeReact = (v: Obj): ParseResult<ReactMsg> => {
  const x = coord(v.x); if (x === null) return malformed("react.x");
  const y = coord(v.y); if (y === null) return malformed("react.y");
  const e = emoji(v.emoji); if (e === null) return malformed("react.emoji");
  const seq = uint(v.seq); if (seq === null) return malformed("react.seq");
  return { ok: true, message: { t: "react", x, y, emoji: e, seq } };
};

const decodePing = (v: Obj): ParseResult<PingMsg> => {
  const clientTime = nonneg(v.clientTime);
  if (clientTime === null) return malformed("ping.clientTime");
  return { ok: true, message: { t: "ping", clientTime } };
};

const decodePeerInfo = (v: unknown, path: string): ParseResult<PeerInfo> => {
  if (!isObj(v)) return malformed(path);
  const clientId = str(v.clientId, 1, 64);
  if (clientId === null) return malformed(`${path}.clientId`);
  const name = str(v.name, 1, 24);
  if (name === null) return malformed(`${path}.name`);
  const color = colorIndex(v.color);
  if (color === null) return malformed(`${path}.color`);
  return { ok: true, message: { clientId, name, color } };
};

const decodePeerSnapshot = (v: unknown, path: string): ParseResult<PeerSnapshot> => {
  if (!isObj(v)) return malformed(path);
  const info = decodePeerInfo(v, path);
  if (!info.ok) return info;
  const hasX = v.x !== undefined;
  const hasY = v.y !== undefined;
  const hasSeq = v.seq !== undefined;
  // Cursor triple is all-present or all-absent.
  if (hasX !== hasY || hasY !== hasSeq) {
    return malformed(`${path}: x/y/seq must be all present or all absent`);
  }
  if (!hasX) return { ok: true, message: { ...info.message } };
  const x = coord(v.x); if (x === null) return malformed(`${path}.x`);
  const y = coord(v.y); if (y === null) return malformed(`${path}.y`);
  const seq = uint(v.seq); if (seq === null) return malformed(`${path}.seq`);
  return { ok: true, message: { ...info.message, x, y, seq } };
};

const decodeWelcome = (v: Obj): ParseResult<WelcomeMsg> => {
  const you = decodePeerInfo(v.you, "welcome.you");
  if (!you.ok) return you;
  const serverTime = nonneg(v.serverTime);
  if (serverTime === null) return malformed("welcome.serverTime");
  if (!Array.isArray(v.peers)) return malformed("welcome.peers");
  const peers: PeerSnapshot[] = [];
  for (let i = 0; i < v.peers.length; i++) {
    const snap = decodePeerSnapshot(v.peers[i], `welcome.peers[${i}]`);
    if (!snap.ok) return snap;
    peers.push(snap.message);
  }
  return { ok: true, message: { t: "welcome", you: you.message, serverTime, peers } };
};

const decodeJoin = (v: Obj): ParseResult<JoinMsg> => {
  const info = decodePeerInfo(v, "join");
  if (!info.ok) return info;
  return { ok: true, message: { t: "join", ...info.message } };
};

const decodeLeave = (v: Obj): ParseResult<LeaveMsg> => {
  const clientId = str(v.clientId, 1, 64);
  if (clientId === null) return malformed("leave.clientId");
  if (typeof v.reason !== "string" || !(LEAVE_REASONS as readonly string[]).includes(v.reason)) {
    return malformed("leave.reason");
  }
  return { ok: true, message: { t: "leave", clientId, reason: v.reason as LeaveReason } };
};

const decodeCursor = (v: Obj): ParseResult<CursorMsg> => {
  const from = str(v.from, 1, 64);
  if (from === null) return malformed("cursor.from");
  const x = coord(v.x); if (x === null) return malformed("cursor.x");
  const y = coord(v.y); if (y === null) return malformed("cursor.y");
  const seq = uint(v.seq); if (seq === null) return malformed("cursor.seq");
  const ts = nonneg(v.ts); if (ts === null) return malformed("cursor.ts");
  return { ok: true, message: { t: "cursor", from, x, y, seq, ts } };
};

const decodeReaction = (v: Obj): ParseResult<ReactionMsg> => {
  const from = str(v.from, 1, 64);
  if (from === null) return malformed("reaction.from");
  const x = coord(v.x); if (x === null) return malformed("reaction.x");
  const y = coord(v.y); if (y === null) return malformed("reaction.y");
  const e = emoji(v.emoji); if (e === null) return malformed("reaction.emoji");
  const seq = uint(v.seq); if (seq === null) return malformed("reaction.seq");
  return { ok: true, message: { t: "reaction", from, x, y, emoji: e, seq } };
};

const decodePong = (v: Obj): ParseResult<PongMsg> => {
  const clientTime = nonneg(v.clientTime);
  if (clientTime === null) return malformed("pong.clientTime");
  const serverTime = nonneg(v.serverTime);
  if (serverTime === null) return malformed("pong.serverTime");
  return { ok: true, message: { t: "pong", clientTime, serverTime } };
};

const decodeError = (v: Obj): ParseResult<ErrorMsg> => {
  if (typeof v.code !== "string" || !(ERROR_CODES as readonly string[]).includes(v.code)) {
    return malformed("error.code");
  }
  const detail = str(v.detail, 0, 200);
  if (detail === null) return malformed("error.detail");
  return { ok: true, message: { t: "error", code: v.code as ErrorCode, detail } };
};

// ---------------------------------------------------------------------------
// Envelope & public API
// ---------------------------------------------------------------------------

const typeName = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

const parseEnvelope = (raw: string): ParseFail | { ok: true; t: string; obj: Obj } => {
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "oversized", detail: `${raw.length} chars > ${MAX_MESSAGE_BYTES} cap` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: "bad_json", detail: err instanceof Error ? err.message : "JSON.parse failed" };
  }
  if (!isObj(value)) {
    return { ok: false, code: "not_object", detail: `top-level ${typeName(value)}` };
  }
  if (typeof value.t !== "string") {
    return { ok: false, code: "unknown_type", detail: "t missing or non-string" };
  }
  return { ok: true, t: value.t, obj: value };
};

/**
 * Parse and validate a raw payload expected to be a Client→Server message.
 * Never throws: any input yields a typed, sanitized message or a ParseFail.
 */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const env = parseEnvelope(raw);
  if (!env.ok) return env;
  switch (env.t) {
    case "hello": return decodeHello(env.obj);
    case "move":  return decodeMove(env.obj);
    case "react": return decodeReact(env.obj);
    case "ping":  return decodePing(env.obj);
    default:
      return { ok: false, code: "unknown_type", detail: `unknown client message t="${env.t}"` };
  }
}

/**
 * Parse and validate a raw payload expected to be a Server→Client message.
 * Never throws; mirrors parseClientMessage for the opposite direction.
 */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const env = parseEnvelope(raw);
  if (!env.ok) return env;
  switch (env.t) {
    case "welcome":  return decodeWelcome(env.obj);
    case "join":     return decodeJoin(env.obj);
    case "leave":    return decodeLeave(env.obj);
    case "cursor":   return decodeCursor(env.obj);
    case "reaction": return decodeReaction(env.obj);
    case "pong":     return decodePong(env.obj);
    case "error":    return decodeError(env.obj);
    default:
      return { ok: false, code: "unknown_type", detail: `unknown server message t="${env.t}"` };
  }
}

/**
 * Encode a message for the wire. Throws only if the caller constructed a
 * message above the size cap — a programmer error, not network input.
 */
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  const json = JSON.stringify(msg);
  if (json.length > MAX_MESSAGE_BYTES) {
    throw new Error(`encoded message exceeds MAX_MESSAGE_BYTES (${json.length})`);
  }
  return json;
}
