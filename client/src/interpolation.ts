/**
 * interpolation.ts — the remote-cursor interpolation engine (Phase 4).
 *
 * Strategy in one paragraph: every inbound cursor update becomes a SAMPLE
 * stamped with its LOCAL arrival time; the renderer runs on a clock that
 * lags "now" by renderDelayMs (default 100 ms) and positions are linearly
 * interpolated between the two samples bracketing that time. When the
 * render clock runs past the newest sample (network hiccup), we extrapolate
 * by dead reckoning with a velocity that decays LINEARLY to zero over
 * extrapolationCapMs — the cursor eases to a full stop and holds there
 * instead of flying off. When fresh data resumes, a short recovery blend
 * eases from the predicted position onto the true path, so a stall never
 * ends in a teleport. Keyed entirely on LOCAL arrival time — no clock
 * synchronization is ever needed.
 *
 * Robustness details that matter under real networks:
 *  - Bounded memory: ≤ maxSamples (16) and ≤ ~windowMs (1 s) of history per
 *    peer (FR-26). Verified by a 60-second 30 Hz simulation in tests.
 *  - Burst stretching: when the network delivers a batch at once (Slow 3G
 *    does), identical arrival timestamps would collapse the batch into a
 *    single frame — a teleport. Bunched samples are spaced ≥
 *    minSampleSpacingMs (8 ms) on a virtual timeline, becoming a replay.
 *  - Velocity guards: computed from the nearest pair at least
 *    minVelocityDtMs apart (skips stretched neighbors and sub-frame noise),
 *    magnitude-clamped (a pathological sender cannot rocket cursors away).
 *  - Defensive seq drop (the session already dedupes; the track re-checks).
 *
 * Purity split: PeerTrack.evaluate() is pure math (unit-tested directly).
 * The recovery blend lives in a separate per-peer RenderFilter driven ONLY
 * by the render path — a single consumer, so debug polling can never
 * corrupt its state.
 */

export interface InterpolationConfig {
  /** Render clock lags real time by this much. 0 = no added latency. */
  readonly renderDelayMs: number;
  /** Extrapolation window past the newest sample; velocity decays to 0. */
  readonly extrapolationCapMs: number;
  /** Resume blend duration from predicted position onto the true path. */
  readonly recoveryMs: number;
  /** Hard cap on buffered samples per peer. */
  readonly maxSamples: number;
  /** Age window for buffered samples. */
  readonly windowMs: number;
  /** Minimum spacing on the virtual timeline between bunched samples. */
  readonly minSampleSpacingMs: number;
  /** Velocity pairs closer than this (arrival-time) are ignored. */
  readonly minVelocityDtMs: number;
  /** Speed limit for extrapolation, normalized units per second. */
  readonly maxVelocityPerSec: number;
}

export const DEFAULT_INTERPOLATION: InterpolationConfig = {
  renderDelayMs: 100,
  extrapolationCapMs: 100,
  recoveryMs: 150,
  maxSamples: 16,
  windowMs: 1_000,
  minSampleSpacingMs: 8,
  minVelocityDtMs: 24,
  maxVelocityPerSec: 3,
};

export type InterpMode = "empty" | "hold" | "lerp" | "extrapolate";

export interface PeerPosition {
  readonly x: number;
  readonly y: number;
}

export interface TrackStatus {
  readonly position: PeerPosition | null;
  readonly mode: InterpMode;
  readonly beyondMs: number;
  readonly depth: number;
  readonly ratePerSec: number;
}

export interface DebugEntry {
  readonly peerId: string;
  readonly mode: InterpMode;
  readonly depth: number;
  readonly beyondMs: number;
  readonly ratePerSec: number;
  readonly position: PeerPosition | null;
}

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly seq: number;
  /** Effective (virtual-timeline) time — all math uses this. */
  readonly at: number;
  /** True arrival time — stats use this. */
  readonly arrivedAt: number;
}

interface Evaluation {
  readonly position: PeerPosition;
  readonly mode: InterpMode;
  readonly beyondMs: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// -- per-peer track (pure) ------------------------------------------------------

class PeerTrack {
  private samples: Sample[] = [];
  private feedTimes: number[] = []; // bounded ≤64, last 1 s — rate stat only
  private lastSeq = -1;
  private lastEffectiveAt = -Infinity;

  constructor(private readonly cfg: InterpolationConfig) {}

