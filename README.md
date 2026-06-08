# WellMarked MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[WellMarked.io](https://wellmarked.io) — give your AI agents the ability to turn
any URL into clean Markdown, bulk-extract batches of pages, and crawl entire
sites, all from inside Claude Desktop, Claude Code, Cursor, or any MCP host.

It's a thin adapter over the official [`wellmarked`](https://www.npmjs.com/package/wellmarked)
JavaScript SDK, so it inherits the SDK's auth, typed errors, retry/back-off
hints, and polymorphic job polling.

## Tools

| Tool | What it does |
| --- | --- |
| `extract` | Fetch one URL and return its main content as clean Markdown + metadata. |
| `bulk` | Submit many URLs for concurrent extraction (Pro+). Blocks for results by default. |
| `crawl` | Crawl a site BFS from a root URL to a given depth (Pro+). Returns an async job. |
| `get_job` | Poll a bulk/crawl job once by id. |
| `wait_for_job` | Block until a job finishes, then return all results. |
| `get_usage` | Report current billing-period quota (plan, used, limit, remaining). |

> **Not exposed as tools:** API-key rotation (`/keys/rotate`) and webhook-secret
> rotation (`/webhook/rotate`). Both are destructive and irreversible — the old
> credential dies the instant the call returns, with no recovery flow — which is
> the wrong shape for an autonomous agent. Rotate from the dashboard or the SDK.

## Setup

You need a WellMarked API key (`wm_...`) — generate one at
[wellmarked.io](https://wellmarked.io).

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "wellmarked": {
      "command": "npx",
      "args": ["-y", "wellmarked-mcp"],
      "env": {
        "WELLMARKED_API_KEY": "wm_your_key_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add wellmarked --env WELLMARKED_API_KEY=wm_your_key_here -- npx -y wellmarked-mcp
```

### Cursor / other MCP hosts

Any host that launches MCP servers over stdio works — point it at
`npx -y wellmarked-mcp` with `WELLMARKED_API_KEY` in the environment.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `WELLMARKED_API_KEY` | yes | Your `wm_...` API key. |
| `WELLMARKED_BASE_URL` | no | Override the API base URL (self-hosted instances). |
| `WELLMARKED_TIMEOUT_MS` | no | Per-request timeout in ms (default `30000`). |

## Develop locally

```bash
npm install
npm run build        # compile TypeScript to dist/
npm start            # run the compiled server on stdio

# Inspect it interactively with the MCP Inspector:
WELLMARKED_API_KEY=wm_... npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT — see [LICENSE](./LICENSE).
