// Smoke test: spawn the built server over stdio, complete the MCP handshake,
// list tools, and invoke get_usage to exercise the live error path.
// Run: node test/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath, // node
  args: ["dist/index.js"],
  env: { ...process.env, WELLMARKED_API_KEY: "wm_smoke_test_key" },
});

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);
console.log("✓ connected + initialized");

const { tools } = await client.listTools();
console.log(`✓ tools/list returned ${tools.length} tools:`);
for (const t of tools) {
  const keys = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`   - ${t.name}(${keys.join(", ")})`);
}

console.log("\nCalling get_usage (expect a 401 auth error from the live API):");
const res = await client.callTool({ name: "get_usage", arguments: {} });
console.log(`   isError=${res.isError === true}`);
console.log(`   text: ${res.content?.[0]?.text}`);

await client.close();
console.log("\n✓ smoke test complete");
