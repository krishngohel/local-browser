import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserHub } from "../../src/main/browser";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `withTab` is a private queueing layer with no public state of its own to inspect, so this
 * test reaches into `BrowserHub`'s private `tabs` map to seed two fake tabs — there is no
 * lighter-weight way to get a real `BrowserHub` instance without a running Electron app.
 * `withTabForTest` is the one test-only seam (`browser.ts`): a thin public wrapper around the
 * private `withTab`, not registered as an MCP tool, so it is inert in production.
 */
function makeTestHub(tabIds: string[]): BrowserHub {
  const hub = new BrowserHub();
  const tabs = (hub as unknown as { tabs: Map<string, { id: string }> }).tabs;
  for (const id of tabIds) tabs.set(id, { id });
  return hub;
}

test("withTab serializes same-tab calls and lets different tabs run concurrently", async () => {
  const hub = makeTestHub(["tabA", "tabB"]);
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
  const hub = makeTestHub(["tabA"]);
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
