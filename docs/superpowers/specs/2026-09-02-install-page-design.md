# GitHub Pages install page

**Date:** 2026-09-02
**Status:** Approved, building.

## Purpose

A focused download/install landing page for Echo, hosted via GitHub Pages, separate from the
full README (which stays the source of truth for troubleshooting and every client's connect
instructions). This page is the thing a new visitor lands on: what Echo is, download the right
installer for their OS, and the shortest path to a working connection — then a link out to the
README for everything else.

## Structure (wireframe-approved)

1. **Nav** — icon + wordmark, a link to the GitHub repo.
2. **Hero** — large icon (the radiating-rings mark), "ECHO" wordmark, one-line description, a
   2-line sub-description, one primary download button (OS auto-detected client-side via
   `navigator.userAgent`/`navigator.platform`, defaulting to Windows if detection is
   inconclusive since that's the majority platform per the repo's own install docs), small
   secondary links for the other two OSes, and a version/build-status line.
3. **How it works** — 4 numbered steps: install & leave running → Settings → Connections →
   Connect → restart your AI app → ask it to browse.
4. **Works with** — the list of MCP clients Echo already documents in the README (Cursor,
   Claude, ChatGPT/Codex, Continue, Cline, Windsurf, VS Code, any MCP client).
5. **Footer** — link to the GitHub repo for full docs/troubleshooting, Privacy/Terms/MIT
   License links (reuse `legal/PRIVACY.md`/`legal/TERMS.md` content or link straight to them on
   GitHub rather than duplicating).

## Content (real copy, not placeholder)

- Hero one-liner: "A desktop browser your AI can actually drive."
- Hero sub-line: "No cloud Chromium. No model API. The window you see is the window it
  controls." (matches the README's own framing, already tested copy)
- Download links point directly at the `v1.1.0` GitHub Release assets:
  - Windows (Intel/AMD): `Echo-Setup-1.1.0-x64.exe`
  - Windows (ARM): `Echo-Setup-1.1.0-arm64.exe`
  - Mac (Apple Silicon): `Echo-1.1.0-mac-arm64.dmg` — labelled "Apple Silicon", not
    "universal"/"Intel", since this release's `macos-latest` CI runner only produced an arm64
    build.
  - Linux: `Echo-1.1.0-linux-x86_64.AppImage`
- All release asset URLs are `https://github.com/krishngohel/local-browser/releases/download/v1.1.0/<asset>`
  — direct links, not just to the Releases page, so the primary button is a real one-click
  download.
- "How it works" steps mirror the README's own Quick Start (already-tested wording), condensed
  to fit 4 short steps instead of 6.

## Visual design

- **Typography:** IBM Plex Sans (headings, body) + IBM Plex Mono (version tag, small technical
  labels) — loaded from Google Fonts. Distinctive, technical-but-warm; avoids Inter/system-font
  sameness.
- **Color:** anchored on the app's actual icon blue (`build/icon.png`'s vivid blue, not the
  renderer UI's indigo accent) as the dominant color of the hero section — used boldly (a deep
  blue hero background), not diluted into a pastel gradient. Light surface below the fold for
  the how-it-works/works-with sections, keeping the page from being all-dark.
- **Motion:** one orchestrated load moment — the icon's radiating rings animate outward on page
  load, then settle to static. No scattered micro-interactions elsewhere on the page.
- **Background/atmosphere:** faint concentric ring arcs bleeding into the hero's dark-blue
  background for depth — the logo's own visual language extended into the page background,
  not a generic gradient mesh or flat solid.
- **OS-detected primary button:** the button label and href update via a small inline script
  based on `navigator.userAgent`/`navigator.platform` at page load; the two non-primary OS
  options remain visible as smaller secondary links so a visitor on someone else's computer (or
  a misdetected browser) isn't stuck.

## Technical / hosting

- Served via GitHub Pages from a `docs/` folder on `main` (simplest setup for a single static
  page — no separate branch, no build step, no framework). This repo already keeps its own
  planning docs under `docs/superpowers/` (specs, plans) — those coexist under the same folder
  and become reachable by direct URL once Pages is enabled, though GitHub Pages does not
  generate directory listings, so nothing becomes newly *discoverable*, only fetchable if you
  already know the path (same exposure level as browsing the repo on GitHub today). Nothing
  under `docs/superpowers/` contains secrets. `docs/index.html` is the only page meant to be
  found/linked.
- Single self-contained `docs/index.html` (inline `<style>`/`<script>`, Google Fonts the only
  external request) — no build tooling needed for a one-page static site.
- Pages source configured via the repo's Settings → Pages (or `gh api` equivalent) to serve
  from `main` / `docs`.
- The page's own asset (icon) is copied from `build/icon.png` into `docs/` rather than
  referenced across a path that won't resolve once Pages serves `docs/` as the site root.

## Out of scope

- No duplication of the README's full troubleshooting/security/client-specific connect
  instructions — those stay on GitHub, linked from the footer.
- No custom domain — GitHub's default `krishngohel.github.io/local-browser/` URL.
- No analytics/tracking.
