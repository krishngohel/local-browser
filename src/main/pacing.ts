/**
 * Human-like pacing for assistant-driven pointer and keyboard actions. Firing clicks and
 * keystrokes with zero delay is one of the clearest "this is a script" signals a site sees;
 * a small randomized pause before each interaction makes Echo read as an ordinary browser and
 * is just polite pacing. It is not evasion — it slows Echo down, it does not hide anything.
 *
 * Pure (an injectable RNG) so the range is unit-testable without waiting.
 */

export const PACING_MIN_MS = 60;
export const PACING_MAX_MS = 220;

/** A randomized delay in [PACING_MIN_MS, PACING_MAX_MS]. */
export function pacingDelayMs(rng: () => number = Math.random): number {
  const span = PACING_MAX_MS - PACING_MIN_MS;
  return Math.round(PACING_MIN_MS + rng() * span);
}

/** Sleeps for one pacing interval. A no-op wait still yields to the event loop. */
export function pace(enabled: boolean, rng: () => number = Math.random): Promise<void> {
  if (!enabled) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, pacingDelayMs(rng)));
}
