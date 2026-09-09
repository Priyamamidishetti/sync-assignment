# live-room — real-time multi-client cursor & reaction sync

Raw WebSockets. Hand-rolled protocol, hand-rolled RFC 6455 server codec.
No Socket.IO / Yjs / PartyKit / any sync library.

## Status
- ✅ Phase 0: wire protocol + validators
- ✅ Phase 1: hand-rolled RFC 6455 WebSocket server
- ✅ Phase 2: rooms, presence, relay, heartbeat, replace-on-reconnect
- ⏳ Phase 3: browser client — next

## Run the server
    cd server && npm run dev
    # WebSocket: any path on ws://localhost:8080/ · health: http://localhost:8080/healthz
(No browser client yet — Phase 3. `npm run dev:echo` still runs the Phase 1 echo rig
as a transport debug tool.)

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
