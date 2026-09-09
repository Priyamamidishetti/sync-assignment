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
- ✅ Phase 6: hardening (stale-peer fade, malformed escalation, failure matrix)
- ✅ Phase 7: production scaling & architecture documentation

## Verification & Acceptance Criteria Matrix

| Criterion | Requirement | Implementation & Proof | Status |
|---|---|---|:---:|
| **AC-1** | Multi-client cursor synchronization | Normalized coordinates [0,1], peer colors, name pills, single-serialization broadcast | PASS |
| **AC-2** | Smooth interpolation (normal conditions) | 100 ms arrival-time buffer with lerp; absorbs sender jitter without clock synchronization | PASS |
| **AC-3** | Network jitter & stall recovery | Linear-decay dead reckoning eases to full stop at 100 ms; 150 ms blend on resume (tested in `interpolation.test.ts`) | PASS |
| **AC-4** | Burst batch stretching | Slow 3G batches spaced $\ge 8\text{ ms}$ on virtual timeline, turning collapses into replays | PASS |
| **AC-5** | Zero added latency for local cursor | Local prediction on `pointermove` renders instantly without waiting for network round-trip | PASS |
| **AC-6** | Reaction bursts & local echo | Taps trigger instant local echo burst + unthrottled `react` relay; analytic particle trajectories | PASS |
| **AC-7** | Live presence roster | Real-time participant drawer with assigned color dots; dynamic updates on join/leave | PASS |
| **AC-8** | Clean reconnect & zombie eviction | Persisted `clientId` evicts old connection (`1000 replaced`); connection-guarded close handler | PASS |
| **AC-9** | Stale peer fade & removal (FR-11) | Inactive peers fade between 10s–15s and are pruned from memory and canvas at 15s (`stale.test.ts`) | PASS |
| **AC-10** | Rate limiting & abuse escalation | Per-peer token bucket (120/s) drops excess; 5 malformed frames in 10s triggers 1008 disconnect | PASS |
| **AC-11** | RFC 6455 transport compliance | Hand-rolled frame codec, masking, fragmentation, ping/pong heartbeats, UTF-8 checks (45 tests in `ws.test.ts`) | PASS |

## Run the demo

### Dev (hot reload, two terminals):
```bash
cd server && npm run dev          # :8080 WebSocket + API
cd client && npm run dev          # :5173 Vite dev server, proxies /ws → :8080
open http://localhost:5173 in multiple tabs
```

### Single port (production bundle):
```bash
cd client && npm run build        # compiles bundle to client/dist
cd server && npm run dev          # serves static assets + WebSocket on :8080
open http://localhost:8080 in multiple tabs
```

## Running Automated Tests

```bash
cd server && npm test             # 119 server tests (ws, protocol, room, escalation)
cd client && npm test             # 32 client tests (throttle, backoff, interpolation, bursts, stale)
```

## Demo Instructions

1. **Multi-Peer Sync**: Open `http://localhost:5173/?room=demo` in 3+ tabs side-by-side. Move your pointer in one window to watch smooth cursors glide across all other tabs.
2. **A/B Interpolation Proof**: Open another tab with `http://localhost:5173/?room=demo&snap=1`. Compare cursor movement: `snap=1` jumps sample-to-sample, while default mode glides smoothly.
3. **Reactions**: Click/tap anywhere on the canvas to trigger emoji bursts. Switch emojis using the bottom-right picker or number keys `1`–`8`.
4. **Dev Inspector**: In dev mode, check the bottom-left panel for live buffer depth ($\le 16$), mode (`lerp` / `extrapolate` / `hold`), and update rate ($\approx 30/\text{s}$).
5. **Degraded Network Simulation**: In DevTools Network tab, set throttling to "Slow 3G" or 300 ms latency:
   - Notice cursors ease to a stop instead of snapping.
   - When connection resumes, cursors blend onto the true path without teleports.
6. **Stale Peer Fade**: Leave one tab idle for 10 seconds — its cursor and roster entry begin fading, and disappear completely at 15 seconds.

## Architecture & Design Documentation
- Protocol design → [`ARCHITECTURE.md` §2](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#2-wire-protocol-phase-0)
- Interpolation strategy → [`ARCHITECTURE.md` §3](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#3-client-sync-core-phase-3--interpolation-engine-phase-4)
- Full failure handling matrix → [`ARCHITECTURE.md` §4](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#4-failure-handling-matrix-phase-6)
- Multi-process scaling design → [`ARCHITECTURE.md` §5](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#5-scaling-beyond-one-process-phase-7)
- Known limitations, time spent & AI disclosure → [`ARCHITECTURE.md` §6](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#6-known-limitations-time-spent--disclosure-phase-7)
- Decisions log (#1–#36) → [`ARCHITECTURE.md` Decisions Log](file:///Users/akshith/LG/multiplayer-sync-assignment/ARCHITECTURE.md#decisions-log)
