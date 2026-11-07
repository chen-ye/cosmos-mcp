import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config";
import { createHttpHandler, parsePort, type HttpSessionHandler } from "../src/http";
import { SERVER_NAME, SERVER_VERSION } from "../src/server";
import { SIGNED_IN_ONLY_TOOLS, SIGNED_OUT_TOOLS } from "../src/tools/catalog";

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
    expect(tools.length).toBe(SIGNED_OUT_TOOLS.length + SIGNED_IN_ONLY_TOOLS.length);

    const whoami = await client.callTool({ name: "cosmos_whoami", arguments: {} });
    expect(whoami.isError).toBeUndefined();
    expect((whoami.structuredContent as { authenticated?: boolean })?.authenticated).toBe(false);

    await transport.terminateSession();
    await client.close();
    expect(handler.sessionCount()).toBe(0);
  });
});
