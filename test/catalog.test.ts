import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { loadConfig } from "../src/config";
import { BETTER_SIGNED_IN, RESTRICTED_TOOLS, SIGNED_IN_ONLY_TOOLS, SIGNED_OUT_TOOLS } from "../src/tools/catalog";

/**
 * `cosmos_whoami` tells an agent which tools it can use before signing in. That
 * claim is only as good as the catalog behind it, and the catalog is hand-kept.
 * These tests fail the moment it drifts from what the server actually registers.
 */
async function registeredToolNames(): Promise<string[]> {
  // Ignore any real credential in the environment; this is a static check.
  const server = createServer({ ...loadConfig({}), cookie: undefined, authorization: undefined });
  const client = new Client({ name: "catalog-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();

  return tools.map((t) => t.name).sort();
}

test("every registered tool is classified in the catalog", async () => {
  const registered = await registeredToolNames();
  const classified = new Set<string>([...SIGNED_OUT_TOOLS, ...SIGNED_IN_ONLY_TOOLS, ...RESTRICTED_TOOLS]);

  const unclassified = registered.filter((name) => !classified.has(name));
  expect(unclassified).toEqual([]);
});

test("every catalog entry is a tool the server actually registers", async () => {
  const registered = new Set(await registeredToolNames());

  const phantom = [...SIGNED_OUT_TOOLS, ...SIGNED_IN_ONLY_TOOLS, ...RESTRICTED_TOOLS, ...BETTER_SIGNED_IN].filter(
    (name) => !registered.has(name),
  );
  expect(phantom).toEqual([]);
});

test("no tool appears in more than one catalog bucket", () => {
  const signedOut = new Set<string>(SIGNED_OUT_TOOLS);
  const signedIn = new Set<string>(SIGNED_IN_ONLY_TOOLS);
  const restricted = new Set<string>(RESTRICTED_TOOLS);
  expect(SIGNED_IN_ONLY_TOOLS.filter((name) => signedOut.has(name))).toEqual([]);
  expect(RESTRICTED_TOOLS.filter((name) => signedOut.has(name) || signedIn.has(name))).toEqual([]);
  expect(restricted.size).toBe(RESTRICTED_TOOLS.length);
});

test("tools that merely degrade signed out are listed as available, not gated", () => {
  const signedOut = new Set<string>(SIGNED_OUT_TOOLS);
  const gated = new Set<string>(SIGNED_IN_ONLY_TOOLS);

  for (const name of BETTER_SIGNED_IN) {
    expect(signedOut.has(name)).toBe(true);
    expect(gated.has(name)).toBe(false);
  }
});
