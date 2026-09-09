/**
 * server.ts — http server: upgrade routing → RoomManager, /healthz.
 * Static file serving for the client demo lands in Phase 3.
 *
 *   npm run dev   →   http://localhost:8080/  (WebSocket on any path)
 *
 * Per-connection wiring lives here (parse → route); room semantics live in
 * room.ts. Layering: transport (ws) → protocol (parse/validate) → rooms
 * (presence/relay) — adding a new action type touches route() + room.ts +
 * protocol.ts, never the transport.
 */
import * as http from "node:http";
import * as net from "node:net";
import { pathToFileURL } from "node:url";
import { acceptWebSocket, type WsConnection } from "./ws.js";
import { encodeMessage, parseClientMessage, type ClientMessage, type ErrorCode } from "./protocol.js";
import { RoomManager, type RoomManagerOptions } from "./room.js";

const PORT = Number(process.env.PORT ?? 8080);

export function createLiveRoomServer(options: RoomManagerOptions = {}) {
  const manager = new RoomManager(options);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...manager.stats() }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("live-room server — connect a WebSocket to this origin (any path).\n");
  });

  httpServer.on("upgrade", (req, socket, head) => {
    // http types say Duplex; runtime is always the TCP socket for upgrades.
    const conn = acceptWebSocket(req, socket as net.Socket, head);
    if (conn === null) return; // handshake rejected; error response already sent
    wire(manager, conn);
  });

  return { httpServer, manager };
}

function wire(manager: RoomManager, conn: WsConnection): void {
  conn.on("message", (text: string) => {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      // FR-32: malformed → error reply, connection survives…
      sendError(conn, parsed.code, parsed.detail);
      // …except a version mismatch, which cannot proceed.
      if (parsed.code === "bad_version") conn.close(1002, "unsupported protocol version");
      return;
    }
    route(manager, conn, parsed.message);
  });
  conn.on("pong", () => manager.touch(conn));
  conn.on("close", () => manager.handleClose(conn));
}

function route(manager: RoomManager, conn: WsConnection, msg: ClientMessage): void {
  switch (msg.t) {
    case "hello": {
      const { welcome } = manager.join(msg.roomId, conn, msg);
      conn.send(encodeMessage(welcome));
      return;
    }
    case "move":
    case "react": {
      const result = manager.action(conn, msg);
      if (result === "not_joined") {
        sendError(conn, "not_joined", `${msg.t} sent before hello`);
      }
      // "stale" | "rate_limited" | "relayed" → silent by design.
      // Phase 6 adds error signaling + repeated-violation escalation.
      return;
    }
    case "ping": {
      // App-level RTT probe — answered regardless of join state.
      conn.send(encodeMessage({ t: "pong", clientTime: msg.clientTime, serverTime: Date.now() }));
      return;
    }
  }
}

function sendError(conn: WsConnection, code: ErrorCode, detail: string): void {
  conn.send(encodeMessage({ t: "error", code, detail: clampDetail(detail) }));
}

/** Code-point-safe 200-char cap so our own error messages always validate. */
function clampDetail(s: string): string {
  const cps = [...s];
  return cps.length <= 200 ? s : cps.slice(0, 200).join("");
}

// -- entrypoint --------------------------------------------------------------------

function main() {
  const { httpServer, manager } = createLiveRoomServer();
  httpServer.listen(PORT, () => {
    console.log(`[live-room] listening on http://localhost:${PORT} (WebSocket on any path)`);
    console.log(`[live-room] health: http://localhost:${PORT}/healthz`);
  });
  process.on("SIGINT", () => {
    manager.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
