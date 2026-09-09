import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
  it("attempt 0 → 500ms base with ±30% jitter", () => {
    expect(backoffDelay(0, {}, () => 0)).toBe(350);
    expect(backoffDelay(0, {}, () => 0.5)).toBe(500);
    expect(backoffDelay(0, {}, () => 1)).toBe(650);
  });

  it("doubles per attempt", () => {
    expect(backoffDelay(1, {}, () => 0.5)).toBe(1000);
    expect(backoffDelay(2, {}, () => 0.5)).toBe(2000);
    expect(backoffDelay(3, {}, () => 0.5)).toBe(4000);
  });

  it("caps the base at maxMs (8s), jitter still applies", () => {
    expect(backoffDelay(4, {}, () => 0.5)).toBe(8000);
    expect(backoffDelay(50, {}, () => 0.5)).toBe(8000);
    expect(backoffDelay(50, {}, () => 1)).toBe(10_400);
  });

  it("random draws always land inside [base(1−j), cap(1+j)]", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const d = backoffDelay(attempt);
      expect(d).toBeGreaterThanOrEqual(350);
      expect(d).toBeLessThanOrEqual(Math.round(8000 * 1.3));
    }
  });
});
