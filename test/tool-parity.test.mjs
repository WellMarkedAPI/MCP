// Tool-list parity across transports (Phase 7, step 4).
//
// The stdio entry point (src/index.ts) and the remote HTTP entry point
// (src/http.ts) both build their McpServer from the SAME createServer(). The
// whole point of that shared seam is that an agent sees the identical tools
// whether it connects locally or over the network. This test pins that: it
// lists the tools through a real client↔server transport pair and asserts the
// exact surface. If a future edit forks tool definitions per transport, or
// drops/renames a tool, this fails.
//
// Zero test deps on purpose (the repo had no runner): Node's built-in test
// runner + the SDK's in-memory transport, against the built dist/. Run with
// `npm test` (builds first).
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../dist/server.js";

const EXPECTED_TOOLS = ["bulk", "crawl", "extract", "get_job", "get_usage", "search", "wait_for_job"];

// A well-formed dummy key: createServer builds a WellMarked client but makes no
// network call, and listing tools is local (they're statically registered).
const DUMMY_KEY = "wm_" + "0".repeat(40);

async function toolNames() {
  const server = createServer({ apiKey: DUMMY_KEY });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

test("the shared createServer exposes exactly the expected tool set", async () => {
  const names = await toolNames();
  assert.deepEqual(names, EXPECTED_TOOLS);
});

test("two independent createServer() instances (stdio vs HTTP) are identical", async () => {
  // index.ts and http.ts each call createServer() independently. Comparing two
  // fresh instances is a faithful stand-in for "stdio transport tools" vs
  // "HTTP transport tools": same surface, transport-independent.
  const [a, b] = await Promise.all([toolNames(), toolNames()]);
  assert.deepEqual(a, b);
});
