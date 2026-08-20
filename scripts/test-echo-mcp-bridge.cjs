"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Echo bridge path with spaces "));
  const userData = path.join(root, "User Data");
  const resources = path.join(root, "Echo Resources");
  const sourceResources =
    process.env.ECHO_BRIDGE_RESOURCES || path.join(__dirname, "..", "out", "resources");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  for (const name of ["echo-mcp-bridge.cjs", "echo-mcp-proxy.mjs"]) {
    fs.copyFileSync(path.join(sourceResources, name), path.join(resources, name));
  }

  const token = "smoke-test-secret-that-must-not-be-logged";
  fs.writeFileSync(path.join(userData, "mcp-token.txt"), token, "utf8");
  const eventStreams = [];
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, name: "echo" }));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["x-echo-client"], "claude");
    if (request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(": connected\n\n");
      eventStreams.push(response);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    assert.equal(message.method, "initialize");
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "echo-smoke-session",
    });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "echo", version: "smoke-test" },
        },
      }),
    );
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  fs.writeFileSync(path.join(userData, "mcp-port.txt"), String(address.port), "utf8");

  const executable = process.env.ECHO_BRIDGE_EXECUTABLE || require("electron");
  assert(fs.existsSync(executable), `bridge executable not found: ${executable}`);

  const child = spawn(executable, [path.join(resources, "echo-mcp-bridge.cjs"), "--self-test"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ECHO_USERDATA: userData,
      ECHO_RESOURCES: resources,
    },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const exitCode = await Promise.race([
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    }),
    new Promise((_, reject) =>
      setTimeout(() => {
        child.kill();
        reject(new Error("bridge smoke test timed out"));
      }, 20_000),
    ),
  ]);

  for (const response of eventStreams) response.end();
  server.close();
  assert.equal(exitCode, 0, `bridge failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stderr, /self-test passed \(echo smoke-test\)/);
  const log = fs.readFileSync(path.join(userData, "echo-mcp-bridge.log"), "utf8");
  assert.match(log, /SELF_TEST_OK server=echo version=smoke-test/);
  assert(!log.includes(token), "bridge log leaked bearer token");
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`Bridge handshake passed via ${path.basename(executable)} using paths with spaces.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
