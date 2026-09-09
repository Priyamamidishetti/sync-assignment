import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadingTrailingThrottle } from "./throttle";

describe("LeadingTrailingThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Injected clock kept in lockstep with fake timers.
  let clock = 0;
  const now = () => clock;
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i++) {
      clock += 1;
      vi.advanceTimersByTime(1);
    }
  };
  beforeEach(() => {
    clock = 0;
  });

  it("fires the first push immediately (leading edge)", () => {
    const fired: number[] = [];
    new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now).push(1);
    expect(fired).toEqual([1]);
  });

  it("suppresses pushes during cooldown, keeping only the latest", () => {
    const fired: number[] = [];
    const t = new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now);
    t.push(1); // leading at t=0
    clock = 10;
    t.push(2); // cooldown
    clock = 20;
    t.push(3); // cooldown — latest wins
    expect(fired).toEqual([1]);
    advance(90);
    expect(fired).toEqual([1, 3]);
  });

  it("trailing flush delivers the FINAL value after a burst", () => {
    const fired: number[] = [];
    const t = new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now);
    clock = 50;
    t.push(7); // leading
    clock = 60;
    t.push(8);
    clock = 70;
    t.push(9); // pending
    advance(40);
    expect(fired).toEqual([7, 9]);
  });

  it("holds ≤ ~1 fire per interval under continuous input, final value guaranteed", () => {
    const fired: number[] = [];
    const t = new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now);
    for (let i = 0; i < 100; i++) {
      clock = i * 10;
      t.push(i);
      advance(10);
    }
    advance(50); // let the final trailing flush land
    expect(fired.length).toBeGreaterThanOrEqual(28); // ~30 Hz, not 100 Hz
    expect(fired.length).toBeLessThanOrEqual(35);
    expect(fired[fired.length - 1]).toBe(99); // resting position always sent
  });

  it("goes leading again after a quiet period", () => {
    const fired: number[] = [];
    const t = new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now);
    t.push(1);
    clock = 5000;
    t.push(42);
    expect(fired).toEqual([1, 42]);
  });

  it("cancel() drops the pending trailing flush", () => {
    const fired: number[] = [];
    const t = new LeadingTrailingThrottle<number>(33, (v) => fired.push(v), now);
    t.push(1);
    clock = 10;
    t.push(2);
    t.cancel();
    advance(200);
    expect(fired).toEqual([1]);
  });
});
