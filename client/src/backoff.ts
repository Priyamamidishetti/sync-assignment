/**
 * backoff.ts — reconnect delay: exponential, capped, ±jitter.
 * Pure function; the jitter source is injectable for deterministic tests.
 */
export interface BackoffOptions {
  readonly initialMs?: number; // default 500
  readonly maxMs?: number; // default 8 000
  readonly jitterRatio?: number; // default 0.3 → ±30%
}

/** Delay before reconnect attempt N (0-based). */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = {},
  rand: () => number = Math.random,
): number {
  const initial = opts.initialMs ?? 500;
  const max = opts.maxMs ?? 8_000;
  const jitter = opts.jitterRatio ?? 0.3;
  const base = Math.min(max, initial * 2 ** attempt);
  const spread = base * jitter;
  return Math.round(base - spread + rand() * 2 * spread); // [base(1−j), base(1+j)]
}
