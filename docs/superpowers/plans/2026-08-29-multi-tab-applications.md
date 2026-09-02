# Multi-tab Concurrent Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude fill out several job applications concurrently in Echo — every tool can target a specific tab, tabs get independent action queues, a batch-fill tool cuts round-trips, a profile store backs suggestion-only autofill, an in-page cursor shows what's happening, and an offscreen-rendered grid lets the user watch several tabs live at once.

**Architecture:** `BrowserHub` (`src/main/browser.ts`) currently threads every operation through one global "active tab" pointer. This plan splits every tab-scoped method into a `xCore(tab, ...)` implementation plus a thin public `x(..., tabId?)` wrapper that resolves the target tab and runs it through a per-tab promise queue — so same-tab calls stay ordered, different-tab calls run concurrently, and higher-level operations (`fillForm`, `profile_suggest_fill`) can call `xCore` directly from inside their own queue slot without deadlocking. Playwright-backed actions get a CDP-targetId-based tab resolver to replace today's URL-string matching (which silently collides when two tabs share a URL). A new "Applications" workspace opens tabs as offscreen-rendered (OSR) `BrowserView`s so their frames stream to a live grid regardless of which tab is "on top."

**Tech Stack:** Electron (`BrowserView`, offscreen rendering, `webContents.debugger`), Playwright-core over CDP (`connectOverCDP`), MCP SDK (`@modelcontextprotocol/sdk`), zod, TypeScript, Node's built-in test runner (`node --test`).

## Global Constraints

- Every new/changed MCP tool description must stay byte-identical across `src/shared/tool-manifest.ts`, the skill tree (`src/main/skill-tree.ts`), and the README — the existing `test-tools.mjs` tool-registration test enforces this; keep them in sync in the same commit as the tool code.
- `TOOL_GROUP_COUNTS` (`src/main/transfer-prefs.ts`) and `TOTAL_TOOLS` (`scripts/test-tools.mjs`) must be updated whenever a tool is added — never left to drift.
- `npx tsc --noEmit` has 4 pre-existing errors (browser.ts `selectOption`, preload/page.ts) — judge only newly introduced errors against that baseline; run with `NODE_OPTIONS=--max-old-space-size=8192`.
- Gates that must stay green after every task: `npm run test:unit`, `npm run test:tools` (needs ports 9333 + 18931 free — quit the installed Echo first), `npm run test:bridge`, `npm run packaging:check`.
- No stealth/evasion additions — this plan only adds legitimate tool surface and rendering plumbing, consistent with the project's prior decision to decline anti-detection work.
- Renderer CSP stays `img-src 'self' data:` — any new image data (grid frames, favicons) must be data URLs, never remote URLs.
- No resume file storage in the profile store — resumes stay on the existing `upload_file` tool.

---

## Task 1: Per-tab dispatch core — queue, CDP-targetId resolution, `xCore` split

This is a refactor of `BrowserHub`'s internals in `src/main/browser.ts`. It has no new tool surface yet (Task 2 wires tools to it), so its correctness gate is the *existing* test suite staying green plus two new unit tests proving the genuinely new behavior (per-tab ordering, CDP disambiguation). Classic write-test-first TDD doesn't fit a pure internal refactor of already-tested code; the two new-behavior tests below are still written and run before anything is called "done."

**Files:**
- Modify: `src/main/browser.ts`
- Test: `scripts/test-unit/tab-queue.test.mjs` (new)

**Interfaces:**
- Produces: `private withTab<T>(tabId: string | undefined, fn: (tab: Tab) => Promise<T>): Promise<T>` — every later public hub method calls this once, at its outermost layer, and nowhere else.
- Produces: `private resolveTab(tabId?: string): Tab` — throws `Unknown tab <id>` / `No active tab` exactly as `requireTab`/`requireActive` do today.
- Produces: `private exec(tab: Tab, js: string): Promise<unknown>`, `private withPage(tab: Tab, pwFn, fallback): Promise<void>`, `private resolveSelectors(tab: Tab, ref: string)`, `private selectorsForRef(tab: Tab, ref: string)` — same behavior as today, `tab` explicit instead of `this.active()`.
- Consumes: nothing from other tasks (this task is foundational).

- [ ] **Step 1: Add the per-tab queue and `withTab`/`resolveTab` to `BrowserHub`**

  In `src/main/browser.ts`, add a field alongside the other private fields (near `private activeId: string | null = null;`, around line 199):

  ```ts
  /** One promise chain per tab id, so same-tab calls stay ordered and different-tab calls run concurrently. */
  private tabQueues = new Map<string, Promise<unknown>>();
  ```

  Add these two methods near `requireActive`/`requireTab` (around line 2024-2034):

  ```ts
  private resolveTab(tabId?: string): Tab {
    return tabId ? this.requireTab(tabId) : this.requireActive();
  }

  /**
   * Runs `fn` against the resolved tab, queued behind any call already running for that same
   * tab id. Calls targeting different tabs never wait on each other. `fn` receives the tab
   * directly and should call `xCore(tab, ...)` helpers rather than public `x(tabId)` wrappers,
   * or it will enqueue onto its own slot and deadlock.
   */
  private withTab<T>(tabId: string | undefined, fn: (tab: Tab) => Promise<T>): Promise<T> {
    const tab = this.resolveTab(tabId);
    const prior = this.tabQueues.get(tab.id) ?? Promise.resolve();
    const run = prior.then(() => fn(tab), () => fn(tab));
    this.tabQueues.set(
      tab.id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
  ```

- [ ] **Step 2: Add CDP-targetId-based Playwright page resolution**

  Today `playwrightPage()` matches a Playwright `Page` to the active tab by comparing URLs (`src/main/browser.ts:2036-2048`), and the existing comment at the top of `hookDialogs` (line ~2077) already documents that two tabs on the same URL resolve to the same page. All non-incognito tabs share one partition (`persist:local-browser`, `src/main/paths.ts:87`), so this collision is real, not theoretical, and matters more once several application tabs can be open at once.

  Add a per-tab cached target id and a page→targetId cache near the top of the class (with `private thumbs`, around line 216):

  ```ts
  /** Electron's own CDP target id for each tab's webContents, once discovered (see `electronTargetId`). */
  private tabTargetIds = new Map<string, string>();
  /** Playwright Page -> its CDP target id, so repeat lookups don't pay another round trip. */
  private pageTargetIds = new WeakMap<PwPage, string>();
  ```

  Add these two private methods near `playwrightPage` (around line 2036):

  ```ts
  /**
   * This tab's own CDP target id, via Electron's in-process debugger (not the external
   * Playwright connection). Cached per tab id since a target id is stable for the tab's
   * lifetime. Returns null on any failure (e.g. a debugger already attached by devtools) so
   * callers fall back to URL matching rather than breaking.
   */
  private async electronTargetId(tab: Tab): Promise<string | null> {
    const cached = this.tabTargetIds.get(tab.id);
    if (cached) return cached;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return null;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const info = (await wc.debugger.sendCommand("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info.targetInfo?.targetId;
      if (id) this.tabTargetIds.set(tab.id, id);
      return id ?? null;
    } catch {
      return null;
    }
  }

  /** A Playwright page's own CDP target id, via its own CDP session (safe to hold alongside Electron's debugger — CDP targets support multiple attached sessions). */
  private async pwPageTargetId(page: PwPage): Promise<string | null> {
    const cached = this.pageTargetIds.get(page);
    if (cached) return cached;
    try {
      const session = await page.context().newCDPSession(page);
      const info = (await session.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info.targetInfo?.targetId ?? null;
      if (id) this.pageTargetIds.set(page, id);
      try {
        await session.detach();
      } catch {
        /* already gone */
      }
      return id;
    } catch {
      return null;
    }
  }
  ```

- [ ] **Step 3: Thread `tab: Tab` through `playwrightPage`, `requirePlaywrightPage`, `pwTarget`, `withPage`, `exec`, `resolveSelectors`, `selectorsForRef`**

  Replace `playwrightPage` (`src/main/browser.ts:2036-2048`):

  ```ts
  private async playwrightPage(tab: Tab): Promise<PwPage | null> {
    await this.connectPlaywright();
    if (!this.pw) return null;
    const url = tab.view.webContents.getURL();
    if (!url || url.startsWith("file:")) return null;
    const pages = this.pw.contexts().flatMap((ctx) => ctx.pages());
    let page: PwPage | null = null;
    if (pages.length > 1) {
      const targetId = await this.electronTargetId(tab);
      if (targetId) {
        for (const candidate of pages) {
          if ((await this.pwPageTargetId(candidate)) === targetId) {
            page = candidate;
            break;
          }
        }
      }
    }
    if (!page) page = pages.find((p) => safePageUrl(p) === url) || null;
    if (page) this.hookDialogs(tab.id, page);
    return page;
  }
  ```

  Replace `requirePlaywrightPage` (`src/main/browser.ts:2058-2068`):

  ```ts
  private async requirePlaywrightPage(tab: Tab): Promise<PwPage | null> {
    const deadline = Date.now() + PW_PAGE_WAIT_MS;
    for (;;) {
      const url = tab.view.webContents.getURL();
      if (!url || url.startsWith("file:")) return null;
      const page = await this.playwrightPage(tab);
      if (page) return page;
      if (Date.now() >= deadline) return null;
      await sleep(100);
    }
  }
  ```

  Replace `pwTarget` (`src/main/browser.ts:2287-2297`):

  ```ts
  private async pwTarget(tab: Tab, opts?: { wait?: boolean }): Promise<{ page: PwPage; root: PwLocatorRoot } | null> {
    const page = opts?.wait ? await this.requirePlaywrightPage(tab) : await this.playwrightPage(tab);
    if (!page) return null;
    if (tab.frameIndex === null) return { page, root: page };
    const frames: PwFrame[] = page.frames();
    const byUrl = tab.frameUrl ? frames.find((f) => f.url() === tab.frameUrl) : undefined;
    const root = byUrl ?? frames[tab.frameIndex];
    if (!root) return null;
    return { page, root };
  }
  ```

  Replace `withPage` (`src/main/browser.ts:2299-2309`):

  ```ts
  private async withPage(
    tab: Tab,
    pwFn: (page: PwPage, root: PwLocatorRoot) => Promise<void>,
    fallback: () => Promise<void>,
  ): Promise<void> {
    const target = await this.pwTarget(tab);
    if (target) {
      await pwFn(target.page, target.root);
      return;
    }
    await fallback();
  }
  ```

  Replace `exec` (`src/main/browser.ts:1028-1037`):

  ```ts
  private async exec(tab: Tab, js: string): Promise<unknown> {
    const wc = tab.view.webContents;
    if (tab.frameIndex === null) return wc.executeJavaScript(js);
    const frame = wc.mainFrame.framesInSubtree[tab.frameIndex];
    if (!frame) {
      throw new Error(`Frame ${tab.frameIndex} is gone. Call frames, then frame_select again.`);
    }
    return frame.executeJavaScript(js);
  }
  ```

  Replace `selectorsForRef` (`src/main/browser.ts:1568-1574`):

  ```ts
  async selectorsForRef(tab: Tab, ref: string): Promise<string[]> {
    return (await this.exec(
      tab,
      `(() => {
      ${ECHO_SELECTORS_SOURCE}
      const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
      return el ? echoSelectors(el) : [];
    })()`,
    )) as string[];
  }
  ```

  Replace `resolveSelectors` (`src/main/browser.ts:1576-1592`):

  ```ts
  private async resolveSelectors(tab: Tab, ref: string): Promise<{ selectors: string[]; text?: string }> {
    const cached = tab.snapshotByRef.get(ref);
    let live: string[] = [];
    try {
      live = await this.selectorsForRef(tab, ref);
    } catch {
      live = [];
    }
    const hrefSel = cached?.href && cached.href.length < 180 ? [`a[href=${JSON.stringify(cached.href)}]`] : [];
    return {
      selectors: unique([...(cached?.selectors ?? []), ...live, ...hrefSel]),
      text: cached?.name || undefined,
    };
  }
  ```

