import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserHub } from "../../src/main/browser";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Just enough of a `Tab` for the private-field pokes below: never a real `BrowserView`. */
type FakeTab = { id: string; incognito: boolean; view: { webContents: { close: () => void } } };

/** The private state this file reaches into, named once so every cast below agrees on the shape. */
type HubInternals = {
  tabs: Map<string, FakeTab>;
  tabQueues: Map<string, Promise<unknown>>;
  tabTargetIds: Map<string, string>;
};

/**
 * `withTab` is a private queueing layer with no public state of its own to inspect, so this
 * test reaches into `BrowserHub`'s private `tabs` map to seed fake tabs — there is no
 * lighter-weight way to get a real `BrowserHub` instance without a running Electron app.
 * `withTabForTest` is the one test-only seam (`browser.ts`): a thin public wrapper around the
 * private `withTab`, not registered as an MCP tool, so it is inert in production. The closeTab
 * cleanup test below reaches into `tabQueues`/`tabTargetIds` the same way, rather than adding a
 * second test-only public method just to read two private maps.
 */
function makeTestHub(tabIds: string[]): { hub: BrowserHub; internals: HubInternals } {
  const hub = new BrowserHub();
  const internals = hub as unknown as HubInternals;
  for (const id of tabIds) {
    internals.tabs.set(id, { id, incognito: false, view: { webContents: { close: () => {} } } });
  }
  return { hub, internals };
}

test("withTab serializes same-tab calls and lets different tabs run concurrently", async () => {
  const { hub } = makeTestHub(["tabA", "tabB"]);
  const order: string[] = [];

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

  // Same-tab calls run strictly in the order they were dispatched, never overlapping.
  assert.deepEqual(
    order.filter((e) => e.startsWith("A")),
    ["A-start", "A-end", "A2-start", "A2-end"],
  );
  // Tab B's call is not queued behind tab A's: it starts and finishes while A's 30ms call is
  // still in flight, proving the two tabs' queues run concurrently rather than sharing one.
  assert.ok(order.indexOf("B-start") < order.indexOf("A-end"), `expected B to start before A finished: ${order}`);
  assert.ok(order.indexOf("B-end") < order.indexOf("A-end"), `expected B to finish before A finished: ${order}`);
});

test("withTab still runs a later same-tab call after an earlier one throws", async () => {
  const { hub } = makeTestHub(["tabA"]);
  const order: string[] = [];

  await assert.rejects(
    hub.withTabForTest("tabA", async () => {
      order.push("first");
      throw new Error("boom");
    }),
    /boom/,
  );
  await hub.withTabForTest("tabA", async () => {
    order.push("second");
  });

  assert.deepEqual(order, ["first", "second"]);
});

/**
 * Regression for a leak: `tabQueues` and `tabTargetIds` are keyed by tab id (unlike
 * `pageTargetIds`, a WeakMap keyed on the Playwright Page object, which needs no explicit
 * cleanup), so a tab that closes without clearing its entries there would grow both maps for
 * the life of a long-running desktop session.
 */
test("closeTab clears the closed tab's queue and cached CDP target id", async () => {
  const { hub, internals } = makeTestHub(["tabA", "tabB"]);

  // Give tabA a queue entry the way real use would, plus a cached CDP target id the way
  // `electronTargetId` would after a real lookup (poked in directly here since that lookup
  // needs a real Electron debugger session).
  await hub.withTabForTest("tabA", async () => {});
  internals.tabTargetIds.set("tabA", "cdp-target-123");
  assert.ok(internals.tabQueues.has("tabA"), "setup: tabA should have a queue entry");
  assert.ok(internals.tabTargetIds.has("tabA"), "setup: tabA should have a cached target id");

  hub.closeTab("tabA");

  assert.equal(internals.tabQueues.has("tabA"), false, "tabQueues should drop the closed tab's entry");
  assert.equal(internals.tabTargetIds.has("tabA"), false, "tabTargetIds should drop the closed tab's entry");
  // tabB is untouched by closing tabA.
  assert.equal(internals.tabs.has("tabB"), true);
});
