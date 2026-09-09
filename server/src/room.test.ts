import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createLiveRoomServer } from "./server.js";
import type { RoomManager } from "./room.js";
import { TestClient } from "./test-client.js";
import {
  encodeMessage,
  parseServerMessage,
  PEER_COLORS,
  PROTOCOL_VERSION,
  type ReactionEmoji,
  type ServerMessage,
  type WelcomeMsg,
} from "./protocol.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fast heartbeat + small rate bucket so both are testable in milliseconds.
// Production defaults: ping 10s / sweep 5s / timeout 25s, bucket 120/120.
const CONFIG = {
  heartbeat: { pingMs: 40, sweepMs: 15, timeoutMs: 120 },
  rateLimit: { capacity: 20, refillPerSec: 5 },
};

describe("rooms, presence & relay", () => {
  let httpServer: http.Server;
  let manager: RoomManager;
  let clients: TestClient[];

  beforeEach(async () => {
    const app = createLiveRoomServer(CONFIG);
    httpServer = app.httpServer;
    manager = app.manager;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    clients = [];
  });

  afterEach(async () => {
    // Black-box invariant: the server must only ever send protocol-valid frames.
    for (const c of clients) {
      expect(c.invalidMessages, "server sent a message the client parser rejected").toBe(0);
    }
    for (const c of clients) c.destroy();
    httpServer.closeAllConnections();
    manager.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // -- helpers ------------------------------------------------------------------

  const port = () => (httpServer.address() as net.AddressInfo).port;

  const connect = async (opts?: { autoPong?: boolean }): Promise<TestClient> => {
    const c = new TestClient(port(), opts);
    clients.push(c);
    await c.opened;
    return c;
  };

  async function hello(c: TestClient, roomId: string, clientId: string, name?: string): Promise<WelcomeMsg> {
    c.send(
      encodeMessage({
        t: "hello",
        v: PROTOCOL_VERSION,
        roomId,
        clientId,
        ...(name !== undefined ? { name } : {}),
      }),
    );
    const raw = await c.waitForMessage();
    const res = parseServerMessage(raw);
    if (!res.ok || res.message.t !== "welcome") throw new Error(`expected welcome, got: ${raw}`);
    return res.message;
  }

  const move = (c: TestClient, x: number, y: number, seq: number) =>
    c.send(encodeMessage({ t: "move", x, y, seq }));

  const react = (c: TestClient, x: number, y: number, emoji: ReactionEmoji, seq: number) =>
    c.send(encodeMessage({ t: "react", x, y, emoji, seq }));

  function of<T extends ServerMessage["t"]>(c: TestClient, t: T): Extract<ServerMessage, { t: T }>[] {
    return c.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }

  // -- join / welcome ---------------------------------------------------------------

  it("welcome snapshot: new joiner sees all peers with last-known cursors", async () => {
    const a = await connect(); await hello(a, "r1", "A", "Alice");
    const b = await connect(); await hello(b, "r1", "B", "Bob");
    const c = await connect(); await hello(c, "r1", "C", "Carol");
    const d = await connect(); await hello(d, "r1", "D", "Dave");
    move(a, 0.1, 0.2, 1);
    move(b, 0.3, 0.4, 1);
    move(c, 0.5, 0.6, 1);
    await sleep(50); // relays are irrelevant here; cursor STATE is what matters

    const e = await connect();
    const w = await hello(e, "r1", "E");

    expect(w.peers.length).toBe(4);
    const byId = new Map(w.peers.map((p) => [p.clientId, p]));
    expect(byId.get("A")).toMatchObject({ name: "Alice", x: 0.1, y: 0.2, seq: 1 });
    expect(byId.get("B")).toMatchObject({ name: "Bob", x: 0.3, y: 0.4, seq: 1 });
    expect(byId.get("C")).toMatchObject({ name: "Carol", x: 0.5, y: 0.6, seq: 1 });
    // D never moved: cursor triple entirely absent (all-or-none).
    const dSnap = byId.get("D")!;
    expect(dSnap.name).toBe("Dave");
    expect(dSnap.x).toBeUndefined();
    expect(dSnap.y).toBeUndefined();
    expect(dSnap.seq).toBeUndefined();
    // Distinct in-range colors; own identity; server-generated name for E.
    const colors = w.peers.map((p) => p.color);
    expect(new Set(colors).size).toBe(4);
    for (const col of colors) expect(col).toBeLessThan(PEER_COLORS.length);
    expect(w.you.clientId).toBe("E");
    expect(w.you.name.length).toBeGreaterThan(0);
    expect(w.serverTime).toBeGreaterThan(0);
  });

  it("join broadcasts exactly once to each other peer; nobody sees their own join", async () => {
    const cs: TestClient[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await connect();
      await hello(c, "r2", `c${i}`);
      cs.push(c);
    }
    const sixth = await connect();
    await hello(sixth, "r2", "c5");
    await sleep(50);

    for (let i = 0; i < 5; i++) {
      const joinsForC5 = of(cs[i], "join").filter((j) => j.clientId === "c5");
      expect(joinsForC5.length).toBe(1); // exactly one fan-out per observer
      expect(joinsForC5[0].color).toBeLessThan(PEER_COLORS.length);
      expect(joinsForC5[0].name.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < 6; i++) {
      const c = i < 5 ? cs[i] : sixth;
      const own = i < 5 ? `c${i}` : "c5";
      expect(of(c, "join").some((j) => j.clientId === own)).toBe(false);
    }
    expect(of(sixth, "join").length).toBe(0); // joiner saw only its welcome
  });

  // -- relay ---------------------------------------------------------------------------

  it("moves relay to all others, never back to the sender, with server ts", async () => {
    const a = await connect(); await hello(a, "r3", "A", "Alice");
    const b = await connect(); await hello(b, "r3", "B", "Bob");
    const c = await connect(); await hello(c, "r3", "C");
    a.clearMessages(); b.clearMessages(); c.clearMessages();

    move(a, 0.25, 0.75, 7);
    await sleep(50);

    expect(of(a, "cursor").length).toBe(0); // no self-echo
    for (const peer of [b, c]) {
      const cursors = of(peer, "cursor");
      expect(cursors.length).toBe(1);
      expect(cursors[0]).toMatchObject({ from: "A", x: 0.25, y: 0.75, seq: 7 });
      expect(cursors[0].ts).toBeGreaterThan(0);
    }
  });

  it("reactions relay additively to all others", async () => {
    const a = await connect(); await hello(a, "r4", "A");
    const b = await connect(); await hello(b, "r4", "B");
    a.clearMessages(); b.clearMessages();

    react(b, 0.9, 0.1, "🔥", 3);
    await sleep(50);

    const reactions = of(a, "reaction");
    expect(reactions.length).toBe(1);
    expect(reactions[0]).toMatchObject({ from: "B", x: 0.9, y: 0.1, emoji: "🔥", seq: 3 });
    expect(of(b, "reaction").length).toBe(0); // no self-echo
  });

  it("drops stale sequence numbers (defensive duplicate/replay guard)", async () => {
    const a = await connect(); await hello(a, "r5", "A");
    const b = await connect(); await hello(b, "r5", "B");
    move(a, 0.5, 0.5, 5);
    await sleep(30);
    b.clearMessages();

    move(a, 0.6, 0.6, 5); // duplicate seq
    move(a, 0.7, 0.7, 3); // older seq
    move(a, 0.8, 0.8, 6); // fresh → the only one relayed
    await sleep(50);

    const cursors = of(b, "cursor");
    expect(cursors.length).toBe(1);
    expect(cursors[0]).toMatchObject({ seq: 6, x: 0.8, y: 0.8 });
  });

  it("rooms are isolated: relays and leaves never cross rooms", async () => {
    const a = await connect(); await hello(a, "roomX", "A");
    const b = await connect(); await hello(b, "roomX", "B");
    const other = await connect(); await hello(other, "roomY", "C");
    b.clearMessages(); other.clearMessages();

    move(a, 0.5, 0.5, 1);
    await sleep(50);
    expect(of(b, "cursor").length).toBe(1);
    expect(of(other, "cursor").length).toBe(0);

    await a.close(1000);
    await sleep(50);
    expect(of(b, "leave").length).toBe(1);
    expect(of(other, "leave").length).toBe(0);
  });

  // -- leaving -------------------------------------------------------------------------

  it("clean close → leave(reason closed) to others; empty room is GC'd", async () => {
    const a = await connect(); await hello(a, "r6", "A");
    const b = await connect(); await hello(b, "r6", "B");
    b.clearMessages();

    await a.close(1000, "bye");
    await sleep(50);

    const leaves = of(b, "leave");
    expect(leaves.length).toBe(1);
    expect(leaves[0]).toMatchObject({ clientId: "A", reason: "closed" });
    expect(manager.stats().peers).toBe(1);

    await b.close(1000);
    await sleep(50);
    expect(manager.stats()).toEqual({ rooms: 0, peers: 0 });
  });

  it("raw TCP kill (no close frame) → leave within ~1s", async () => {
    const a = await connect(); await hello(a, "r7", "A");
    const b = await connect(); await hello(b, "r7", "B");
    b.clearMessages();

    a.destroy(); // abrupt — no close handshake
    await sleep(100);

    const leaves = of(b, "leave");
    expect(leaves.length).toBe(1);
    expect(leaves[0]).toMatchObject({ clientId: "A", reason: "closed" });
  });

  it("silent peer (no pongs) is evicted by heartbeat with leave(reason timeout)", async () => {
    const a = await connect({ autoPong: false }); await hello(a, "r8", "A"); // hung-peer simulation
    const b = await connect(); await hello(b, "r8", "B");
    b.clearMessages();

    await sleep(400); // timeout 120ms + sweep 15ms (production: 25s + 5s)
    const leaves = of(b, "leave");
    expect(leaves.length).toBe(1);
    expect(leaves[0]).toMatchObject({ clientId: "A", reason: "timeout" });

    // The half-open connection was cut hard — the evicted client sees 1006.
    const closeInfo = await a.waitForClose(1000);
    expect(closeInfo.code).toBe(1006);
  });

  // -- replacement / reconnect (FR-6) -----------------------------------------------------

  it("same clientId on a new connection evicts the old one — no duplicate cursors", async () => {
    const a = await connect();
    const w1 = await hello(a, "r9", "X", "Xena");
    const b = await connect(); await hello(b, "r9", "B");
    const c = await connect(); await hello(c, "r9", "C");
    const oldColor = w1.you.color;

    b.clearMessages(); c.clearMessages();
    const a2 = await connect();
    const w2 = await hello(a2, "r9", "X", "Xena"); // same identity, NEW socket
    expect(w2.peers.map((p) => p.clientId).sort()).toEqual(["B", "C"]);

    // The old socket is closed by the server, with a clear reason.
    const closed = await a.waitForClose(1000);
    expect(closed.code).toBe(1000);
    expect(closed.reason).toContain("replaced");

    await sleep(50);
    // Others saw leave("replaced") THEN join, in order — color preserved.
    for (const peer of [b, c]) {
      const events = peer.messages.filter(
        (m): m is Extract<ServerMessage, { t: "leave" | "join" }> => m.t === "leave" || m.t === "join",
      );
      const relevant = events.filter((e) => e.clientId === "X");
      expect(relevant.map((e) => e.t)).toEqual(["leave", "join"]);
      if (relevant[0].t === "leave") expect(relevant[0].reason).toBe("replaced");
      if (relevant[1].t === "join") expect(relevant[1].color).toBe(oldColor);
    }

    // Exactly ONE peer with id X — a probe's snapshot proves it.
    const probe = await connect();
    const w3 = await hello(probe, "r9", "P");
    expect(w3.peers.filter((p) => p.clientId === "X").length).toBe(1);
    expect(manager.stats().peers).toBe(4); // X, B, C, P
  });

  it("duplicate hello on the same connection is idempotent — no broadcast churn", async () => {
    const a = await connect();
    const w1 = await hello(a, "r10", "A", "Alice");
    const b = await connect(); await hello(b, "r10", "B");
    b.clearMessages();

    const w2 = await hello(a, "r10", "A", "Alice"); // same socket, same identity
    expect(w2.you).toEqual(w1.you); // fresh snapshot, same identity

    await sleep(50);
    expect(of(b, "join").filter((j) => j.clientId === "A").length).toBe(0);
    expect(of(b, "leave").length).toBe(0);
    expect(manager.stats().peers).toBe(2);
  });

  // -- error paths --------------------------------------------------------------------------

  it("actions before hello get a not_joined error; the connection survives", async () => {
    const a = await connect();
    move(a, 0.5, 0.5, 1); // no hello yet
    const raw = await a.waitForMessage();
    const res = parseServerMessage(raw);
    if (!res.ok || res.message.t !== "error") throw new Error(`expected error, got: ${raw}`);
    expect(res.message.code).toBe("not_joined");

    const w = await hello(a, "r11", "A"); // still usable afterwards
    expect(w.you.clientId).toBe("A");
  });

  it("malformed messages get error replies and never kill the connection", async () => {
    const a = await connect(); await hello(a, "r12", "A");
    const b = await connect(); await hello(b, "r12", "B");

    const cases: Array<[string, string]> = [
      ["{not json", "bad_json"],
      ['{"t":"fly"}', "unknown_type"],
      ['{"t":"move","x":2,"y":0.5,"seq":1}', "malformed"],
    ];
    for (const [payload, expectedCode] of cases) {
      a.send(payload);
      const raw = await a.waitForMessage();
      const res = parseServerMessage(raw);
      if (!res.ok || res.message.t !== "error") throw new Error(`expected error, got: ${raw}`);
      expect(res.message.code).toBe(expectedCode);
    }

    // After three violations the connection is still fully functional.
    b.clearMessages();
    move(a, 0.5, 0.5, 1);
    await sleep(50);
    expect(of(b, "cursor").length).toBe(1);
  });

  it("hello with a wrong protocol version → error reply, then close", async () => {
    const a = await connect();
    a.send(encodeMessage({ t: "hello", v: 99, roomId: "r13", clientId: "A" }));
    const raw = await a.waitForMessage();
    const res = parseServerMessage(raw);
    if (!res.ok || res.message.t !== "error") throw new Error(`expected error, got: ${raw}`);
    expect(res.message.code).toBe("bad_version");

    const closed = await a.waitForClose(1000);
    expect(closed.code).toBe(1002);
  });

  // -- ping/pong + rate limit + healthz ---------------------------------------------------------

  it("app-level ping is answered with an echoed pong, before and after joining", async () => {
    const a = await connect();
    a.send(encodeMessage({ t: "ping", clientTime: 1234.5 }));
    const pre = parseServerMessage(await a.waitForMessage());
    if (!pre.ok || pre.message.t !== "pong") throw new Error("expected pong");
    expect(pre.message.clientTime).toBe(1234.5);
    expect(pre.message.serverTime).toBeGreaterThan(0);

    await hello(a, "r14", "A");
    a.clearMessages();
    a.send(encodeMessage({ t: "ping", clientTime: 999 }));
    const post = parseServerMessage(await a.waitForMessage());
    if (!post.ok || post.message.t !== "pong") throw new Error("expected pong");
    expect(post.message.clientTime).toBe(999);
  });

  it("rate limit: flood is dropped beyond budget, order preserved, connection survives", async () => {
    const a = await connect(); await hello(a, "r15", "A");
    const b = await connect(); await hello(b, "r15", "B");
    b.clearMessages();

    // 60 sequenced messages as fast as the loop allows — a burst far above 200 Hz.
    for (let seq = 1; seq <= 60; seq++) move(a, seq / 100, 0.5, seq);
    await sleep(80);

    const cursors = of(b, "cursor");
    expect(cursors.length).toBeGreaterThanOrEqual(15); // most of the burst got through
    expect(cursors.length).toBeLessThanOrEqual(25); // …but bounded by the bucket
    expect(cursors.every((cu) => cu.from === "A")).toBe(true);
    const seqs = cursors.map((cu) => cu.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // per-sender order preserved

    // The connection is still healthy: after refill, a fresh move relays.
    await sleep(400); // +2 tokens at 5/s
    b.clearMessages();
    move(a, 0.99, 0.5, 100);
    await sleep(50);
    expect(of(b, "cursor").length).toBe(1);
  });

  it("healthz reports room and peer counts", async () => {
    const a = await connect(); await hello(a, "r16", "A");
    const b = await connect(); await hello(b, "r16", "B");
    const other = await connect(); await hello(other, "other", "C");

    const res = await fetch(`http://127.0.0.1:${port()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rooms: 2, peers: 3 });
  });
});
