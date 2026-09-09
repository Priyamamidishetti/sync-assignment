import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import {
  FrameParser,
  MessageAssembler,
  Opcode,
  WsProtocolError,
  acceptWebSocket,
  computeAccept,
  encodeFrame,
  isValidUtf8,
  parseClosePayload,
  type RawFrame,
  type WsConnection,
} from "./ws.js";
import { TestClient } from "./test-client.js";
import { MAX_MESSAGE_BYTES } from "./protocol.js";

// -- helpers -------------------------------------------------------------------

function expectWsError(fn: () => unknown, closeCode: number): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!(err instanceof WsProtocolError)) {
    throw new Error(`expected WsProtocolError(${closeCode}), got: ${String(err)}`);
  }
  expect(err.closeCode).toBe(closeCode);
}

const unmaskedParser = () => new FrameParser({ expectMasked: false, maxFrameBytes: MAX_MESSAGE_BYTES });
const maskedParser = () => new FrameParser({ expectMasked: true, maxFrameBytes: MAX_MESSAGE_BYTES });

function roundTrip(payload: Buffer, mask?: Buffer, maxFrameBytes = MAX_MESSAGE_BYTES): RawFrame[] {
  const parser = new FrameParser({ expectMasked: mask !== undefined, maxFrameBytes });
  return parser.push(encodeFrame({ opcode: Opcode.Text, payload, mask }));
}

// -- frame codec -----------------------------------------------------------------

describe("frame codec", () => {
  it("round-trips a small payload (7-bit length)", () => {
    const frames = roundTrip(Buffer.from("hello"));
    expect(frames.length).toBe(1);
    expect(frames[0].fin).toBe(true);
    expect(frames[0].opcode).toBe(Opcode.Text);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  it("round-trips 125/126/200-byte payloads (7-bit ↔ 16-bit boundary)", () => {
    for (const n of [125, 126, 200]) {
      expect(roundTrip(Buffer.alloc(n, 0x61))[0].payload.length).toBe(n);
    }
  });

  it("round-trips a 70 000-byte payload (64-bit extended length)", () => {
    const payload = crypto.randomBytes(70_000);
    const frames = roundTrip(payload, undefined, 100_000);
    expect(frames[0].payload.equals(payload)).toBe(true);
  });

  it("round-trips a masked frame and unmasks the payload", () => {
    const payload = Buffer.from("masked payload — 😀 included");
    const frames = roundTrip(payload, crypto.randomBytes(4));
    expect(frames[0].payload.toString()).toBe(payload.toString());
  });

  it("parses several frames from one chunk", () => {
    const a = encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("a") });
    const b = encodeFrame({ opcode: Opcode.Ping, payload: Buffer.from("hb") });
    const c = encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("c") });
    const frames = unmaskedParser().push(Buffer.concat([a, b, c]));
    expect(frames.map((f) => f.opcode)).toEqual([Opcode.Text, Opcode.Ping, Opcode.Text]);
  });

  it("reassembles a frame fed byte-by-byte (TCP fragmentation)", () => {
    const bytes = encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("slowly") });
    const parser = unmaskedParser();
    const collected: RawFrame[] = [];
    for (let i = 0; i < bytes.length; i++) {
      collected.push(...parser.push(bytes.subarray(i, i + 1)));
    }
    expect(collected.length).toBe(1);
    expect(collected[0].payload.toString()).toBe("slowly");
  });

  it("rejects an unmasked frame when masking is required (1002)", () => {
    expectWsError(
      () => maskedParser().push(encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("x") })),
      1002,
    );
  });

  it("rejects a masked frame when masking is forbidden (1002)", () => {
    expectWsError(
      () =>
        unmaskedParser().push(
          encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("x"), mask: crypto.randomBytes(4) }),
        ),
      1002,
    );
  });

  it("rejects RSV bits (1002)", () => {
    const bytes = encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("x") });
    bytes[0] |= 0x40;
    expectWsError(() => unmaskedParser().push(bytes), 1002);
  });

  it("rejects unknown opcodes (1002)", () => {
    const bytes = encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("x") });
    bytes[0] = (bytes[0] & 0xf0) | 0x03;
    expectWsError(() => unmaskedParser().push(bytes), 1002);
  });

  it("rejects a fragmented control frame (1002)", () => {
    expectWsError(
      () => unmaskedParser().push(encodeFrame({ opcode: Opcode.Ping, payload: Buffer.from("x"), fin: false })),
      1002,
    );
  });

  it("rejects a control frame using a 16-bit payload length (1002)", () => {
    const header = Buffer.alloc(4);
    header[0] = 0x89; // FIN + ping
    header[1] = 126;
    header.writeUInt16BE(200, 2);
    expectWsError(() => unmaskedParser().push(header), 1002);
  });

  it("rejects a declared length over the cap WITHOUT buffering it (1009)", () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81; // FIN + text
    header[1] = 0x7f; // 64-bit length follows
    header.writeBigUInt64BE(0x4000_0000n, 2); // claims 1 GiB — must not allocate
    expectWsError(() => unmaskedParser().push(header), 1009);
  });

  it("rejects a 64-bit length with MSB set (1002)", () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x7f;
    header.writeBigUInt64BE(0x8000_0000_0000_0000n, 2);
    expectWsError(() => unmaskedParser().push(header), 1002);
  });
});

