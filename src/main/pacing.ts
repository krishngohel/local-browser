/**
 * Human-like pacing for assistant-driven pointer and keyboard actions. Firing clicks and
 * keystrokes with near-zero, near-constant gaps is one of the clearest "this is a script"
 * signals a site sees — behavioural anti-bot checks (Cloudflare Turnstile, reCAPTCHA v3, and
 * the like) score exactly that cadence, and a run that trips them gets a CAPTCHA or a
 * checkpoint in the way. A randomized, form-filling-speed pause before each interaction makes
 * Echo's timing read like a person working through a page.
 *
 * It is a throttle, not a disguise: it only slows Echo down and jitters *when* it acts. It does
 * not forge any hardware, identity, or input signal. The trade is deliberate — a bit slower per
 * action, but far less time lost to challenges and checkpoints, which nets out to more work done
 * on a long unattended run.
 *
 * The shape matters as much as the size. A human's gaps are not a tight band: most are short,
 * but every so often one is much longer (reading a new field, thinking). So each pause is a
 * base gap plus, occasionally, an extra "reading" pause — a heavier tail than a flat range.
 *
 * Pure (an injectable RNG) so the distribution is unit-testable without waiting.
 */

/** Base gap bounds, in ms — the common case for one action-to-action pause. */
export const PACING_MIN_MS = 450;
export const PACING_MAX_MS = 1700;

/** Now and then, tack on a longer "reading/thinking" pause so the cadence has a human tail. */
export const PACING_LONG_CHANCE = 0.15;
export const PACING_LONG_MIN_MS = 700;
export const PACING_LONG_MAX_MS = 2600;

/** The most a single pause can ever be (base max + long max). Handy for callers/tests that bound it. */
export const PACING_ABS_MAX_MS = PACING_MAX_MS + PACING_LONG_MAX_MS;

/**
 * A randomized human-cadence delay in ms: a base gap in [PACING_MIN_MS, PACING_MAX_MS], plus —
 * with probability PACING_LONG_CHANCE — an extra pause in [PACING_LONG_MIN_MS, PACING_LONG_MAX_MS].
 *
 * `rng` is drawn in a fixed order (base, then the long-pause coin, then the long magnitude) so a
 * scripted RNG makes the result fully deterministic for tests.
 */
export function pacingDelayMs(rng: () => number = Math.random): number {
  const base = PACING_MIN_MS + rng() * (PACING_MAX_MS - PACING_MIN_MS);
  const long =
    rng() < PACING_LONG_CHANCE ? PACING_LONG_MIN_MS + rng() * (PACING_LONG_MAX_MS - PACING_LONG_MIN_MS) : 0;
  return Math.round(base + long);
}

/** Sleeps for one pacing interval. A no-op wait still yields to the event loop. */
export function pace(enabled: boolean, rng: () => number = Math.random): Promise<void> {
  if (!enabled) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, pacingDelayMs(rng)));
}
