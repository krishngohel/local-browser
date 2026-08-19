import { app, type Session } from "electron";

export function chromeVersion(): string {
  return process.versions.chrome || "136.0.7103.48";
}

export function chromeMajor(): string {
  return chromeVersion().split(".")[0] || "136";
}

/** Reduced Chrome desktop UA — no Electron, no app name. Matches this OS so sites see a normal Chrome. */
export function chromeUserAgent(): string {
  const major = chromeMajor();
  const chrome = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome}`;
  }
  if (process.platform === "linux") {
    return `Mozilla/5.0 (X11; Linux x86_64) ${chrome}`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome}`;
}

export function chromeSecChUa(): string {
  const major = chromeMajor();
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not.A/Brand";v="24"`;
}

export function chromeSecChUaFullList(): string {
  const full = chromeVersion();
  return `"Google Chrome";v="${full}", "Chromium";v="${full}", "Not.A/Brand";v="10.0.0.0"`;
}

function chromePlatform(): string {
  if (process.platform === "darwin") return '"macOS"';
  if (process.platform === "linux") return '"Linux"';
  return '"Windows"';
}

/** Must run before app ready. */
export function applyChromeCommandLine(): void {
  app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
  app.userAgentFallback = chromeUserAgent();
}

export function chromePageShim(): string {
  const major = chromeMajor();
  return `(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
    const chromeBrand = { brand: 'Google Chrome', version: '${major}' };
    const data = navigator.userAgentData;
    if (data && Array.isArray(data.brands) && !data.brands.some((b) => b.brand === 'Google Chrome')) {
      const brands = [data.brands[0], chromeBrand, ...data.brands.slice(1)];
      try { Object.defineProperty(data, 'brands', { get: () => brands }); } catch (e) {}
    }
    window.chrome = window.chrome || { runtime: {} };
  })();`;
}

export function installChromePageShim(wc: Electron.WebContents): void {
  const apply = () => {
    void wc.executeJavaScript(chromePageShim()).catch(() => undefined);
  };
  wc.on("did-start-loading", apply);
  wc.on("dom-ready", apply);
}

export function applyChromeSession(ses: Session): void {
  const ua = chromeUserAgent();
  ses.setUserAgent(ua, "en-US,en");
  ses.webRequest.onBeforeSendHeaders(
    {
      urls: ["https://*/*", "http://*/*"],
    },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      requestHeaders["User-Agent"] = ua;
      requestHeaders["sec-ch-ua"] = chromeSecChUa();
      requestHeaders["sec-ch-ua-mobile"] = "?0";
      requestHeaders["sec-ch-ua-platform"] = chromePlatform();
      requestHeaders["sec-ch-ua-full-version"] = `"${chromeVersion()}"`;
      requestHeaders["sec-ch-ua-full-version-list"] = chromeSecChUaFullList();
      requestHeaders["sec-ch-ua-bitness"] = process.arch.includes("64") ? '"64"' : '"32"';
      requestHeaders["sec-ch-ua-arch"] = process.arch === "arm64" ? '"arm"' : '"x86"';
      callback({ requestHeaders });
    },
  );
}
