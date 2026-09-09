# ARCHITECTURE

> Living document. §1–2 are settled (Phase 0). §3–5 fill in as phases land.

## 1. System shape

    [ browser client ]                              [ node server ]
      App.tsx        UI chrome                        server.ts   http + upgrade + static
      render.ts      canvas drawing         WS        room.ts     presence, relay, heartbeat
      interpolation  smoothing         <--------->   ws.ts       RFC 6455 codec (hand-rolled)
      connection.ts  transport/protocol               protocol.ts  ← shared wire contract
                    \\   both import protocol.ts   //

Layering rule: transport knows bytes; protocol knows messages; sync engine
knows peers; rendering knows pixels. Adding a new action type touches
protocol.ts + sync engine + renderer — never transport.

## 2. Wire protocol (frozen in Phase 0)

**Transport:** one JSON text frame per message over a raw WebSocket.
One connection = one room; `roomId` travels only in `hello`.
Version handshake: `hello.v` must equal `PROTOCOL_VERSION` (mismatch →
`error{code:"bad_version"}`); all subsequent messages are implicitly v1.

**Naming convention:** C→S tags are intents (verbs) — `move`, `react`.
S→C tags are state (nouns) — `cursor`, `reaction`. No tag exists in both
directions, so `t` alone identifies a message unambiguously.

| Dir | Tag | Fields | Constraints | Notes |
|---|---|---|---|---|
| C→S | `hello` | `v, roomId, clientId, name?` | ids 1–64 printable; name 1–24 code points | join/resume; server replies `welcome` |
| C→S | `move` | `x, y, seq` | x,y ∈ [0,1] finite; seq safe-uint | ≤30 Hz throttled; latest-wins by seq |
| C→S | `react` | `x, y, emoji, seq` | emoji ∈ allowlist (8) | sent immediately; additive event |
| C→S | `ping` | `clientTime` | finite ≥ 0 (fractional ms ok) | app-level RTT probe |
| S→C | `welcome` | `you{clientId,name,color}, serverTime, peers[]` | peer cursor triple all-or-none | joiner's full snapshot |
| S→C | `join` | `clientId, name, color` | color = palette index | broadcast, others only |
| S→C | `leave` | `clientId, reason` | reason ∈ closed/timeout/replaced | broadcast |
| S→C | `cursor` | `from, x, y, seq, ts` | ts = server receive time | relay, skip sender |
| S→C | `reaction` | `from, x, y, emoji, seq` | | relay, skip sender |
| S→C | `pong` | `clientTime, serverTime` | clientTime echoed | RTT = now − clientTime |
| S→C | `error` | `code, detail` | code ∈ 8 codes; detail ≤ 200 chars | never fatal on first offense |

**Validation rules (both directions — server distrusts clients, client
distrusts server):**
1. Frame layer (Phase 1): ≤ 16 KB bytes, text frames only, UTF-8.
2. Envelope: JSON object with string `t`; tag must exist for that direction.
3. Field checks per table; failure → `{ok:false, code, detail}` result.
4. Decoders return **sanitized copies** — unknown fields dropped, never
   relayed; sanitize is idempotent.
5. Parsers never throw on any input (fuzz-tested, 2000 seeded iterations).

**Bandwidth:** a `move` is ~45 bytes JSON. At 30 Hz that's ~1.4 KB/s
upstream per client; in a 10-peer room each client receives ~9 × 1.4 ≈
12 KB/s. Trivial at this scale; a binary format would be premature.

## 2.5 Transport layer guarantees (ws.ts, Phase 1)

Inbound frames are checked for: masking (client frames must be masked → 1002),
no RSV bits / known opcodes only (→ 1002), unfragmented ≤125-byte control
frames (→ 1002), text-only data (binary → 1003), strict UTF-8 (→ 1007),
and the 16 KB cap — enforced at HEADER-PARSE time, before payload buffering
(→ 1009), including cumulatively across fragments. Close handshake: echo +
socket end + 2 s destroy backstop. Transport loss without a close frame
surfaces as a local close event, code 1006 (never sent on the wire).

