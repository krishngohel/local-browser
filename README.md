# Echo

**Echo** is a desktop browser that runs on your computer. It exposes an **MCP server** so Cursor, Claude Desktop, ChatGPT/Codex, Continue, Cline, Windsurf, VS Code, and other MCP clients can drive it with your existing subscription.

There is no model API and no cloud Chromium. The browser window you see is the one the assistant controls.

---

## Quick start (for your friend)

1. **Install Echo** on your computer (Windows, Mac, or Linux — see below).
2. **Leave Echo running.** Closing the window hides it; it keeps running in the tray (Windows/Linux) or menu bar (Mac).
3. Open **Settings** (⋮ menu, top right) → **Connections**.
4. Click **Connect** for Cursor, Claude, or ChatGPT/Codex.
5. **Fully quit and reopen** that AI app so it picks up Echo.
6. Ask the assistant to search the web or open a page — it should use Echo’s tools (`navigate`, `snapshot`, `search_web`, etc.).

MCP URL on the same computer: `http://127.0.0.1:18931/mcp`  
Server name: `echo`  
A bearer token is shown in Settings → Connections (Echo creates it on first launch).

---

## Download

**Installers:** [GitHub Releases](https://github.com/krishngohel/local-browser/releases)

Pick the file for your OS:

| Your computer | Download this file |
| --- | --- |
| Windows (Intel/AMD 64-bit) | `Echo-Setup-*-x64.exe` |
| Windows (ARM — Surface, Snapdragon PC) | `Echo-Setup-*-arm64.exe` |
| Mac (Apple Silicon or Intel) | `Echo-*-mac-universal.dmg` (or `*-mac-arm64.dmg` on Releases) |
| Linux (64-bit) | `Echo-*-linux-x64.AppImage` |

If the Releases page is empty, the maintainer needs to publish a version tag (for example `v1.0.0`) so GitHub Actions builds the installers. Until then, use [Run from source](#run-from-source-developers) below.

**Repo:** https://github.com/krishngohel/local-browser

---

## Install — Windows

1. Download the installer for **your CPU** from [Releases](https://github.com/krishngohel/local-browser/releases):
   - Most PCs: `Echo-Setup-*-x64.exe`
   - **ARM laptops** (Surface Pro X, Snapdragon, Copilot+ PC): `Echo-Setup-*-arm64.exe` — do not use the x64 build on ARM.
2. Run the installer. **Windows SmartScreen** may warn because the build is unsigned:
   - Click **More info** → **Run anyway**.
3. Finish the wizard. Echo installs to `%LOCALAPPDATA%\Programs\Echo\` and adds Desktop + Start Menu shortcuts.
4. Echo opens when setup finishes. **Leave it running.**
5. Closing the window **does not quit Echo** — it hides to the **system tray** (by the clock). Right-click the Echo icon there to **Show** or **Quit**.

**Open Settings:** click the **⋮** menu (top right) → Connections.

**Uninstall:** Windows Settings → Apps → Echo. Your browsing profile stays in `%APPDATA%\Echo` unless you delete that folder manually.

---

## Install — Mac

1. Download `Echo-1.0.0-mac-universal.dmg` from [Releases](https://github.com/krishngohel/local-browser/releases).
2. Open the `.dmg`. Drag **Echo** to **Applications**.
3. **Eject the disk image.** Do not keep using Echo from the mounted `.dmg` — it will stop working after eject. Echo warns you if you launch from the disk image.
4. Open Echo from **Applications**.
5. **First launch — Gatekeeper:** the app is unsigned (no Apple Developer ID yet). macOS blocks a normal double-click:
   - **Right-click Echo** → **Open** → **Open**.
   - On macOS Sequoia or later, if needed: **System Settings → Privacy & Security → Open Anyway**.
6. **Leave Echo running.** The red close button **hides** the window; Echo stays in the **Dock** and **menu bar** (top right).
   - Show again: click the Dock icon, menu-bar icon, or **Echo → Show Echo**.
   - Quit: **Echo → Quit Echo**, **Cmd+Q**, or menu-bar icon → Quit.

**Open Settings:** ⋮ menu → Connections.

**If you use Claude Desktop:** install [Node.js](https://nodejs.org) (LTS) from nodejs.org. Claude launched from the Dock cannot see Homebrew’s PATH; Echo writes Node’s full path when you click Connect.

**Profile folder:** `~/Library/Application Support/Echo`

**Firewall (optional):** if another device on your Wi-Fi cannot connect, allow Echo in **System Settings → Network → Firewall**.

---

## Install — Linux

1. Download `Echo-1.0.0-linux-x64.AppImage` from [Releases](https://github.com/krishngohel/local-browser/releases).
2. Make it executable and run it:

```bash
chmod +x Echo-1.0.0-linux-x64.AppImage
./Echo-1.0.0-linux-x64.AppImage
```

3. **Leave Echo running** (system tray). Open **Settings → Connections** from the ⋮ menu.

**Profile folder:** `~/.config/Echo` (or the Electron userData path for the packaged app).

**Firewall (optional):** allow TCP port **18931** (or the port shown in Settings) if another device on your LAN needs to connect.

---

## Connect your AI

Echo must be **running** before you connect. Open **Settings** (⋮) → **Connections**.

The green dot next to **MCP server** means Echo is listening. Copy the **This computer** URL if you need it manually: `http://127.0.0.1:18931/mcp`.

### What the assistant can do

Tools are grouped. Each group is a switch in **Settings → Tools** (the same switches appear under Transfers). Turning a group off removes those tools from the assistant entirely.

| Group | Tools | On by default | What it covers |
| --- | --- | --- | --- |
| Always on | 1 | Yes | `echo_help`, the built-in guide |
| Browse and click | 15 | Yes | tabs, navigate, snapshot, click, type, fill, scroll, wait |
| Screenshots and live feed | 2 | Yes | `screenshot`, `watch` |
| Search and article text | 2 | Yes | `search_web`, `extract_readable` |
| Console and network | 2 | Yes | `console_errors`, `network_failures` |
| Product tests | 5 | Yes | viewport, test start / assert / end |
| Recordings | 5 | Yes | record, list, replay, delete |
| Read and data | 8 | Yes | text, find, links, tables, forms, page info, HTML, PDF text |
| Interaction depth | 10 | No | hover, drag, right-click, dialogs, frames, zoom, file upload |
| Sessions and state | 9 | No | cookies, storage, history, downloads, bookmarks, clear site data |
| Automation and QA | 9 | No | asserts, visual diff, page speed, request log, schedules |

Two of those groups reach past the page: Interaction depth includes uploading any local file the assistant names or writes itself, and Sessions and state exposes every cookie and storage value in this profile, including sign-in tokens.

That adds up to **40 tools on a fresh install** and **68 with every group on**. One more tool, `evaluate` (run JavaScript in the page), brings the total to **69**, and it needs both Interaction depth and its own switch in Settings → Transfers.

**Reconnect the AI client after changing groups.** MCP clients read the tool list once, at startup.

Full descriptions: [skills/ECHO-SKILL-TREE.md](skills/ECHO-SKILL-TREE.md).

### Cursor

1. In Echo: click **Connect** under Cursor.
2. Echo writes `~/.cursor/mcp.json` (backs up any existing file to `mcp.json.bak`).
3. In Cursor: **Settings → MCP** — enable `echo` if it shows as disabled.
4. Start a new chat. The assistant should see Echo tools (`navigate`, `snapshot`, `search_web`, …).

### Claude Desktop

**Connect does not hot-plug.** Echo writes a config file; Claude only reads it on startup.

1. In Echo: click **Connect** under Claude Desktop (Echo must be running).
2. Echo writes Claude’s config:
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`
3. **Fully quit Claude Desktop** — this is the step most people miss:
   - Mac: **Cmd+Q** (closing the red button is not enough)
   - Windows: right-click Claude in the **system tray** → **Exit**
4. **Keep Echo running** (tray / menu bar).
5. Open Claude again.
6. In Claude: **Settings → Developer → Local MCP servers** — confirm `echo` is listed. A **hammer icon** in chat means MCP tools are active.

**Packaged Echo (v1.0.1+)** uses Echo itself as the bridge — **Node.js is not required**.

**Do not** use Claude’s “Add custom connector” — that is for public HTTPS servers only.

If it still fails, see [Claude will not connect](#claude-will-not-connect) below.

### ChatGPT / Codex desktop

1. In Echo: click **Connect** under ChatGPT / Codex.
2. Echo writes `~/.codex/config.toml` (backs up to `config.toml.bak`).
3. **Fully quit and reopen** ChatGPT desktop or Codex.

**Note:** chatgpt.com in a normal browser **cannot** reach Echo on your computer unless you set up your own HTTPS tunnel.

### Any other MCP client

On the same Settings page, copy one of:

- **HTTP (this computer)** — Cursor, Continue, Cline, Windsurf, VS Code, etc.
- **stdio (this computer)** — clients that only support command-based MCP.
- **This network** — if the AI client runs on another device on your Wi-Fi (uses your computer’s LAN IP; still needs the bearer token).

Paste the JSON/TOML into that client’s MCP config. Include the `Authorization: Bearer …` header exactly as shown.

---

## Verify it works

1. Echo is running (tray / menu bar).
2. Settings → Connections shows **MCP server** as listening.
3. Your AI app was **fully restarted** after Connect.
4. Ask something like: *“Search Google for Echo browser MCP and open the first result in Echo.”*

The assistant should call tools such as `search_web`, `navigate`, and `snapshot`. If tools are missing, check that `echo` is enabled in the client’s MCP settings and reconnect.

**Captcha / login / 2FA:** complete it in the Echo window yourself. Tell the assistant to `wait_for` and then continue.

---

## Day-to-day use

| Action | Windows / Linux | Mac |
| --- | --- | --- |
| Hide window | Close window (stays in tray) | Red button (stays in Dock + menu bar) |
| Show Echo again | Tray icon → Show | Dock or menu-bar icon |
| Quit completely | Tray → Quit | Echo menu → Quit, or Cmd+Q |
| Open Settings | ⋮ menu | ⋮ menu |
| New tab | Ctrl+T | Cmd+T |
| Focus address bar | Ctrl+L | Cmd+L |
| Incognito tab | Ctrl+Shift+N | Cmd+Shift+N |
| Command palette | Ctrl+K | Cmd+K |

**Command palette:** **Ctrl+K** (Cmd+K on Mac) opens a search box over the page for tabs, history, bookmarks, settings, and actions.

**Incognito tab:** **Ctrl+Shift+N** (Cmd+Shift+N on Mac) opens a tab on a shared throwaway cookie jar, cleared when the last incognito tab closes. It writes no history and keeps nothing after you close it.

**Assistant pill:** while an AI client is connected, a pill in the toolbar shows the tool it is running. Click **Pause** there to stop the assistant mid-flow. Paused tools return "Echo is paused by the user" until you resume.

**Appearance:** Settings → Appearance. Light, dark, or follow the system, plus compact chrome and the home page.

**Activity:** Settings → Activity. The last calls this session, with client, tool, how long it took, and the result. Clear it or pause from the same page.

**Tools:** Settings → Tools. Every tool a connected assistant can call, its group, and whether it is on right now.

**Open at login:** Settings → System → **Open at login** (starts hidden in the background).

**Downloads, screenshots, recordings:** Settings → System → **Open folder**.

**Token usage and tool count:** Settings → Transfers. Turn off page photos, watch frames, or the skill tree on connect if you want fewer tokens. A fresh install exposes **40 tools**; Cursor and some other clients get unreliable past roughly 40 tools across every MCP server at once, so turn groups off if that cap bites. Reconnect the AI client after changing tool groups.

---

## Run from source (developers)

Requires **Node.js 20+**.

```bash
git clone https://github.com/krishngohel/local-browser.git
cd local-browser
npm install
npm run dev
```

This compiles the app and opens the Electron window. Playwright connects to the same Chromium over CDP (port 9333). You do not need a separate browser install.

**Build an installer on your machine:**

```bash
npm run dist
```

| OS | Output |
| --- | --- |
| Windows x64 | `dist-installer/Echo-Setup-*-x64.exe` |
| Windows ARM64 | `dist-installer/Echo-Setup-*-arm64.exe` |
| Mac | `dist-installer/Echo-1.0.0-mac-universal.dmg` |
| Linux | `dist-installer/Echo-1.0.0-linux-x64.AppImage` |

You cannot build a Mac `.dmg` from Windows — that requires a Mac or GitHub Actions on `macos-latest`.

On Windows, after `npm run dist`, `npm run start-menu` adds Echo to the Start Menu without rerunning the installer wizard.

---

## Troubleshooting

### “Echo is already running”

Only one Echo instance should run (MCP port conflict). Find Echo in the tray (Windows/Linux) or menu bar (Mac). Quit from there, then open Echo once.

### Claude will not connect

Connect **saves a file** — it does not restart Claude for you.

1. **Echo must be running** when Claude starts (tray on Windows, menu bar on Mac).
2. **Fully quit Claude**, not just close the chat window:
   - Mac: **Cmd+Q**
   - Windows: tray icon → **Exit**
3. Reopen Claude. Check **Settings → Developer → Local MCP servers** for `echo`.
4. In Echo Settings → Connections, status should change from “Saved in Claude” to **Connected now** (green) once Claude’s bridge is live.
5. On **v1.0.0**, install [Node.js](https://nodejs.org) and click Connect again. **v1.0.1+** does not need Node — update from [Releases](https://github.com/krishngohel/local-browser/releases).
6. Claude logs (if needed): Mac `~/Library/Logs/Claude/`, Windows `%APPDATA%\Claude\logs\`.

### Cursor / Claude does not see Echo (general)

- Echo must be running before the AI app starts (or restart the AI app after Echo is up).
- Click **Connect** again in Settings → Connections.
- **Fully quit** Cursor or Claude (not just close the chat window), then reopen.
- Cursor: Settings → MCP → enable `echo`.
- Claude: use **Local MCP servers**, not “Add custom connector”.

### Claude says Node.js is missing

Install Node from https://nodejs.org, then click **Connect** again in Echo so it writes the correct path.

### Mac: “Echo cannot be opened” / “damaged”

Right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**. This is normal for unsigned apps.

### Mac: opened from the disk image

Drag Echo to Applications, eject the `.dmg`, open from Applications.

### SmartScreen / Gatekeeper warnings

Installers are **unsigned** until an code-signing certificate is added. Use the steps above — the app is built from this repo’s GitHub Actions.

### Google shows captcha or consent

Complete it in the Echo window. Ask the assistant to wait (`wait_for`) and retry.

### Another device on Wi-Fi cannot connect

Use the **This network** URL and token from Settings. Allow Echo through the host computer’s firewall on private networks. Do not share the token publicly.

### MCP port in use

Echo prefers port **18931** and tries **18931–18940**. Port 8931 is avoided (Playwright MCP default). Check Settings for the actual URL.

### Windows ARM laptop (Surface, Snapdragon)

Use **`Echo-Setup-*-arm64.exe`**, not the x64 installer. The x64 build may fail to install, crash, or behave oddly under emulation. Releases from **v1.0.2** include a native ARM64 Windows build. Settings → System → About → **System type** should say **ARM64-based PC**.

---

## What Echo gives an assistant

On connect, Echo sends a **skill tree** (how to browse, search, screenshot, record, etc.) unless you turn that off in Settings → Transfers.

**Browse and click:** `tabs_list`, `tabs_new`, `tabs_close`, `tabs_select`, `navigate`, `back`, `reload`, `snapshot`, `click`, `type`, `fill`, `press`, `scroll`, `select`, `wait_for`

**Screenshots and live feed:** `screenshot`, `watch`

**Search and article text:** `search_web`, `extract_readable`

**Console and network:** `console_errors`, `network_failures`

**Product tests:** `viewport_set`, `test_start`, `test_assert_text`, `test_assert_url`, `test_end`

**Recordings:** `record_start`, `record_stop`, `recordings_list`, `recording_play`, `recording_delete`

**Read and data:** `get_text`, `find`, `links`, `tables`, `forms`, `page_info`, `html`, `pdf_text`

Three more groups are off until you turn them on in Settings → Tools:

**Interaction depth:** `hover`, `double_click`, `right_click`, `drag`, `keyboard_shortcut`, `upload_file`, `dialog`, `frames`, `frame_select`, `zoom` (plus `evaluate` with its own switch)

**Sessions and state:** `cookies_get`, `cookies_set`, `cookies_clear`, `storage_get`, `storage_set`, `clear_site_data`, `history_search`, `downloads_list`, `bookmarks`

**Automation and QA:** `assert_visible`, `assert_url`, `assert_count`, `visual_baseline`, `visual_diff`, `perf_timing`, `network_log`, `schedule_recording`, `run_recording_steps`

Always **`snapshot` before `click` / `type` / `fill`**. Refs look like `e0`, `e1`.

Full guide: [skills/ECHO-SKILL-TREE.md](skills/ECHO-SKILL-TREE.md)

---

## Security (read this)

- Anything you **log into** in Echo is visible to a **connected assistant** while MCP is connected.
- MCP listens on this computer and your LAN (`0.0.0.0:18931`, or the next free port). Same-machine clients should use `127.0.0.1`.
- A **bearer token** protects the MCP server. Echo writes it into Cursor/Claude config when you Connect. Do not post the token online.
- Echo uses a **separate profile** from your daily Chrome — not your normal browser cookies.
- Downloads: app data folder → `downloads/`. Recordings: `recordings/`.

---

## Legal

- [Privacy Policy](legal/PRIVACY.md)
- [Terms of Service](legal/TERMS.md)
- [MIT License](LICENSE)

Also in the app: **Settings → About**, **Privacy**, **Terms**.

---

## Build / release (maintainers)

GitHub Actions (`.github/workflows/release.yml`) builds Windows, Mac, and Linux installers on **`v*` tags** (for example `git tag v1.0.0 && git push origin v1.0.0`). Manual **Run workflow** uploads artifacts to the Actions run but does not create a Release page.

Mac and Windows builds are unsigned unless signing secrets are configured.

| Script | What it does |
| --- | --- |
| `npm run dev` | Build + run unpackaged |
| `npm run dist` | Installer for this OS |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Single-platform installer |
| `npm run packaging:check` | Verify packaging files and the built output (run after `npm run build:prod`) |
| `npm run test:unit` | Unit tests (no browser needed) |
| `npm run test` | Unit tests, end-to-end tool tests, and the Claude bridge test |
