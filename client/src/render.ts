/**
 * render.ts — canvas rendering + local input capture.
 *
 * Deliberately dumb: every frame it asks the session for positions via
 * peerPosition(). Phase 3 returns the last-known position — remote cursors
 * SNAP between updates, which is known debt, fixed in Phase 4's
 * interpolation engine WITHOUT this file changing (that's the point of the
 * peerPosition seam).
 *
 * Own cursor: drawn from local input only — zero added latency (FR-29).
 */
import { PEER_COLORS } from "@protocol";
import type { RemotePeer, RoomSession } from "./connection";

const FALLBACK_COLOR = "#5b8ee6"; // before welcome (own color unknown)

export class CursorCanvas {
  private readonly ctx: CanvasRenderingContext2D;
  private rafId = 0;
  private disposed = false;
  private own = { x: 0.5, y: 0.5 };
  private ownVisible = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: RoomSession,
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.onResize(); // must come after ctx is assigned (field-initializer ordering)
    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
  }

  start(): void {
    this.loop();
  }

  stop(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
  }

  // -- local input: own cursor is local-only (FR-29) --------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    this.own = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    this.ownVisible = true;
    this.session.sendMove(this.own.x, this.own.y);
  };

  private onResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // -- render loop ----------------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return;
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);

    for (const peer of this.session.peerList()) {
      const pos = this.session.peerPosition(peer); // ← Phase 4 swaps the implementation
      if (pos === null) continue; // joined but never moved
      this.drawCursor(pos.x * w, pos.y * h, PEER_COLORS[peer.color] ?? FALLBACK_COLOR, peer.name);
    }

    if (this.ownVisible) {
      const you = this.session.you;
      const color = you !== null ? (PEER_COLORS[you.color] ?? FALLBACK_COLOR) : FALLBACK_COLOR;
      const label = you !== null ? `${you.name} (you)` : "you";
      this.drawCursor(this.own.x * w, this.own.y * h, color, label);
    }
  }

  private drawCursor(x: number, y: number, color: string, label: string): void {
    const ctx = this.ctx;
    ctx.save();
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
