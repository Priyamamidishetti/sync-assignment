/**
 * ws.ts — a minimal, hand-rolled RFC 6455 WebSocket server implementation
 * on node:http + node:crypto. No `ws` library.
 *
 * This is the TRANSPORT layer: it knows bytes and frames, not rooms or the
 * application protocol. Phase 2 wires rooms/relay on top of WsConnection.
 *
 * Deliberate scope (see ARCHITECTURE.md decisions log):
 *  - Text frames only; binary → close 1003. Ping/pong/close fully supported.
 *  - Data-frame fragmentation supported (RFC §5.4), including control frames
 *    legally interleaved mid-message.
 *  - No extensions: RSV bits must be 0 → close 1002.
 *  - Client→server frames MUST be masked (close 1002 if not). Server frames
 *    are sent unmasked, as the RFC requires of servers.
 *  - Inbound messages capped at MAX_MESSAGE_BYTES (shared with protocol.ts),
 *    enforced at HEADER-PARSE time — a frame claiming a 1 GiB payload is
 *    rejected before a single payload byte is buffered.
 *  - Text payloads validated as strict UTF-8 → close 1007.
 *  - Close handshake: echo the peer's close, end the socket, with a 2 s
 *    destroy backstop so half-open peers can't linger.
 *  - No send-side backpressure beyond socket buffers (documented limitation,
 *    fine for 3–10 clients — see ARCHITECTURE.md §5).
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import { MAX_MESSAGE_BYTES } from "./protocol.js";

// §1 — Opcodes & errors ------------------------------------------------------

export const Opcode = {
  Continuation: 0,
  Text: 1,
  Binary: 2,
  Close: 8,
  Ping: 9,
  Pong: 10,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];

const KNOWN_OPCODES: readonly number[] = [
  Opcode.Continuation, Opcode.Text, Opcode.Binary,
  Opcode.Close, Opcode.Ping, Opcode.Pong,
];

/** Close codes we use. 1005/1006 are never sent on the wire — local-only. */
export const CLOSE_CODE = {
  Normal: 1000,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  MessageTooBig: 1009,
  InternalError: 1011,
  NoStatus: 1005,
  AbnormalClosure: 1006,
} as const;

/** A protocol violation. `closeCode` is what the connection should send. */
export class WsProtocolError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
    this.name = "WsProtocolError";
  }
}

// §2 — UTF-8 validation (RFC 3629) -------------------------------------------

/**
 * Strict UTF-8 validation. Node's toString("utf8") silently replaces invalid
 * sequences with U+FFFD; RFC 6455 requires closing with 1007 instead, so we
 * validate explicitly. Rejects overlong encodings, surrogate halves,
 * codepoints > U+10FFFF, stray/truncated continuation bytes.
 */
export function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b0 = buf[i];
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    // cont = continuation byte count; [lo, hi] = legal range of the FIRST
    // continuation byte, tightened per lead byte to reject the classes above.
    let cont: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) cont = 1;
    else if (b0 === 0xe0) { cont = 2; lo = 0xa0; }        // no overlong
    else if (b0 >= 0xe1 && b0 <= 0xec) cont = 2;
    else if (b0 === 0xed) { cont = 2; hi = 0x9f; }        // no surrogates
    else if (b0 >= 0xee && b0 <= 0xef) cont = 2;
    else if (b0 === 0xf0) { cont = 3; lo = 0x90; }        // no overlong
    else if (b0 >= 0xf1 && b0 <= 0xf3) cont = 3;
    else if (b0 === 0xf4) { cont = 3; hi = 0x8f; }        // nothing above U+10FFFF
    else return false;

    if (i + cont >= n) return false; // truncated at end of buffer
    const b1 = buf[i + 1];
    if (b1 < lo || b1 > hi) return false;
    for (let k = 2; k <= cont; k++) {
      const bk = buf[i + k];
      if (bk < 0x80 || bk > 0xbf) return false;
    }
    i += 1 + cont;
  }
  return true;
}

// §3 — Frame codec (pure, no sockets) ----------------------------------------

export interface RawFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export interface EncodeFrameInput {
  opcode: number;
  payload?: Buffer;
  /** Defaults to true (unfragmented). */
  fin?: boolean;
  /** 4-byte key; present ⇒ frame is masked (client role). */
  mask?: Buffer;
}

const EMPTY = Buffer.alloc(0);

