/**
 * test-client.ts — Node-side WebSocket client for tests and scripted
 * multi-client scenarios. Behaves like a well-behaved browser: validates the
 * 101 handshake, auto-pongs WS pings (disable via { autoPong: false } to
 * simulate a hung peer), echoes close frames.
 *
 * Phase 2 additions:
 *   - messages: every successfully parsed inbound ServerMessage, in order
 *   - invalidMessages: inbound messages our parser REJECTED (must stay 0 —
 *     a black-box proof that the server only sends protocol-valid frames)
 *   - clearMessages() for scoped assertions
 *
 * Shares the frame codec with the server (expectMasked flipped) — the exact
 * symmetry RFC 6455 defines.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
  FrameParser,
  MessageAssembler,
  Opcode,
  buildClosePayload,
  computeAccept,
  encodeFrame,
  parseClosePayload,
  type Assembled,
  type RawFrame,
} from "./ws.js";
import { parseServerMessage, MAX_MESSAGE_BYTES, type ServerMessage } from "./protocol.js";

export interface TestClientOptions {
  readonly headers?: Record<string, string>;
  /** Default true. false = never answer WS pings (hung-peer simulation). */
  readonly autoPong?: boolean;
}

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly timer: NodeJS.Timeout;
}

export class TestClient {
  /** Resolves once the 101 handshake is verified (accept header checked). */
  readonly opened: Promise<void>;

  /** Every successfully parsed inbound server message, in order. */
  readonly messages: ServerMessage[] = [];
  /** Inbound messages the parser rejected — should always be 0. */
  invalidMessages = 0;

  private socket: net.Socket | null = null;
  private readonly autoPong: boolean;
  private readonly parser = new FrameParser({ expectMasked: false, maxFrameBytes: MAX_MESSAGE_BYTES });
  private readonly assembler = new MessageAssembler(MAX_MESSAGE_BYTES);
  private sentClose = false;
  private closeResult: { code: number; reason: string } | null = null;

  private readonly messageWaiters: Waiter<string>[] = [];
  private readonly closeWaiters: Waiter<{ code: number; reason: string }>[] = [];
  private readonly pongWaiters: Waiter<Buffer>[] = [];

  constructor(port: number, options: TestClientOptions = {}) {
    this.autoPong = options.autoPong ?? true;
    const key = crypto.randomBytes(16).toString("base64");
    this.opened = new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/",
        agent: false, // one-off socket; never pooled
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          ...options.headers,
        },
      });
      req.on("upgrade", (res, socket, head) => {
        const accept = res.headers["sec-websocket-accept"];
        if (res.statusCode !== 101 || accept !== computeAccept(key)) {
          socket.destroy();
          reject(new Error(`handshake failed: status=${res.statusCode}`));
          return;
        }
        this.socket = socket as net.Socket; // Duplex → TCP socket, same downcast as server side
        socket.setNoDelay(true);
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", () => {}); // 'close' follows
        socket.on("close", () => this.onTransportClosed());
        if (head.length > 0) this.onData(head);
        resolve();
      });
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`expected 101 upgrade, got ${res.statusCode}`));
      });
      req.end();
    });
  }

  clearMessages(): void {
    this.messages.length = 0;
  }

  // -- waits -------------------------------------------------------------------

  waitForMessage(timeoutMs = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout: no message")), timeoutMs);
      timer.unref();
      this.messageWaiters.push({ resolve, timer });
    });
  }

  waitForClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    if (this.closeResult) return Promise.resolve(this.closeResult); // already closed
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout: no close")), timeoutMs);
      timer.unref();
      this.closeWaiters.push({ resolve, timer });
    });
  }

  waitForPong(timeoutMs = 2000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout: no pong")), timeoutMs);
      timer.unref();
      this.pongWaiters.push({ resolve, timer });
    });
  }

  // -- outbound ------------------------------------------------------------------

  send(text: string): void {
    this.sendRaw(
      encodeFrame({ opcode: Opcode.Text, payload: Buffer.from(text, "utf8"), mask: crypto.randomBytes(4) }),
    );
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    this.sendRaw(encodeFrame({ opcode: Opcode.Ping, payload, mask: crypto.randomBytes(4) }));
  }

  /** Escape hatch for protocol-violation tests: raw bytes, verbatim. */
  sendRaw(bytes: Buffer): void {
    this.socket?.write(bytes);
  }

  /** Clean close handshake. Resolves with the server's echoed close. */
  async close(code = 1000, reason = ""): Promise<{ code: number; reason: string }> {
    this.sentClose = true;
    this.sendRaw(
      encodeFrame({ opcode: Opcode.Close, payload: buildClosePayload(code, reason), mask: crypto.randomBytes(4) }),
    );
    const res = await this.waitForClose(2000);
    this.socket?.destroy();
    return res;
  }

  destroy(): void {
    this.socket?.destroy();
  }

  // -- inbound -------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    let frames: RawFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.socket?.destroy(); // server sent a protocol-violating frame
      return;
    }
    for (const frame of frames) {
      let events: Assembled[];
      try {
        events = this.assembler.push(frame);
      } catch {
        this.socket?.destroy();
        return;
      }
      for (const ev of events) this.handle(ev);
    }
  }

  private handle(ev: Assembled): void {
    if (ev.kind === "text") {
      const parsed = parseServerMessage(ev.text);
      if (parsed.ok) {
        this.messages.push(parsed.message);
      } else {
        this.invalidMessages++;
      }
      const w = this.messageWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(ev.text);
      }
      return;
    }
    const { opcode, payload } = ev.frame;
    if (opcode === Opcode.Close) {
      if (!this.sentClose) {
        // A well-behaved client echoes the close before ending.
        this.sendRaw(
          encodeFrame({
            opcode: Opcode.Close,
            payload: payload.length === 0 ? Buffer.alloc(0) : payload,
            mask: crypto.randomBytes(4),
          }),
        );
      }
      let code = 1006;
      let reason = "";
      try {
        ({ code, reason } = parseClosePayload(payload));
      } catch {
        // keep defaults — invalid close frame from server
      }
      this.closeResult = { code, reason };
      const w = this.closeWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve({ code, reason });
      }
      this.socket?.end();
      setTimeout(() => this.socket?.destroy(), 500).unref();
    } else if (opcode === Opcode.Ping) {
      if (this.autoPong) {
        this.sendRaw(encodeFrame({ opcode: Opcode.Pong, payload, mask: crypto.randomBytes(4) }));
      }
    } else {
      // pong from server
      const w = this.pongWaiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(payload);
      }
    }
  }

  private onTransportClosed(): void {
    if (this.closeResult) return;
    this.closeResult = { code: 1006, reason: "transport closed" };
    const w = this.closeWaiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(this.closeResult);
    }
  }
}