// -- UTF-8 validation ----------------------------------------------------------------

describe("isValidUtf8", () => {
  it("accepts ascii, 2/3/4-byte sequences and emoji", () => {
    expect(isValidUtf8(Buffer.from("hello"))).toBe(true);
    expect(isValidUtf8(Buffer.from([0xc3, 0xa9]))).toBe(true); // é
    expect(isValidUtf8(Buffer.from([0xe2, 0x82, 0xac]))).toBe(true); // €
    expect(isValidUtf8(Buffer.from("😀 fire 🔥"))).toBe(true);
    expect(isValidUtf8(Buffer.alloc(0))).toBe(true);
  });

  it("rejects overlong, surrogate, out-of-range, stray and truncated sequences", () => {
    expect(isValidUtf8(Buffer.from([0xc0, 0xaf]))).toBe(false); // overlong 2-byte lead
    expect(isValidUtf8(Buffer.from([0xe0, 0x9f, 0xbf]))).toBe(false); // overlong 3-byte
    expect(isValidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false); // surrogate half
    expect(isValidUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80]))).toBe(false); // > U+10FFFF
    expect(isValidUtf8(Buffer.from([0x80]))).toBe(false); // stray continuation
    expect(isValidUtf8(Buffer.from([0xf0, 0x9f]))).toBe(false); // truncated
  });
});

// -- message assembler -----------------------------------------------------------------