export function encodeFrame(input: EncodeFrameInput): Buffer {
  const payload = input.payload ?? EMPTY;
  const fin = input.fin ?? true;
  const mask = input.mask;
  const opcode = input.opcode & 0x0f;

  if (mask !== undefined && mask.length !== 4) {
    throw new Error("mask key must be exactly 4 bytes");
  }
  if (opcode >= 8 && payload.length > 125) {
    throw new Error("control frame payload must be ≤ 125 bytes");
  }

  const maskBit = mask !== undefined ? 0x80 : 0;
  const len = payload.length;

  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, maskBit | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (mask === undefined) return Buffer.concat([header, payload]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export interface FrameParserOptions {
  /** true when the peer is a client (its frames MUST be masked). */
  readonly expectMasked: boolean;
  /** Payload cap per frame, checked at header-parse time. */
  readonly maxFrameBytes: number;
}

/**
 * Incremental frame decoder: feed TCP chunks, get complete frames out.
 * Partial frames are buffered across chunks. Throws WsProtocolError
 * (carrying the close code the connection should send) on RFC violations.
 *
 * Pure — no sockets — so it is unit-testable and reusable: the Node test
 * client (test-client.ts) runs the same class with expectMasked: false.
 */
export class FrameParser {
  private buffered: Buffer = EMPTY;
  private readonly expectMasked: boolean;
  private readonly maxFrameBytes: number;

  constructor(options: FrameParserOptions) {
    this.expectMasked = options.expectMasked;
    this.maxFrameBytes = options.maxFrameBytes;
  }

  push(chunk: Buffer): RawFrame[] {
    this.buffered =
      this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: RawFrame[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (frame === null) return frames;
      frames.push(frame);
    }
  }

  private tryParse(): RawFrame | null {
    const buf = this.buffered;
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new WsProtocolError(1002, "RSV bits set — no extension negotiated");
    if (!KNOWN_OPCODES.includes(opcode)) throw new WsProtocolError(1002, `unknown opcode ${opcode}`);
    if (opcode >= 8 && !fin) throw new WsProtocolError(1002, "control frame with FIN=0");
    if (masked !== this.expectMasked) {
      throw new WsProtocolError(
        1002,
        masked ? "server frames must not be masked" : "client frames must be masked",
      );
    }

    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > 0x7fff_ffff_ffff_ffffn) throw new WsProtocolError(1002, "64-bit length with MSB set");
      len = Number(big);
      offset = 10;
    }

    if (opcode >= 8 && len > 125) throw new WsProtocolError(1002, "control frame payload > 125");
    // Size cap at HEADER-PARSE time: a frame claiming a huge payload is
    // rejected here, before we wait for or copy a single payload byte.
    if (len > this.maxFrameBytes) {
      throw new WsProtocolError(1009, `frame payload ${len} > cap ${this.maxFrameBytes}`);
    }

    if (masked) {
      if (buf.length < offset + 4) return null;
      const key = buf.subarray(offset, offset + 4);
      if (buf.length < offset + 4 + len) return null;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + 4 + i] ^ key[i & 3];
      this.buffered = buf.subarray(offset + 4 + len);
      return { fin, opcode, payload };
    }

    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    this.buffered = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

// §4 — Message assembly (fragmentation) --------------------------------------

export type Assembled =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "control"; readonly frame: RawFrame };

/**
 * Turns frames into complete text messages: reassembles fragments, enforces
 * the size cap ACROSS fragments, validates UTF-8, and passes control frames
 * through untouched (they may legally interleave with a fragmented message,
 * RFC 6455 §5.4/§5.5).
 */
export class MessageAssembler {
  private fragments: Buffer[] | null = null;
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  push(frame: RawFrame): Assembled[] {
    if (frame.opcode >= 8) return [{ kind: "control", frame }];

    if (frame.opcode === Opcode.Continuation) {
      if (this.fragments === null) {
        throw new WsProtocolError(1002, "continuation frame without a fragmented message in progress");
      }
      this.total += frame.payload.length;
      if (this.total > this.maxBytes) {
        throw new WsProtocolError(1009, `fragmented message exceeds ${this.maxBytes} bytes`);
      }
      this.fragments.push(frame.payload);
      if (frame.fin) return [{ kind: "text", text: this.finish() }];
      return [];
    }

    // A new data frame while a fragmented message is in progress → violation.
    if (this.fragments !== null) {
      throw new WsProtocolError(1002, "new data frame while a fragmented message is in progress");
    }
    if (frame.opcode === Opcode.Binary) {
      throw new WsProtocolError(1003, "binary frames are not part of this protocol (text only)");
    }
    // opcode === Text
    if (frame.payload.length > this.maxBytes) {
      throw new WsProtocolError(1009, `message exceeds ${this.maxBytes} bytes`);
    }
    if (frame.fin) {
      if (!isValidUtf8(frame.payload)) {
        throw new WsProtocolError(1007, "invalid UTF-8 in text message");
      }
      return [{ kind: "text", text: frame.payload.toString("utf8") }];
    }

    this.total = frame.payload.length;
    this.fragments = [frame.payload];
    return [];
  }

