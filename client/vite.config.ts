import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The protocol module physically lives in server/src (matching the
// submission structure) — the client compiles it in via this alias.
// fs.allow lets the dev server serve that file (it's outside client/).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@protocol": fileURLToPath(new URL("../server/src/protocol.ts", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
