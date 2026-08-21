import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityLog } from "../../src/main/activity";
import { DEFAULT_SETTINGS } from "../../src/main/settings";
import { DEFAULT_TRANSFER_PREFS } from "../../src/main/transfer-prefs";
import { registerTools } from "../../src/mcp/register-tools";
import type { ToolDeps } from "../../src/mcp/tools/_helpers";
import { TOOL_MANIFEST, type ToolGroup } from "../../src/shared/tool-manifest";
import type { TransferPrefs } from "../../src/shared/types";

/** Groups whose tools exist today. Later tasks add: toolsRead, toolsInteract, toolsState, toolsQa. */
const IMPLEMENTED_GROUPS: ToolGroup[] = [
  "always",
  "toolsBrowse",
  "toolsSee",
  "toolsSearch",
  "toolsDebug",
  "toolsTest",
  "toolsRecord",
];

type Registered = { name: string; description: string };

function registerAll(): Registered[] {
  const registered: Registered[] = [];
  const server = {
    tool(name: string, description: string, _schema: unknown, _handler: unknown) {
      registered.push({ name, description });
    },
    registerResource() {},
    registerPrompt() {},
  };
  const allGroupsOn = Object.fromEntries(
    Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true]),
  ) as TransferPrefs;
  const deps: ToolDeps = {
    hub: {} as never,
    tests: {} as never,
    recorder: {} as never,
    activity: new ActivityLog(),
    clientName: () => "unit-test",
    history: {} as never,
    bookmarks: {} as never,
    downloads: {} as never,
    settings: () => ({ ...DEFAULT_SETTINGS, evaluateEnabled: true }),
    prefs: allGroupsOn,
  };
  registerTools(server as never, deps);
  return registered;
}

test("every registered tool matches its TOOL_MANIFEST name and description", () => {
  const registered = registerAll();
  assert.ok(registered.length > 0, "no tools registered");
  const manifest = new Map(TOOL_MANIFEST.map((t) => [t.name, t]));
  for (const tool of registered) {
    const entry = manifest.get(tool.name);
    assert.ok(entry, `${tool.name} is registered but missing from TOOL_MANIFEST`);
    assert.equal(tool.description, entry.description, `${tool.name} description`);
  }
});

test("every manifest entry in an implemented group is registered exactly once", () => {
  const registered = registerAll();
  const counts = new Map<string, number>();
  for (const tool of registered) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  for (const [name, n] of counts) assert.equal(n, 1, `${name} registered ${n} times`);
  for (const entry of TOOL_MANIFEST) {
    if (!IMPLEMENTED_GROUPS.includes(entry.group)) continue;
    assert.equal(counts.get(entry.name) ?? 0, 1, `${entry.name} (${entry.group}) not registered`);
  }
});
