# live-room — real-time multi-client cursor & reaction sync

Raw WebSockets. Hand-rolled protocol, hand-rolled RFC 6455 server codec.
No Socket.IO / Yjs / PartyKit / any sync library.

## Status
- ✅ Phase 0: wire protocol + validators
- ✅ Phase 1: hand-rolled RFC 6455 WebSocket server (handshake, frame codec,
      fragmentation, ping/pong, close handshake, pre-allocation size caps)
- ⏳ Phase 2: rooms, presence, relay — next

## Phase 1 transport rig (temporary — replaced by the real server in Phase 2)
    cd server && npm run dev:echo
Browser devtools console (any page):
    const ws = new WebSocket("ws://localhost:8080/");
    ws.onmessage = (e) => console.log("echo:", e.data);
    ws.onclose  = (e) => console.log("closed:", e.code, e.reason);
    ws.send("hello");   // → echo: hello

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
