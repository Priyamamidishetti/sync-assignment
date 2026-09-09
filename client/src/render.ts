/**
 * render.ts — canvas rendering + local input capture.
 *
 * - Remote cursors: positioned via session.peerPosition() — the
 *   interpolation seam, unchanged since Phase 3 (renderer never knew
 *   interpolation happened).
 * - Own cursor: drawn from local input only — zero added latency (FR-29).
 * - Reactions (Phase 5): pointerDOWN on the canvas emits a reaction at that
 *   point — locally echoed instantly (the server never echoes the sender),
 *   same prediction pattern as the own cursor. Remote bursts arrive via
 *   App → spawnReaction(). Particle logic lives in bursts.ts.
 *
 * Input split: pointermove is on window (cursor tracking everywhere);
 * pointerdown is on the CANVAS element only, so clicks on UI chrome
 * (header, emoji picker, presence) never spawn reactions.
 */
import { PEER_COLORS, type ReactionEmoji } from "@protocol";
import { peerOpacity, type RemotePeer, type RoomSession } from "./connection";
import { ReactionBursts } from "./bursts";

const FALLBACK_COLOR = "#5b8ee6";

export class CursorCanvas {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bursts = new ReactionBursts();
  private rafId = 0;
  private disposed = false;
  private own = { x: 0.5, y: 0.5 };
  private ownVisible = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: RoomSession,
    private readonly getEmoji: () => ReactionEmoji = () => "🔥",
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.onResize(); // after ctx assignment (field-initializer ordering)
    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
  }

  start(): void {
    this.loop();
  }

  stop(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
  }

  /** Remote reaction landed — spawn its burst. Called by App on the event. */
  spawnReaction(emoji: string, x: number, y: number): void {
    this.bursts.spawn(emoji, x, y);
  }

  // -- local input ---------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    this.own = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    this.ownVisible = true;
    this.session.sendMove(this.own.x, this.own.y);
  };

  private onPointerDown = (e: PointerEvent): void => {
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    this.own = { x, y };
    this.ownVisible = true;
    const emoji = this.getEmoji();
    // Local echo: the relay skips the sender, so we render our own burst
    // immediately — prediction, exactly like the own cursor.
    this.bursts.spawn(emoji, x, y);
    this.session.sendReact(x, y, emoji); // discrete: immediate, never throttled
  };

  private onResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // -- render loop -----------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return;
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    for (const peer of this.session.peerList()) {
      const opacity = peerOpacity(peer, now);
      if (opacity <= 0) continue; // fully faded (PHASE 6 / FR-11)
      const pos = this.session.peerPosition(peer); // the seam — unchanged
      if (pos === null) continue; // joined but never moved
      this.drawCursor(pos.x * w, pos.y * h, PEER_COLORS[peer.color] ?? FALLBACK_COLOR, peer.name, opacity);
    }

    if (this.ownVisible) {
      const you = this.session.you;
      const color = you !== null ? (PEER_COLORS[you.color] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
      const label = you !== null ? `${you.name} (you)` : "you";
      this.drawCursor(this.own.x * w, this.own.y * h, color, label);
    }

    // Reactions paint on top of cursors.
    this.bursts.draw(this.ctx, w, h, performance.now());
  }

  private drawCursor(x: number, y: number, color: string, label: string, opacity = 1): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y);

    // pointer arrow
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16);
    ctx.lineTo(4.2, 11.8);
    ctx.lineTo(7.2, 17.4);
    ctx.lineTo(9.4, 16.2);
    ctx.lineTo(6.4, 10.8);
    ctx.lineTo(11, 10.2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1.4;
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 5;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();

    // name pill
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    const tw = ctx.measureText(label).width;
    roundedRect(ctx, 12, 16, tw + 14, 20, 9);
    ctx.fillStyle = "rgba(16,16,22,0.78)";
    ctx.fill();
    ctx.fillStyle = "#f2f2f7";
    ctx.fillText(label, 19, 29.5);
    ctx.restore();
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
