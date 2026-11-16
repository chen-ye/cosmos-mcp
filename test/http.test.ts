import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config";
import { createHttpHandler, parsePort, type HttpSessionHandler } from "../src/http";
import { SERVER_NAME, SERVER_VERSION } from "../src/server";
import { RESTRICTED_TOOLS, SIGNED_IN_ONLY_TOOLS, SIGNED_OUT_TOOLS } from "../src/tools/catalog";
import { CosmosClient } from "../src/graphql/client";
import { writeAuth } from "../src/auth-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const handlers: HttpSessionHandler[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

function testHandler(): HttpSessionHandler {
  const handler = createHttpHandler({
    ...loadConfig({}),
    cookie: undefined,
    authorization: undefined,
    userId: undefined,
  });
  handlers.push(handler);
  return handler;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await s.stop(true);
  }
  for (const h of handlers.splice(0)) {
    await h.close();
  }
});

describe("parsePort", () => {
  test("defaults to 3000 when unset or blank", () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort("")).toBe(3000);
    expect(parsePort("   ")).toBe(3000);
  });

  test("parses valid TCP port numbers", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  test("rejects non-integers and out-of-range ports", () => {
    expect(() => parsePort("0")).toThrow(/PORT/);
    expect(() => parsePort("65536")).toThrow(/PORT/);
    expect(() => parsePort("-1")).toThrow(/PORT/);
    expect(() => parsePort("abc")).toThrow(/PORT/);
  });
});

describe("createHttpHandler", () => {
  test("GET /health reports server readiness", async () => {
    const handler = testHandler();
    const res = await handler.fetch(new Request("http://127.0.0.1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  test("POST /health returns 405", async () => {
    const handler = testHandler();
    const res = await handler.fetch(new Request("http://127.0.0.1/health", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("unknown path returns 404", async () => {
    const handler = testHandler();
    const res = await handler.fetch(new Request("http://127.0.0.1/unknown"));
    expect(res.status).toBe(404);
  });

  test("GET /mcp without Mcp-Session-Id returns 400", async () => {
    const handler = testHandler();
    const res = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /mcp with unknown Mcp-Session-Id returns 404", async () => {
    const handler = testHandler();
    const res = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "nonexistent-session",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PUT /mcp returns 405", async () => {
    const handler = testHandler();
    const res = await handler.fetch(new Request("http://127.0.0.1/mcp", { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  test("completes full Streamable HTTP session lifecycle with MCP client", async () => {
    const handler = testHandler();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => handler.fetch(req),
    });
    servers.push(server);

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
    );
    const client = new Client({ name: "http-test", version: "0.1.0" });

    expect(handler.sessionCount()).toBe(0);
    await client.connect(transport);
    expect(handler.sessionCount()).toBe(1);
    expect(transport.sessionId).toBeTruthy();

    const { tools } = await client.listTools();
    expect(tools.length).toBe(SIGNED_OUT_TOOLS.length + SIGNED_IN_ONLY_TOOLS.length + RESTRICTED_TOOLS.length);

    const whoami = await client.callTool({ name: "cosmos_whoami", arguments: {} });
    expect(whoami.isError).toBeUndefined();
    expect((whoami.structuredContent as { authenticated?: boolean })?.authenticated).toBe(false);

    await transport.terminateSession();
    await client.close();
    expect(handler.sessionCount()).toBe(0);
  });

  test("CosmosClient picks up refreshed config.json credentials without recreating the HTTP handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosmos-http-reload-"));
    const realFetch = globalThis.fetch;
    try {
      const env: NodeJS.ProcessEnv = {
        XDG_CONFIG_HOME: dir,
        COSMOS_AUTHORIZATION: "",
        COSMOS_COOKIE: "",
        COSMOS_USER_ID: "",
      };
      writeAuth({ authorization: "Bearer old-token" }, env);
      const client = new CosmosClient(loadConfig(env), () => loadConfig(env));
      const handler = createHttpHandler(client.config, client);
      handlers.push(handler);

      const seenAuth: (string | null)[] = [];
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        if (!String(input).includes("api.cosmos.so")) {
          return realFetch(input, init);
        }
        const headers = init?.headers as Record<string, string>;
        seenAuth.push(headers.authorization ?? null);
        if (headers.authorization === "Bearer old-token") {
          return Response.json(
            { errors: [{ message: "expired", extensions: { code: "AUTHENTICATION" } }] },
            { status: 401 },
          );
        }
        return Response.json({
          data: {
            me: { id: 42, username: "refreshed" },
            userClusters: { meta: { count: 2 } },
            allElementsV2: { meta: { count: 9 } },
          },
        });
      }) as typeof fetch;

      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler.fetch(req) });
      servers.push(server);

      const mcp = new Client({ name: "reload-test", version: "0.1.0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));

      const first = await mcp.callTool({ name: "cosmos_whoami", arguments: {} });
      expect((first.structuredContent as { authenticated?: boolean })?.authenticated).toBe(false);

      // Refresh credential on disk (as `cosmos-mcp login` does in the config volume,
      // including persisted userId/username metadata).
      writeAuth({ authorization: "Bearer fresh-token", userId: 42, username: "refreshed" }, env);

      const second = await mcp.callTool({ name: "cosmos_whoami", arguments: {} });
      const secondPayload = second.structuredContent as { authenticated?: boolean; viewer?: { username?: string } };
      expect(secondPayload.authenticated).toBe(true);
      expect(secondPayload.viewer?.username).toBe("refreshed");
      expect(seenAuth).toContain("Bearer old-token");
      expect(seenAuth).toContain("Bearer fresh-token");

      await mcp.close();
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
