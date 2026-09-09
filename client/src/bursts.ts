/**
 * bursts.ts — reaction burst particle system (Phase 5).
 *
 * Each reaction spawns one burst: a large main glyph floating upward plus
 * minis scattering outward. Every particle is ANALYTIC — position, alpha,
 * scale, and rotation are pure functions of (now − born) — so there is no
 * per-frame integration to drift and the whole system is unit-testable
 * without a canvas (particlesAt()).
 *
 * Bounded (NFR-4): at most maxBursts bursts alive (oldest dropped first);
 * a burst is removed once its longest-lived particle expires.
 */

export interface BurstConfig {
  /** Live-burst cap. Default 32. */
  readonly maxBursts?: number;
  /** Main glyph lifetime, ms. Default 1500. */
  readonly mainTtlMs?: number;
  /** Scattered minis per burst. Default 5. */
  readonly minis?: number;
  /** Injectable randomness for deterministic tests. */
  readonly rand?: () => number;
}

interface Particle {
  readonly emoji: string;
  readonly x0: number;
  readonly y0: number;
  readonly dx: number; // total displacement over life, normalized units
  readonly dy: number;
  readonly rot0: number;
  readonly rotTotal: number;
  readonly born: number;
  readonly ttl: number;
  readonly size: number; // px at scale 1
}

interface Burst {
  readonly particles: readonly Particle[];
  readonly born: number;
  readonly diesAt: number;
}

export interface ParticleView {
  readonly emoji: string;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly alpha: number;
  readonly scale: number;
  readonly size: number;
}

const easeOutQuad = (u: number): number => 1 - (1 - u) * (1 - u);

export class ReactionBursts {
  private readonly bursts: Burst[] = [];
  private readonly cfg: Required<BurstConfig>;

  constructor(config: BurstConfig = {}) {
    this.cfg = {
      maxBursts: config.maxBursts ?? 32,
      mainTtlMs: config.mainTtlMs ?? 1_500,
      minis: config.minis ?? 5,
      rand: config.rand ?? Math.random,
    };
  }

  get burstCount(): number {
    return this.bursts.length;
  }

  spawn(emoji: string, x: number, y: number, now: number = performance.now()): void {
    const rand = this.cfg.rand;
    const particles: Particle[] = [
      // Main glyph: floats up ~10% of the screen, gentle rotation.
      {
        emoji,
        x0: x,
        y0: y,
        dx: 0,
        dy: -0.1,
        rot0: (rand() - 0.5) * 0.3,
        rotTotal: (rand() - 0.5) * 0.6,
        born: now,
        ttl: this.cfg.mainTtlMs,
        size: 30,
      },
    ];
    for (let i = 0; i < this.cfg.minis; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = 0.06 + rand() * 0.12;
      particles.push({
        emoji,
        x0: x,
        y0: y,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 0.05, // upward bias
        rot0: rand() * Math.PI * 2,
        rotTotal: (rand() - 0.5) * 2.5,
        born: now,
        ttl: 800 + rand() * 400,
        size: 9 + rand() * 8,
      });
    }
    this.bursts.push({ particles, born: now, diesAt: now + this.cfg.mainTtlMs });
    while (this.bursts.length > this.cfg.maxBursts) this.bursts.shift(); // bounded
    this.prune(now);
  }

  /** Remove bursts whose every particle has expired. */
  prune(now: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (this.bursts[i].diesAt <= now) this.bursts.splice(i, 1);
    }
  }

  /**
   * Pure evaluation: every live particle's render state at `now`.
   * No mutation, no canvas — the unit-test surface.
   */
  particlesAt(now: number): ParticleView[] {
    const out: ParticleView[] = [];
    for (const burst of this.bursts) {
      for (const p of burst.particles) {
        const age = now - p.born;
        if (age < 0 || age > p.ttl) continue;
        const u = age / p.ttl;
        const ease = easeOutQuad(u); // decelerating drift
        const fadeIn = Math.min(1, age / 90);
        const fadeOut = u > 0.6 ? Math.max(0, (1 - u) / 0.4) : 1;
        out.push({
          emoji: p.emoji,
          x: p.x0 + p.dx * ease,
          y: p.y0 + p.dy * ease,
          rot: p.rot0 + p.rotTotal * ease,
          alpha: fadeIn * fadeOut,
          scale: 0.35 + 0.65 * Math.min(1, age / 130), // pop-in
          size: p.size,
        });
      }
    }
    return out;
  }

  /** Paint live particles; prunes dead bursts afterwards. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, now: number = performance.now()): void {
    const views = this.particlesAt(now);
    if (views.length > 0) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const p of views) {
        ctx.save();
        ctx.translate(p.x * w, p.y * h);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.alpha;
        ctx.font = `${Math.round(p.size * p.scale)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
        ctx.fillText(p.emoji, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }
    this.prune(now);
  }
}