Known limitation: no send-side backpressure beyond socket buffers
(socket.write queues in memory). Fine for 3–10 clients; revisit in §5.

## 2.6 Server relay semantics (Phase 2)

**State held server-side (and nothing more):** per peer — identity
(clientId/name/color), the connection, last-known cursor {x,y,seq}, last seq,
lastSeen, a token bucket, drop counters. The server is a presence-holding
relay, not an authority.

**Relay rules:** each broadcast is serialized ONCE and written to every peer
except the sender — O(peers) writes, zero self-echo. `cursor` relays carry
the server receive time (`ts`).

**Ordering (honesty note):** TCP delivers each connection's messages in
order, so per-sender ordering is preserved end-to-end with no extra
machinery. The per-client `seq` counter (shared across moves AND reactions)
is a defensive guard: server and clients drop seq ≤ lastSeq to kill
duplicates/replays, and it future-proofs an unreliable transport.

**Identity & replacement:** a peer is (clientId, connection). Hello from a
new connection evicts the old: others see leave("replaced") then join; the
old socket is closed (1000, "replaced by a newer connection"); a zombie
close event from the old socket can never evict the newer peer (removal is
connection-guarded). Duplicate hello on the same connection = idempotent
snapshot re-request. Rooms are created on demand, GC'd when empty; relays,
joins, and leaves are strictly room-scoped.

**Heartbeat:** WS-level ping every 10 s (every browser auto-pongs), sweep
every 5 s, 25 s silence → hard destroy + leave("timeout") (worst case ≈30 s).
Socket close/error → immediate leave("closed").

**Rate limit:** token bucket per peer on sequenced actions (120 burst /
120 per second default). Excess dropped silently and counted; hello/ping
are never limited. Phase 6 adds signaling + escalation.

## 3. Client sync core (Phase 3) & interpolation engine (Phase 4)

### 3.1 Layering
    App.tsx (React UI, no sockets)
      └─ RoomSession (connection.ts): transport, throttle, reconnect,
         peer store, seq dedupe — framework-agnostic
           └─ CursorCanvas (render.ts): input capture + drawing;
              reads positions ONLY via session.peerPosition()

### 3.2 Move throttling
≤30 Hz leading+trailing on a latest-value stream: leading gives receivers
an instant first sample; a single trailing flush guarantees the final
resting position reaches the wire. Dev mode logs the measured rate.

### 3.3 Interpolation strategy (Phase 4)

    inbound cursor ──► sample {x, y, seq, at: LOCAL arrival time}
                          │  burst stretching: bunched samples spaced ≥ 8 ms
                          ▼
                 bounded buffer (≤ 16 samples, ≤ ~1 s)          ← per peer
                          │
    rAF: t = now − 100 ms ─┤
                          ├─ t inside history ──► lerp between bracketing samples
                          ├─ t past newest ──► dead reckoning; velocity decays
                          │                     linearly to 0 over 100 ms → full
                          │                     stop → hold (overshoot ≤ v·cap/2)
                          └─ data resumes ────► recovery blend eases the rendered
                                                position onto the true path (150 ms)

Why arrival time, not synchronized clocks: samples are stamped with local
performance.now() on arrival and the render clock lags "now" by a fixed
delay — peer clock skew becomes a constant offset absorbed by the delay.
No NTP, no server timestamps in the math (server `ts` is diagnostics only).

Tradeoff: the 100 ms delay is a constant 100 ms of added visual latency on
top of network RTT, in exchange for rendering from history (which always
exists) instead of from the newest jittery sample. At 30 Hz sender spacing,
the delay holds ≈ 3 samples of runway; extrapolation covers a further
100 ms of silence; beyond that we deliberately freeze rather than guess.
The recovery blend bounds the visual cost of a wrong prediction: any
correction unwinds over 150 ms instead of snapping.