  private finish(): string {
    const full = Buffer.concat(this.fragments as Buffer[]);
    this.fragments = null;
    this.total = 0;
    if (!isValidUtf8(full)) throw new WsProtocolError(1007, "invalid UTF-8 in text message");
    return full.toString("utf8");
  }
}

// §5 — Close-frame payloads ---------------------------------------------------

export function buildClosePayload(code: number, reason: string): Buffer {
  let reasonBytes = Buffer.from(reason, "utf8");
  if (reasonBytes.length > 123) {
    // Cut back to the largest valid UTF-8 boundary ≤ 123 bytes.
    reasonBytes = reasonBytes.subarray(0, 123);
    while (reasonBytes.length > 0 && !isValidUtf8(reasonBytes)) {
      reasonBytes = reasonBytes.subarray(0, reasonBytes.length - 1);
    }
  }
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

export function parseClosePayload(payload: Buffer): { code: number; reason: string } {
  // Empty payload = "no status" (1005) — legal to RECEIVE, never to send.
  if (payload.length === 0) return { code: CLOSE_CODE.NoStatus, reason: "" };
  if (payload.length === 1) throw new WsProtocolError(1002, "close payload of 1 byte");
  const code = payload.readUInt16BE(0);
  const valid =
    (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
  if (!valid) throw new WsProtocolError(1002, `invalid close code ${code}`);
  const reasonBytes = payload.subarray(2);
  if (!isValidUtf8(reasonBytes)) throw new WsProtocolError(1007, "invalid UTF-8 in close reason");
  return { code, reason: reasonBytes.toString("utf8") };
}

// §6 — Handshake --------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function computeAccept(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

export interface WsOptions {
  /** Cap for a single inbound (reassembled) message. Defaults to protocol max. */
  readonly maxMessageBytes?: number;
}

/**
 * Validate a WebSocket upgrade request and complete the server side of the
 * RFC 6455 opening handshake. On success: writes the 101 response, wires a
 * WsConnection to the socket (including any bytes that arrived in `head`),
 * returns it. On failure: writes an HTTP error, destroys the socket,
 * returns null.
 *
 * Types note: http's 'upgrade' event types the socket as Duplex, but at
 * runtime it is always the underlying TCP socket — callers downcast once
 * at this boundary.
 */
export function acceptWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  options: WsOptions = {},
): WsConnection | null {
  const reject = (status: number, text: string, extraHeaders = ""): null => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${extraHeaders}\r\n`);
    socket.destroy();
    return null;
  };

  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const connection = String(req.headers.connection ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];

  if (upgrade !== "websocket" || !connection.includes("upgrade")) {
    return reject(400, "Bad Request");
  }
  if (typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    return reject(400, "Bad Request");
  }
  if (version !== "13") {
    return reject(426, "Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n` +
      "\r\n",
  );
  socket.setNoDelay(true); // small frames, latency-sensitive

  const conn = new WsConnection(socket, options);
  if (head.length > 0) queueMicrotask(() => conn.feed(head)); // bytes that arrived with the upgrade
  return conn;
}

// §7 — Connection (socket wiring) ---------------------------------------------

export class WsConnection extends EventEmitter {
  private readonly socket: net.Socket;
  private readonly parser: FrameParser;
  private readonly assembler: MessageAssembler;
  private closed = false;

  readonly maxMessageBytes: number;