  /** Add a sample. Returns false ⇒ rejected as stale/duplicate seq. */
  feed(x: number, y: number, seq: number, arrivedAt: number): boolean {
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    // Burst stretching: identical arrival times would collapse under lerp.
    const at = Math.max(arrivedAt, this.lastEffectiveAt + this.cfg.minSampleSpacingMs);
    this.lastEffectiveAt = at;
    this.samples.push({ x, y, seq, at, arrivedAt });
    this.prune();
    this.noteFeed(arrivedAt);
    return true;
  }

  private prune(): void {
    while (this.samples.length > this.cfg.maxSamples) this.samples.shift();
    if (this.samples.length === 0) return;
    const newestAt = this.samples[this.samples.length - 1].at;
    // Age window — but always keep the newest two (velocity + hold anchor).
    while (this.samples.length > 2 && newestAt - this.samples[0].at > this.cfg.windowMs) {
      this.samples.shift();
    }
  }

  private noteFeed(at: number): void {
    this.feedTimes.push(at);
    while (this.feedTimes.length > 0 && this.feedTimes[0] < at - 1_000) this.feedTimes.shift();
    while (this.feedTimes.length > 64) this.feedTimes.shift();
  }

  /** Pure evaluation at render time t. Null ⇒ no samples yet. */
  evaluate(t: number): Evaluation | null {
    const s = this.samples;
    if (s.length === 0) return null;
    if (s.length === 1) {
      return { position: { x: s[0].x, y: s[0].y }, mode: "hold", beyondMs: 0 };
    }
    const newest = s[s.length - 1];
    if (t >= newest.at) return this.extrapolate(newest, t);
    const oldest = s[0];
    if (t <= oldest.at) {
      // Render clock before our history (right after join) — snap to oldest.
      return { position: { x: oldest.x, y: oldest.y }, mode: "lerp", beyondMs: 0 };
    }
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].at <= t) {
        const a = s[i - 1];
        const b = s[i];
        const u = (t - a.at) / (b.at - a.at);
        return {
          position: { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u },
          mode: "lerp",
          beyondMs: 0,
        };
      }
    }
    return { position: { x: newest.x, y: newest.y }, mode: "lerp", beyondMs: 0 }; // unreachable
  }

  private extrapolate(newest: Sample, t: number): Evaluation {
    const cap = this.cfg.extrapolationCapMs;
    const beyond = t - newest.at;
    const v = this.velocity(); // normalized units per ms
    let dx = 0;
    let dy = 0;
    if (cap > 0) {
      const b = Math.min(beyond, cap);
      // Linear velocity decay: disp(b) = v·(b − b²/2cap). At b = cap this
      // integrates to v·cap/2 — an eased FULL STOP — and we hold there for
      // all larger `beyond` (beyond ≤ cap keeps b = beyond).
      dx = v.x * (b - (b * b) / (2 * cap));
      dy = v.y * (b - (b * b) / (2 * cap));
    }
    const moving = beyond > 0 && (dx !== 0 || dy !== 0);
    return {
      position: { x: clamp01(newest.x + dx), y: clamp01(newest.y + dy) },
      mode: moving ? "extrapolate" : "hold",
      beyondMs: beyond,
    };
  }

  /** Units per ms, from the nearest qualifying pair, magnitude-clamped. */
  private velocity(): { x: number; y: number } {
    const s = this.samples;
    const newest = s[s.length - 1];
    for (let i = s.length - 1; i > 0; i--) {
      const prev = s[i - 1];
      const dt = newest.at - prev.at;
      if (dt >= this.cfg.minVelocityDtMs) {
        let vx = (newest.x - prev.x) / dt;
        let vy = (newest.y - prev.y) / dt;
        const maxPerMs = this.cfg.maxVelocityPerSec / 1_000;
        const mag = Math.hypot(vx, vy);
        if (mag > maxPerMs && mag > 0) {
          const scale = maxPerMs / mag;
          vx *= scale;
          vy *= scale;
        }
        return { x: vx, y: vy };
      }
    }
    return { x: 0, y: 0 };
  }

  status(t: number, now: number): TrackStatus {
    const ev = this.evaluate(t);
    let rate = 0;
    for (const ft of this.feedTimes) {
      if (ft >= now - 1_000) rate++;
    }
    return {
      position: ev === null ? null : ev.position,
      mode: ev === null ? "empty" : ev.mode,
      beyondMs: ev === null ? 0 : ev.beyondMs,
      depth: this.samples.length,
      ratePerSec: rate,
    };
  }
}

