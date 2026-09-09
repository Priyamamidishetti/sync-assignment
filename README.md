# live-room — real-time multi-client cursor & reaction sync

Raw WebSockets. Hand-rolled protocol, hand-rolled RFC 6455 server codec.
No Socket.IO / Yjs / PartyKit / any sync library.

## Status
- ✅ Phase 0: wire protocol + validators
- ✅ Phase 1: hand-rolled RFC 6455 WebSocket server
- ✅ Phase 2: rooms, presence, relay, heartbeat, replace-on-reconnect
- ✅ Phase 3: browser client — sync core, throttling, reconnect, cursors (snapping)
- ⏳ Phase 4: interpolation — next (remote cursors currently snap by design)

## Run the demo
Dev (hot reload, two terminals):
    cd server && npm run dev          # :8080
    cd client && npm run dev          # :5173, proxies /ws → :8080
    open http://localhost:5173 in several tabs

Single port (built):
    cd client && npm run build
    cd server && npm run dev
    open http://localhost:8080 in several tabs

Client unit tests (throttle, backoff):  cd client && npm test

## Phase 3 known debt (per phase plan)
- Remote cursors snap to last-known position — Phase 4
- Reactions are console-logged, not rendered — Phase 5
- Presence is a count, not a list — Phase 5
- Stale-peer fade (FR-11) — Phase 6

## Setup (current state)
Server tests:
    cd server && npm install && npm test

Client scaffold smoke check:
    cd client && npm install && npm run dev
    → renders protocol palette; proves the shared module compiles into the client.

## Sections (filled by final submission)
- Protocol design → ARCHITECTURE.md §2
- Interpolation strategy → ARCHITECTURE.md §3
- Failure handling → ARCHITECTURE.md §4
- Known limitations / time spent / AI-tool disclosure → filled Phase 7
