/**
 * Static fixture server for the end-to-end MCP tool test.
 *
 *   node scripts/fixture-server.mjs [port=18999]
 *
 * Serves `scripts/fixtures/` plus four routes the static files cannot provide:
 *   /slow?ms=N     delays N ms before answering
 *   /echo-headers  returns the request headers as JSON
 *   /status/404    answers 404
 *   /cookie-set    sets `fx=1; Path=/`
 *
 * Plain `node:http` and `node:fs` only, so the test suite needs no extra dependency.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PORT = Number(process.argv[2] ?? 18999);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

/** Resolves a URL path inside ROOT, or null when it escapes the fixtures directory. */
function resolveFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel === "" ? "index.html" : rel);
  const root = path.resolve(ROOT);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    send(res, 400, TYPES[".txt"], "Bad request");
    return;
  }

  if (url.pathname === "/slow") {
    const ms = Math.max(0, Math.min(20000, Number(url.searchParams.get("ms")) || 0));
    await sleep(ms);
    send(res, 200, TYPES[".html"], page("Slow route", `<h1>Slow route</h1><p>Waited ${ms}ms.</p>`));
    return;
  }

  if (url.pathname === "/echo-headers") {
    send(res, 200, TYPES[".json"], JSON.stringify(req.headers, null, 2));
    return;
  }

  if (url.pathname === "/status/404") {
    send(res, 404, TYPES[".html"], page("Not found", "<h1>404 Not Found</h1><p>Nothing here.</p>"));
    return;
  }

  if (url.pathname === "/cookie-set") {
    send(res, 200, TYPES[".html"], page("Cookie set", "<h1>Cookie set</h1><p>fx=1 is on this origin.</p>"), {
      "Set-Cookie": "fx=1; Path=/",
    });
    return;
  }

  const file = resolveFile(url.pathname);
  if (!file) {
    send(res, 403, TYPES[".txt"], "Forbidden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      send(res, 404, TYPES[".html"], page("Not found", `<h1>404 Not Found</h1><p>${url.pathname}</p>`));
      return;
    }
    send(res, 200, TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", data);
  });
});

server.on("error", (error) => {
  console.error(`fixture-server: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`fixture-server listening on http://${HOST}:${PORT}`);
});
