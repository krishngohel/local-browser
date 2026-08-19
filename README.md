# Echo

Installable desktop browser that runs on your computer and exposes an **MCP server**. Cursor, Claude Desktop, Continue, Cline, Windsurf, VS Code, and other MCP clients can drive it with your existing subscription. There is no model API and no cloud Chromium.

## Install

Download the installer for your computer from [GitHub Releases](https://github.com/krishngohel/local-browser/releases) (or run `npm run dist` on that OS).

### Windows

1. Open `Echo-Setup-1.0.0-x64.exe`. SmartScreen may warn because the build is **unsigned** — choose **More info** → **Run anyway**.
2. Finish the wizard. Shortcuts are added to the Desktop and Start Menu.
3. Leave Echo running (closing the window hides it to the tray). Open **Settings** (⋮) → **Connections**.

Uninstall from Windows Settings → Apps. Your profile stays in `%APPDATA%\Echo` unless you delete that folder.

### Mac

1. Open `Echo-1.0.0-mac-universal.dmg` (Apple Silicon and Intel).
2. Drag Echo to **Applications**. Do not keep running it from the disk image.
3. Eject the disk image, then open Echo from Applications.
4. First launch is blocked because the build is **unsigned** (no Apple Developer ID yet):
   - Right-click Echo → **Open** → **Open**.
   - On macOS Sequoia or later, if that is missing: **System Settings → Privacy & Security → Open Anyway**.
5. Leave Echo running. Closing the red traffic-light button hides the window; Echo stays in the Dock and the menu bar. Quit from the **Echo** menu, **Cmd+Q**, or the menu-bar icon.
6. Open **Settings → Connections**. Install [Node.js](https://nodejs.org) if you will use **Connect Claude Desktop** (Claude launched from the Dock cannot see Homebrew on PATH unless Echo writes an absolute Node path).

Profile: `~/Library/Application Support/Echo`.

GitHub only publishes the `.dmg` when a `v*` tag is pushed (for example `v1.0.0`). A manual **Run workflow** builds artifacts you can download from the Actions run; it does not create a Release.

### Linux

1. Make `Echo-1.0.0-linux-x64.AppImage` executable and run it.
2. Leave Echo running (tray). Open **Settings** → **Connections**.

On this computer the MCP URL is `http://127.0.0.1:18931/mcp` (127.0.0.1 always means the machine running Echo). Echo also shows **this computer’s current Wi-Fi/Ethernet address** in Settings for other devices on the same network. Bearer token required. MCP server name: `echo`.

The skill tree in [skills/ECHO-SKILL-TREE.md](skills/ECHO-SKILL-TREE.md) is sent to the model automatically when an MCP client connects. You only need to paste it if a client ignores server instructions.

## Run from source

Requires Node.js 20+.

```bash
npm install
npm run dev
```

`npm run dev` compiles TypeScript and opens the Electron window. Playwright talks to this same Chromium over CDP (port 9333). You do not need a second browser install for everyday use.

On Windows, after `npm run dist`, `npm run start-menu` adds Echo to this user’s Start Menu without running the NSIS wizard.

## Connect

1. Leave Echo running (tray on Windows/Linux, menu bar on Mac).
2. Open **Settings** (⋮ menu) → **Connections**.
3. **Connect Cursor** writes `~/.cursor/mcp.json` using `http://127.0.0.1:18931/mcp` (backs up any existing file to `mcp.json.bak`). Enable `echo` in Cursor Settings → MCP if it shows as disabled.
4. **Connect Claude Desktop** writes the Claude config for this OS (`%APPDATA%\Claude\…` on Windows, `~/Library/Application Support/Claude/…` on Mac, `~/.config/Claude/…` on Linux) using Node + `mcp-remote`. Echo launches Node by full path so Claude started from the Dock/Start Menu still works. Install [Node.js](https://nodejs.org) if Connect warns it is missing. Fully quit and reopen Claude Desktop.
5. **Connect ChatGPT / Codex** writes `~/.codex/config.toml` (backs up to `config.toml.bak`). ChatGPT desktop, Codex CLI, and the Codex IDE extension share that file. Fully quit and reopen ChatGPT/Codex. **chatgpt.com in a browser cannot reach Echo** unless you expose it with your own HTTPS tunnel.
6. **Any other AI** — copy the HTTP, stdio, or VS Code JSON from the same Settings page. Use the **This computer** snippet if the client runs on this computer. Use the **This network** snippet (detected LAN IP) if the client runs on another device on your Wi-Fi.

Do not skip the Connect buttons for Cursor/Claude. The app will not silently rewrite other people’s MCP configs. The URLs are generated on **this** machine; they are not hardcoded to a developer’s IP.

## Recordings

Click the red **record** button in the toolbar (or Settings → Recordings), or have the assistant call `record_start`. Echo logs your clicks and typing **and** Cursor/Claude MCP tools (`navigate`, `click`, `type`, and the rest) on this computer. **Play** runs the saved steps in order with no LLM. Files live in the app userData `recordings/` folder.

Assistants can use `record_start`, `record_stop`, `recordings_list`, `recording_play`, and `recording_delete`.

## Agent tools

Browse: `tabs_list`, `tabs_new`, `tabs_close`, `tabs_select`, `navigate`, `back`, `reload`, `snapshot`, `screenshot`, `watch`, `click`, `type`, `fill`, `press`, `scroll`, `select`, `wait_for`

Search / extract: `search_web` (Google), `extract_readable`

Observe: `console_errors`, `network_failures`

Test: `viewport_set`, `test_start`, `test_assert_text`, `test_assert_url`, `test_end` (reports under the app userData `runs/` folder)

Record: `record_start`, `record_stop`, `recordings_list`, `recording_play`, `recording_delete`

Call `snapshot` before `click` / `type` / `fill`. Snapshot refs look like `e0`, `e1`. `snapshot` and `screenshot` return a photograph of the page. `watch` returns a short live feed (ordered frames) so assistants can see animations and motion.

## Build installers

```bash
npm install
npm run dist
```

Builds the installer for **the OS you are on**:

| OS | Output |
| --- | --- |
| Windows | `dist-installer/Echo-Setup-1.0.0-x64.exe` |
| Mac | `dist-installer/Echo-1.0.0-mac-universal.dmg` |
| Linux | `dist-installer/Echo-1.0.0-linux-x64.AppImage` |

GitHub Actions (`.github/workflows/release.yml`) builds all three on `v*` tags. You cannot produce a Mac `.dmg` from Windows — that job runs on `macos-latest`.

Mac and Windows installers are unsigned unless you add signing secrets. On Mac, first open with right-click → Open (or Privacy & Security → Open Anyway). On Windows, use SmartScreen **More info** → **Run anyway**.

## Legal

- [Privacy Policy](legal/PRIVACY.md)
- [Terms of Service](legal/TERMS.md)
- [MIT License](LICENSE)

The same documents are in the app under **Settings → About**, **Privacy**, and **Terms**.

## Security

- MCP listens on all interfaces (`0.0.0.0:18931`, or the next free port up to +9) so this computer’s LAN address can connect. Same-machine clients should still use `http://127.0.0.1:18931/mcp`. Port 8931 is avoided because Playwright MCP uses it.
- A bearer token is created on first launch (`userData/mcp-token.txt`) and written into Cursor/Claude config headers. Other clients need the same `Authorization: Bearer …` header.
- On connect, Echo sends the skill tree as MCP `instructions`, plus a resource, a prompt, and `echo_help`.
- Profile is isolated (`persist:local-browser`), not your daily Chrome.
- Downloads go to the app userData `downloads/` folder.
- Recordings stay in `recordings/` on this computer.
- Anything you log into in this window is visible to the connected agent.
- For captcha / 2FA, complete it in the window; ask the agent to `wait_for`.
- If another device cannot connect, allow Echo through this computer’s firewall on private networks. Do not share the token.

The browsing session identifies as **Google Chrome** on this OS (Chromium 136 in Electron 36): Chrome user-agent, `Sec-CH-UA` brands (`Google Chrome` + `Chromium`), no `Electron` in the UA. Sites that only allow Chrome should treat this like Chrome. `navigator.webdriver` automation is disabled via `AutomationControlled`.

If Google shows a consent or captcha screen, complete it in the window; agents should `wait_for`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Build + run unpackaged |
| `npm run build` | Compile (with source maps) |
| `npm run build:prod` | Minified compile for the installer |
| `npm run dist` | Installer for this OS |
| `npm run dist:win` | Windows NSIS only |
| `npm run dist:mac` | Mac DMG only (must run on a Mac) |
| `npm run dist:linux` | Linux AppImage only |
| `npm run icon` | Write `build/icon.png` (any OS; skips if a real icon already exists unless you pass `--force` via this script) |
| `npm run packaging:check` | Confirm installer assets exist before `electron-builder` |
| `npm run start-menu` | Add Echo to this user’s Start Menu (Windows) |
