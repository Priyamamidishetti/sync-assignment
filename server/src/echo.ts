/**
 * echo.ts — Phase 1 dev rig (transport smoke test).
 *
 *   npm run dev:echo    →    ws://localhost:8080/
 *
 * Accepts WebSocket upgrades, echoes every text message, pings every 5 s.
 * The real server (rooms + relay) replaces this in Phase 2; the rig stays
 * useful as a transport-level debug tool.
 *
 * Browser check (any page, devtools console):
 *   const ws = new WebSocket("ws://localhost:8080/");
 *   ws.onmessage = (e) => console.log("echo:", e.data);
 *   ws.onclose  = (e) => console.log("closed:", e.code, e.reason);
 *   ws.send("hello");            // → echo: hello
 *   // wait 10+s, send again     // still works: server pings, browser auto-pongs
 *   // close the tab             // rig logs a close event within ~1 s
 */
import * as http from "node:http";
import * as net from "node:net";
import { acceptWebSocket, type WsConnection } from "./ws.js";

const PORT = Number(process.env.PORT ?? 8080);
const PING_INTERVAL_MS = 5_000;

const connections = new Set<WsConnection>();

const log = (event: string, detail: string) =>
  console.log(`[${new Date().toISOString()}] ${event.padEnd(7)} ${detail}`);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("live-room Phase 1 echo rig — connect a WebSocket client to ws://localhost:8080/\n");
});

server.on("upgrade", (req, socket, head) => {
  // http types say Duplex; runtime is always the TCP socket for upgrades.
  const conn = acceptWebSocket(req, socket as net.Socket, head);
  if (conn === null) return; // handshake rejected; error response already sent

  connections.add(conn);
  log("connect", conn.remote);

  conn.on("message", (text) => {
    conn.send(text); // echo ONLY in this rig — the real relay (Phase 2) never echoes
  });

  conn.on("close", (code, reason) => {
    connections.delete(conn);
    log("close", `${conn.remote} code=${code}${reason ? ` reason="${reason}"` : ""}`);
  });
});

// Server-initiated heartbeat: proves ping/pong keeps connections alive
// (browsers auto-pong). Eviction on missing pongs is Phase 2's job.
const pinger = setInterval(() => {
  for (const conn of connections) conn.ping();
}, PING_INTERVAL_MS);
pinger.unref();

server.listen(PORT, () => {
  log("listen", `ws://localhost:${PORT}/ (echo rig, ping every ${PING_INTERVAL_MS / 1000}s)`);
});

process.on("SIGINT", () => {
  for (const conn of connections) conn.close(1001, "server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