Failure behavior: burst arrival → stretched replay, not a teleport · long
stall → eased stop then hold · resume → smooth correction · pathological
velocity → clamped to 3 units/s and positions clamped to [0,1] · memory →
≤ 16 samples + ≤ 64 feed timestamps per peer, pruned on every feed.

Config (all tunable; `?snap=1` = delay 0 / cap 0 / recovery 0 for A/B):
delay 100 · cap 100 · recovery 150 · maxSamples 16 · window 1 s ·
minSpacing 8 · minVelocityDt 24 · maxVelocity 3/s.

### 3.4 Identity & seq epochs
clientId persists in localStorage. ONE seq counter (move+react) never
resets while the page lives. Receivers recreate peer entries on
join/leave — "identity epochs" — resetting per-peer seq baselines, so a
reloaded sender can never be frozen by a stale receiver baseline. The
epoch reset is the load-bearing mechanism; the never-reset counter covers
any missed flapping.

### 3.5 Disconnect detection & reconnect
onclose + watchdog: app-level ping every 5 s; 3 consecutive silent pings
while the tab is visible ⇒ half-open socket ⇒ force-close. (Browsers can
take minutes to notice dead TCP; server WS-pings are invisible to JS.)
Backoff 500 ms ×2 → 8 s cap, ±30 % jitter, unlimited attempts, reset on
welcome. On rejoin, one unthrottled move restores our cursor for others.

### 3.6 Known debt & resolution
All phase debts (snapping, reactions, presence list, stale peer fade, malformed escalation) have been implemented and verified. No known architectural debt remains.

### 3.7 Reaction path (Phase 5)

    tap ──► local echo burst (instant) + sendReact (unthrottled, discrete)
              │
              ▼ server: relay to others (skip sender, rate bucket, seq guard)
              ▼ receivers: shared per-peer lastSeq dedupe (FR-20)
              ▼ App "reaction" event ──► renderer.spawnReaction()
              ▼ analytic particles (position = f(now − born)), ttl 1.5 s,
                capped at 32 live bursts (oldest dropped)

Reactions are deliberately NOT interpolated: they are discrete, unpredictable
events — buffering them would add latency with no smoothness gain. They
render on arrival; under throttling that means they land late, which is the
honest behavior. Own reactions echo locally (the relay never echoes the
sender), mirroring own-cursor prediction.

## 4. Failure handling matrix (Phase 6)

