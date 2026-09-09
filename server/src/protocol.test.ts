import { describe, expect, it } from "vitest";
import {
  assertNever,
  encodeMessage,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PEER_COLORS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Fixtures — one valid sample of every message shape
// ---------------------------------------------------------------------------

const alice = "c-1111-aaaa";
const bob = "c-2222-bbbb";

const clientSamples: readonly ClientMessage[] = [
  { t: "hello", v: PROTOCOL_VERSION, roomId: "watch-party-42", clientId: alice, name: "Alice" },
  { t: "hello", v: PROTOCOL_VERSION, roomId: "watch-party-42", clientId: alice }, // no name
  { t: "move", x: 0.5, y: 0.25, seq: 7 },
  { t: "react", x: 0.9, y: 0.1, emoji: "🔥", seq: 3 },
  { t: "ping", clientTime: 123.456 }, // fractional ms is legal
  { t: "say", text: "Hello room!", seq: 4 },
];

const serverSamples: readonly ServerMessage[] = [
  {
    t: "welcome",
    you: { clientId: alice, name: "Alice", color: 0 },
    serverTime: 1_700_000_000_000,
    peers: [
      { clientId: bob, name: "Bob", color: 3, x: 0.25, y: 0.75, seq: 12 },
      { clientId: "c-3333-cccc", name: "Carol", color: 7 }, // never moved: no cursor
    ],
  },
  { t: "join", clientId: "c-4444-dddd", name: "Dave", color: 5 },
  { t: "leave", clientId: bob, reason: "timeout" },
  { t: "cursor", from: bob, x: 0.25, y: 0.75, seq: 12, ts: 1_700_000_000_123 },
  { t: "reaction", from: bob, x: 0.9, y: 0.1, emoji: "🎉", seq: 5 },
  { t: "pong", clientTime: 123.456, serverTime: 1_700_000_000_456 },
  { t: "error", code: "malformed", detail: "move.x" },
  { t: "chat", from: bob, name: "Bob", color: 3, text: "Hey Alice!", ts: 1_700_000_000_200, seq: 15 },
];

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

describe("round-trips (encode → parse → equal)", () => {
  for (const sample of clientSamples) {
    it(`client: ${sample.t}`, () => {
      expect(parseClientMessage(encodeMessage(sample))).toEqual({ ok: true, message: sample });
    });
  }
  for (const sample of serverSamples) {
    it(`server: ${sample.t}`, () => {
      expect(parseServerMessage(encodeMessage(sample))).toEqual({ ok: true, message: sample });
    });
  }
});

// ---------------------------------------------------------------------------
// Malformed input — data-driven
// ---------------------------------------------------------------------------

const malformedClientCases: ReadonlyArray<[raw: string, code: ErrorCode, detail?: string]> = [
  ['{"t":"hello","roomId":"r","clientId":"c"}', "bad_version", "hello.v"],
  ['{"t":"hello","v":2,"roomId":"r","clientId":"c"}', "bad_version"],
  ['{"t":"hello","v":1,"roomId":"","clientId":"c"}', "malformed", "hello.roomId"],
  ['{"t":"hello","v":1,"roomId":"r","clientId":"c\\u0001"}', "malformed", "hello.clientId"],
  ['{"t":"hello","v":1,"roomId":"r","clientId":"c","name":""}', "malformed", "hello.name"],
  ['{"t":"hello","v":1,"roomId":"r","clientId":"c","name":null}', "malformed", "hello.name"],
  ['{"t":"move","x":1.5,"y":0.5,"seq":1}', "malformed", "move.x"],
  ['{"t":"move","x":-0.01,"y":0.5,"seq":1}', "malformed", "move.x"],
  ['{"t":"move","x":"0.5","y":0.5,"seq":1}', "malformed", "move.x"],
  ['{"t":"move","x":0.5,"y":0.5,"seq":-1}', "malformed", "move.seq"],
  ['{"t":"move","x":0.5,"y":0.5,"seq":1.5}', "malformed", "move.seq"],
  ['{"t":"react","x":0.1,"y":0.1,"emoji":"😎","seq":1}', "malformed", "react.emoji"],
  ['{"t":"react","x":0.1,"y":0.1,"emoji":"🔥🔥","seq":1}', "malformed", "react.emoji"],
  ['{"t":"ping","clientTime":"now"}', "malformed", "ping.clientTime"],
  ['{"t":"ping","clientTime":-1}', "malformed", "ping.clientTime"],
  ['{"t":"fly","x":0.1}', "unknown_type"],
  ['{"t":"Move","x":0.1}', "unknown_type"], // case-sensitive
  ['{"t":123}', "unknown_type"],
  ['[1,2,3]', "not_object"],
  ['null', "not_object"],
  ['"move"', "not_object"],
  ['{broken', "bad_json"],
  ['', "bad_json"],
];

const malformedServerCases: ReadonlyArray<[raw: string, code: ErrorCode, detail?: string]> = [
  ['{"t":"welcome","you":{"clientId":"a","name":"A","color":' + PEER_COLORS.length + '},"serverTime":1,"peers":[]}', "malformed", "welcome.you.color"],
  ['{"t":"welcome","you":{"clientId":"a","name":"A","color":0},"serverTime":1,"peers":{}}', "malformed", "welcome.peers"],
  ['{"t":"welcome","you":{"clientId":"a","name":"A","color":0},"serverTime":1,"peers":[{"clientId":"b","name":"B","color":1,"x":0.5}]}', "malformed", "peers[0]"],
  ['{"t":"join","clientId":"a","name":"A","color":-1}', "malformed", "join.color"],
  ['{"t":"leave","clientId":"a","reason":"evicted"}', "malformed", "leave.reason"],
  ['{"t":"cursor","from":"a","x":0.5,"y":0.5,"seq":1}', "malformed", "cursor.ts"],
  ['{"t":"error","code":"nope","detail":"x"}', "malformed", "error.code"],
  ['{"t":"error","code":"malformed","detail":"' + "a".repeat(201) + '"}', "malformed", "error.detail"],
];

describe("client parser rejects malformed input", () => {
  for (const [raw, code, detail] of malformedClientCases) {
    it(`${code}: ${raw.slice(0, 60)}`, () => {
      const res = parseClientMessage(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(code);
        if (detail) expect(res.detail).toContain(detail);
      }
    });
  }
});

describe("server parser rejects malformed input", () => {
  for (const [raw, code, detail] of malformedServerCases) {
    it(`${code}: ${raw.slice(0, 60)}`, () => {
      const res = parseServerMessage(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(code);
        if (detail) expect(res.detail).toContain(detail);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Direction isolation — no tag exists in both directions
// ---------------------------------------------------------------------------

describe("cross-direction messages are rejected as unknown_type", () => {
  it("server parser rejects every client message", () => {
    for (const sample of clientSamples) {
      const res = parseServerMessage(encodeMessage(sample));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("unknown_type");
    }
  });
  it("client parser rejects every server message", () => {
    for (const sample of serverSamples) {
      const res = parseClientMessage(encodeMessage(sample));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("unknown_type");
    }
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe("boundary values", () => {
  const move = (x: unknown, y: unknown, seq: unknown) =>
    JSON.stringify({ t: "move", x, y, seq });

  it("coords: 0 and 1 valid; just outside, NaN, Infinity invalid", () => {
    expect(parseClientMessage(move(0, 1, 0)).ok).toBe(true);
    expect(parseClientMessage(move(-0.000001, 0.5, 0)).ok).toBe(false);
    expect(parseClientMessage(move(1.000001, 0.5, 0)).ok).toBe(false);
    // NaN/Infinity serialize to null in JSON — still rejected:
    expect(parseClientMessage(move(NaN, 0.5, 0)).ok).toBe(false);
    expect(parseClientMessage(move(Infinity, 0.5, 0)).ok).toBe(false);
  });

  it("seq: 0 and MAX_SAFE_INTEGER valid; negative, fractional, unsafe invalid", () => {
    expect(parseClientMessage(move(0, 0, 0)).ok).toBe(true);
    expect(parseClientMessage(move(0, 0, Number.MAX_SAFE_INTEGER)).ok).toBe(true);
    expect(parseClientMessage(move(0, 0, -1)).ok).toBe(false);
    expect(parseClientMessage(move(0, 0, 1.5)).ok).toBe(false);
    expect(parseClientMessage(move(0, 0, 2 ** 53)).ok).toBe(false);
  });

  it("name: 24 code points pass, 25 fail (emoji count as one)", () => {
    const hello = (name: string) =>
      JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, roomId: "r", clientId: "c", name });
    expect(parseClientMessage(hello("🔥".repeat(24))).ok).toBe(true);
    expect(parseClientMessage(hello("🔥".repeat(25))).ok).toBe(false);
  });

  it("color: 0 and max index valid; palette length and -1 invalid", () => {
    const join = (color: number) => JSON.stringify({ t: "join", clientId: "a", name: "A", color });
    expect(parseServerMessage(join(0)).ok).toBe(true);
    expect(parseServerMessage(join(PEER_COLORS.length - 1)).ok).toBe(true);
    expect(parseServerMessage(join(PEER_COLORS.length)).ok).toBe(false);
    expect(parseServerMessage(join(-1)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sanitization policy
// ---------------------------------------------------------------------------

describe("sanitization", () => {
  it("unknown extra fields are stripped, not rejected", () => {
    const res = parseClientMessage('{"t":"move","x":0.5,"y":0.5,"seq":1,"evil":"<script>"}');
    expect(res).toEqual({ ok: true, message: { t: "move", x: 0.5, y: 0.5, seq: 1 } });
  });

  it("sanitize is idempotent: re-encoding a parsed message parses identically", () => {
    const first = parseClientMessage('{"t":"move","x":0.5,"y":0.5,"seq":1,"a":1}');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parseClientMessage(encodeMessage(first.message));
    expect(second).toEqual(first);
  });

  it("oversized payloads are rejected before JSON.parse", () => {
    const raw = '{"t":"ping","clientTime":1,"pad":"' + "a".repeat(MAX_MESSAGE_BYTES) + '"}';
    const res = parseClientMessage(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("oversized");
  });

  it("encodeMessage throws above the size cap (programmer error)", () => {
    const huge = { t: "hello", v: 1, roomId: "r".repeat(20000), clientId: "c" } as ClientMessage;
    expect(() => encodeMessage(huge)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness — if a tag is added to a union without
// updating these switches, typecheck fails.
// ---------------------------------------------------------------------------

describe("compile-time exhaustiveness guards", () => {
  it("ClientMessage switch covers all variants", () => {
    const tagOf = (m: ClientMessage): ClientMessage["t"] => {
      switch (m.t) {
        case "hello":
        case "move":
        case "react":
        case "ping":
        case "say":
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf(clientSamples[0])).toBe("hello");
  });

  it("ServerMessage switch covers all variants", () => {
    const tagOf = (m: ServerMessage): ServerMessage["t"] => {
      switch (m.t) {
        case "welcome":
        case "join":
        case "leave":
        case "cursor":
        case "reaction":
        case "pong":
        case "error":
        case "chat":
          return m.t;
        default:
          return assertNever(m);
      }
    };
    expect(tagOf(serverSamples[0])).toBe("welcome");
  });
});

// ---------------------------------------------------------------------------
// Fuzz — parsers must never throw; results always well-formed; sanitize
// is idempotent. Seeded PRNG so failures are reproducible.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHAR_POOL = 'abZ09 \\\"{}\n\t\u0001\u007f😀🔥-_.';
const KEYS = [
  "t", "v", "x", "y", "seq", "from", "ts", "roomId", "clientId", "name",
  "color", "emoji", "peers", "you", "code", "detail", "reason",
  "serverTime", "clientTime",
];
const GARBAGE = ["", "{", "}", "{'t':1}", "\u0000", "not json at all", "😀".repeat(64), '{"t":"move","x":NaN}'];

function randomString(rng: () => number): string {
  let s = "";
  const n = Math.floor(rng() * 12);
  for (let i = 0; i < n; i++) s += CHAR_POOL[Math.floor(rng() * CHAR_POOL.length)];
  return s;
}

function randomValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth > 3) return r < 0.5 ? 0 : "x";
  if (r < 0.15) return Math.floor(rng() * 1e12) - 5e11;
  if (r < 0.25) return rng() < 0.5;
  if (r < 0.35) return null;
  if (r < 0.55) return randomString(rng);
  if (r < 0.70) return Array.from({ length: Math.floor(rng() * 5) }, () => randomValue(rng, depth + 1));
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 6);
  for (let i = 0; i < n; i++) {
    obj[KEYS[Math.floor(rng() * KEYS.length)]] = randomValue(rng, depth + 1);
  }
  return obj;
}

function randomInput(rng: () => number): string {
  const r = rng();
  if (r < 0.30) return JSON.stringify(randomValue(rng, 0));
  if (r < 0.35) return GARBAGE[Math.floor(rng() * GARBAGE.length)];
  // Mutate a known-good sample — exercises field validators hard, and
  // yields plenty of *valid* outputs so the happy path is fuzzed too.
  const pool: unknown[] = [...clientSamples, ...serverSamples];
  const pick = pool[Math.floor(rng() * pool.length)] as Record<string, unknown>;
  const mutated: Record<string, unknown> = { ...pick };
  const keys = Object.keys(mutated);
  const k = keys[Math.floor(rng() * keys.length)];
  if (rng() < 0.3) delete mutated[k];
  else mutated[k] = randomValue(rng, 1);
  return JSON.stringify(mutated);
}

describe("fuzz (2000 seeded iterations)", () => {
  const rng = mulberry32(0xc0ffee);

  it("never throws; results are well-formed; sanitize is idempotent", () => {
    let valid = 0;
    for (let i = 0; i < 2000; i++) {
      const raw = randomInput(rng);
      const rc = parseClientMessage(raw); // a throw here fails the test
      const rs = parseServerMessage(raw);

      const check = (
        res: { ok: true; message: ClientMessage | ServerMessage } | { ok: false; code: ErrorCode; detail: string },
        again: typeof res,
      ) => {
        if (res.ok) {
          valid++;
          expect(again).toEqual(res);
        } else {
          expect(typeof res.code).toBe("string");
          expect(typeof res.detail).toBe("string");
        }
      };

      check(rc, rc.ok ? parseClientMessage(encodeMessage(rc.message)) : rc);
      check(rs, rs.ok ? parseServerMessage(encodeMessage(rs.message)) : rs);
    }
    // Sanity: the fuzzer actually exercised the happy path.
    expect(valid).toBeGreaterThan(20);
  });
});
