import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The protocol module physically lives in server/src (matching the
// submission structure) — the client compiles it in via this alias.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@protocol": fileURLToPath(new URL("../server/src/protocol.ts", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    // Dev-time WebSocket proxy: the client always connects same-origin at
    // /ws; Vite forwards upgrades to the Node server on :8080. In the
    // single-port build, the server itself accepts /ws directly.
    proxy: {
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
