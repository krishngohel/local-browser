"use strict";

/**
 * Claude Desktop stdio bridge — run via Echo with ELECTRON_RUN_AS_NODE=1.
 * Connects Claude's stdio MCP pipe to Echo's local HTTP MCP server.
 * Echo must already be running (tray/menu bar).
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const userData = process.env.ECHO_USERDATA;
const resources = process.env.ECHO_RESOURCES;
const selfTest = process.argv.includes("--self-test");
let token = "";
let logFile = "";

function sanitized(value) {
  const text = value instanceof Error ? value.stack || value.message : String(value);
  return token ? text.split(token).join("[redacted]") : text;
}

function log(message) {
  const line = `${new Date().toISOString()} ${sanitized(message)}\n`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line, "utf8");
    } catch {
      // stderr still gives Claude Desktop an actionable failure.
    }
  }
}

function fail(message) {
  const safe = sanitized(message);
  log(`ERROR ${safe}`);
  console.error(`Echo MCP bridge: ${safe}`);
  process.exit(1);
}

function requireFile(file, message) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(message);
  return file;
}

function loadRuntime() {
  if (!userData) {
    fail("ECHO_USERDATA is missing. Open Echo Settings → Connections and click Connect again.");
  }
  logFile = path.join(userData, "echo-mcp-bridge.log");
  try {
    fs.mkdirSync(userData, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
      fs.renameSync(logFile, `${logFile}.previous`);
    }
  } catch {
    // Continue; diagnostics can still reach Claude's stderr.
  }

  const tokenPath = requireFile(
    path.join(userData, "mcp-token.txt"),
    "MCP token file is missing. Keep Echo running and click Connect again.",
  );
  token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) fail("MCP token file is empty. Restart Echo and click Connect again.");

  const portPath = requireFile(
    path.join(userData, "mcp-port.txt"),
    "MCP port file is missing. Wait for Echo to finish starting, then click Connect again.",
  );
  const portText = fs.readFileSync(portPath, "utf8").trim();
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) {
    fail("MCP port file is invalid. Restart Echo and click Connect again.");
  }

  if (!resources) fail("ECHO_RESOURCES is missing. Click Connect again or reinstall Echo.");
  const proxy = requireFile(
    path.join(resources, "echo-mcp-proxy.mjs"),
    "Bundled MCP proxy is missing. Reinstall or update Echo.",
  );
  return { port, proxy, url: `http://127.0.0.1:${port}/mcp` };
}

function healthCheck(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 3000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const health = JSON.parse(body);
            if (response.statusCode !== 200 || health.ok !== true || health.name !== "echo") {
              reject(new Error(`unexpected health response (${response.statusCode || "no status"})`));
              return;
            }
            resolve();
          } catch {
            reject(new Error(`invalid health response (${response.statusCode || "no status"})`));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("health check timed out")));
    request.on("error", reject);
  });
}

function proxyArgs(runtime) {
  return [
    runtime.proxy,
    runtime.url,
    "--transport",
    "http-only",
    "--allow-http",
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    "X-Echo-Client: claude",
  ];
}

function proxyEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}

function startProxy(runtime, stdio) {
  return spawn(process.execPath, proxyArgs(runtime), {
    env: proxyEnv(),
    stdio,
    windowsHide: true,
    shell: false,
  });
}

async function runSelfTest(runtime) {
  await healthCheck(runtime.port);
  const child = startProxy(runtime, ["pipe", "pipe", "pipe"]);
  let stdout = "";
  let stderr = "";

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      stop(new Error(`MCP initialize timed out. Proxy diagnostics: ${stderr.trim() || "none"}`));
    }, 10000);
    const stop = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    child.stderr.on("data", (chunk) => {
      const text = sanitized(chunk.toString("utf8"));
      stderr += text;
      log(`proxy ${text.trim()}`);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) {
              stop(new Error(`MCP initialize failed: ${JSON.stringify(message.error)}`));
            } else if (message.result?.serverInfo?.name === "echo") {
              stop(null, message.result);
            } else {
              stop(new Error("MCP initialize returned an unexpected server identity."));
            }
          }
        } catch {
          stop(new Error("Proxy wrote non-JSON data to stdout; stdio framing is invalid."));
        }
      }
    });
    child.on("error", (error) => stop(error));
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        stop(new Error(`Proxy exited with code ${code}. ${stderr.trim()}`));
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "echo-bridge-self-test", version: "1.0.0" },
        },
      })}\n`,
    );
  });
  log(`SELF_TEST_OK server=${result.serverInfo.name} version=${result.serverInfo.version}`);
  console.error(`Echo MCP bridge self-test passed (${result.serverInfo.name} ${result.serverInfo.version}).`);
}

async function runBridge(runtime) {
  await healthCheck(runtime.port);
  log(`START port=${runtime.port} execArch=${process.arch}`);
  const child = startProxy(runtime, ["inherit", "inherit", "pipe"]);
  child.stderr.on("data", (chunk) => {
    const text = sanitized(chunk.toString("utf8"));
    process.stderr.write(text);
    log(`proxy ${text.trim()}`);
  });
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) => {
    log(`EXIT code=${code ?? "none"} signal=${signal || "none"}`);
    process.exit(code ?? (signal ? 0 : 1));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
}

const runtime = loadRuntime();
(selfTest ? runSelfTest(runtime) : runBridge(runtime)).catch((error) => {
  fail(
    `Cannot reach Echo at 127.0.0.1:${runtime.port}: ${sanitized(error)}. ` +
      "Keep Echo running, then reconnect or restart Claude Desktop.",
  );
});
