/**
 * server.ts — http server: upgrade routing → RoomManager, /healthz, and
 * static serving of the built client (../client/dist) so the demo runs
 * single-origin on one port. Hand-rolled static serving (no express):
 * path-traversal-guarded, hashed assets get immutable caching, index.html
 * is no-cache.
 *
 *   npm run dev   →   http://localhost:8080/  (WebSocket on any path)
 *
 * Dev flow alternative: `cd client && npm run dev` (Vite on :5173,
 * proxying /ws here).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acceptWebSocket, type WsConnection } from "./ws.js";
import { encodeMessage, parseClientMessage, type ClientMessage, type ErrorCode } from "./protocol.js";
import { RoomManager, type RoomManagerOptions } from "./room.js";

const PORT = Number(process.env.PORT ?? 8080);
const CLIENT_DIST = fileURLToPath(new URL("../../client/dist", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function createLiveRoomServer(options: RoomManagerOptions = {}) {
  const manager = new RoomManager(options);

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...manager.stats() }));
      return;
    }
    void serveStatic(req, res);
  });

  httpServer.on("upgrade", (req, socket, head) => {
    // http types say Duplex; runtime is always the TCP socket for upgrades.
    const conn = acceptWebSocket(req, socket as net.Socket, head);
    if (conn === null) return; // handshake rejected; error response already sent
    wire(manager, conn);
  });

  return { httpServer, manager };
}

// -- static serving ---------------------------------------------------------------

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  const root = path.normalize(CLIENT_DIST);
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root + path.sep)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let body: Buffer;
  try {
    body = await fs.promises.readFile(filePath);
  } catch {
    if (pathname === "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("client bundle not found — build it: cd client && npm run build\n");
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    // Vite hashes asset filenames → immutable; the document stays fresh.
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(body);
}

// -- per-connection wiring -----------------------------------------------------------

function wire(manager: RoomManager, conn: WsConnection): void {
  let malformedCount = 0;
  let malformedWindowStart = Date.now();

  conn.on("message", (text: string) => {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      sendError(conn, parsed.code, parsed.detail);
      if (parsed.code === "bad_version") {
        conn.close(1002, "unsupported protocol version");
        return;
      }
      const now = Date.now();
      if (now - malformedWindowStart > 10_000) {
        malformedCount = 0;
        malformedWindowStart = now;
      }
      malformedCount += 1;
      if (malformedCount >= 5) {
        conn.close(1008, "repeated malformed messages (5 in 10s)");
      }
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
      return;
    }
    case "ping": {
      conn.send(encodeMessage({ t: "pong", clientTime: msg.clientTime, serverTime: Date.now() }));
      return;
    }
  }
}

function sendError(conn: WsConnection, code: ErrorCode, detail: string): void {
  conn.send(encodeMessage({ t: "error", code, detail: clampDetail(detail) }));
}

function clampDetail(s: string): string {
  const cps = [...s];
  return cps.length <= 200 ? s : cps.slice(0, 200).join("");
}

// -- entrypoint -------------------------------------------------------------------------

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
