import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type CosmosConfig } from "./config";
import { CosmosClient } from "./graphql/client";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;

export interface HttpSessionHandler {
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
  sessionCount(): number;
}

interface ActiveSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HTTP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
    { status, headers },
  );
}

/**
 * Stateful MCP Streamable HTTP handler.
 *
 * Exposes `/mcp` (`POST`, `GET`, `DELETE`) per the MCP Streamable HTTP
 * specification and `/health` (`GET`, `HEAD`) for container health probes.
 * All sessions share one `CosmosClient` so viewer identity lookups stay cached.
 */
export function createHttpHandler(
  config: CosmosConfig = loadConfig(),
  client: CosmosClient = new CosmosClient(config),
): HttpSessionHandler {
  const sessions = new Map<string, ActiveSession>();

  async function handleMcp(req: Request): Promise<Response> {
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "GET, POST, DELETE" });
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return jsonRpcError(404, -32001, "Session not found");
      }
      return existing.transport.handleRequest(req);
    }

    if (req.method !== "POST") {
      return jsonRpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required");
    }

    const server = createServer(config, client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    const response = await transport.handleRequest(req);
    if (!transport.sessionId) {
      await server.close();
    }
    return response;
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        }
        return Response.json({
          status: "ok",
          name: SERVER_NAME,
          version: SERVER_VERSION,
        });
      }

      if (url.pathname === "/mcp") {
        return handleMcp(req);
      }

      return Response.json({ error: "Not Found" }, { status: 404 });
    },

    async close(): Promise<void> {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map(({ server }) => server.close()));
    },

    sessionCount(): number {
      return sessions.size;
    },
  };
}

export async function serveHttp(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const hostname = env.HOST?.trim() || DEFAULT_HTTP_HOST;
  const port = parsePort(env.PORT);
  const handler = createHttpHandler(config);

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 255,
    fetch: (req) => handler.fetch(req),
  });

  process.stderr.write(`cosmos-mcp ready on http://${server.hostname}:${server.port}/mcp\n`);

  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

  await handler.close();
  await server.stop(true);
  return 0;
}
