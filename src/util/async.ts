/**
 * Small async helpers shared across the codebase. Retry/backoff logic that
 * builds on these lands with the Gmail client wrapper (Step 4.1, §19).
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Compute an exponential backoff delay (in ms) with full jitter for a given
 * zero-based attempt: `random(0, min(cap, base * 2^attempt))` (§19). The caller
 * supplies the random source so this stays deterministic in tests.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const baseMs = options.baseMs ?? 250;
  const capMs = options.capMs ?? 10_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * exponential);
}
