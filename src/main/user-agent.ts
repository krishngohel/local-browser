/**
 * Echo runs on a current Chromium (via Electron), but Electron's default user-agent carries
 * `Electron/<ver>` and the app-name token. Some sites treat those as "not a real browser" and
 * block or downgrade the page. This builds the plain desktop-Chrome UA for the Chromium
 * version Echo actually ships, so a genuine Chromium engine is not misread — it does not claim
 * to be anything it is not (the platform and Chrome version stay truthful).
 *
 * Pure so it unit-tests without Electron; `applyHonestUserAgent` does the one Electron call.
 */

/** The Chromium major version from a full version string ("126.0.6478.127" -> "126"). */
function majorOf(chromeVersion: string): string {
  const major = String(chromeVersion).split(".")[0];
  return /^\d+$/.test(major) ? major : "120";
}

/** Platform token for the UA, matching what desktop Chrome sends on each OS. */
function platformToken(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    default:
      return "X11; Linux x86_64";
  }
}

/** A plain, current desktop-Chrome user-agent for this platform and Chromium version. */
export function cleanChromeUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  return (
    `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${majorOf(chromeVersion)}.0.0.0 Safari/537.36`
  );
}

/**
 * Firefox desktop UA for this OS. Google's sign-in endpoint treats an embedded Chromium that
 * claims to be "Google Chrome" as an insecure WebView (the interstitial the user hits). It
 * does not apply that Chrome-WebView check to a Firefox UA, which is why accounts.google.com
 * is served this string only — every other site keeps the truthful Chrome UA.
 */
export function firefoxUserAgent(platform: NodeJS.Platform, firefoxVersion = "142.0"): string {
  const rv = /^\d+(\.\d+)?$/.test(firefoxVersion) ? firefoxVersion : "142.0";
  switch (platform) {
    case "darwin":
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${rv}) Gecko/20100101 Firefox/${rv}`;
    case "linux":
      return `Mozilla/5.0 (X11; Linux x86_64; rv:${rv}) Gecko/20100101 Firefox/${rv}`;
    default:
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${rv}) Gecko/20100101 Firefox/${rv}`;
  }
}

/** Host + path that serve Google's account/OAuth UI (including GIS iframes). */
export function isGoogleAuthHost(hostname: string, pathname = ""): boolean {
  const h = String(hostname || "").toLowerCase();
  const p = String(pathname || "").toLowerCase();
  if (h === "accounts.google.com" || h.endsWith(".accounts.google.com")) return true;
  if (h === "accounts.youtube.com") return true;
  if (h === "gsi.google.com") return true;
  if (h === "oauth2.googleapis.com") return true;
  if ((h === "google.com" || h === "www.google.com") && /\/(signin|accounts|oauth)/.test(p)) return true;
  return false;
}

export function isGoogleAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isGoogleAuthHost(parsed.hostname, parsed.pathname);
  } catch {
    return false;
  }
}
