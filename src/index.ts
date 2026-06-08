#!/usr/bin/env node
/**
 * Entry point for the WellMarked MCP server.
 *
 * Speaks MCP over stdio — the transport every desktop/IDE MCP host uses to
 * launch a local server as a child process. Configure your host to run:
 *
 *     npx -y wellmarked-mcp
 *
 * with `WELLMARKED_API_KEY` set in the server's environment. See README.md
 * for ready-to-paste client configs.
 *
 * Environment:
 *   - WELLMARKED_API_KEY   (required) — your `wm_...` key.
 *   - WELLMARKED_BASE_URL  (optional) — override the API base URL.
 *   - WELLMARKED_TIMEOUT_MS(optional) — per-request timeout in ms.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

function resolveTimeout(): number | undefined {
  const raw = process.env.WELLMARKED_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  let server;
  try {
    server = createServer({
      apiKey: process.env.WELLMARKED_API_KEY,
      baseUrl: process.env.WELLMARKED_BASE_URL,
      timeoutMs: resolveTimeout(),
    });
  } catch (err) {
    // Almost always a missing API key. Write to stderr (stdout is the MCP
    // channel and must carry only protocol traffic) and exit non-zero so the
    // host surfaces the failure instead of hanging on a dead pipe.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[wellmarked-mcp] failed to start: ${message}\n`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connected. The process now lives until the host closes stdin; the MCP
  // SDK resolves the transport's close promise then, and Node exits when the
  // event loop drains. Nothing else to do here.
  process.stderr.write("[wellmarked-mcp] ready on stdio\n");
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[wellmarked-mcp] fatal: ${message}\n`);
  process.exit(1);
});
