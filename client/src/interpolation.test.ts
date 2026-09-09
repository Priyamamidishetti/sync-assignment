import { describe, expect, it } from "vitest";
import { DEFAULT_INTERPOLATION, InterpolationEngine, type PeerPosition } from "./interpolation";

const P = "peer";
const D = DEFAULT_INTERPOLATION;
const fresh = () => new InterpolationEngine();

describe("buffer bounds (FR-26 / NFR-4)", () => {
  it("≤ 16 samples after 60 s of 30 Hz input (1800 feeds); rate stat ≈ 30/s", () => {
    const e = fresh();
    const dt = 1000 / 30;
    for (let i = 1; i <= 1800; i++) {
      e.feed(P, Math.min(1, i * 0.0005), 0.5, i, (i - 1) * dt);
    }
    const snap = e.debugSnapshot(1799 * dt);
    expect(snap.length).toBe(1);
    expect(snap[0].depth).toBeLessThanOrEqual(D.maxSamples);
    expect(snap[0].depth).toBeGreaterThanOrEqual(2);
    expect(snap[0].ratePerSec).toBeGreaterThanOrEqual(28);
    expect(snap[0].ratePerSec).toBeLessThanOrEqual(31);
  });

  it("age window prunes sparse history (≤ ~1 s span)", () => {
    const e = fresh();
    for (let i = 1; i <= 20; i++) e.feed(P, i * 0.01, 0.5, i, (i - 1) * 150);
    const snap = e.debugSnapshot(19 * 150);
    expect(snap[0].depth).toBeLessThanOrEqual(8);
  });
});

describe("defensive seq guard", () => {
  it("rejects duplicate/stale seq; accepts increasing", () => {
    const e = fresh();
    expect(e.feed(P, 0.1, 0.1, 5, 0)).toBe(true);
    expect(e.feed(P, 0.2, 0.2, 5, 33)).toBe(false);
    expect(e.feed(P, 0.3, 0.3, 3, 66)).toBe(false);
    expect(e.feed(P, 0.4, 0.4, 6, 99)).toBe(true);
    expect(e.positionAt(P, 99)).toEqual({ x: 0.4, y: 0.4 }); // t == newest ⇒ newest
  });
});

describe("lerp (FR-24)", () => {
  it("linear interpolation between bracketing samples", () => {
    const e = fresh();
    e.feed(P, 0.0, 0.0, 1, 0);
    e.feed(P, 1.0, 0.0, 2, 100);
    expect(e.positionAt(P, 0)?.x).toBeCloseTo(0, 6);
    expect(e.positionAt(P, 25)?.x).toBeCloseTo(0.25, 6);
    expect(e.positionAt(P, 50)?.x).toBeCloseTo(0.5, 6);
    expect(e.positionAt(P, 100)?.x).toBeCloseTo(1, 6); // t == newest ⇒ disp 0
  });

  it("empty → null; single sample snaps from either side (FR-27)", () => {
    const e = fresh();
    expect(e.positionAt(P, 0)).toBeNull();
    e.feed(P, 0.3, 0.4, 1, 1000);
    expect(e.positionAt(P, 900)).toEqual({ x: 0.3, y: 0.4 }); // starvation side
    expect(e.positionAt(P, 5000)).toEqual({ x: 0.3, y: 0.4 }); // hold side
  });

  it("render clock before history snaps to oldest (join moment)", () => {
    const e = fresh();
    e.feed(P, 0.2, 0.2, 1, 1000);
    e.feed(P, 0.8, 0.8, 2, 1100);
    expect(e.positionAt(P, 500)).toEqual({ x: 0.2, y: 0.2 });
  });
});

