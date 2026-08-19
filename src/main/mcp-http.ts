import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_BIND, MCP_HOST, MCP_PORT_PREFERRED, MCP_PORT_SPAN, mcpUrl, mcpUrlForHost, setMcpPort } from "./paths";
import { lanIPv4s } from "./net";
import { mcpInstructions } from "./skill-tree";
import { dropMcpSession, mcpLiveStatus, noteMcpRequest } from "./mcp-sessions";

export function startMcpHttp(
  token: string,
  register: (server: McpServer) => void,
  version = "1.0.0",
): Promise<{ close: () => void; port: number }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `${MCP_HOST}:${MCP_PORT_PREFERRED}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (url.pathname === "/health") {
      const lan = lanIPv4s();
      const live = mcpLiveStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          mcp: "/mcp",
          name: "echo",
          version,
          clients: live.liveCount,
          urls: {
            local: mcpUrl(),
            lan: lan[0] ? mcpUrlForHost(lan[0]) : null,
            lanAll: lan.map((ip) => mcpUrlForHost(ip)),
          },
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    const sessionId = header(req, "mcp-session-id");
    if (sessionId && transports.has(sessionId)) {
      noteMcpRequest(sessionId, req);
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          noteMcpRequest(id, req);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          dropMcpSession(transport.sessionId);
        }
      };
      const server = new McpServer(
        { name: "echo", version },
        {
          capabilities: { tools: {}, resources: {}, prompts: {} },
          instructions: mcpInstructions(),
        },
      );
      register(server);
      server.server.oninitialized = () => {
        const id = transport.sessionId;
        noteMcpRequest(id, req, server.server.getClientVersion());
      };
      await server.connect(transport);
      await transport.handleRequest(req, res);
      noteMcpRequest(transport.sessionId, req, server.server.getClientVersion());
      return;
    }

    res.writeHead(400);
    res.end("Missing session. Send an initialize POST first.");
  }

  return new Promise((resolve, reject) => {
    const tryListen = (port: number): void => {
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("error", onError);
        if (err.code === "EADDRINUSE" && port < MCP_PORT_PREFERRED + MCP_PORT_SPAN - 1) {
          tryListen(port + 1);
          return;
        }
        reject(err);
      };
      httpServer.once("error", onError);
      httpServer.listen(port, MCP_BIND, () => {
        httpServer.off("error", onError);
        setMcpPort(port);
        resolve({
          close: () => {
            httpServer.close();
            for (const t of transports.values()) void t.close();
          },
          port,
        });
      });
    };
    tryListen(MCP_PORT_PREFERRED);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, Last-Event-ID, X-Echo-Client",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
