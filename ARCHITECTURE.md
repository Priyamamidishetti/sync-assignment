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

## 3. Interpolation strategy — Phase 4
(buffer keyed on local arrival time; render clock now − 100 ms; lerp;
decaying extrapolation capped at 100 ms; bounded buffers)

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
