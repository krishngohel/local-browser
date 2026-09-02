/**
 * Honors HTTP 429 rate limiting. When a server answers a main-frame request with 429, Echo
 * records how long it asked us to wait (the `Retry-After` header) and holds the next
 * navigation to that host until the window passes, instead of hammering an endpoint that has
 * already said "slow down". This is good-citizen backoff, and it is exactly what keeps an
 * automated browser from being flagged as abusive traffic.
 *
 * Pure and injectable-clock so it unit-tests without real time.
 */

/** Longest we will ever hold a navigation waiting on a server's Retry-After, in ms. */
export const MAX_BACKOFF_MS = 30_000;
/** Fallback wait when a 429 carries no usable Retry-After. */
export const DEFAULT_BACKOFF_MS = 5_000;

/**
 * Parses a `Retry-After` value to an absolute epoch-ms deadline. Accepts delta-seconds
 * ("120") and an HTTP-date; returns null for anything unparseable so the caller can fall back.
 */
export function retryAfterUntil(headerValue: string | undefined, now: number): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : null;
}

/** The registrable host of a URL, or "" when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export class RateLimiter {
  /** host -> epoch-ms until which navigation to it should wait. */
  private until = new Map<string, number>();

  /** Records a 429 for a host. `retryAfter` is the raw header value, if any. */
  note429(url: string, retryAfter: string | undefined, now = Date.now()): void {
    const host = hostOf(url);
    if (!host) return;
    const parsed = retryAfterUntil(retryAfter, now);
    const deadline = Math.min(parsed ?? now + DEFAULT_BACKOFF_MS, now + MAX_BACKOFF_MS);
    const existing = this.until.get(host);
    // Keep the later of an existing hold and this one, so a stricter limit is not shortened.
    this.until.set(host, existing ? Math.max(existing, deadline) : deadline);
  }

  /** How long (ms) a navigation to this URL's host should wait now; 0 when clear. */
  waitMsFor(url: string, now = Date.now()): number {
    const host = hostOf(url);
    const deadline = this.until.get(host);
    if (!deadline) return 0;
    if (deadline <= now) {
      this.until.delete(host);
      return 0;
    }
    return deadline - now;
  }
}
