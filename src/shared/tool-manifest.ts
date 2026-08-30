export type ToolGroup =
  | "always"
  | "toolsBrowse"
  | "toolsSee"
  | "toolsSearch"
  | "toolsDebug"
  | "toolsTest"
  | "toolsRecord"
  | "toolsRead"
  | "toolsInteract"
  | "toolsState"
  | "toolsQa";

export type ToolManifestEntry = { name: string; group: ToolGroup; description: string };

export const GROUP_LABELS: Record<ToolGroup, string> = {
  always: "Always on",
  toolsBrowse: "Browse and click",
  toolsSee: "Screenshots and live feed",
  toolsSearch: "Search and article text",
  toolsDebug: "Console and network",
  toolsTest: "Product tests",
  toolsRecord: "Recordings",
  toolsRead: "Read and data",
  toolsInteract: "Interaction depth",
  toolsState: "Sessions and state",
  toolsQa: "Automation and QA",
};

/**
 * Every Echo MCP tool, its group, and its one-line description.
 * The description here is the description the tool is registered with.
 */
export const TOOL_MANIFEST: ToolManifestEntry[] = [
  {
    name: "echo_help",
    group: "always",
    description: "How to drive Echo. Call this if the automatic skill tree is missing or you are unsure which tool to use.",
  },

  // Browse and click
  { name: "tabs_list", group: "toolsBrowse", description: "List open browser tabs." },
  { name: "tabs_new", group: "toolsBrowse", description: "Open a new tab. Optional URL, otherwise the search homepage. Set incognito for a tab with no history, on a throwaway cookie jar shared by incognito tabs and cleared when the last one closes." },
  { name: "tabs_close", group: "toolsBrowse", description: "Close a tab by id." },
  { name: "tabs_select", group: "toolsBrowse", description: "Focus a tab by id." },
  {
    name: "navigate",
    group: "toolsBrowse",
    description: "Navigate the active tab (or a given tab) to a URL. Bare words are treated as a search. Recorded if recording is on.",
  },
  { name: "back", group: "toolsBrowse", description: "Go back in history on the active tab." },
  { name: "reload", group: "toolsBrowse", description: "Reload the active tab." },
  {
    name: "snapshot",
    group: "toolsBrowse",
    description: "Interactive elements plus a photo of the visible page. Use this to see layout, spacing, and colors. Use refs (e0, e1, …) with click/type/fill/select. Optionally target a specific tabId (see tabs_list).",
  },
  {
    name: "click",
    group: "toolsBrowse",
    description: "Click an element from the latest snapshot by ref (e.g. e3). Recorded if recording is on. Optionally target a specific tabId (see tabs_list).",
  },
  {
    name: "type",
    group: "toolsBrowse",
    description: "Type into an element from the snapshot. Set submit to press Enter. Recorded if recording is on. Optionally target a specific tabId (see tabs_list).",
  },
  { name: "fill", group: "toolsBrowse", description: "Clear and fill an input from the snapshot. Optionally target a specific tabId (see tabs_list)." },
  { name: "press", group: "toolsBrowse", description: "Press a keyboard key (Playwright key name, e.g. Enter, Tab, Control+l). Optionally target a specific tabId (see tabs_list)." },
  { name: "scroll", group: "toolsBrowse", description: "Scroll the page. Positive deltaY scrolls down. Optionally target a specific tabId (see tabs_list)." },
  { name: "select", group: "toolsBrowse", description: "Choose an option in a <select> from the snapshot. Optionally target a specific tabId (see tabs_list)." },
  {
    name: "wait_for",
    group: "toolsBrowse",
    description: "Wait until the page contains text, or until loading finishes if text is omitted. Optionally target a specific tabId (see tabs_list).",
  },

  // Screenshots and live feed
  {
    name: "screenshot",
    group: "toolsSee",
    description: "Photograph the visible page and return the image so you can see the UI. Use this for visual QA, layout checks, and UI building. Optional fullPage captures the full document. Optionally target a specific tabId (see tabs_list).",
  },
  {
    name: "watch",
    group: "toolsSee",
    description: "Live feed: record the visible page for a short time and return ordered frames so you can see animations, transitions, hover, spinners, carousels, and video. Use this instead of screenshot when motion matters. durationMs 800–6000 (default 2500). Optionally target a specific tabId (see tabs_list).",
  },

  // Search and article text
  {
    name: "search_web",
    group: "toolsSearch",
    description: "Search the web via Google in a real Chrome-compatible tab (no search API). Opens a tab and returns titled results. Recorded if recording is on.",
  },
  {
    name: "extract_readable",
    group: "toolsSearch",
    description: "Extract article-like markdown from the current page (nav/chrome stripped).",
  },

  // Console and network
  { name: "console_errors", group: "toolsDebug", description: "Recent console errors/warnings from the active tab." },
  { name: "network_failures", group: "toolsDebug", description: "Recent main-frame HTTP failures and load errors." },

  // Product tests
  {
    name: "viewport_set",
    group: "toolsTest",
    description: "Emulate a viewport size for product testing (width x height CSS pixels).",
  },
  {
    name: "test_start",
    group: "toolsTest",
    description: "Start a test run: screenshot, optional Playwright trace, report folder under userData/runs.",
  },
  {
    name: "test_assert_text",
    group: "toolsTest",
    description: "Assert the current page text contains a string (case-insensitive).",
  },
  {
    name: "test_assert_url",
    group: "toolsTest",
    description: "Assert the current URL matches a substring or regular expression.",
  },
  { name: "test_end", group: "toolsTest", description: "Stop the test run, save end screenshot/trace, write report.json." },

  // Recordings
  {
    name: "record_start",
    group: "toolsRecord",
    description: "Start recording. Captures both the user and this assistant (navigate, click, type, fill, press, scroll, select, search_web, new tab). Playback does not need an LLM. Call this before a flow you want to replay later. Optional name.",
  },
  { name: "record_stop", group: "toolsRecord", description: "Stop the current recording and save it on this computer." },
  {
    name: "recordings_list",
    group: "toolsRecord",
    description: "List saved recordings (id, name, step count). Playback does not need an LLM.",
  },
  {
    name: "recording_play",
    group: "toolsRecord",
    description: "Replay a saved recording by id. Runs locally with no model involved.",
  },
  { name: "recording_delete", group: "toolsRecord", description: "Delete a saved recording by id." },

  // Read and data
  {
    name: "get_text",
    group: "toolsRead",
    description: "Visible text of the page, or of one element by snapshot ref. Optionally target a specific tabId (see tabs_list). Capped at 40,000 chars.",
  },
  {
    name: "find",
    group: "toolsRead",
    description: "Find interactive elements by visible text, role, or label. Returns snapshot refs you can click/type. Optionally target a specific tabId (see tabs_list).",
  },
  { name: "links", group: "toolsRead", description: "List links on the page (text + href), optional substring filter, up to 300. Optionally target a specific tabId (see tabs_list)." },
  {
    name: "tables",
    group: "toolsRead",
    description: "Extract every <table> on the page as markdown (headers + up to maxRows rows each). Optionally target a specific tabId (see tabs_list).",
  },
  {
    name: "forms",
    group: "toolsRead",
    description: "List forms and their fields (name, type, value, label, ref) so you can fill them. Optionally target a specific tabId (see tabs_list).",
  },
  {
    name: "page_info",
    group: "toolsRead",
    description: "Title, URL, meta description, language, canonical, h1s, and element counts for the page. Optionally target a specific tabId (see tabs_list).",
  },
  { name: "html", group: "toolsRead", description: "Outer HTML of the document or of one element by ref. Optionally target a specific tabId (see tabs_list). Capped at 50,000 chars." },
  { name: "pdf_text", group: "toolsRead", description: "Text of the current PDF, or of the page printed to PDF. Optionally target a specific tabId (see tabs_list)." },
  { name: "captcha_check", group: "toolsRead", description: "Report whether a CAPTCHA or anti-bot challenge (reCAPTCHA, hCaptcha, Cloudflare Turnstile) is on the page. Echo does not solve these; if one is present, pause and ask the user to complete it in the Echo window. Optionally target a specific tabId (see tabs_list)." },

  // Interaction depth
  { name: "hover", group: "toolsInteract", description: "Hover an element by ref (opens menus, shows tooltips)." },
  { name: "double_click", group: "toolsInteract", description: "Double-click an element by ref." },
  { name: "right_click", group: "toolsInteract", description: "Right-click an element by ref (opens its context menu)." },
  { name: "drag", group: "toolsInteract", description: "Drag an element by ref onto another ref, or by dx/dy pixels." },
  { name: "keyboard_shortcut", group: "toolsInteract", description: "Press a key chord such as Control+Shift+P." },
  { name: "upload_file", group: "toolsInteract", description: "Upload to a file input or upload button by ref. Give local file paths, inline files you write yourself ({name, content, encoding: text|base64}), or both." },
  {
    name: "dialog",
    group: "toolsInteract",
    description: "Set how alerts, confirms, and prompts are answered on this tab (accept or dismiss, optional prompt text) and report the last dialog seen. Covers dialogs raised by the main frame.",
  },
  { name: "frames", group: "toolsInteract", description: "List iframes on the page." },
  {
    name: "frame_select",
    group: "toolsInteract",
    description: "Scope snapshot/click/get_text to an iframe by index; omit index to return to the main frame.",
  },
  { name: "zoom", group: "toolsInteract", description: "Set the page zoom factor (0.25-5), or omit to reset." },
  {
    name: "evaluate",
    group: "toolsInteract",
    description: "Runs JavaScript in the page and returns the JSON result. Enabled by the user in Settings → Transfers.",
  },
  {
    name: "fill_form",
    group: "toolsInteract",
    description: "Fill several fields from the latest snapshot/forms call in one round-trip: { ref, value } pairs. Text/textarea fields are typed, <select> fields choose the option matching value, checkboxes/radios are clicked only when value is truthy (already-checked boxes are not unchecked). Returns a per-field { ref, ok, error? } result so one bad ref does not block the rest. Optionally target a specific tabId.",
  },

  // Sessions and state
  { name: "cookies_get", group: "toolsState", description: "List cookies, optionally for one URL." },
  { name: "cookies_set", group: "toolsState", description: "Set a cookie for a URL." },
  { name: "cookies_clear", group: "toolsState", description: "Delete cookies for a URL, or all cookies." },
  { name: "storage_get", group: "toolsState", description: "Read localStorage or sessionStorage (one key or all)." },
  { name: "storage_set", group: "toolsState", description: "Write or delete a localStorage/sessionStorage key." },
  { name: "clear_site_data", group: "toolsState", description: "Clear storage and cache for one origin, or everything." },
  { name: "history_search", group: "toolsState", description: "Search Echo's browsing history by URL or title." },
  {
    name: "downloads_list",
    group: "toolsState",
    description: "List files downloaded in this session and the downloads folder.",
  },
  {
    name: "bookmarks",
    group: "toolsState",
    description: "List, add, or remove bookmarks (add uses the current page when url is omitted).",
  },
  {
    name: "profile_get",
    group: "toolsState",
    description: "Read the stored applicant profile (name, email, phone, address, links). Empty fields mean nothing is stored yet.",
  },
  {
    name: "profile_set",
    group: "toolsState",
    description: "Save or update applicant profile fields (name, email, phone, address, links) so fill_form/profile_suggest_fill can reuse them across applications. Only given fields are changed.",
  },

  // Automation and QA
  {
    name: "assert_visible",
    group: "toolsQa",
    description: "PASS/FAIL: an element (by ref) is visible or text is on the page. Recorded in the active test run.",
  },
  { name: "assert_url", group: "toolsQa", description: "PASS/FAIL: current URL matches a substring or regex." },
  {
    name: "assert_count",
    group: "toolsQa",
    description: "PASS/FAIL: number of matching elements (by role/text) equals expected.",
  },
  { name: "visual_baseline", group: "toolsQa", description: "Save a named screenshot baseline of the viewport." },
  {
    name: "visual_diff",
    group: "toolsQa",
    description: "Compare the viewport to a named baseline; returns changed percent, pass/fail, and a diff image path.",
  },
  {
    name: "perf_timing",
    group: "toolsQa",
    description: "Navigation timing (TTFB, DOMContentLoaded, load) plus LCP and CLS if observed.",
  },
  {
    name: "network_log",
    group: "toolsQa",
    description: "Recent document and API requests on this tab (method, url, status, type, ms, bytes), newest first. Images, scripts, styles and fonts are not logged.",
  },
  {
    name: "schedule_recording",
    group: "toolsQa",
    description: "Replay a saved recording on an interval while Echo is open. action add/list/cancel.",
  },
  {
    name: "run_recording_steps",
    group: "toolsQa",
    description: "Play a slice of a saved recording (from step index, optional to).",
  },
];