// -- recovery filter (render path only) -------------------------------------------

/**
 * Stateful output filter with exactly ONE consumer: the render loop (via
 * engine.positionNow). When the track switches from extrapolate/hold back
 * to lerp (data resumed after a stall), the raw candidate would jump from
 * the predicted position onto the true path — a visible teleport. The
 * filter eases from the last rendered position onto the truth over
 * recoveryMs instead. Pure debug reads go through debugSnapshot(), which
 * never touches this state.
 */
class RenderFilter {
  private prevMode: InterpMode = "empty";
  private lastOut: PeerPosition | null = null;
  private anchor: PeerPosition | null = null;
  private anchorT = 0;

  constructor(private readonly recoveryMs: number) {}

  step(candidate: PeerPosition, mode: InterpMode, t: number): PeerPosition {
    const wasPredicting = this.prevMode === "extrapolate" || this.prevMode === "hold";
    if (mode === "lerp" && wasPredicting && this.lastOut !== null && this.anchor === null) {
      this.anchor = this.lastOut; // begin recovery from where we actually are
      this.anchorT = t;
    }
    let out = candidate;
    if (this.anchor !== null) {
      if (this.recoveryMs <= 0 || t - this.anchorT >= this.recoveryMs) {
        this.anchor = null; // recovery complete
      } else {
        const k = (t - this.anchorT) / this.recoveryMs;
        out = {
          x: this.anchor.x + (candidate.x - this.anchor.x) * k,
          y: this.anchor.y + (candidate.y - this.anchor.y) * k,
        };
      }
    }
    this.prevMode = mode;
    this.lastOut = out;
    return out;
  }

  reset(): void {
    this.prevMode = "empty";
    this.lastOut = null;
    this.anchor = null;
  }
}

// -- engine -------------------------------------------------------------------------

export class InterpolationEngine {
  private readonly cfg: InterpolationConfig;
  private readonly tracks = new Map<string, PeerTrack>();
  private readonly filters = new Map<string, RenderFilter>();

  constructor(config: Partial<InterpolationConfig> = {}) {
    this.cfg = { ...DEFAULT_INTERPOLATION, ...config };
  }

  get config(): InterpolationConfig {
    return this.cfg;
  }

  /** Record an inbound cursor update. false ⇒ stale seq (dropped). */
  feed(
    peerId: string,
    x: number,
    y: number,
    seq: number,
    arrivedAt: number = performance.now(),
  ): boolean {
    let track = this.tracks.get(peerId);
    if (track === undefined) {
      track = new PeerTrack(this.cfg);
      this.tracks.set(peerId, track);
    }
    return track.feed(x, y, seq, arrivedAt);
  }

  /** Pure interpolated position at an explicit render time (unit tests). */
  positionAt(peerId: string, t: number): PeerPosition | null {
    const track = this.tracks.get(peerId);
    if (track === undefined) return null;
    const ev = track.evaluate(t);
    return ev === null ? null : ev.position;
  }

  /**
   * RENDER PATH: position at (now − renderDelay), passed through the
   * recovery filter. The ONLY filter consumer — one caller per frame.
   */
  positionNow(peerId: string, now: number = performance.now()): PeerPosition | null {
    const track = this.tracks.get(peerId);
    if (track === undefined) return null;
    const t = now - this.cfg.renderDelayMs;
    const ev = track.evaluate(t);
    if (ev === null) return null;
    let filter = this.filters.get(peerId);
    if (filter === undefined) {
      filter = new RenderFilter(this.cfg.recoveryMs);
      this.filters.set(peerId, filter);
    }
    return filter.step(ev.position, ev.mode, t);
  }

  remove(peerId: string): void {
    this.tracks.delete(peerId);
    this.filters.delete(peerId);
  }

  clear(): void {
    this.tracks.clear();
    this.filters.clear();
  }

  /** Raw track states for the dev panel — never touches filter state. */
  debugSnapshot(now: number = performance.now()): DebugEntry[] {
    const out: DebugEntry[] = [];
    for (const [peerId, track] of this.tracks) {
      const st = track.status(now - this.cfg.renderDelayMs, now);
      out.push({
        peerId,
        mode: st.mode,
        depth: st.depth,
        beyondMs: st.beyondMs,
        ratePerSec: st.ratePerSec,
        position: st.position,
      });
    }
    return out;
  }
}