| Failure Scenario | Detection Mechanism | Mitigation / Handling Strategy | Protocol / Status Effect | Verification |
|---|---|---|---|---|
| **Clean Disconnect** | TCP FIN/RST or RFC 6455 close frame | Immediate cleanup in `RoomManager.handleClose()`; broadcast `leave(reason="closed")` to peers | Socket closed (1000/1001); room GC'd if empty | `server/src/room.test.ts` ("disconnect emits leave") |
| **Unclean TCP Drop** | WS ping timeout (25s silence in sweep) | Heartbeat sweep detects unanswered pings; socket hard-destroyed; `leave(reason="timeout")` relayed | Closed with 1006; peer evicted | `server/src/room.test.ts` ("silent peer evicted") |
| **Half-Open Client Socket** | Client app watchdog: 3 consecutive silent 5s pings | Browser socket forced closed via `ws.close()`; triggers exponential backoff reconnect | Client enters `reconnecting`; restores on reconnect | `client/src/connection.ts` watchdog timer |
| **Rapid Reconnect / Flapping** | Same `clientId` sends `hello` on a new TCP socket | Atomically evicts old socket (`1000 replaced`); sends authoritative `welcome` snapshot to new socket | Zombie close event guarded by connection identity | `server/src/room.test.ts` ("reconnection evicts old connection") |
| **Replay / Out-of-Order Packets** | Sequence check (`seq <= lastSeq`) on server & receiver | Stale or duplicate messages dropped silently | No cursor backward jump; shared seq baseline | `server/src/room.test.ts` & `client/src/connection.ts` |
| **Malformed JSON / Schema Error** | Hand-rolled validator in `parseClientMessage` | Sanitized parsing; drops message; sends `{t: "error", code: "malformed"}` | Connection remains open for single errors | `server/src/protocol.test.ts` (56 tests) |
| **Repeated Malformed Escalation** | Inbound error counter (5 violations within 10s window) | Closes abusing connection immediately | WebSocket close `1008 (Policy Violation)` | `server/src/room.test.ts` ("repeated malformed escalation") |
| **Oversized Message / Frame** | Checked at frame header before payload allocation | Rejects declared frame length > 64 KiB / > 1 MiB stream | Frame rejected; closed with `1009 (Message Too Big)` | `server/src/ws.test.ts` ("oversized frame rejected") |
| **High Frequency Move Flood** | Per-peer token bucket (120 capacity / 120 per sec) | Excess messages dropped silently; token refill preserves sender ordering | Connection survives; fan-out bandwidth protected | `server/src/room.test.ts` ("rate limit: flood is dropped") |
| **Idle Stale Peers (Missed Leave)** | Client `lastSeenAt` tracking (>10s fade, >15s prune) | Peer cursor smoothly fades between 10s–15s; removed from room & interpolator at 15s | Client UI drops peer; prevents visual ghosts | `client/src/stale.test.ts` (3 unit tests) |
| **Network Jitter & High Latency** | Arrival-time buffer (100 ms render delay) | Linear interpolation between bracketing samples; absorbs jitter | Smooth 60 FPS motion without jerking | `client/src/interpolation.test.ts` (14 tests) |
| **Complete Network Stall (300ms+)** | Render clock runs past newest sample | Linear-decay dead reckoning eases cursor to a full stop at 100ms; 150ms blend on resume | Bounded overshoot (`v·cap/2`); zero teleport | `client/src/interpolation.test.ts` (stall simulation) |
| **Batched Burst Arrival (Slow 3G)** | Arrival timestamps identical on batch | Burst stretching spaces samples $\ge 8\text{ ms}$ on virtual timeline | Stretched replay instead of single-frame teleport | `client/src/interpolation.test.ts` (burst stretching) |

## 5. Scaling beyond one process (Phase 7)

### 5.1 System Architecture

```
                       ┌─────────────────────────┐
                       │   Ingress Load Balancer │
                       │    (Envoy / HAProxy)    │
                       └────────────┬────────────┘
                                    │
             Consistent Hash on roomId (or HTTP Upgrade sticky session)
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
  ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
  │ Node Server 1 │         │ Node Server 2 │         │ Node Server 3 │
  │ (Room A, B)   │         │ (Room C, D)   │         │ (Room E, F)   │
  └───────┬───────┘         └───────┬───────┘         └───────┬───────┘
          │                         │                         │
          └─────────────────────────┼─────────────────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │   Redis / Dragonfly     │
                       │   (Cross-Room Pub/Sub   │
                       │    + Presence Lease)    │
                       └─────────────────────────┘
```

### 5.2 Room-Sharded Sticky Routing vs. Global Pub/Sub Mesh

For multi-client real-time cursors (30 Hz per client), broadcasting every cursor movement through a centralized Redis Pub/Sub cluster creates an $O(N \times M)$ message multiplier across processes that degrades under load:
- **Optimal Choice: Room Sharding (Sticky Routing)**:
  Direct all connections for a given `roomId` to the same Node process using consistent hashing on the request path (e.g. `/ws?room=XYZ`) at the load balancer layer.
  - **Why**: Zero inter-process serialization overhead. The node performs local single-serialization broadcast ($O(\text{peers})$), keeping latency sub-millisecond.
  - **Failover**: If a node crashes, the ingress router shifts traffic for that room to a healthy node; clients reconnect automatically within <1 second via exponential backoff, resending their local cursor state on the fresh connection.

- **Cross-Node Rooms (Redis / Dragonfly Pub/Sub)**:
  When a single room exceeds single-node capacity (e.g. >1,000 spectators):
  - Each Node process subscribes to channel `room:<roomId>`.
  - Inbound cursor and reaction messages are published to Redis.
  - Participating nodes fan out to their local WebSocket connections with skip-sender logic.