describe("MessageAssembler", () => {
  const asm = () => new MessageAssembler(MAX_MESSAGE_BYTES);

  it("delivers an unfragmented text message", () => {
    expect(asm().push({ fin: true, opcode: Opcode.Text, payload: Buffer.from("hi") })).toEqual([
      { kind: "text", text: "hi" },
    ]);
  });

  it("assembles fragments into one message", () => {
    const a = asm();
    expect(a.push({ fin: false, opcode: Opcode.Text, payload: Buffer.from("hello ") })).toEqual([]);
    expect(a.push({ fin: true, opcode: Opcode.Continuation, payload: Buffer.from("world") })).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  it("passes control frames through mid-fragmented-message (RFC interleave)", () => {
    const a = asm();
    a.push({ fin: false, opcode: Opcode.Text, payload: Buffer.from("hello ") });
    const out = a.push({ fin: true, opcode: Opcode.Ping, payload: Buffer.from("hb") });
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("control");
    if (out[0].kind === "control") expect(out[0].frame.opcode).toBe(Opcode.Ping);
  });

  it("rejects continuation without a message in progress (1002)", () => {
    expectWsError(
      () => asm().push({ fin: true, opcode: Opcode.Continuation, payload: Buffer.from("x") }),
      1002,
    );
  });

  it("rejects a new text frame mid-message (1002)", () => {
    const a = asm();
    a.push({ fin: false, opcode: Opcode.Text, payload: Buffer.from("hello ") });
    expectWsError(() => a.push({ fin: true, opcode: Opcode.Text, payload: Buffer.from("!") }), 1002);
  });

  it("rejects binary frames (1003)", () => {
    expectWsError(() => asm().push({ fin: true, opcode: Opcode.Binary, payload: Buffer.alloc(4) }), 1003);
  });

  it("enforces the size cap ACROSS fragments (1009)", () => {
    const a = asm();
    a.push({ fin: false, opcode: Opcode.Text, payload: Buffer.alloc(15_000) });
    expectWsError(() => a.push({ fin: true, opcode: Opcode.Continuation, payload: Buffer.alloc(2_000) }), 1009);
  });

  it("rejects invalid UTF-8 in an assembled message (1007)", () => {
    const a = asm();
    a.push({ fin: false, opcode: Opcode.Text, payload: Buffer.from([0xf0, 0x9f]) });
    expectWsError(() => a.push({ fin: true, opcode: Opcode.Continuation, payload: Buffer.from([0x28]) }), 1007);
  });
});

// -- close payload parsing ---------------------------------------------------------------

describe("parseClosePayload", () => {
  it("parses code and reason", () => {
    const payload = Buffer.alloc(2 + 5);
    payload.writeUInt16BE(1000, 0);
    payload.write("bye!!", 2, "utf8");
    expect(parseClosePayload(payload)).toEqual({ code: 1000, reason: "bye!!" });
  });

  it("treats an empty payload as 'no status' (1005)", () => {
    expect(parseClosePayload(Buffer.alloc(0))).toEqual({ code: 1005, reason: "" });
  });

  it("rejects a 1-byte payload (1002)", () => {
    expectWsError(() => parseClosePayload(Buffer.from([0x03])), 1002);
  });

  it("rejects reserved / out-of-range codes (1002)", () => {
    for (const code of [999, 1004, 1005, 1006, 1015, 5000]) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      expectWsError(() => parseClosePayload(payload), 1002);
    }
  });

  it("rejects invalid UTF-8 in the reason (1007)", () => {
    expectWsError(() => parseClosePayload(Buffer.from([0x03, 0xe8, 0x80])), 1007);
  });
});

// -- integration over loopback TCP (real sockets, real handshake) ---------------------------

describe("integration over loopback TCP", () => {
  let rig: Awaited<ReturnType<typeof startRig>>;
  let clients: TestClient[];
  let rawSockets: net.Socket[];

  const startRig = async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("plain http");
    });
    const connections = new Set<WsConnection>();
    const state = {
      server,
      connections,
      port: 0,
      onConnection(conn: WsConnection) {
        conn.on("message", (text: string) => conn.send(text)); // default: echo
      },
    };
    server.on("upgrade", (req, socket, head) => {
      const conn = acceptWebSocket(req, socket as net.Socket, head);
      if (conn === null) return;
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      state.onConnection(conn);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    state.port = (server.address() as net.AddressInfo).port;
    return state;
  };

  beforeEach(async () => {
    rig = await startRig();
    clients = [];
    rawSockets = [];
  });

  afterEach(async () => {
    for (const c of clients) c.destroy();
    for (const s of rawSockets) s.destroy();
    for (const conn of rig.connections) conn.destroy();
    rig.server.closeAllConnections();
    await new Promise<void>((resolve) => rig.server.close(() => resolve()));
  });

  const connect = async (): Promise<TestClient> => {
    const client = new TestClient(rig.port);
    clients.push(client);
    await client.opened;
    return client;
  };

  it("completes the RFC 6455 handshake (101 + Sec-WebSocket-Accept)", async () => {
    await connect();
    expect(rig.connections.size).toBe(1);
    // TestClient.opened already asserted status 101 and validated the accept key.
  });

  it("echoes a text message", async () => {
    const client = await connect();
    client.send("hello phase 1");
    expect(await client.waitForMessage()).toBe("hello phase 1");
  });

  it("echoes a large (near-cap) message", async () => {
    const client = await connect();
    const big = "x".repeat(15_000);
    client.send(big);
    expect(await client.waitForMessage()).toBe(big);
  });

  it("handles a fragmented message interleaved with a ping (exit criterion)", async () => {
    const client = await connect();
    const mask = crypto.randomBytes(4);
    client.sendRaw(encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("hello "), fin: false, mask }));
    client.sendRaw(encodeFrame({ opcode: Opcode.Ping, payload: Buffer.from("hb"), mask }));
    client.sendRaw(
      encodeFrame({ opcode: Opcode.Continuation, payload: Buffer.from("world"), fin: true, mask }),
    );
    // The ping is answered mid-message; the assembled message still arrives whole.
    const pongPromise = client.waitForPong();
    const msgPromise = client.waitForMessage();
    const pong = await pongPromise;
    expect(pong.toString()).toBe("hb");
    expect(await msgPromise).toBe("hello world");
  });

  it("auto-pongs server-initiated pings (payload echoed)", async () => {
    rig.onConnection = (conn) => {
      conn.on("message", (text) => conn.send(text));
      conn.on("pong", (payload) => conn.send(`pong:${payload.toString()}`));
      conn.ping(Buffer.from("hb"));
    };
    const client = await connect();
    expect(await client.waitForMessage()).toBe("pong:hb");
  });

  it("answers client pings with the same payload", async () => {
    const client = await connect();
    client.ping(Buffer.from("rtt"));
    const pong = await client.waitForPong();
    expect(pong.toString()).toBe("rtt");
  });

  it("closes with 1009 on an oversized message", async () => {
    const client = await connect();
    client.send("y".repeat(MAX_MESSAGE_BYTES + 1000));
    const close = await client.waitForClose();
    expect(close.code).toBe(1009);
  });

  it("closes with 1002 on an unmasked client frame", async () => {
    const client = await connect();
    client.sendRaw(encodeFrame({ opcode: Opcode.Text, payload: Buffer.from("naughty") }));
    const close = await client.waitForClose();
    expect(close.code).toBe(1002);
  });

  it("closes with 1003 on a binary frame", async () => {
    const client = await connect();
    client.sendRaw(
      encodeFrame({ opcode: Opcode.Binary, payload: Buffer.from([1, 2, 3]), mask: crypto.randomBytes(4) }),
    );
    const close = await client.waitForClose();
    expect(close.code).toBe(1003);
  });

  it("closes with 1007 on invalid UTF-8 in a text message", async () => {
    const client = await connect();
    client.sendRaw(
      encodeFrame({ opcode: Opcode.Text, payload: Buffer.from([0xf0, 0x28, 0x8c, 0x28]), mask: crypto.randomBytes(4) }),
    );
    const close = await client.waitForClose();
    expect(close.code).toBe(1007);
  });

  it("performs the close handshake: client closes 1000, server echoes and ends", async () => {
    const serverSawClose = new Promise<{ code: number; reason: string }>((resolve) => {
      rig.onConnection = (conn) => {
        conn.on("message", (text) => conn.send(text));
        conn.on("close", (code, reason) => resolve({ code, reason }));
      };
    });
    const client = await connect();
    const close = await client.close(1000, "done");
    expect(close.code).toBe(1000);
    expect(close.reason).toBe("done");
    expect((await serverSawClose).code).toBe(1000);
  });

  it("delivers a server-initiated close with code and reason", async () => {
    rig.onConnection = (conn) => {
      conn.on("message", (text) => conn.send(text));
      conn.close(1000, "server says bye");
    };
    const client = await connect();
    const close = await client.waitForClose();
    expect(close.code).toBe(1000);
    expect(close.reason).toBe("server says bye");
  });

  it("reports abrupt transport loss as 1006 (tab kill / RST)", async () => {
    const serverSawClose = new Promise<{ code: number; reason: string }>((resolve) => {
      rig.onConnection = (conn) => {
        conn.on("message", (text) => conn.send(text));
        conn.on("close", (code, reason) => resolve({ code, reason }));
      };
    });
    const client = await connect();
    client.destroy(); // raw TCP kill — no close frame
    expect((await serverSawClose).code).toBe(1006);
  });

  it("rejects an upgrade without Sec-WebSocket-Key with HTTP 400", async () => {
    const res = await rawHandshake(
      "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n",
    );
    expect(res.status).toContain("400");
  });

  it("rejects a wrong Sec-WebSocket-Version with HTTP 426", async () => {
    const key = crypto.randomBytes(16).toString("base64");
    const res = await rawHandshake(
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 8\r\n`,
    );
    expect(res.status).toContain("426");
  });

  it("processes bytes that arrived together with the handshake (head)", async () => {
    const key = crypto.randomBytes(16).toString("base64");
    const frame = encodeFrame({
      opcode: Opcode.Text,
      payload: Buffer.from("early-bird"),
      mask: crypto.randomBytes(4),
    });
    const request = Buffer.from(
      "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    const socket = net.connect(rig.port, "127.0.0.1");
    rawSockets.push(socket);
    const acc = await new Promise<Buffer>((resolve, reject) => {
      let data = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("timeout waiting for echo")), 2000);
      socket.on("data", (c: Buffer) => {
        data = Buffer.concat([data, c]);
        if (tryParseUpgradeResponse(data, key)) {
          clearTimeout(timer);
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.on("connect", () => socket.write(Buffer.concat([request, frame])));
    });

    const parsed = tryParseUpgradeResponse(acc, key);
    expect(parsed?.status).toContain("101");
    expect(parsed?.accept).toBe(computeAccept(key));
    expect(parsed?.text).toBe("early-bird");
  });

  // -- raw helpers -------------------------------------------------------------

  function rawHandshake(headers: string): Promise<{ status: string; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(rig.port, "127.0.0.1");
      rawSockets.push(socket);
      const parts: Buffer[] = [];
      const fail = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout on raw handshake"));
      }, 2000);
      socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`));
      socket.on("data", (c: Buffer) => parts.push(c));
      socket.on("close", () => {
        clearTimeout(fail);
        const raw = Buffer.concat(parts).toString("latin1");
        resolve({ status: raw.split("\r\n")[0] ?? "", body: raw });
      });
      socket.on("error", reject);
    });
  }

  function tryParseUpgradeResponse(
    data: Buffer,
    key: string,
  ): { status: string; accept: string; text: string } | null {
    const idx = data.indexOf("\r\n\r\n");
    if (idx < 0) return null;
    const headerBlock = data.subarray(0, idx).toString("latin1");
    const status = headerBlock.split("\r\n")[0];
    const accept = /sec-websocket-accept:\s*([^\r\n]+)/i.exec(headerBlock)?.[1] ?? "";
    const parser = unmaskedParser();
    const frames = parser.push(data.subarray(idx + 4));
    const textFrame = frames.find((f) => f.opcode === Opcode.Text);
    return textFrame ? { status, accept, text: textFrame.payload.toString("utf8") } : null;
  }
});