  constructor(socket: net.Socket, options: WsOptions = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.parser = new FrameParser({ expectMasked: true, maxFrameBytes: this.maxMessageBytes });
    this.assembler = new MessageAssembler(this.maxMessageBytes);

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    // Swallow transport errors — they are always followed by 'close', which
    // is where we surface the failure. An unhandled 'error' would crash the
    // process, which is exactly what we must never do on bad input.
    socket.on("error", () => {});
    socket.on("end", () => {
      this.socket.destroy();
    });
    socket.on("close", () => this.onTransportClosed());
  }

  /** Internal: bytes that arrived together with the upgrade (the `head`). */
  feed(chunk: Buffer): void {
    this.onData(chunk);
  }

  get remote(): string {
    return `${this.socket.remoteAddress ?? "?"}:${this.socket.remotePort ?? "?"}`;
  }

  // -- outbound ---------------------------------------------------------------

  /** Send one text message (single unfragmented frame). */
  send(text: string): void {
    if (this.closed) return;
    this.writeFrame({ opcode: Opcode.Text, payload: Buffer.from(text, "utf8") });
  }

  /** Send a ping (payload ≤ 125 bytes). Browser peers auto-pong. */
  ping(payload: Buffer = EMPTY): void {
    if (this.closed) return;
    if (payload.length > 125) throw new Error("ping payload must be ≤ 125 bytes");
    this.writeFrame({ opcode: Opcode.Ping, payload });
  }

  /** Initiate a clean close: send a close frame, then end the socket. */
  close(code: number = CLOSE_CODE.Normal, reason: string = ""): void {
    this.shutdownWith(code, reason);
  }

  /** Hard teardown (eviction, shutdown, test cleanup). Emits close(1006). */
  destroy(): void {
    if (this.closed) {
      this.socket.destroy();
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.emit("close", CLOSE_CODE.AbnormalClosure, "destroyed");
  }

  private writeFrame(input: EncodeFrameInput): void {
    if (!this.socket.writable) return; // transport already gone
    this.socket.write(encodeFrame(input)); // server frames: unmasked (RFC §5.1)
  }

  // -- inbound ----------------------------------------------------------------

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let frames: RawFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.failFrom(err);
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      try {
        for (const event of this.assembler.push(frame)) this.handleAssembled(event);
      } catch (err) {
        this.failFrom(err);
        return;
      }
    }
  }

  private handleAssembled(event: Assembled): void {
    if (event.kind === "text") {
      this.emit("message", event.text);
      return;
    }
    const { opcode, payload } = event.frame;
    if (opcode === Opcode.Close) {
      this.handleCloseFrame(payload);
    } else if (opcode === Opcode.Ping) {
      this.writeFrame({ opcode: Opcode.Pong, payload }); // must echo the payload
    } else {
      this.emit("pong", payload); // heartbeat bookkeeping (Phase 2)
    }
  }

  private handleCloseFrame(payload: Buffer): void {
    let code: number;
    let reason: string;
    try {
      ({ code, reason } = parseClosePayload(payload));
    } catch (err) {
      this.failFrom(err);
      return;
    }
    this.closed = true;
    // Echo the peer's close (or an empty close if the peer sent no status),
    // then end the TCP connection.
    const echo = payload.length === 0 ? EMPTY : buildClosePayload(code, reason);
    this.writeFrame({ opcode: Opcode.Close, payload: echo });
    this.emit("close", code, reason);
    this.socket.end();
    this.destroyAfter(2000);
  }

  private onTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    // Peer vanished without a close handshake (tab kill, RST, network loss).
    this.emit("close", CLOSE_CODE.AbnormalClosure, "transport closed without close frame");
  }

  private failFrom(err: unknown): void {
    if (err instanceof WsProtocolError) this.shutdownWith(err.closeCode, err.message);
    else this.shutdownWith(CLOSE_CODE.InternalError, "internal server error");
  }

  private shutdownWith(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.writeFrame({ opcode: Opcode.Close, payload: buildClosePayload(code, reason) });
    this.emit("close", code, reason);
    this.socket.end();
    this.destroyAfter(2000); // backstop if the peer never reads the close frame
  }

  private destroyAfter(ms: number): void {
    const timer = setTimeout(() => this.socket.destroy(), ms);
    timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
  }

  // -- typed events -------------------------------------------------------------

  override on(event: "message", listener: (text: string) => void): this;
  override on(event: "close", listener: (code: number, reason: string) => void): this;
  override on(event: "pong", listener: (payload: Buffer) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once(event: "message", listener: (text: string) => void): this;
  override once(event: "close", listener: (code: number, reason: string) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
}
