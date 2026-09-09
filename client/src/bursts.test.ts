import { describe, expect, it } from "vitest";
import { ReactionBursts } from "./bursts";

describe("ReactionBursts", () => {
  it("caps live bursts, dropping the oldest (NFR-4)", () => {
    const b = new ReactionBursts({ maxBursts: 10, rand: () => 0.5 });
    for (let i = 0; i < 25; i++) b.spawn("🔥", 0.5, 0.5, i * 10);
    expect(b.burstCount).toBe(10);
    // The survivors are the newest — still alive and renderable.
    expect(b.particlesAt(24 * 10 + 10).length).toBeGreaterThan(0);
  });

  it("expires bursts after the main ttl", () => {
    const b = new ReactionBursts({ mainTtlMs: 1000, rand: () => 0.5 });
    b.spawn("🎉", 0.2, 0.2, 0);
    expect(b.burstCount).toBe(1);
    expect(b.particlesAt(500).length).toBeGreaterThan(0);
    expect(b.particlesAt(1001).length).toBe(0); // every particle expired
    b.prune(1001);
    expect(b.burstCount).toBe(0);
  });

  it("analytic motion: starts at spawn, eases to full displacement", () => {
    const b = new ReactionBursts({ minis: 0, rand: () => 0.25 }); // main glyph only
    b.spawn("❤️", 0.3, 0.4, 1000);
    // age 0 → exactly at the spawn point
    const [p0] = b.particlesAt(1000);
    expect(p0.x).toBeCloseTo(0.3, 6);
    expect(p0.y).toBeCloseTo(0.4, 6);
    // half-life: u = 0.5 ⇒ ease = 0.75 ⇒ y = 0.4 − 0.1·0.75
    const [ph] = b.particlesAt(1000 + 750);
    expect(ph.y).toBeCloseTo(0.4 - 0.075, 6);
    // just before expiry: full displacement, alpha fading out
    const [pe] = b.particlesAt(1000 + 1499);
    expect(pe.y).toBeCloseTo(0.3, 4); // 0.4 − 0.1
    expect(pe.alpha).toBeLessThan(0.35);
  });

  it("alpha/scale/rotation stay within sane bounds across the lifetime", () => {
    const b = new ReactionBursts();
    b.spawn("🔥", 0.5, 0.5, 0);
    b.spawn("💀", 0.5, 0.5, 400);
    for (let t = 0; t <= 1600; t += 50) {
      for (const p of b.particlesAt(t)) {
        expect(p.alpha).toBeGreaterThanOrEqual(0);
        expect(p.alpha).toBeLessThanOrEqual(1);
        expect(p.scale).toBeGreaterThanOrEqual(0.35);
        expect(p.scale).toBeLessThanOrEqual(1);
        expect(p.x).toBeGreaterThanOrEqual(-0.5);
        expect(p.x).toBeLessThanOrEqual(1.5);
        expect(Number.isFinite(p.rot)).toBe(true);
      }
    }
  });

  it("draw() paints live particles and prunes (smoke test with stub ctx)", () => {
    const b = new ReactionBursts({ minis: 0, rand: () => 0.5 });
    b.spawn("👏", 0.5, 0.5, 0);
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: () => {},
      rotate: () => {},
      fillText: () => calls.push("fillText"),
    } as unknown as CanvasRenderingContext2D;
    b.draw(ctx, 800, 600, 500);
    expect(calls).toContain("fillText");
    b.draw(ctx, 800, 600, 5000);
    expect(b.burstCount).toBe(0); // pruned after expiry
  });
});