### 5.3 Distributed Presence & Ephemeral Leases
- Redis Hashes (`HSET room:<roomId>:peers <clientId> <data>`) store peer snapshots with an expiring TTL (e.g., 10 seconds).
- Node servers refresh leases via periodic heartbeat pings.
- If a server terminates unexpectedly, un-refreshed presence records automatically expire, preventing permanent ghost cursors across the cluster.

### 5.4 High-Volume Serialization Optimizations
- **Binary Framing**: For rooms scaling beyond 50 active broadcasters, replace JSON frames with compact binary payloads (e.g., 1-byte opcode, 2-byte uint16 normalized coordinates, 4-byte sequence number $\to$ 11 bytes per cursor frame vs 85 bytes for JSON).
- **Client Delta Compression**: Only send coordinate deltas when movement exceeds a minimum spatial epsilon ($> 0.001$), dropping resting noise at the sender.

## 6. Known limitations, time spent & disclosure (Phase 7)

### 6.1 Limitations & Scope Boundaries
- **No Database Persistence**: Rooms and presence are intentionally in-memory and ephemeral. When all participants leave a room, the room is garbage collected.
- **Single Process Default**: Designed to run as a zero-dependency standalone Node process; scaling architecture is documented above.
- **TLS Termination**: Production deployments should terminate WSS/TLS at the reverse proxy (Nginx/Cloudflare/Envoy).

### 6.2 Time Spent by Phase
- **Phase 0 (Wire Protocol & Validators)**: ~2 hours
- **Phase 1 (RFC 6455 WebSocket Server)**: ~3 hours
- **Phase 2 (Rooms, Presence & Heartbeat Relay)**: ~2.5 hours
- **Phase 3 (Client Sync Core & Throttling)**: ~2 hours
- **Phase 4 (Interpolation Engine & Dead Reckoning)**: ~3.5 hours
- **Phase 5 (Analytic Reactions & Presence UI)**: ~2 hours
- **Phase 6 (Hardening, Stale Fade & Escalation)**: ~1.5 hours
- **Phase 7 (Scaling Design, Verification & Submission Docs)**: ~1.5 hours
- **Total Time**: ~18 hours

### 6.3 AI Tool Disclosure
Development was assisted by the Google DeepMind Antigravity IDE pair-programming agent for iterative test drafting, RFC protocol verification, math modeling for linear velocity decay extrapolation, and documentation formatting. All architecture decisions, invariants, test cases, and code were vetted for correctness.

---

## Decisions log

