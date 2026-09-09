# live-room — real-time multi-client cursor & reaction sync

Raw WebSockets. Hand-rolled protocol, hand-rolled RFC 6455 server codec.
No Socket.IO / Yjs / PartyKit / any sync library.

## Status
- ✅ Phase 0: wire protocol + validators
- ✅ Phase 1: hand-rolled RFC 6455 WebSocket server
- ✅ Phase 2: rooms, presence, relay, heartbeat, replace-on-reconnect
- ✅ Phase 3: client sync core (transport, throttle, reconnect, canvas)
- ✅ Phase 4: interpolation — smooth cursors under degraded networks
- ✅ Phase 5: reactions (tap-to-react bursts), emoji picker, presence list
- ⏳ Phase 6: hardening (stale-peer fade, malformed escalation) — next

## Using the demo
- Click/tap anywhere → reaction burst at that point (everyone sees it).
- Number keys 1–8 or the bottom-right picker switch the emoji.
- The right panel lists participants; the header shows connection state,
  participant count, and RTT.
- Reactions are NOT interpolated (discrete events render on arrival —
  under network throttling they land late, by design).

## Demo: see the interpolation working
- Open two tabs. In dev builds, a bottom-left panel shows per-peer buffer
  depth / extrapolation status / sample rate.
- Devtools → Network → "Slow 3G" (or custom 300 ms + jitter) on one tab:
  remote cursors keep moving smoothly — extrapolation eases them to a stop
  through gaps, then a recovery blend eases them back onto the true path.
- A/B proof: open a second window at the same URL with `?snap=1` —
  interpolation disabled, cursors jump sample-to-sample.
- Devtools → Offline for ~5 s, then back online: cursors ease to a stop
  (not freeze mid-air), and resume without a teleport.

## Run the demo
Dev (hot reload, two terminals):
    cd server && npm run dev          # :8080
    cd client && npm run dev          # :5173, proxies /ws → :8080
    open http://localhost:5173 in several tabs

Single port (built):
    cd client && npm run build
    cd server && npm run dev
    open http://localhost:8080 in several tabs

Client unit tests (throttle, backoff, interpolation, bursts):  cd client && npm test
Server unit tests (ws, protocol, room):                        cd server && npm test

## Phase 5 known debt (per phase plan)
- Stale-peer fade (FR-11) — Phase 6
- Repeated-malformed escalation (disconnect after 5 violations/10s) — Phase 6

## Setup (current state)
Server tests:
    cd server && npm install && npm test

Client tests and build:
    cd client && npm install && npm test && npm run build

## Sections (filled by final submission)
- Protocol design → ARCHITECTURE.md §2
- Interpolation strategy → ARCHITECTURE.md §3
- Failure handling → ARCHITECTURE.md §4
- Known limitations / time spent / AI-tool disclosure → filled Phase 7
