/**
 * throttle.ts — leading + trailing throttle for a single latest-value
 * stream (the move path).
 *
 *  - Leading: the first call after a quiet period fires immediately.
 *  - Trailing: calls during cooldown keep ONLY the latest value and arm at
 *    most one flush at the cooldown's end — so the FINAL RESTING POSITION
 *    always reaches the wire (FR-13: trailing guaranteed).
 *
 * Pure logic, no network; `now` is injectable for deterministic tests.
 */
export class LeadingTrailingThrottle<T> {
  private lastFireAt = -Infinity;
  private pending: T | undefined;
  private hasPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly fire: (value: T) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  push(value: T): void {
    if (this.timer !== null) {
      this.pending = value; // cooldown: keep only the latest
      this.hasPending = true;
      return;
    }
    const now = this.now();
    if (now - this.lastFireAt >= this.intervalMs) {
      this.lastFireAt = now;
      this.fire(value); // leading edge
      return;
    }
    this.pending = value;
    this.hasPending = true;
    this.timer = setTimeout(() => this.flush(), this.intervalMs - (now - this.lastFireAt));
  }

  private flush(): void {
    this.timer = null;
    if (!this.hasPending) return;
    const value = this.pending as T;
    this.pending = undefined;
    this.hasPending = false;
    this.lastFireAt = this.now();
    this.fire(value);
  }

  /** Drop any pending trailing flush (teardown / deliberate stop). */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = undefined;
    this.hasPending = false;
  }
}
