# Honest anti-friction (no evasion, no CAPTCHA solving)

**Date:** 2026-08-27
**Status:** Built.

## Scope boundary

The user asked for anti-bot-detection evasion (stealth fingerprinting, residential proxies)
and automated CAPTCHA solving (2Captcha/CapSolver token injection). Those were **declined**:
they are general-purpose defeats of the controls sites use to stop automated abuse, and
building them into a browser any LLM can drive is building abuse infrastructure. This spec is
the honest subset that reduces friction without deceiving anyone or defeating a human-check.

## What was built

### 1. Honest user-agent (`src/main/user-agent.ts`)
Electron's default UA carries `Electron/<ver>` and the app-name token, which some sites block
as "not a real browser". `cleanChromeUserAgent(platform, chromeVersion)` builds the plain
desktop-Chrome UA for the Chromium version Echo actually ships; `app.userAgentFallback` is set
to it at startup, before any tab loads. Platform and Chrome version stay truthful — no claim to
be a human, no fingerprint spoofing.

### 2. Human pacing (`src/main/pacing.ts`)
A small randomized pause (60–220 ms) before each assistant click/keystroke, so Echo paces like
a person instead of firing instantly — the clearest "this is a script" signal. Applied in the
hub's click/type/press/hover/double_click/right_click/drag/select/scroll. Gated by a new
`humanPacing` setting (default on, toggle in Settings → System). It only slows Echo down; it
hides nothing.

### 3. HTTP 429 backoff (`src/main/rate-limit.ts`)
When a host answers a request with 429, Echo records its `Retry-After` window (capped at 30 s)
and holds the next navigation to that host until it passes, rather than hammering an endpoint
that already said "slow down". Recorded in the existing `onCompleted` network hook; consulted
in `navigate`.

### 4. CAPTCHA detect-and-handoff (`captcha_check` tool + navigate hook)
`CAPTCHA_SCAN_SCRIPT` detects reCAPTCHA, hCaptcha, Cloudflare Turnstile, and the Cloudflare
interstitial. On navigation, if one is found, Echo fires a desktop notification (once per host)
and appends a line to the result telling the assistant to pause and ask the human to solve it
in the Echo window. The `captcha_check` tool (Read group, on by default) reports the same on
demand. Echo never solves, injects, or bypasses — it hands off to the person at the machine.

## Testing
- `test/unit/anti-friction.test.ts` — UA building, pacing range, Retry-After parsing, limiter
  hold/release/cap/stricter-wins.
- `scripts/test-tools.mjs` — `captcha_check` returns `present:false` on a clean page.
- Counts updated across manifest, transfer-prefs, README, skill tree (70 tools total).
