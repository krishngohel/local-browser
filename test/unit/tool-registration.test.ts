import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../../src/main/activity";
import { DEFAULT_SETTINGS } from "../../src/main/settings";
import { DialogPolicies } from "../../src/main/dialogs";
import {
  DEFAULT_TRANSFER_PREFS,
  setTransferPrefs,
  setTransferPrefsDir,
} from "../../src/main/transfer-prefs";
import { setCaptchaSolverPrefs, setCaptchaSolverPrefsDir } from "../../src/main/captcha-solver-prefs";
import { registerTools } from "../../src/mcp/register-tools";
import { refreshToolAvailability, type ToolDeps, type ToolResult } from "../../src/mcp/tools/_helpers";
import { TOOL_MANIFEST, type ToolGroup } from "../../src/shared/tool-manifest";
import type { TransferPrefs } from "../../src/shared/types";

/** Every group in the manifest — all of them are implemented. */
const IMPLEMENTED_GROUPS: ToolGroup[] = [
  "always",
  "toolsBrowse",
  "toolsSee",
  "toolsSearch",
  "toolsDebug",
  "toolsTest",
  "toolsRecord",
  "toolsRead",
  "toolsInteract",
  "toolsState",
  "toolsQa",
];

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type ToolControl = { enabled: boolean; enable: () => void; disable: () => void };
type Registered = { name: string; description: string; handler: Handler; tool: ToolControl };

