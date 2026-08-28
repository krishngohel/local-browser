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
