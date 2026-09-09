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

## 3. Client sync core (Phase 3) & interpolation (Phase 4 — pending)

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

### 3.3 Identity & seq epochs
clientId persists in localStorage. ONE seq counter (move+react) never
resets while the page lives. Receivers recreate peer entries on
join/leave — "identity epochs" — resetting per-peer seq baselines, so a
reloaded sender can never be frozen by a stale receiver baseline. The
epoch reset is the load-bearing mechanism; the never-reset counter covers
any missed flapping.

### 3.4 Disconnect detection & reconnect
onclose + watchdog: app-level ping every 5 s; 3 consecutive silent pings
while the tab is visible ⇒ half-open socket ⇒ force-close. (Browsers can
take minutes to notice dead TCP; server WS-pings are invisible to JS.)
Backoff 500 ms ×2 → 8 s cap, ±30 % jitter, unlimited attempts, reset on
welcome. On rejoin, one unthrottled move restores our cursor for others.

### 3.5 Known debt (by design, per phase plan)
Snapping remote cursors (→ Phase 4, via the peerPosition seam), reaction
rendering (→ Phase 5), presence list (→ Phase 5), stale-peer fade (→ 6).

## 4. Failure handling matrix — Phase 6
(disconnect, reconnect, out-of-order, malformed, oversized, flood)

## 5. Scaling beyond one process — Phase 7
(discussion only)

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