describe("extrapolation (FR-25)", () => {
  it("dead reckoning with linear velocity decay — exact displacements", () => {
    const e = fresh();
    e.feed(P, 0.2, 0.5, 1, 0);
    e.feed(P, 0.4, 0.5, 2, 100); // v = 0.002/ms (2 units/s, under the clamp)
    const cap = D.extrapolationCapMs;
    // b = cap/2 ⇒ disp = v·(50 − 12.5) = v·37.5
    expect(e.positionAt(P, 100 + cap / 2)?.x).toBeCloseTo(0.4 + 0.002 * 37.5, 6);
    // b = cap ⇒ disp = v·cap/2 — an eased FULL stop…
    expect(e.positionAt(P, 100 + cap)?.x).toBeCloseTo(0.4 + 0.1, 6);
    // …and we hold there indefinitely
    expect(e.positionAt(P, 100 + 1000)?.x).toBeCloseTo(0.5, 6);
  });

  it("eases monotonically to the stop — never backward, never NaN", () => {
    const e = fresh();
    e.feed(P, 0.1, 0.1, 1, 0);
    e.feed(P, 0.5, 0.3, 2, 100);
    let prevX = -Infinity;
    let prevY = -Infinity;
    for (let t = 100; t <= 600; t += 5) {
      const p = e.positionAt(P, t);
      expect(p).not.toBeNull();
      if (p === null) continue;
      expect(p.x).toBeGreaterThanOrEqual(prevX);
      expect(p.y).toBeGreaterThanOrEqual(prevY);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      prevX = p.x;
      prevY = p.y;
    }
  });

  it("ignores velocity from too-close samples (burst-arrival guard)", () => {
    const e = fresh();
    e.feed(P, 0.1, 0.5, 1, 0);
    e.feed(P, 0.6, 0.5, 2, 1); // 1 ms apart — enormous apparent velocity
    expect(e.positionAt(P, 201)?.x).toBeCloseTo(0.6, 6); // no rocket: v = 0
  });

  it("clamps extrapolation speed to maxVelocityPerSec", () => {
    const e = fresh();
    e.feed(P, 0.1, 0.5, 1, 0);
    e.feed(P, 0.6, 0.5, 2, 100); // apparent 5 units/s > 3
    const cap = D.extrapolationCapMs;
    // clamped v = 0.003/ms ⇒ disp at cap = 0.15
    expect(e.positionAt(P, 100 + cap)?.x).toBeCloseTo(0.75, 6);
  });

  it("clamps extrapolated positions into [0,1]", () => {
    const e = fresh();
    e.feed(P, 0.9, 0.9, 1, 0);
    e.feed(P, 0.99, 0.99, 2, 100);
    const p = e.positionAt(P, 600);
    expect(p?.x).toBeLessThanOrEqual(1);
    expect(p?.y).toBeLessThanOrEqual(1);
  });
});

describe("burst stretching (no teleport when a batch lands)", () => {
  it("spaces same-instant samples into a replay, not a single-frame collapse", () => {
    const e = fresh();
    for (let i = 0; i <= 10; i++) e.feed(P, i * 0.1, 0.5, i + 1, 1000); // all arrive together
    // Effective times: 1000, 1008, 1016, …, 1080
    expect(e.positionAt(P, 1004)?.x).toBeCloseTo(0.05, 2); // inside the FIRST segment
    const mid = e.positionAt(P, 1000 + 4 * 8 + 4); // between stretched samples 4 and 5
    expect(mid === null ? 0 : mid.x).toBeGreaterThan(0.35);
    expect(mid === null ? 0 : mid.x).toBeLessThan(0.55);
    expect(e.positionAt(P, 1081)?.x).toBeCloseTo(1.0, 6);
  });
});

describe("render path: jitter + 300 ms stall (FR-28 / AC-3 core)", () => {
  it("no per-frame teleport at resume; positions finite and in-bounds", () => {
    const e = fresh();
    // Build the sender timeline: steady 30 Hz → 300 ms network stall (the
    // 10 samples sent during it arrive bunched) → steady again.
    const timeline: Array<{ at: number; x: number }> = [];
    let x = 0;
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 33;
      x += 0.01;
      timeline.push({ at: t, x });
    }
    t += 300;
    for (let i = 0; i < 10; i++) {
      x += 0.01;
      timeline.push({ at: t, x });
    }
    for (let i = 0; i < 30; i++) {
      t += 33;
      x += 0.01;
      timeline.push({ at: t, x });
    }

    // Drive the RENDER path frame-by-frame, feeding samples only when they
    // would actually have ARRIVED — so the stall really starves the buffer.
    let idx = 0;
    let seq = 0;
    let prev: PeerPosition | null = null;
    let maxStep = 0;
    let last: PeerPosition | null = null;
    for (let now = D.renderDelayMs + 33; now <= t + 400; now += 16) {
      while (idx < timeline.length && timeline[idx].at <= now) {
        seq += 1;
        e.feed(P, timeline[idx].x, 0.5, seq, timeline[idx].at);
        idx += 1;
      }
      const p = e.positionNow(P, now);
      expect(p).not.toBeNull();
      if (p === null) continue;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      if (prev !== null) {
        const step = Math.hypot(p.x - prev.x, p.y - prev.y);
        if (step > maxStep) maxStep = step;
      }
      prev = p;
      last = p;
    }
    expect(maxStep).toBeLessThan(0.05); // no frame ever teleports
    expect(last?.x).toBeCloseTo(0.7, 1); // ended on the truth
  });
});

describe("lifecycle", () => {
  it("remove/clear drop tracks and filters; re-feed works after clear", () => {
    const e = fresh();
    e.feed("a", 0.1, 0.1, 1, 0);
    e.feed("b", 0.2, 0.2, 1, 0);
    expect(e.positionAt("a", 0)).not.toBeNull();
    e.remove("a");
    expect(e.positionAt("a", 0)).toBeNull();
    expect(e.positionAt("b", 0)).not.toBeNull();
    e.clear();
    expect(e.positionAt("b", 0)).toBeNull();
    expect(e.feed("b", 0.9, 0.9, 1, 100)).toBe(true); // fresh track, any seq
  });
});