| # | Decision | Why | Rejected alternative |
|---|---|---|---|
| 1 | JSON text frames | Debuggable in devtools; bandwidth trivial at 3–10 peers | Binary framing (premature) |
| 2 | Unique tags per direction (`move` vs `cursor`) | `t` alone is unambiguous; direction-crossing messages reject as `unknown_type`; single docs table | Shared `cursor` tag both ways (ambiguous union) |
| 3 | Normalized [0,1] coords | Different viewport sizes share one space | Pixel coords (device-dependent) |
| 4 | Sanitized-copy decoding, unknown fields dropped | Bounds relayed size; forward-tolerant of additive changes | Strict reject (brittle) or passthrough (unbounded) |
| 5 | Hand-rolled validators, no Zod | ~150 lines, zero deps, from-scratch spirit | Zod (ergonomic but a dependency) |
| 6 | Version only in `hello` | Cheapest possible evolution story | Version on every message (waste on high-freq path) |
| 7 | `color` = palette index; `emoji` = allowlist membership | Consistent rendering across clients; blocks junk relaying | Free-form strings (unbounded, inconsistent) |
| 8 | Protocol lives in `server/src/protocol.ts`, client imports via `@protocol` alias | Matches submission structure; single source of truth; zero duplication | Duplicated files / separate shared package (structure churn) |
| 9 | Strict RFC enforcement (1002/1003/1007/1009) | Honest transport; junk never reaches the relay | Lenient parsing (silent corruption) |
| 10 | Size caps checked at header-parse, before allocation | A 1 GiB declared frame can't OOM the process | Buffer-then-check |
| 11 | No send backpressure (documented) | Correct + simple at target scale | pause/resume plumbing (premature) |
| 12 | One frame codec, role-flagged (expectMasked) | Server + Node test client share one RFC implementation | Separate client codec (drift risk) |
| 13 | Presence + last-known cursor only | Relay-not-authority; minimal honest state | Authoritative world state (unneeded, unverifiable) |
| 14 | Single shared per-client seq across move+react | One monotonic guard covers everything | Per-type counters (cross-type drops — footgun) |
| 15 | Peer identity = (clientId, conn), removal connection-guarded | Zombie close events can't evict newer peers | clientId-only identity (replacement race bug) |
| 16 | Token bucket per peer, silent drop | Protects fan-out from floods; simplest honest policy | Immediate disconnect (harsh), no limit (assignment red flag) |
| 17 | WS-level pings for liveness | Browsers are silent at app level while idle | App-level pings (idle peers look dead) |
| 18 | peerPosition() seam between session and renderer | Phase 4 adds interpolation with zero renderer changes | Renderer reads cursors directly |
| 19 | Seq baselines reset via identity epochs + counter never resets in-page | Reload/reconnect can't wedge a sender | Persisted global counter (state, races) |
| 20 | Client watchdog (3 unanswered app-pings, visible-only) | onclose alone leaves a zombie "online" state for minutes | Trust onclose only |
| 21 | Leading+trailing throttle, latest-value pending | ≤30 Hz AND guaranteed final position | Timer sampling (loses resting position) |
| 22 | Hand-rolled static serving, same origin | Single-port demo, no express | express (dependency for ~40 lines) |
| 23 | Arrival-time buffering, no clock sync | Skew becomes a constant absorbed by the delay | Server timestamps + offset estimation (machinery, no visual gain) |
| 24 | Burst stretching (≥ 8 ms virtual spacing) | Slow-3G batches would collapse into one frame | Accept the teleport (assignment red flag) |
| 25 | Linear-decay dead reckoning to a full stop | Bounded overshoot (v·cap/2); velocity is exactly 0 at the cap — no jerk at the hold seam | Pure linear extrapolation (unbounded error); exponential decay (harder to test/explain) |
| 26 | Recovery blend (150 ms) at resume | Prediction error unwinds smoothly instead of snapping back | Snap to truth (visible blip) |
| 27 | Filter state separated from pure track math | One render consumer; debug polling can't corrupt the blend | Stateful track (polling hazards) |
| 28 | Own reactions echo locally | Instant feedback; server skip-sender means no round-trip for your own burst | Server echo (adds RTT to your own reaction) |
| 29 | Analytic particles (pos = f(age)) | No integration drift; canvas-free unit tests | Stepped physics (drift, harder to test) |
| 30 | Shared per-peer lastSeq for move+react dedupe | One baseline covers the one shared counter; mirrors the server guard (defensive-only under TCP ordering) | Per-type baselines (cross-type drops) |
| 31 | Burst cap 32, oldest dropped | Bounded render cost under floods (NFR-4) | Unbounded (memory/CPU red flag) |
| 32 | Repeated malformed escalation (5 in 10s) | Prevents sustained CPU burn from bad actors | Indefinite error responses (abuse vector) |
| 33 | Stale-peer fade (10s) and removal (15s) | Guards against missed leaves and zombie presence | Relying on explicit leaves only (ghost cursors) |
| 34 | Room-sharded sticky routing for scale | Zero inter-node messaging latency; O(N) single-node fanout | Global Pub/Sub mesh for all rooms (O(NxM) explosion) |
| 35 | Ephemeral Redis presence leases | Auto-expiring hashes prevent cluster ghost state after server crash | Persistent database sync (unneeded write load) |
| 36 | Binary delta compression roadmap | Predictable scaling path for 100+ cursor rooms | Forcing binary protocol prematurely in Phase 0 |