- [ ] **Step 4: Verify the project still compiles against the partially-updated call sites**

  Run: `npx tsc --noEmit` (with `NODE_OPTIONS=--max-old-space-size=8192` if needed).
  Expected: new errors at every call site still passing the old (no-`tab`) signatures to `exec`, `withPage`, `resolveSelectors`, `playwrightPage`, `requirePlaywrightPage`, `pwTarget`, `selectorsForRef` — this is expected and fixed in Task 2's `xCore` split. Confirm no *other* new errors appeared (only these expected call-site mismatches), so Step 1-3 didn't introduce anything unrelated.

- [ ] **Step 5: Write the per-tab queue ordering unit test**

  Create `scripts/test-unit/tab-queue.test.mjs` (this project's existing unit tests are esbuild-bundled `node --test` — follow the import style already used by the other files in that directory; check one sibling file for the exact bundler-import boilerplate before writing this one). Test body:

  ```js
  test("withTab serializes same-tab calls and lets different tabs run concurrently", async () => {
    const hub = makeTestHub(); // helper already present in this test dir for a minimal BrowserHub-like harness; if none exists, construct BrowserHub directly with two fake tabs registered via its existing test-only tab-injection path
    const order = [];
    const p1 = hub.withTabForTest("tabA", async () => {
      order.push("A-start");
      await sleep(30);
      order.push("A-end");
    });
    const p2 = hub.withTabForTest("tabA", async () => {
      order.push("A2-start");
      order.push("A2-end");
    });
    const p3 = hub.withTabForTest("tabB", async () => {
      order.push("B-start");
      order.push("B-end");
    });
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(
      order.filter((e) => e.startsWith("A")),
      ["A-start", "A-end", "A2-start", "A2-end"],
    );
    assert.ok(order.indexOf("B-start") < order.indexOf("A-end") || order.indexOf("B-end") > 0);
  });
  ```

  Since `withTab` is private, expose a tiny test-only wrapper on `BrowserHub` guarded the same way other test-only seams in this file are guarded (check `ECHO_TEST` usage elsewhere in `browser.ts`/`index.ts` for the existing pattern before adding a new one) — e.g. `withTabForTest(tabId, fn)` that calls `this.withTab(tabId, fn)`, compiled out or simply harmless in production since it's not registered as an MCP tool.

- [ ] **Step 6: Run the new test and confirm it fails before the queue exists, passes after**

  Run: `npm run test:unit -- --test-name-pattern=tab-queue` (adjust to this project's actual unit-test invocation — confirm the exact flag by reading `package.json`'s `test:unit` script first).
  Expected: PASS, with the assertion on `A-start, A-end, A2-start, A2-end` confirming same-tab ordering.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/browser.ts scripts/test-unit/tab-queue.test.mjs
  git commit -m "Add per-tab action queue and CDP-targetId Playwright page resolution"
  ```

---

## Task 2: `xCore`/public split for every tab-scoped `BrowserHub` method + tool wiring

**Files:**
- Modify: `src/main/browser.ts`
- Modify: `src/mcp/tools/read.ts`, `src/mcp/tools/browse.ts`, `src/mcp/tools/see.ts`
- Modify: `src/shared/tool-manifest.ts` (description text only — see Task 9 for the count/manifest bookkeeping pass)
- Test: `scripts/test-tools.mjs` (extend the existing e2e suite)

**Interfaces:**
- Consumes: `withTab`, `resolveTab`, `exec(tab, js)`, `withPage(tab, ...)`, `resolveSelectors(tab, ref)` from Task 1.
- Produces: public methods `snapshot(tabId?)`, `click(ref, tabId?)`, `typeText(ref, text, submit?, tabId?)`, `fill(ref, value, tabId?)`, `select(ref, value, tabId?)`, `hover(ref, tabId?)`, `press(key, tabId?)`, `scroll(deltaY, tabId?)`, `getText(ref?, maxChars?, tabId?)`, `find(q, tabId?)`, `links(filter?, limit?, tabId?)`, `tables(maxRows?, tabId?)`, `forms(tabId?)`, `pageInfo(tabId?)`, `html(ref?, maxChars?, tabId?)`, `pdfText(tabId?)`, `detectCaptcha(tabId?)`, `waitFor(opts, tabId?)`, `back(tabId?)`, `reload(tabId?)`, `listFrames(tabId?)`, `selectFrame(index, tabId?)`, `selectedFrame(tabId?)` — each backed by a private `xCore(tab, ...)` that later tasks (`fillForm`, `profile_suggest_fill`) call directly.

- [ ] **Step 1: Convert `snapshot`, `click`, `typeText`/`fill`, `select`, `hover`, `press`, `scroll`**

  Replace `snapshot` (`src/main/browser.ts:1071-1095`):

  ```ts
  private async snapshotCore(tab: Tab): Promise<SnapshotItem[]> {
    const items = (await this.exec(
      tab,
      `(() => {
      ${ECHO_SELECTORS_SOURCE}
      const sel = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]';
      const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 250);
      nodes.forEach((el, i) => el.setAttribute('data-lb-ref', 'e' + i));
      return nodes.map((el, i) => {
        return {
          ref: 'e' + i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('value') || el.getAttribute('href') || '').trim().slice(0, 120),
          label: (((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 120)) || undefined,
          href: el.href || undefined,
          inputType: el.getAttribute('type') || undefined,
          value: el.value || undefined,
          selectors: echoSelectors(el)
        };
      });
    })()`,
    )) as SnapshotItem[];
    tab.snapshotByRef.clear();
    for (const item of items) tab.snapshotByRef.set(item.ref, item);
    return items;
  }

  async snapshot(tabId?: string): Promise<SnapshotItem[]> {
    return this.withTab(tabId, (tab) => this.snapshotCore(tab));
  }
  ```

  Replace `click` (`src/main/browser.ts:1097-1117`):

  ```ts
  private async clickCore(tab: Tab, ref: string): Promise<void> {
    await pace(this.humanPacing);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().click({ timeout: 8000 });
        },
        async () => {
          const found = await this.exec(
            tab,
            `(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) return false;
          el.click();
          return true;
        })()`,
          );
          if (!found) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
        },
      );
      this.rec?.record({ type: "click", selectors: resolved.selectors, text: resolved.text });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async click(ref: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.clickCore(tab, ref));
  }
  ```

  Replace `typeText`/`fill` (`src/main/browser.ts:1119-1153`):

  ```ts
  private async typeTextCore(tab: Tab, ref: string, text: string, submit = false): Promise<void> {
    await pace(this.humanPacing);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          const loc = root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first();
          await loc.click({ timeout: 8000 });
          await loc.fill(text);
          if (submit) await loc.press("Enter");
        },
        async () => {
          await this.exec(
            tab,
            `(() => {
          const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
          if (!el) throw new Error('ref not found');
          el.focus();
          if ('value' in el) el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
          );
        },
      );
      this.rec?.record({
        type: "type",
        selectors: resolved.selectors,
        text,
        submit,
        name: resolved.text,
      });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async typeText(ref: string, text: string, submit = false, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.typeTextCore(tab, ref, text, submit));
  }

  async fill(ref: string, value: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.typeTextCore(tab, ref, value, false));
  }
  ```

  Replace `select` (`src/main/browser.ts:1182-1204`):

  ```ts
  private async selectCore(tab: Tab, ref: string, value: string): Promise<void> {
    await pace(this.humanPacing);
    const resolved = await this.resolveSelectors(tab, ref);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (_page, root) => {
          await root.locator(`[data-lb-ref="${cssEscape(ref)}"]`).first().selectOption(value);
        },
        async () => {
          await this.exec(
            tab,
            `(() => {
            const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
            if (!el) throw new Error('ref not found');
            el.value = ${JSON.stringify(value)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`,
          );
        },
      );
      this.rec?.record({ type: "select", selectors: resolved.selectors, value });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async select(ref: string, value: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.selectCore(tab, ref, value));
  }
  ```

  Replace `hover` (`src/main/browser.ts:1206-1224`) the same way — `hoverCore(tab, ref)` using `this.withPage(tab, ...)`/`this.exec(tab, ...)`/`this.resolveSelectors(tab, ref)`, and a public `hover(ref, tabId?)` calling `this.withTab(tabId, (tab) => this.hoverCore(tab, ref))`.

  Replace `press` (`src/main/browser.ts:1155-1173`):

  ```ts
  private async pressCore(tab: Tab, key: string): Promise<void> {
    await pace(this.humanPacing);
    this.rec?.beginIgnore();
    try {
      await this.withPage(
        tab,
        async (page) => {
          await page.keyboard.press(key);
        },
        async () => {
          await this.exec(
            tab,
            `document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`,
          );
        },
      );
      this.rec?.record({ type: "press", key });
    } finally {
      this.rec?.endIgnoreSoon();
    }
  }

  async press(key: string, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.pressCore(tab, key));
  }
  ```

  Replace `scroll` (`src/main/browser.ts:1175-1180`):

  ```ts
  private async scrollCore(tab: Tab, deltaY: number): Promise<void> {
    await pace(this.humanPacing);
    const amount = Number(deltaY) || 600;
    await tab.view.webContents.executeJavaScript(`window.scrollBy(0, ${amount})`);
    this.rec?.record({ type: "scroll", deltaY: amount });
  }

  async scroll(deltaY: number, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.scrollCore(tab, deltaY));
  }
  ```

- [ ] **Step 2: Convert the read methods (`getText`, `find`, `links`, `tables`, `forms`, `pageInfo`, `html`, `pdfText`, `detectCaptcha`, `waitFor`)**

  Replace `getText` (`src/main/browser.ts:1654-1659`):

  ```ts
  private async getTextCore(tab: Tab, ref: string | undefined, maxChars: number): Promise<string> {
    const cap = Math.max(1, Math.min(maxChars, 40_000));
    const value = (await this.exec(tab, getTextScript(ref ?? null, cap))) as string | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }

  async getText(ref?: string, maxChars = 40_000, tabId?: string): Promise<string> {
    return this.withTab(tabId, (tab) => this.getTextCore(tab, ref, maxChars));
  }
  ```

  Replace `find` (`src/main/browser.ts:1666-1684`) — it calls `this.snapshot()` today, which must become `this.snapshotCore(tab)` to avoid deadlocking inside `withTab`:

  ```ts
  private async findCore(
    tab: Tab,
    q: { text?: string; role?: string; label?: string; limit?: number },
  ): Promise<SnapshotItem[]> {
    const items = await this.snapshotCore(tab);
    const wanted = {
      text: q.text?.trim().toLowerCase() ?? "",
      role: q.role?.trim().toLowerCase() ?? "",
      label: q.label?.trim().toLowerCase() ?? "",
    };
    const matches = items.filter((item) => {
      if (wanted.text && !(item.name ?? "").toLowerCase().includes(wanted.text)) return false;
      if (wanted.role) {
        const role = (item.role ?? "").toLowerCase();
        const tag = (item.tag ?? "").toLowerCase();
        if (role !== wanted.role && tag !== wanted.role) return false;
      }
      if (wanted.label && !(item.label ?? "").toLowerCase().includes(wanted.label)) return false;
      return true;
    });
    return matches.slice(0, Math.max(1, q.limit ?? 50));
  }

  async find(q: { text?: string; role?: string; label?: string; limit?: number }, tabId?: string): Promise<SnapshotItem[]> {
    return this.withTab(tabId, (tab) => this.findCore(tab, q));
  }
  ```

  Replace `links`/`tables`/`forms`/`pageInfo` (`src/main/browser.ts:1686-1720`) — `forms` also calls `this.snapshot()` today, same fix:

  ```ts
  private async linksCore(tab: Tab, filter: string | undefined, limit: number): Promise<PageLink[]> {
    const cap = Math.max(1, Math.min(limit, 300));
    return (await tab.view.webContents.executeJavaScript(linksScript(filter?.trim() || null, cap))) as PageLink[];
  }
  async links(filter?: string, limit = 300, tabId?: string): Promise<PageLink[]> {
    return this.withTab(tabId, (tab) => this.linksCore(tab, filter, limit));
  }

  private async tablesCore(tab: Tab, maxRows: number): Promise<PageTable[]> {
    return (await tab.view.webContents.executeJavaScript(tablesScript(Math.max(1, maxRows)))) as PageTable[];
  }
  async tables(maxRows = 30, tabId?: string): Promise<PageTable[]> {
    return this.withTab(tabId, (tab) => this.tablesCore(tab, maxRows));
  }

  private async formsCore(tab: Tab): Promise<PageForm[]> {
    await this.snapshotCore(tab);
    return (await tab.view.webContents.executeJavaScript(FORMS_SCRIPT)) as PageForm[];
  }
  async forms(tabId?: string): Promise<PageForm[]> {
    return this.withTab(tabId, (tab) => this.formsCore(tab));
  }

  private async pageInfoCore(tab: Tab): Promise<PageInfo> {
    const info = (await tab.view.webContents.executeJavaScript(PAGE_INFO_SCRIPT)) as Omit<PageInfo, "cookiesCount">;
    let cookiesCount = 0;
    try {
      const url = info.url || tab.view.webContents.getURL();
      if (/^https?:/i.test(url)) {
        cookiesCount = (await tab.view.webContents.session.cookies.get({ url })).length;
      }
    } catch {
      cookiesCount = 0;
    }
    return { ...info, cookiesCount };
  }
  async pageInfo(tabId?: string): Promise<PageInfo> {
    return this.withTab(tabId, (tab) => this.pageInfoCore(tab));
  }
  ```

  Replace `html` (`src/main/browser.ts:1722-1733`):

  ```ts
  private async htmlCore(
    tab: Tab,
    ref: string | undefined,
    maxChars: number,
  ): Promise<{ html: string; truncated: boolean; total: number }> {
    const cap = Math.max(1, Math.min(maxChars, 50_000));
    const value = (await this.exec(tab, htmlScript(ref ?? null, cap))) as {
      html: string;
      truncated: boolean;
      total: number;
    } | null;
    if (value === null) throw new Error(`No element with ref ${ref}. Call snapshot first.`);
    return value;
  }
  async html(ref?: string, maxChars = 50_000, tabId?: string): Promise<{ html: string; truncated: boolean; total: number }> {
    return this.withTab(tabId, (tab) => this.htmlCore(tab, ref, maxChars));
  }
  ```

  Replace `pdfText` (`src/main/browser.ts:1739-...`, read the rest of the method body first since only the first half was captured above) — wrap the existing body as `pdfTextCore(tab: Tab)` (swap every `this.requireActive()`/implicit active use inside it for `tab`, keep the logic identical), with:

  ```ts
  async pdfText(tabId?: string): Promise<{ title: string; text: string; pages?: number }> {
    return this.withTab(tabId, (tab) => this.pdfTextCore(tab));
  }
  ```

  Replace `detectCaptcha` (`src/main/browser.ts:834-...`, read the full body first) the same way — `detectCaptchaCore(tab: Tab)` wrapping today's logic, plus:

  ```ts
  async detectCaptcha(tabId?: string): Promise<{ present: boolean; kind: string | null; visible: boolean }> {
    return this.withTab(tabId, (tab) => this.detectCaptchaCore(tab));
  }
  ```

  Replace `waitFor` (`src/main/browser.ts:1401-1418`) — its `pageText()` call must become tab-scoped too (add `pageTextCore(tab)` wrapping the current `pageText()` body, `this.exec(tab, ...)`):

  ```ts
  private async waitForCore(tab: Tab, opts: { text?: string; timeoutMs?: number; record?: boolean }): Promise<void> {
    const timeout = opts.timeoutMs ?? 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (opts.text) {
        const text = await this.pageTextCore(tab);
        if (text.toLowerCase().includes(opts.text.toLowerCase())) {
          if (opts.record !== false) this.rec?.record({ type: "wait", text: opts.text, ms: timeout });
          return;
        }
      } else {
        if (!tab.view.webContents.isLoading()) return;
      }
      await sleep(250);
    }
    throw new Error("wait_for timed out");
  }

  async waitFor(opts: { text?: string; timeoutMs?: number; record?: boolean }, tabId?: string): Promise<void> {
    return this.withTab(tabId, (tab) => this.waitForCore(tab, opts));
  }
  ```

- [ ] **Step 3: Convert `back`, `reload`, `listFrames`, `selectFrame`, `selectedFrame`**

  Find and convert each the same way: locate the current body (`grep -n "async back\|async reload" src/main/browser.ts`), replace its `this.requireActive()` with the passed-in `tab`, split into `xCore(tab, ...)` + public `x(..., tabId?)` calling `this.withTab(tabId, (tab) => this.xCore(tab, ...))`. `selectFrame`/`listFrames` already read `tab.frameIndex`/`tab.frameUrl` directly (`src/main/browser.ts:1039-1064`) — same transformation, no new logic.

- [ ] **Step 4: Wire `tabId` through the MCP tool schemas**

  In `src/mcp/tools/read.ts`, add `tabId: z.string().optional()` to every tool's zod shape and pass it through, e.g. for `get_text` (`src/mcp/tools/read.ts:8-22`):

  ```ts
  define(
    server,
    deps,
    "get_text",
    "Visible text of the page, or of one element by snapshot ref. Optionally target a specific tabId (see tabs_list). Capped at 40,000 chars.",
    { ref: z.string().optional(), maxChars: z.number().int().min(1).max(40000).optional(), tabId: z.string().optional() },
    async ({ ref, maxChars, tabId }) => {
      try {
        const value = await hub.getText(ref, maxChars ?? 40000, tabId);
        return text(value.trim() ? value : "The page has no visible text.");
      } catch (e) {
        return err(e);
      }
    },
  );
  ```

  Apply the same pattern (add `tabId` to the shape, add ", optionally target a specific tabId" to the description, pass `tabId` as the trailing hub-call argument) to `find`, `links`, `tables`, `forms`, `page_info`, `html`, `pdf_text`, `captcha_check` in `read.ts`, and to `click`, `type`, `fill`, `select`, `press`, `scroll`, `wait_for` in `browse.ts` (`snapshot` too — add `tabId` there as well since it is the source of the refs every interact tool consumes).

  Because the tool *description* text changes, update the matching entries in `src/shared/tool-manifest.ts` to the exact same new description strings in the same commit — `test-tools.mjs`'s registration test asserts they stay byte-identical.

- [ ] **Step 5: Extend `screenshot`/`watch` (`src/mcp/tools/see.ts`) with `tabId`, selecting the tab first if it isn't already attached**

  `capturePng`/`captureForModel` (`src/main/browser.ts:887-926`) and `watch` (`src/main/browser.ts:928-951`) rely on the tab already being the attached `BrowserView` (native `capturePage()` never resolves on a detached one — documented at `tabThumbnail`, `src/main/browser.ts:717-724`). Add a tab parameter that, when it names a tab other than the current active one, calls `this.selectTab(tab.id)` before capturing:

  ```ts
  async capturePng(opts?: { fullPage?: boolean; reveal?: boolean; tabId?: string }): Promise<Buffer> {
    const tab = this.resolveTab(opts?.tabId);
    if (tab.id !== this.activeId) this.selectTab(tab.id);
    if (opts?.reveal !== false) await this.revealForCapture();
    const page = await this.playwrightPage(tab);
    if (page) {
      try {
        return await withTimeout(page.screenshot({ type: "png", fullPage: Boolean(opts?.fullPage), timeout: 8000 }), 10000);
      } catch {
        /* fall through to Electron capture */
      }
    }
    const image = await withTimeout(tab.view.webContents.capturePage(), 6000);
    const png = image.toPNG();
    if (!png.length) throw new Error("Screenshot was empty. Show the Echo window and try again.");
    return png;
  }

  async captureForModel(opts?: { fullPage?: boolean; tabId?: string }): Promise<{ jpeg: Buffer; width: number; height: number; png: Buffer }> {
    const png = await this.capturePng({ fullPage: opts?.fullPage, tabId: opts?.tabId });
    const fitted = fitForModel(nativeImage.createFromBuffer(png));
    const size = fitted.getSize();
    return { png, jpeg: fitted.toJPEG(72), width: size.width, height: size.height };
  }
  ```

  Change `private watching = false;` to `private watchingTabs = new Set<string>();` and update `watch` (`src/main/browser.ts:928-951`) to resolve its tab and guard per-tab:

  ```ts
  async watch(opts?: { durationMs?: number; maxFrames?: number; tabId?: string }): Promise<{
    url: string;
    durationMs: number;
    frames: { tMs: number; jpeg: Buffer; width: number; height: number }[];
  }> {
    const tab = this.resolveTab(opts?.tabId);
    const durationMs = Math.min(6000, Math.max(800, opts?.durationMs ?? 2500));
    const maxFrames = Math.min(12, Math.max(4, opts?.maxFrames ?? 8));
    if (this.watchingTabs.has(tab.id)) throw new Error("Already watching this tab. Wait for the current live feed to finish.");
    this.watchingTabs.add(tab.id);
    try {
      if (tab.id !== this.activeId) this.selectTab(tab.id);
      await this.revealForCapture();
      const collected = await this.watchViaCdp(tab, durationMs);
      const fallback = collected.length === 0 ? await this.watchViaPoll(tab, durationMs, maxFrames) : collected;
      const unique = dedupeFrames(fallback);
      let frames = subsample(unique, maxFrames);
      if (!frames.length) {
        const still = await this.captureForModel({ tabId: tab.id });
        frames = [{ tMs: 0, jpeg: still.jpeg, width: still.width, height: still.height }];
      }
      return { url: tab.view.webContents.getURL(), durationMs, frames };
    } finally {
      this.watchingTabs.delete(tab.id);
    }
  }
  ```

  (`watchViaCdp`/`watchViaPoll` gain a leading `tab: Tab` parameter the same way `playwrightPage` did — replace their internal `this.playwrightPage()`/`this.requireActive()` calls with the passed-in `tab`.)

  Add `tabId: z.string().optional()` to `screenshot` and `watch` in `src/mcp/tools/see.ts`, passed through to `hub.captureForModel({ fullPage, tabId })` and `hub.watch({ durationMs, maxFrames, tabId })` respectively; update their descriptions and the matching `tool-manifest.ts` entries to match.

- [ ] **Step 6: Confirm the project compiles clean against the new baseline**

  Run: `npx tsc --noEmit`.
  Expected: exactly the 4 pre-existing errors noted in Global Constraints, nothing new.

- [ ] **Step 7: Run the full existing gates**

  Run: `npm run test:unit`, then `npm run test:tools` (quit the installed Echo app first so ports 9333/18931 are free), then `npm run test:bridge`.
  Expected: all green — this is the regression proof for the refactor.

- [ ] **Step 8: Add the e2e cross-tab concurrency test**

  In `scripts/test-tools.mjs`, add a test using the existing fixture server (`scripts/fixtures/forms.html` and `scripts/fixtures/index.html` are already used by other tests — follow their setup pattern): open two tabs via `tabs_new` against two different fixture pages, call `find`/`type` on tab A and `find`/`type` on tab B with overlapping timing (fire both `type` calls without awaiting the first before starting the second), then assert both tabs show the correct typed values and neither tab's snapshot refs were clobbered by the other's `find` call refreshing `tab.snapshotByRef`.

  Run: `npm run test:tools` again.
  Expected: PASS.

- [ ] **Step 9: Commit**

  ```bash
  git add src/main/browser.ts src/mcp/tools/read.ts src/mcp/tools/browse.ts src/mcp/tools/see.ts src/shared/tool-manifest.ts scripts/test-tools.mjs
  git commit -m "Add tabId to every read/interact tool, backed by per-tab-queued core implementations"
  ```

---

## Task 3: `fill_form` batch tool

**Files:**
- Modify: `src/main/browser.ts`
- Modify: `src/mcp/tools/browse.ts` (or a new `src/mcp/tools/fill.ts` if `browse.ts` is already large — check its line count first; split out if it has grown past ~250 lines with this addition)
- Modify: `src/shared/tool-manifest.ts`, `src/main/transfer-prefs.ts` (`toolsInteract` count +1)
- Test: `scripts/test-tools.mjs`

**Interfaces:**
- Consumes: `withTab`, and the `xCore` methods from Task 2 (`typeTextCore`, `selectCore`, `clickCore`).
- Produces: `BrowserHub.fillForm(fields: { ref: string; value: string }[], tabId?: string): Promise<{ ref: string; ok: boolean; error?: string }[]>`, tool `fill_form`.

- [ ] **Step 1: Write the failing e2e test**

  In `scripts/test-tools.mjs`, add (using the existing fixture-server/tool-call helper pattern already used by other tests in this file):

  ```js
  test("fill_form fills text, select, and checkbox fields in one call and reports per-field results", async () => {
    await callTool("navigate", { url: fixtureUrl("forms.html") });
    const formsResult = await callTool("forms", {});
    const fields = extractFieldsFromFormsResult(formsResult); // pull refs for a text input, a <select>, and a checkbox from forms.html's known fixture fields
    const result = await callTool("fill_form", {
      fields: [
        { ref: fields.textRef, value: "Ada Lovelace" },
        { ref: fields.selectRef, value: fields.selectValue },
        { ref: fields.checkboxRef, value: "true" },
      ],
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.every((r) => r.ok), true);
    const text = await callTool("get_text", {});
    assert.ok(text.content[0].text.includes("Ada Lovelace"));
  });
  ```

  (Read `scripts/fixtures/forms.html` first to use its actual field names/values rather than invented ones.)

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npm run test:tools -- --test-name-pattern=fill_form` (adjust to the actual invocation used elsewhere in this suite).
  Expected: FAIL — `fill_form` tool does not exist yet.

- [ ] **Step 3: Implement `BrowserHub.fillForm`**

  Add to `src/main/browser.ts`, near `select`/`click`:

  ```ts
  async fillForm(
    fields: { ref: string; value: string }[],
    tabId?: string,
  ): Promise<{ ref: string; ok: boolean; error?: string }[]> {
    return this.withTab(tabId, async (tab) => {
      const results: { ref: string; ok: boolean; error?: string }[] = [];
      for (const { ref, value } of fields) {
        try {
          const item = tab.snapshotByRef.get(ref);
          const tag = (item?.tag ?? "").toLowerCase();
          const inputType = (item?.inputType ?? "").toLowerCase();
          if (tag === "select") {
            await this.selectCore(tab, ref, value);
          } else if (inputType === "checkbox" || inputType === "radio") {
            const wantChecked = value === "true" || value === "1" || value.toLowerCase() === "on";
            if (wantChecked) await this.clickCore(tab, ref);
          } else {
            await this.typeTextCore(tab, ref, value, false);
          }
          results.push({ ref, ok: true });
        } catch (e) {
          results.push({ ref, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    });
  }
  ```

  Note the checkbox/radio branch only clicks when a truthy value is requested — since `clickCore` toggles rather than sets, and there is no reliable read-then-toggle-to-match without an extra round trip per field, that tradeoff (can't uncheck an already-checked box via `fill_form`) is acceptable for the application-filling use case and should be called out in the tool's description below.

- [ ] **Step 4: Register the `fill_form` tool**

  In `src/mcp/tools/browse.ts` (or the new split file), add:

  ```ts
  define(
    server,
    deps,
    "fill_form",
    "Fill several fields from the latest snapshot/forms call in one round-trip: { ref, value } pairs. Text/textarea fields are typed, <select> fields choose the option matching value, checkboxes/radios are clicked only when value is truthy (already-checked boxes are not unchecked). Returns a per-field { ref, ok, error? } result so one bad ref does not block the rest. Optionally target a specific tabId.",
    {
      fields: z.array(z.object({ ref: z.string(), value: z.string() })).min(1),
      tabId: z.string().optional(),
    },
    async ({ fields, tabId }) => {
      try {
        const results = await hub.fillForm(fields, tabId);
        return text(JSON.stringify(results, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );
  ```

- [ ] **Step 5: Add `fill_form` to the manifest, group counts, and skill tree**

  In `src/shared/tool-manifest.ts`, add an entry with `group: "toolsInteract"` and the exact description string used above. In `src/main/transfer-prefs.ts`, bump `TOOL_GROUP_COUNTS.toolsInteract` from `10` to `11`. In `scripts/test-tools.mjs`, bump `TOTAL_TOOLS` from `70` to `71`. In `src/main/skill-tree.ts`, add a short mention near the existing "snapshot before click/type/fill" line pointing at `fill_form` for multi-field forms.

- [ ] **Step 6: Run the test again and confirm it passes**

  Run: `npm run test:tools -- --test-name-pattern=fill_form`.
  Expected: PASS.

- [ ] **Step 7: Run the full gate**

  Run: `npx tsc --noEmit`, `npm run test:unit`, `npm run test:tools`, `npm run packaging:check`.
  Expected: all green (tsc: only the 4 pre-existing errors).

- [ ] **Step 8: Commit**

  ```bash
  git add src/main/browser.ts src/mcp/tools/browse.ts src/shared/tool-manifest.ts src/main/transfer-prefs.ts src/main/skill-tree.ts scripts/test-tools.mjs
  git commit -m "Add fill_form: batch-fill several fields in one round-trip"
  ```

---

## Task 4: Profile store + `profile_get`/`profile_set` tools + Settings UI section

**Files:**
- Create: `src/main/profile.ts`
- Create: `src/mcp/tools/profile.ts`
- Modify: `src/main/index.ts` (IPC handlers), `src/preload/index.ts`, `src/renderer/global.d.ts`, `src/renderer/index.html`, `src/renderer/ui/settings.ts`
- Modify: `src/mcp/register-tools.ts` (wire the new tool file in), `src/shared/tool-manifest.ts`, `src/main/transfer-prefs.ts`
- Test: `scripts/test-unit/profile.test.mjs` (new), `scripts/test-tools.mjs`

**Interfaces:**
- Produces: `Profile` type, `DEFAULT_PROFILE`, `getProfile(dir?): Profile`, `setProfile(next: Partial<Profile>, dir?): Profile` in `src/main/profile.ts`.
- Produces: tools `profile_get`, `profile_set`.
- Produces: `window.lb.getProfile()`, `window.lb.updateProfile(next)` on the renderer bridge.

- [ ] **Step 1: Write the failing unit test for the profile store**

  Create `scripts/test-unit/profile.test.mjs` (mirror `src/main/settings.ts`'s own test file's structure — find it via `grep -rl "getSettings" scripts/test-unit` first and copy its shape):

  ```js
  test("setProfile merges partial updates and rejects bad fields without clobbering good ones", () => {
    const dir = makeTempDir();
    setProfile({ fullName: "Ada Lovelace", email: "ada@example.com" }, dir);
    const withBadEmail = setProfile({ email: 123 }, dir); // wrong type, should be ignored
    assert.equal(withBadEmail.fullName, "Ada Lovelace");
    assert.equal(withBadEmail.email, "ada@example.com");
    const read = getProfile(dir);
    assert.equal(read.fullName, "Ada Lovelace");
  });
  ```

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npm run test:unit -- --test-name-pattern=profile`.
  Expected: FAIL — `src/main/profile.ts` does not exist.

- [ ] **Step 3: Implement `src/main/profile.ts`**

  Mirror `src/main/settings.ts`'s exact pattern (`src/main/settings.ts:1-43`):

  ```ts
  import fs from "node:fs";
  import path from "node:path";

  export type Profile = {
    fullName: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    linkedin: string;
    portfolio: string;
    github: string;
  };

  export const DEFAULT_PROFILE: Profile = {
    fullName: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    zip: "",
    country: "",
    linkedin: "",
    portfolio: "",
    github: "",
  };

  function file(dir?: string): string {
    const base = dir ?? (require("./paths").userDataDir() as string);
    return path.join(base, "profile.json");
  }

  export function getProfile(dir?: string): Profile {
    try {
      const raw = JSON.parse(fs.readFileSync(file(dir), "utf8")) as Partial<Profile>;
      return sanitize(raw, DEFAULT_PROFILE);
    } catch {
      return { ...DEFAULT_PROFILE };
    }
  }

  export function setProfile(next: Partial<Profile>, dir?: string): Profile {
    const current = getProfile(dir);
    const merged = sanitize({ ...current, ...next }, current);
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    fs.writeFileSync(file(dir), JSON.stringify(merged, null, 2) + "\n", "utf8");
    return merged;
  }

  function sanitize(p: Partial<Profile>, fallback: Profile): Profile {
    const out = { ...fallback };
    for (const key of Object.keys(DEFAULT_PROFILE) as (keyof Profile)[]) {
      if (typeof p[key] === "string") out[key] = p[key] as string;
    }
    return out;
  }
  ```

- [ ] **Step 4: Run the unit test again and confirm it passes**

  Run: `npm run test:unit -- --test-name-pattern=profile`.
  Expected: PASS.

- [ ] **Step 5: Register `profile_get`/`profile_set` tools**

  Create `src/mcp/tools/profile.ts`:

  ```ts
  import { z } from "zod";
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { getProfile, setProfile } from "../../main/profile";
  import { define, err, text, type ToolDeps } from "./_helpers";

  export function registerProfile(server: McpServer, deps: ToolDeps): void {
    define(server, deps, "profile_get", "Read the stored applicant profile (name, email, phone, address, links). Empty fields mean nothing is stored yet.", {}, async () => {
      try {
        return text(JSON.stringify(getProfile(), null, 2));
      } catch (e) {
        return err(e);
      }
    });

    define(
      server,
      deps,
      "profile_set",
      "Save or update applicant profile fields (name, email, phone, address, links) so fill_form/profile_suggest_fill can reuse them across applications. Only given fields are changed.",
      {
        fullName: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        addressLine1: z.string().optional(),
        addressLine2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        country: z.string().optional(),
        linkedin: z.string().optional(),
        portfolio: z.string().optional(),
        github: z.string().optional(),
      },
      async (fields) => {
        try {
          return text(JSON.stringify(setProfile(fields), null, 2));
        } catch (e) {
          return err(e);
        }
      },
    );
  }
  ```

  Wire it into `src/mcp/register-tools.ts` next to the other `register*` calls (check that file's current list first — `grep -n "register" src/mcp/register-tools.ts`).

- [ ] **Step 6: Add IPC + preload + renderer bridge**

  In `src/main/index.ts`, near the `settings:get`/`settings:update` handlers (`src/main/index.ts:426-427`):

  ```ts
  ipcMain.handle("profile:get", () => getProfile());
  ipcMain.handle("profile:update", (_e, next: Partial<Profile>) => setProfile(next));
  ```

  (Import `getProfile`, `setProfile`, `type Profile` from `../main/profile` at the top of `index.ts`.)

  In `src/preload/index.ts`, near `getSettings`/`updateSettings` (`src/preload/index.ts:44-45`):

  ```ts
  getProfile: (): Promise<Profile> => ipcRenderer.invoke("profile:get"),
  updateProfile: (next: Partial<Profile>): Promise<Profile> => ipcRenderer.invoke("profile:update", next),
  ```

  In `src/renderer/global.d.ts`, near the matching settings lines (`src/renderer/global.d.ts:45-46`):

  ```ts
  getProfile: () => Promise<Profile>;
  updateProfile: (next: Partial<Profile>) => Promise<Profile>;
  ```

  (Add `import type { Profile } from "../main/profile";` or re-export it from `../shared/types` if that's this project's convention for renderer-visible main-process types — check how `AppSettings` gets there first.)

- [ ] **Step 7: Add the Settings → Profile section**

  In `src/renderer/index.html`, add a nav item next to `system` (`src/renderer/index.html:104`):

  ```html
  <button class="nav-item" data-section="profile" data-icon="user"><span class="nav-label">Profile</span></button>
  ```

  Add a new `<section>` following the exact `home-url` text-input + save-button pattern (`src/renderer/index.html:436-454`), with one `<div class="field">` per profile field (14 total), each `<input class="text-input" id="profile-<field>" ...>`, and a single `<button class="chrome-btn" id="profile-save">Save</button>` at the bottom of the section rather than one per field.

  In `src/renderer/ui/settings.ts`, mirror the `home-url` wiring (`src/renderer/ui/settings.ts:188-189, 286-287`): on settings-page open, call `window.lb.getProfile()` and populate each `#profile-<field>` input; on `#profile-save` click, read every `#profile-<field>` input into a `Partial<Profile>` object and call `window.lb.updateProfile(next)`.

- [ ] **Step 8: Add the e2e tool test**

  In `scripts/test-tools.mjs`:

  ```js
  test("profile_set stores fields and profile_get reads them back", async () => {
    await callTool("profile_set", { fullName: "Ada Lovelace", email: "ada@example.com" });
    const result = await callTool("profile_get", {});
    const profile = JSON.parse(result.content[0].text);
    assert.equal(profile.fullName, "Ada Lovelace");
    assert.equal(profile.email, "ada@example.com");
  });
  ```

  Run: `npm run test:tools -- --test-name-pattern=profile`.
  Expected: PASS.

- [ ] **Step 9: Bookkeeping and gates**

  Add both tools to `src/shared/tool-manifest.ts` (`group: "toolsState"`), bump `TOOL_GROUP_COUNTS.toolsState` from `9` to `11`, bump `TOTAL_TOOLS` in `scripts/test-tools.mjs` from `71` to `73`. Add a line to `src/main/skill-tree.ts` mentioning `profile_get`/`profile_set`. Run `npx tsc --noEmit`, `npm run test:unit`, `npm run test:tools`, `npm run packaging:check` — all green.

- [ ] **Step 10: Commit**

  ```bash
  git add src/main/profile.ts src/mcp/tools/profile.ts src/mcp/register-tools.ts src/main/index.ts src/preload/index.ts src/renderer/global.d.ts src/renderer/index.html src/renderer/ui/settings.ts src/shared/tool-manifest.ts src/main/transfer-prefs.ts src/main/skill-tree.ts scripts/test-unit/profile.test.mjs scripts/test-tools.mjs
  git commit -m "Add applicant profile store, profile_get/profile_set tools, and Settings > Profile"
  ```

---

## Task 5: `profile_suggest_fill` tool

**Files:**
- Modify: `src/mcp/tools/profile.ts`
- Create: `src/shared/profile-match.ts`
- Test: `scripts/test-unit/profile-match.test.mjs` (new), `scripts/test-tools.mjs`

**Interfaces:**
- Consumes: `PageForm`/`FormField` types from `src/main/browser.ts`, `Profile` from `src/main/profile.ts`.
- Produces: `matchProfileToFields(fields: FormField[], profile: Profile): { ref: string; label: string; suggestedValue: string; confidence: "high" | "medium" }[]` (pure function, unit-tested without Electron), tool `profile_suggest_fill`.

- [ ] **Step 1: Write the failing unit test for the matcher**

  Create `scripts/test-unit/profile-match.test.mjs`:

  ```js
  test("matches common label synonyms to profile fields and skips fields with no match or no ref", () => {
    const profile = { ...DEFAULT_PROFILE, firstName: "Ada", email: "ada@example.com", phone: "555-0100" };
    const fields = [
      { name: "fname", type: "text", value: "", label: "First Name", ref: "e0" },
      { name: "email_addr", type: "email", value: "", label: "Email Address", ref: "e1" },
      { name: "referral", type: "text", value: "", label: "How did you hear about us?", ref: "e2" },
      { name: "phone", type: "tel", value: "", label: "Mobile Number", ref: undefined },
    ];
    const matches = matchProfileToFields(fields, profile);
    assert.deepEqual(
      matches.map((m) => m.ref),
      ["e0", "e1"],
    );
    assert.equal(matches[0].suggestedValue, "Ada");
    assert.equal(matches[1].suggestedValue, "ada@example.com");
  });
  ```

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npm run test:unit -- --test-name-pattern=profile-match`.
  Expected: FAIL — `src/shared/profile-match.ts` does not exist.

- [ ] **Step 3: Implement the synonym matcher**

  Create `src/shared/profile-match.ts`:

  ```ts
  import type { Profile } from "../main/profile";
  import type { FormField } from "../main/browser";

  /** Label substrings (lowercased) mapped to the profile field they suggest, most specific first. */
  const SYNONYMS: { pattern: RegExp; key: keyof Profile }[] = [
    { pattern: /first\s*name|given\s*name/, key: "firstName" },
    { pattern: /last\s*name|surname|family\s*name/, key: "lastName" },
    { pattern: /full\s*name|your\s*name/, key: "fullName" },
    { pattern: /e-?mail/, key: "email" },
    { pattern: /phone|mobile|cell/, key: "phone" },
    { pattern: /address\s*line\s*1|street\s*address|address(?!.*2)/, key: "addressLine1" },
    { pattern: /address\s*line\s*2|apt|suite|unit/, key: "addressLine2" },
    { pattern: /city|town/, key: "city" },
    { pattern: /state|province/, key: "state" },
    { pattern: /zip|postal/, key: "zip" },
    { pattern: /country/, key: "country" },
    { pattern: /linkedin/, key: "linkedin" },
    { pattern: /portfolio|website|personal\s*site/, key: "portfolio" },
    { pattern: /github/, key: "github" },
  ];

  export type ProfileSuggestion = { ref: string; label: string; suggestedValue: string; confidence: "high" };

  /**
   * Matches form fields to stored profile values by label text. Never guesses: a field with no
   * ref (nothing to fill), an empty profile value, or no synonym match is simply omitted rather
   * than returned with a low-confidence value — the caller (Claude) decides what to do with
   * gaps, this never fabricates a value.
   */
  export function matchProfileToFields(fields: FormField[], profile: Profile): ProfileSuggestion[] {
    const out: ProfileSuggestion[] = [];
    for (const field of fields) {
      if (!field.ref) continue;
      const label = (field.label || field.name || "").toLowerCase();
      if (!label) continue;
      const match = SYNONYMS.find((s) => s.pattern.test(label));
      if (!match) continue;
      const value = profile[match.key];
      if (!value) continue;
      out.push({ ref: field.ref, label: field.label || field.name, suggestedValue: value, confidence: "high" });
    }
    return out;
  }
  ```

- [ ] **Step 4: Run the unit test again and confirm it passes**

  Run: `npm run test:unit -- --test-name-pattern=profile-match`.
  Expected: PASS.

- [ ] **Step 5: Register the `profile_suggest_fill` tool**

  Add to `src/mcp/tools/profile.ts`:

  ```ts
  define(
    server,
    deps,
    "profile_suggest_fill",
    "Match the current tab's form fields (from the last forms() call) to the stored profile by label. Returns { ref, label, suggestedValue, confidence } for fields it's confident about; it never fills anything itself and never guesses for a field with no clear match — review each suggestion (or ask the user) before calling fill_form with the ones you accept. Optionally target a specific tabId.",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const fields = (await deps.hub.forms(tabId)).flatMap((f) => f.fields);
        const suggestions = matchProfileToFields(fields, getProfile());
        if (!suggestions.length) return text("No confident matches. Call forms to see the fields, or ask the user for the values.");
        return text(JSON.stringify(suggestions, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );
  ```

  (Add the `matchProfileToFields` import from `../../shared/profile-match` at the top of the file.)

- [ ] **Step 6: Add the e2e tool test**

  In `scripts/test-tools.mjs`:

  ```js
  test("profile_suggest_fill matches fixture form fields to the stored profile without filling anything", async () => {
    await callTool("profile_set", { firstName: "Ada", email: "ada@example.com" });
    await callTool("navigate", { url: fixtureUrl("forms.html") });
    const result = await callTool("profile_suggest_fill", {});
    const suggestions = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(suggestions));
    assert.ok(suggestions.some((s) => s.suggestedValue === "Ada" || s.suggestedValue === "ada@example.com"));
    const text = await callTool("get_text", {});
    assert.ok(!text.content[0].text.includes("Ada Lovelace")); // confirm nothing was actually typed
  });
  ```

  Run: `npm run test:tools -- --test-name-pattern=profile_suggest`.
  Expected: PASS. (If `forms.html` has no fields whose labels match the synonym list, add one — e.g. a "First Name" input — to that fixture rather than inventing a mismatched assertion.)

- [ ] **Step 7: Bookkeeping and gates**

  Add `profile_suggest_fill` to `src/shared/tool-manifest.ts` (`group: "toolsState"`), bump `TOOL_GROUP_COUNTS.toolsState` from `11` to `12`, bump `TOTAL_TOOLS` from `73` to `74`. Run the full gate (`tsc`, `test:unit`, `test:tools`, `packaging:check`) — all green.

- [ ] **Step 8: Commit**

  ```bash
  git add src/mcp/tools/profile.ts src/shared/profile-match.ts src/shared/tool-manifest.ts src/main/transfer-prefs.ts scripts/test-unit/profile-match.test.mjs scripts/test-tools.mjs
  git commit -m "Add profile_suggest_fill: suggestion-only label matching, never auto-fills"
  ```

---

## Task 6: Assistant cursor overlay

**Files:**
- Create: `src/shared/cursor-script.ts`
- Modify: `src/main/browser.ts`, `src/shared/types.ts` (`AppSettings.showAssistantCursor`), `src/main/settings.ts`, `src/renderer/index.html`, `src/renderer/ui/settings.ts`
- Test: `scripts/test-tools.mjs`

**Interfaces:**
- Consumes: `resolveSelectors`/element bounding info already available on `clickCore`/`typeTextCore`/`selectCore`/`hoverCore`.
- Produces: `showAssistantCursor` setting (default `true`), a private `BrowserHub.moveCursorTo(tab, ref)` called at the top of each of those four `xCore` methods.

- [ ] **Step 1: Add the setting**

  In `src/shared/types.ts`, add `showAssistantCursor: boolean;` to `AppSettings` (near `humanPacing`, `src/shared/types.ts:88-95` area). In `src/main/settings.ts`, add `showAssistantCursor: true` to `DEFAULT_SETTINGS` and a `typeof s.showAssistantCursor === "boolean" ? s.showAssistantCursor : fallback.showAssistantCursor` line in `sanitize` (mirroring `humanPacing`'s exact two lines, `src/main/settings.ts:9, 42`).

- [ ] **Step 2: Add the cursor script**

  Create `src/shared/cursor-script.ts`:

  ```ts
  /** Injected before an assistant click/type/select/hover to show a small cursor moving to the target — purely cosmetic, never affects the real action that follows. Idempotent: safe to call repeatedly on the same page. */
  export function moveCursorScript(x: number, y: number): string {
    return `(() => {
      let el = document.getElementById('__echo_cursor__');
      if (!el) {
        el = document.createElement('div');
        el.id = '__echo_cursor__';
        el.style.cssText = 'position:fixed;z-index:2147483647;width:14px;height:14px;margin:-2px 0 0 -2px;border-radius:50%;background:rgba(255,80,80,0.85);box-shadow:0 0 0 2px rgba(255,255,255,0.9);pointer-events:none;transition:left 120ms ease,top 120ms ease,opacity 120ms ease;opacity:0;';
        document.documentElement.appendChild(el);
      }
      el.style.left = ${JSON.stringify(String(x))} + 'px';
      el.style.top = ${JSON.stringify(String(y))} + 'px';
      el.style.opacity = '1';
    })()`;
  }

  /** Bounding-box center of a snapshot ref, in viewport coordinates, or null if the ref isn't found. */
  export function elementCenterScript(ref: string): string {
    return `(() => {
      const el = document.querySelector(${JSON.stringify(`[data-lb-ref="${ref}"]`)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
  }
  ```

- [ ] **Step 3: Add `moveCursorTo` and call it from the four action `xCore`s**

  In `src/main/browser.ts`, add near `resolveSelectors`:

  ```ts
  private async moveCursorTo(tab: Tab, ref: string): Promise<void> {
    if (!this.showAssistantCursor) return;
    try {
      const center = (await this.exec(tab, elementCenterScript(ref))) as { x: number; y: number } | null;
      if (!center) return;
      await this.exec(tab, moveCursorScript(center.x, center.y));
    } catch {
      /* cosmetic only — never block the real action on this failing */
    }
  }
  ```

  Add a `private showAssistantCursor = true;` field (next to `private humanPacing`, find its declaration via `grep -n "humanPacing" src/main/browser.ts` and mirror it exactly, including its setter method, e.g. `setShowAssistantCursor(value: boolean)`), and call `await this.moveCursorTo(tab, ref);` as the first line inside `clickCore`, `typeTextCore`, `selectCore`, and `hoverCore` (after their existing `await pace(this.humanPacing);` line), so the cursor becomes visible during the same pacing pause the user already sees.

  Wire `hub.setShowAssistantCursor(getSettings().showAssistantCursor)` alongside the existing `hub.setHumanPacing(...)` calls in `src/main/index.ts` (`src/main/index.ts:430, 685`).

- [ ] **Step 4: Add the Settings → System toggle**

  In `src/renderer/index.html`, add a card right after the "Human pacing" card (`src/renderer/index.html:467-473`):

  ```html
  <div class="card">
    <div>
      <h3>Show assistant cursor</h3>
      <p class="meta">Shows a small cursor moving to what the assistant clicks or types into, so you can see what it's doing.</p>
    </div>
    <label class="switch"><input type="checkbox" id="show-assistant-cursor" /><span></span></label>
  </div>
  ```

  In `src/renderer/ui/settings.ts`, mirror the `human-pacing` wiring exactly (`src/renderer/ui/settings.ts:182-185, 286-287`) for `#show-assistant-cursor` / `showAssistantCursor`.

- [ ] **Step 5: Add an e2e test that the cursor element appears after a click**

  In `scripts/test-tools.mjs`:

  ```js
  test("click leaves a cursor overlay element positioned near the clicked element", async () => {
    await callTool("navigate", { url: fixtureUrl("index.html") });
    const found = await callTool("find", { role: "link" });
    const ref = extractFirstRef(found.content[0].text);
    await callTool("click", { ref });
    const hasCursor = await callTool("evaluate", { js: "!!document.getElementById('__echo_cursor__')" });
    assert.equal(JSON.parse(hasCursor.content[0].text), true);
  });
  ```

  (Skip this test, or gate it, if `evaluate` is off by default in the test harness's transfer prefs — check how other tests that need `evaluate` handle that, e.g. `grep -n "evaluate" scripts/test-tools.mjs`.)

  Run: `npm run test:tools -- --test-name-pattern=cursor`.
  Expected: PASS.

- [ ] **Step 6: Full gate and commit**

  Run: `npx tsc --noEmit`, `npm run test:unit`, `npm run test:tools`, `npm run packaging:check` — all green.

  ```bash
  git add src/shared/cursor-script.ts src/main/browser.ts src/shared/types.ts src/main/settings.ts src/main/index.ts src/renderer/index.html src/renderer/ui/settings.ts scripts/test-tools.mjs
  git commit -m "Show an in-page assistant cursor before click/type/select/hover"
  ```

---

## Task 7: OSR "Applications" workspace — tab creation and session tools

**Files:**
- Modify: `src/main/browser.ts` (Tab type, tab creation, paint forwarding)
- Modify: `src/main/index.ts` (IPC for grid frames), `src/preload/index.ts`, `src/renderer/global.d.ts`
- Create: `src/mcp/tools/apps.ts`
- Modify: `src/mcp/register-tools.ts`, `src/shared/tool-manifest.ts`, `src/main/transfer-prefs.ts`
- Test: `scripts/test-tools.mjs`

**Interfaces:**
- Produces: `Tab.osr: boolean` field, `Tab.view` widened to `BrowserView | BrowserWindow`; `BrowserHub.createAppsSession(urls: string[]): { tabIds: string[] }`, `BrowserHub.endAppsSession(opts: { close: boolean }): void`; IPC event `grid:frame` with `{ tabId: string, dataUrl: string, width: number, height: number }`; tools `apps_session_start`, `apps_session_end`.
- Consumes: `createTab`'s existing structure (`src/main/browser.ts:529-574`), `withTab`/`xCore` machinery from Tasks 1-2 (OSR tabs are ordinary `Tab`s for every read/interact tool — no changes needed there, since they only ever touch `tab.view.webContents`, which both `BrowserView` and `BrowserWindow` expose identically).
- **Design correction (2026-08-29):** OSR tabs use a hidden `BrowserWindow`, not an offscreen `BrowserView` — see Step 1's "CORRECTED DESIGN" note for why. Task 8 (the grid renderer) is unaffected: the `grid:frame` IPC contract is identical either way.

- [ ] **Step 1: Add `osr` to the `Tab` type and an OSR-aware tab constructor**

  **CORRECTED DESIGN (2026-08-29, after Task 7's first implementation attempt):** the plan originally specified `new BrowserView({ webPreferences: { offscreen: true } })`. This was **verified false** against this project's actual Electron version (36.9.5): a detached offscreen `BrowserView` produces zero `paint` events and a 0×0 `capturePage()` — silently, with no thrown error (`isOffscreen()` and `isPainting()` both report `true` regardless). The verified working alternative is a **hidden `BrowserWindow`** (`show: false`, `webPreferences: { offscreen: true, ... }`), which does stream real `paint` frames. Use that instead everywhere this step (and Step 3) says `BrowserView`.

  This widens `Tab.view`'s type from `BrowserView` to `BrowserView | BrowserWindow`. Every existing call site only ever uses `tab.view.webContents`, which both types expose identically, so this change is additive, not a rewrite — but grep for any place that calls a `BrowserView`-only method directly on `tab.view` (e.g. `this.window.addBrowserView(tab.view)`/`removeBrowserView(tab.view)` in `selectTab`/`closeTab`) and guard those specifically on `tab.osr` rather than assuming `tab.view` is always a `BrowserView`.

  Add `osr: boolean;` to the `Tab` type (`src/main/browser.ts:115-143`, next to `incognito`), and widen `view: BrowserView;` to `view: BrowserView | BrowserWindow;`.

  Add a new method next to `createTab` (`src/main/browser.ts:529`):

  ```ts
  /**
   * An OSR tab is a hidden BrowserWindow (show: false, offscreen: true), never the window's
   * attached BrowserView — offscreen BrowserViews do not paint on this Electron version
   * (verified: zero paint events, 0x0 capturePage, no thrown error). It exists purely to stream
   * `paint` frames to the grid. Every read/interact tool works on it unchanged, since they all
   * operate on `tab.view.webContents`, which BrowserWindow exposes identically to BrowserView.
   */
  private createOsrTab(url: string): string {
    const id = `tab-${++this.seq}`;
    const partition = partitionName();
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload", "page.js"),
        offscreen: true,
      },
    });
    win.webContents.setFrameRate(12); // matches forwardGridFrame's throttle; avoid rendering faster than we forward
    const tab: Tab = {
      id,
      view: win,
      console: [],
      networkFailures: [],
      network: [],
      favicon: null,
      incognito: false,
      partition,
      contentType: null,
      frameIndex: null,
      frameUrl: null,
      snapshotByRef: new Map(),
      osr: true,
    };
    installChromePageShim(win.webContents);
    this.attachListeners(tab);
    this.tabs.set(id, tab);
    this.order.push(id);
    win.webContents.on("paint", (_event, _dirty, image) => {
      this.forwardGridFrame(id, image);
    });
    win.webContents.startPainting();
    void win.webContents.loadURL(url);
    this.onChange();
    return id;
  }
  ```

  Add `osr: false` to the object literal in the existing `createTab` (`src/main/browser.ts:549-562`) so the `Tab` type stays fully satisfied.

  Adjust `selectTab` (`src/main/browser.ts:585-620`) to refuse attaching an OSR tab as the primary view — add `if (tab.osr) throw new Error("OSR tabs render in the grid, not the main view.");` right after `const tab = this.requireTab(id);`.

  Adjust `closeTab` to close an OSR tab's hidden `BrowserWindow` directly (`tab.view.destroy()` or `.close()`, guarded on `tab.osr`) rather than calling `this.window.removeBrowserView(tab.view)` on it — a `BrowserWindow` is not a valid argument to `removeBrowserView`. (Note: the original brief claimed the existing `removeBrowserView` call was already try/caught and would harmlessly no-op for a never-attached view — verify this directly in the current `closeTab` body rather than trusting that claim; Task 7's first implementation attempt found the call is NOT guarded at the line in question, so an OSR tab must be routed to the `BrowserWindow`-appropriate cleanup path explicitly, not merely rely on a catch.)

  **Audit app-quit semantics.** Hidden OSR `BrowserWindow`s appear in Electron's `BrowserWindow.getAllWindows()` and count toward `window-all-closed`/quit logic. Find wherever this app currently decides to quit (search for `window-all-closed` in `src/main/index.ts`) and confirm an open OSR tab does not either (a) prevent the app from quitting when the user closes the real main window, or (b) get force-closed unexpectedly by existing quit logic while a session is active. Adjust that logic to count only the real main window, not OSR tabs' hidden windows, if it currently doesn't.

- [ ] **Step 2: Throttle and forward paint frames over IPC**

  Add near the other per-tab maps:

  ```ts
  private lastGridFrameAt = new Map<string, number>();
  private onGridFrame: (tabId: string, dataUrl: string, width: number, height: number) => void = () => {};

  setGridFrameListener(fn: (tabId: string, dataUrl: string, width: number, height: number) => void): void {
    this.onGridFrame = fn;
  }

  private forwardGridFrame(tabId: string, image: Electron.NativeImage): void {
    const now = Date.now();
    const last = this.lastGridFrameAt.get(tabId) ?? 0;
    if (now - last < 80) return; // cap at ~12fps per tile — plenty for a form-filling grid, keeps IPC light
    this.lastGridFrameAt.set(tabId, now);
    const size = image.getSize();
    this.onGridFrame(tabId, image.toDataURL(), size.width, size.height);
  }
  ```

  In `src/main/index.ts`, where the hub is constructed, wire `hub.setGridFrameListener((tabId, dataUrl, width, height) => { win.webContents.send("grid:frame", { tabId, dataUrl, width, height }); })` (find the existing `hub.setHumanPacing`-style wiring block, around `src/main/index.ts:685`, and add this alongside it).

- [ ] **Step 3: Add session tracking and start/end methods**

  ```ts
  private appsSessionTabIds: string[] = [];

  async createAppsSession(urls: string[]): Promise<{ tabIds: string[] }> {
    const cap = 6;
    if (urls.length > cap) throw new Error(`Applications sessions support up to ${cap} tabs at once, got ${urls.length}.`);
    if (this.appsSessionTabIds.length) throw new Error("An applications session is already open. Call apps_session_end first.");
    const tabIds = urls.map((url) => this.createOsrTab(normalizeUrl(url)));
    this.appsSessionTabIds = tabIds;
    this.onChange();
    return { tabIds };
  }

  endAppsSession(opts?: { close?: boolean }): void {
    const ids = this.appsSessionTabIds;
    this.appsSessionTabIds = [];
    if (opts?.close === false) return;
    for (const id of ids) {
      try {
        this.closeTab(id);
      } catch {
        /* already gone */
      }
    }
  }

  appsSessionTabs(): string[] {
    return [...this.appsSessionTabIds];
  }
  ```

  (Confirm `closeTab` already tolerates an OSR tab — it operates on `this.tabs`/`this.order`/`window.removeBrowserView` guarded by try/catch per the existing pattern at `src/main/browser.ts:620-628`; an OSR tab was never added via `addBrowserView`, so `removeBrowserView` throwing "already detached" and being caught is expected, not a bug.)

- [ ] **Step 4: Register `apps_session_start`/`apps_session_end` tools**

  Create `src/mcp/tools/apps.ts`:

  ```ts
  import { z } from "zod";
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { define, err, text, type ToolDeps } from "./_helpers";

  export function registerApps(server: McpServer, deps: ToolDeps): void {
    const hub = deps.hub;

    define(
      server,
      deps,
      "apps_session_start",
      "Open up to 6 URLs as a live grid the user can watch (Echo switches into grid view). Returns the tabId for each, in the same order as the URLs given, for use with every tabId-addressed tool. Only one session at a time — call apps_session_end first to start another.",
      { urls: z.array(z.string()).min(1).max(6) },
      async ({ urls }) => {
        try {
          const { tabIds } = await hub.createAppsSession(urls);
          return text(JSON.stringify({ tabIds }, null, 2));
        } catch (e) {
          return err(e);
        }
      },
    );

    define(
      server,
      deps,
      "apps_session_end",
      "End the current applications grid session. Set close to false to keep the tabs open as regular tabs instead of closing them (default: close them).",
      { close: z.boolean().optional() },
      async ({ close }) => {
        try {
          hub.endAppsSession({ close });
          return text("Applications session ended.");
        } catch (e) {
          return err(e);
        }
      },
    );
  }
  ```

  Wire it into `src/mcp/register-tools.ts` next to `registerProfile`/other registrations.

- [ ] **Step 5: Add the e2e test**

  In `scripts/test-tools.mjs`:

  ```js
  test("apps_session_start opens OSR tabs addressable by every tabId tool, apps_session_end closes them", async () => {
    const start = await callTool("apps_session_start", { urls: [fixtureUrl("forms.html"), fixtureUrl("tables.html")] });
    const { tabIds } = JSON.parse(start.content[0].text);
    assert.equal(tabIds.length, 2);
    const info = await callTool("page_info", { tabId: tabIds[0] });
    assert.ok(JSON.parse(info.content[0].text).title);
    await callTool("apps_session_end", {});
    const list = await callTool("tabs_list", {});
    const remaining = JSON.parse(list.content[0].text).map((t) => t.id);
    assert.ok(!remaining.includes(tabIds[0]));
  });
  ```

  Run: `npm run test:tools -- --test-name-pattern=apps_session`.
  Expected: PASS. If `webContents.startPainting`/OSR frame delivery doesn't fire inside the headless `ECHO_TEST` harness, this test still validates the part that matters for tool correctness (tabId addressability, session lifecycle) without depending on actual paint events — the visual grid itself is verified manually in Step 6 of Task 8.

- [ ] **Step 6: Bookkeeping and gates**

  Add both tools to `src/shared/tool-manifest.ts` (`group: "toolsState"`), bump `TOOL_GROUP_COUNTS.toolsState` from `12` to `14`, bump `TOTAL_TOOLS` from `74` to `76`. Run the full gate — all green.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/browser.ts src/main/index.ts src/mcp/tools/apps.ts src/mcp/register-tools.ts src/shared/tool-manifest.ts src/main/transfer-prefs.ts scripts/test-tools.mjs
  git commit -m "Add OSR-backed apps_session_start/apps_session_end for a multi-tab applications workspace"
  ```

---

## Task 8: Renderer grid view

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/main.ts`, `src/preload/index.ts`, `src/renderer/global.d.ts`
- Create: `src/renderer/ui/grid.ts`

**Interfaces:**
- Consumes: `grid:frame` IPC event and `tabs_list`-equivalent tab metadata from Task 7 (via a new `window.lb.onGridFrame(cb)` and `window.lb.getAppsSessionTabs()`/existing tab-list IPC).
- Produces: a grid view toggled on when an apps session is active, drawing each tab's frames into its own `<canvas>`, with one tile marked "focused" and receiving forwarded mouse/keyboard input.

- [ ] **Step 1: Expose the grid frame event and tab list on the preload bridge**

  In `src/preload/index.ts`:

  ```ts
  onGridFrame: (cb: (frame: { tabId: string; dataUrl: string; width: number; height: number }) => void) => {
    ipcRenderer.on("grid:frame", (_e, frame) => cb(frame));
  },
  ```

  Add the matching type to `src/renderer/global.d.ts`.

- [ ] **Step 2: Build the grid renderer**

  Create `src/renderer/ui/grid.ts`:

  ```ts
  type Tile = { tabId: string; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: HTMLImageElement };

  const tiles = new Map<string, Tile>();
  let container: HTMLElement | null = null;
  let focusedTabId: string | null = null;

  export function initGrid(): void {
    container = document.getElementById("apps-grid");
    window.lb.onGridFrame(({ tabId, dataUrl, width, height }) => {
      const tile = tiles.get(tabId) ?? createTile(tabId);
      if (tile.canvas.width !== width || tile.canvas.height !== height) {
        tile.canvas.width = width;
        tile.canvas.height = height;
      }
      tile.img.onload = () => tile.ctx.drawImage(tile.img, 0, 0, width, height);
      tile.img.src = dataUrl;
    });
  }

  function createTile(tabId: string): Tile {
    if (!container) throw new Error("Grid container not initialized");
    const wrapper = document.createElement("div");
    wrapper.className = "grid-tile";
    wrapper.dataset.tabId = tabId;
    const canvas = document.createElement("canvas");
    wrapper.appendChild(canvas);
    wrapper.addEventListener("click", () => setFocused(tabId));
    container.appendChild(wrapper);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    const tile: Tile = { tabId, canvas, ctx, img: new Image() };
    tiles.set(tabId, tile);
    if (!focusedTabId) setFocused(tabId);
    return tile;
  }

  function setFocused(tabId: string): void {
    focusedTabId = tabId;
    for (const el of container?.querySelectorAll<HTMLElement>(".grid-tile") ?? []) {
      el.classList.toggle("focused", el.dataset.tabId === tabId);
    }
  }

  export function clearGrid(): void {
    for (const tile of tiles.values()) tile.canvas.remove();
    tiles.clear();
    focusedTabId = null;
  }

  export function focusedTile(): string | null {
    return focusedTabId;
  }
  ```

  (Input forwarding to the focused tile — `sendInputEvent` from clicks/keystrokes on the focused canvas — is a reasonable follow-up once the frame pipeline itself is verified working; note it as an explicit gap in this task's manual verification step rather than half-building it. The grid is primarily for the user to *watch* Claude work across tabs, per this plan's Section 2 framing; manual takeover of one tile is a smaller, separable enhancement.)

- [ ] **Step 3: Add the grid container to the HTML and CSS**

  In `src/renderer/index.html`, add a hidden container near the main chrome (check where `BrowserView` bounds are reserved, e.g. the `#chrome` element, to place the grid as a sibling that can be shown/hidden without fighting the BrowserView's fixed screen position):

  ```html
  <div id="apps-grid" class="apps-grid" hidden></div>
  ```

  Add minimal CSS (in whatever stylesheet `src/renderer/index.html` already links — find it via `grep -n "<link.*css" src/renderer/index.html`):

  ```css
  .apps-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; padding: 8px; }
  .grid-tile { position: relative; border: 2px solid transparent; border-radius: 6px; overflow: hidden; }
  .grid-tile.focused { border-color: #4a90e2; }
  .grid-tile canvas { width: 100%; display: block; }
  ```

- [ ] **Step 4: Wire visibility to the apps session lifecycle**

  In `src/renderer/main.ts` (find its existing IPC-listener setup block), call `initGrid()` at startup, and show/hide `#apps-grid` based on whatever signal Task 7's `onChange()` already broadcasts for tab-list updates (check how the renderer currently learns tab lists changed — likely an existing `tabs:changed` IPC event — and toggle `#apps-grid`'s `hidden` attribute based on whether any current tab is OSR, using the tab list's existing shape rather than inventing a new one).

- [ ] **Step 5: Manual verification**

  Run the dev build (`npm start`), connect an MCP client, call `apps_session_start` with 2-3 fixture or real URLs, and confirm:
  - The grid appears showing live, independently-updating frames for each tab (not frozen, not all showing the same page).
  - Clicking a tile visually marks it focused (border highlight).
  - `apps_session_end` closes the tabs and the grid disappears.
  - Memory/CPU stay reasonable with 3 tabs open (rough sanity check via Task Manager, not a hard threshold).

  Record the outcome in the task notes; this is the one step in the whole plan that can't be asserted by an automated test given the OSR pipeline's dependence on real compositing.

- [ ] **Step 6: Full gate and commit**

  Run: `npx tsc --noEmit`, `npm run test:unit`, `npm run test:tools`, `npm run packaging:check` — all green.

  ```bash
  git add src/renderer/index.html src/renderer/main.ts src/renderer/ui/grid.ts src/preload/index.ts src/renderer/global.d.ts
  git commit -m "Add the live applications grid view, wired to apps_session_start/end"
  ```

---

## Task 9: Final bookkeeping pass

**Files:**
- Modify: `README.md`, `src/main/skill-tree.ts`, `src/shared/tool-manifest.ts`, `scripts/test-tools.mjs`

**Interfaces:**
- Consumes: nothing new — this is a consistency pass across everything Tasks 2-7 added.

- [ ] **Step 1: Recount every group and cross-check against `TOOL_MANIFEST`**

  Run `node -e "const {TOOL_MANIFEST}=require('./src/shared/tool-manifest.ts'); ..."` is not directly runnable on `.ts` — instead, grep-count: `grep -c '"toolsInteract"' src/shared/tool-manifest.ts`, `grep -c '"toolsState"' src/shared/tool-manifest.ts`, etc., and confirm each matches the corresponding `TOOL_GROUP_COUNTS` entry in `src/main/transfer-prefs.ts` exactly, and that their sum plus `always` equals `TOTAL_TOOLS` in `scripts/test-tools.mjs` (should be `76` after Tasks 3-7: `fill_form` +1 interact, `profile_get`/`profile_set`/`profile_suggest_fill`/`apps_session_start`/`apps_session_end` +5 state).

- [ ] **Step 2: Update the README's tool list and count**

  Find the README's existing tool-count/tool-list section (`grep -n "tools\b" README.md | head -20`) and add the six new tools with one-line descriptions matching `tool-manifest.ts` exactly, updating any stated total.

- [ ] **Step 3: Update the skill tree with a short multi-tab guidance line**

  In `src/main/skill-tree.ts`, near the existing "snapshot before click/type/fill" guidance (`src/main/skill-tree.ts:12, 60`), add one sentence: working several applications at once, use `apps_session_start` to open them, address each with its `tabId`, and `fill_form`/`profile_suggest_fill` to fill them fast.

- [ ] **Step 4: Run the complete gate suite one last time**

  Run, in order: `npx tsc --noEmit` (only the 4 pre-existing errors), `npm run test:unit`, `npm run test:tools` (installed Echo quit first), `npm run test:bridge`, `npm run packaging:check`.
  Expected: all green.

- [ ] **Step 5: Commit**

  ```bash
  git add README.md src/main/skill-tree.ts src/shared/tool-manifest.ts
  git commit -m "Sync README, skill tree, and tool counts for the multi-tab applications feature"
  ```