function registerAll(opts: { evaluateEnabled?: boolean } = {}): Registered[] {
  const registered: Registered[] = [];
  const server = {
    // Mirrors the SDK: `tool()` returns a RegisteredTool whose enabled state Echo flips live.
    tool(name: string, description: string, _schema: unknown, handler: unknown): ToolControl {
      const control: ToolControl = {
        enabled: true,
        enable() {
          this.enabled = true;
        },
        disable() {
          this.enabled = false;
        },
      };
      registered.push({ name, description, handler: handler as Handler, tool: control });
      return control;
    },
    registerResource() {},
    registerPrompt() {},
  };
  const allGroupsOn = Object.fromEntries(
    Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true]),
  ) as TransferPrefs;
  const deps: ToolDeps = {
    // Enough of a hub for `tabs_list` to answer, so a handler can actually be called.
    hub: { listTabs: () => [] } as never,
    tests: {} as never,
    recorder: {} as never,
    activity: new ActivityLog(),
    clientName: () => "unit-test",
    history: {} as never,
    bookmarks: {} as never,
    downloads: {} as never,
    settings: () => ({ ...DEFAULT_SETTINGS, evaluateEnabled: opts.evaluateEnabled ?? true }),
    prefs: allGroupsOn,
    dialogs: new DialogPolicies(),
    scheduler: {} as never,
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

test("evaluate always registers but stays disabled until the user enables it", () => {
  const on = registerAll({ evaluateEnabled: true });
  const off = registerAll({ evaluateEnabled: false });
  const onEval = on.find((t) => t.name === "evaluate");
  const offEval = off.find((t) => t.name === "evaluate");
  assert.ok(onEval?.tool.enabled, "evaluate should be enabled when evaluateEnabled is on");
  assert.ok(offEval && !offEval.tool.enabled, "evaluate should register but be disabled when evaluateEnabled is off");
  // The tool surface itself is identical either way; only evaluate's enabled state differs.
  assert.equal(off.length, on.length, "evaluate registers regardless of the switch");
  // The rest of the interaction group registers enabled with the group on.
  for (const name of ["hover", "double_click", "right_click", "drag", "keyboard_shortcut",
    "upload_file", "dialog", "frames", "frame_select", "zoom"]) {
    assert.ok(off.find((t) => t.name === name)?.tool.enabled, `${name} should register enabled`);
  }
});

test("captcha_solve always registers but stays disabled until the solver is configured", () => {
  const registered = registerAll({ evaluateEnabled: true });
  const solve = registered.find((t) => t.name === "captcha_solve");
  assert.ok(solve, "captcha_solve should register");
  assert.equal(solve.tool.enabled, false, "captcha_solve should be disabled without a configured solver");
  const check = registered.find((t) => t.name === "captcha_check");
  assert.ok(check?.tool.enabled, "captcha_check should stay on with Read and data");
});

/**
 * The bug behind "I can't turn tools on and off": a switch flipped after an assistant connected
 * did nothing, because its tool list was fixed at connect. Tools now register on every session
 * and `refreshToolAvailability` flips their enabled state in place when a switch changes.
 */
test("refreshToolAvailability follows the switches on an already-registered session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-live-toggle-"));
  setTransferPrefsDir(dir);
  try {
    setTransferPrefs(
      Object.fromEntries(Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true])) as TransferPrefs,
    );
    const reg = registerAll();
    const upload = reg.find((t) => t.name === "upload_file");
    assert.ok(upload?.tool.enabled, "upload_file starts enabled with Interaction depth on");

    // The user turns the group off after the assistant is already connected.
    setTransferPrefs({ toolsInteract: false });
    refreshToolAvailability();
    assert.equal(upload!.tool.enabled, false, "upload_file goes disabled live when the group is turned off");

    setTransferPrefs({ toolsInteract: true });
    refreshToolAvailability();
    assert.equal(upload!.tool.enabled, true, "upload_file comes back live when the group is turned on");
  } finally {
    setTransferPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshToolAvailability enables captcha_solve when a key is saved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-captcha-toggle-"));
  setTransferPrefsDir(dir);
  setCaptchaSolverPrefsDir(dir);
  try {
    setTransferPrefs(
      Object.fromEntries(Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true])) as TransferPrefs,
    );
    const reg = registerAll();
    const solve = reg.find((t) => t.name === "captcha_solve");
    assert.equal(solve?.tool.enabled, false, "captcha_solve starts disabled");
    setCaptchaSolverPrefs({ enabled: true, openaiKey: "sk-test" });
    refreshToolAvailability();
    assert.equal(solve!.tool.enabled, true, "captcha_solve comes on live when a key is saved");
    setCaptchaSolverPrefs({ enabled: false });
    refreshToolAvailability();
    assert.equal(solve!.tool.enabled, false, "captcha_solve turns off live when the solver is disabled");
    setCaptchaSolverPrefs({ enabled: true, provider: "agent", openaiKey: "" });
    refreshToolAvailability();
    assert.equal(solve!.tool.enabled, true, "captcha_solve comes on for Connected assistant without a key");
    setCaptchaSolverPrefs({ enabled: true, provider: "openai", openaiKey: "" });
    refreshToolAvailability();
    assert.equal(solve!.tool.enabled, false, "OpenAI provider stays off without a key");
  } finally {
    setTransferPrefsDir(null);
    setCaptchaSolverPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `deps.prefs` is a snapshot taken at registration, so the switch is only a real control if
 * every call re-reads the stored prefs. Registration happens with every group on; the group
 * is then turned off underneath the already-registered handler, the way Settings does it to a
 * connected assistant.
 */
test("turning a group off revokes its tools on an already-registered handler", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-tool-revoke-"));
  setTransferPrefsDir(dir);
  try {
    const allOn = Object.fromEntries(
      Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, true]),
    ) as TransferPrefs;
    setTransferPrefs(allOn);

    const tabsList = registerAll().find((t) => t.name === "tabs_list");
    assert.ok(tabsList, "tabs_list was not registered");

    const before = await tabsList.handler({});
    assert.notEqual(before.isError, true, `tabs_list failed with the group on: ${textOf(before)}`);
    assert.equal(textOf(before), "[]");

    setTransferPrefs({ toolsBrowse: false });
    const revoked = await tabsList.handler({});
    assert.equal(revoked.isError, true, "a tool in a turned-off group still ran");
    assert.equal(
      textOf(revoked),
      "tabs_list is turned off in Echo Settings → Transfers (Browse and click). Turn the group on and retry.",
    );

    setTransferPrefs({ toolsBrowse: true });
    const after = await tabsList.handler({});
    assert.notEqual(after.isError, true, "turning the group back on did not restore the tool");
    assert.equal(textOf(after), "[]");
  } finally {
    setTransferPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("echo_help is never revoked — its group is always on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-tool-always-"));
  setTransferPrefsDir(dir);
  try {
    setTransferPrefs(
      Object.fromEntries(
        Object.keys(DEFAULT_TRANSFER_PREFS).map((k) => [k, false]),
      ) as TransferPrefs,
    );
    const help = registerAll().find((t) => t.name === "echo_help");
    assert.ok(help, "echo_help was not registered");
    const result = await help.handler({});
    assert.notEqual(result.isError, true, `echo_help was refused: ${textOf(result)}`);
  } finally {
    setTransferPrefsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function textOf(result: ToolResult): string {
  const first = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
  return first?.text ?? "";
}
