import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP = "http://127.0.0.1:18931/mcp";
const tokenPath = path.join(os.homedir(), "AppData", "Roaming", "local-browser", "mcp-token.txt");
const token = fs.readFileSync(tokenPath, "utf8").trim();

const findings = [];

function textOf(result) {
  const parts = result?.content ?? [];
  return parts.map((p) => (p.type === "text" ? p.text : JSON.stringify(p))).join("\n");
}

async function call(client, name, args = {}, timeoutMs = 30000) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const content = result?.content ?? [];
    return {
      isError: Boolean(result.isError),
      text: textOf(result),
      images: content.filter((p) => p.type === "image" && p.data).length,
    };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err), images: 0 };
  }
}

function check(name, ok, detail) {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const health = await fetch("http://127.0.0.1:18931/health").then((r) => r.json());
  check("health endpoint", health.ok === true, JSON.stringify(health));

  const unauth = await fetch(MCP, { method: "POST", body: "{}" });
  check("rejects missing bearer token", unauth.status === 401, `status ${unauth.status}`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "local-browser-bugtest", version: "0.1.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  const expected = [
    "back",
    "click",
    "console_errors",
    "extract_readable",
    "fill",
    "navigate",
    "network_failures",
    "press",
    "reload",
    "screenshot",
    "scroll",
    "search_web",
    "select",
    "snapshot",
    "tabs_close",
    "tabs_list",
    "tabs_new",
    "tabs_select",
    "test_assert_text",
    "test_assert_url",
    "test_end",
    "test_start",
    "type",
    "viewport_set",
    "wait_for",
    "watch",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  check("tool catalog", missing.length === 0, missing.length ? `missing ${missing.join(",")}` : `${names.length} tools`);

  let tabs = await call(client, "tabs_list");
  check("tabs_list", !tabs.isError && tabs.text.includes("tab-"), tabs.text.slice(0, 180));

  const home = await call(client, "navigate", { url: "https://example.com/" });
  check("navigate example.com", !home.isError && /example\.com/i.test(home.text), home.text);

  await call(client, "wait_for", { timeoutMs: 8000 });
  const readable = await call(client, "extract_readable");
  check(
    "extract_readable has article text",
    !readable.isError && /example domain/i.test(readable.text),
    readable.text.slice(0, 200).replace(/\s+/g, " "),
  );

  const shot = await call(client, "screenshot", {}, 20000);
  check("screenshot writes a file", !shot.isError && /Saved PNG to .+\.png|Saved screenshot to .+\.png/i.test(shot.text), shot.text.slice(0, 240));
  check("screenshot includes a page photo", !shot.isError && shot.images >= 1, `images=${shot.images}`);
  if (!shot.isError) {
    const file = shot.text.replace(/^Saved screenshot to /, "").trim();
    check("screenshot file exists", fs.existsSync(file), file);
  }

  const snap = await call(client, "snapshot");
  check("snapshot returns refs", !snap.isError && /\[e\d+\]/.test(snap.text), snap.text.split("\n").slice(0, 8).join(" | "));
  check("snapshot includes a page photo", snap.images >= 1, `images=${snap.images}`);

  const more = await call(client, "tabs_new", { url: "https://example.com/user/india" });
  check("tabs_new", !more.isError, more.text);
  tabs = await call(client, "tabs_list");
  const ids = [...tabs.text.matchAll(/"id": "(tab-\d+)"/g)].map((m) => m[1]);
  check("two tabs open", ids.length >= 2, `count=${ids.length}`);

  if (ids.length >= 2) {
    const select = await call(client, "tabs_select", { id: ids[0] });
    check("tabs_select", !select.isError, select.text);
    const closed = await call(client, "tabs_close", { id: ids[ids.length - 1] });
    check("tabs_close", !closed.isError, closed.text);
  }

  await call(client, "navigate", { url: "https://example.com/" });
  const started = await call(client, "test_start");
  check("test_start", !started.isError, started.text);
  const assertUrl = await call(client, "test_assert_url", { pattern: "example.com" });
  check("test_assert_url pass", !assertUrl.isError, assertUrl.text);
  const assertText = await call(client, "test_assert_text", { text: "Example Domain" });
  check("test_assert_text pass", !assertText.isError, assertText.text);
  const assertFail = await call(client, "test_assert_text", { text: "this-string-should-not-exist-xyz" });
  check("test_assert_text fail is flagged", assertFail.isError === true, assertFail.text);
  const ended = await call(client, "test_end");
  check("test_end", !ended.isError && /Test run saved/i.test(ended.text), ended.text);

  const badClick = await call(client, "click", { ref: "e9999" });
  check("click missing ref errors", badClick.isError === true, badClick.text.slice(0, 160));

  await call(client, "navigate", { url: "https://example.com/" });
  await call(client, "wait_for", { timeoutMs: 5000 });
  const snap2 = await call(client, "snapshot");
  const refMatch = snap2.text.match(/\[(e\d+)\] <a>/);
  if (refMatch) {
    const clicked = await call(client, "click", { ref: refMatch[1] });
    check("click snapshot ref", !clicked.isError, clicked.text);
  } else {
    check("click snapshot ref", false, "no link ref in snapshot");
  }

  const search = await call(client, "search_web", { query: "example domain iana" }, 45000);
  let searchOk = !search.isError;
  let parsed = [];
  try {
    parsed = JSON.parse(search.text).results || [];
  } catch {
    searchOk = false;
  }
  check("search_web returns JSON results", searchOk && Array.isArray(parsed), `n=${parsed.length}`);
  check(
    "search_web has at least one http result",
    parsed.some((r) => typeof r.url === "string" && r.url.startsWith("http") && r.title),
    parsed
      .slice(0, 3)
      .map((r) => r.title)
      .join(" | ") || search.text.slice(0, 240),
  );

  const cons = await call(client, "console_errors");
  check("console_errors tool", !cons.isError, cons.text.slice(0, 120));
  const net = await call(client, "network_failures");
  check("network_failures tool", !net.isError, net.text.slice(0, 120));

  const vp = await call(client, "viewport_set", { width: 1280, height: 720 });
  check("viewport_set", !vp.isError, vp.text);

  const back = await call(client, "back");
  check("back", !back.isError, back.text);
  const reload = await call(client, "reload");
  check("reload", !reload.isError, reload.text);

  await client.close();

  const failed = findings.filter((f) => !f.ok);
  console.log("\n---");
  console.log(`${findings.length - failed.length}/${findings.length} passed`);
  if (failed.length) {
    console.log("Failures:");
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("CRASH", err);
  process.exit(1);
});
