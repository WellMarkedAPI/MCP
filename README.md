# WellMarked MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[WellMarked.io](https://wellmarked.io) — give your AI agents the ability to turn
any URL into clean Markdown, bulk-extract batches of pages, crawl entire sites,
and search the web, all from inside Claude Desktop, Claude Code, Cursor, or any
MCP host.

It's a thin adapter over the official [`wellmarked`](https://www.npmjs.com/package/wellmarked)
JavaScript SDK, so it inherits the SDK's auth, typed errors, retry/back-off
hints, and polymorphic job polling.

## Tools

| Tool | What it does |
| --- | --- |
| `extract` | Fetch one URL and return its main content as clean Markdown + metadata. |
| `bulk` | Submit many URLs for concurrent extraction (Pro+). Blocks for results by default. |
| `crawl` | Crawl a site BFS from a root URL to a given depth (Pro+). Returns an async job. |
| `search` | Search the web and return each result page as clean Markdown, in one call. Available on every plan; the plan caps the result count (Free 5 · Pro 10 · Growth 50 · Enterprise uncapped). |
| `get_job` | Poll a bulk/crawl job once by id. |
| `wait_for_job` | Block until a job finishes, then return all results. |
| `get_usage` | Report current billing-period quota (plan, used, limit, remaining). |

`extract`, `bulk`, `crawl`, and `search` all accept a `format`
(`markdown` / `json` / `chunks` / `html` / `links`) and per-request compliance
overrides (`allow_domains` / `deny_patterns` / `respect_robots`); `extract`,
`bulk`, and `crawl` also accept a `retry` count for target timeouts, and
`crawl` a `max_pages` budget.

### Structured output

Every tool returns its payload as JSON in the result's text block. An agent
reads `status`, `completed`, `ok`, or `tokensSaved` as real fields instead of
pattern-matching them out of a rendered sentence:

```json
{
  "kind": "crawl",
  "jobId": "job_abc",
  "status": "done",
  "total": 12,
  "completed": 12,
  "done": true,
  "truncated": false,
  "results": [
    { "url": "https://example.com/a", "depth": 1, "ok": true, "markdown": "# A" },
    { "url": "https://example.com/b", "depth": 1, "ok": false, "error": "target_timeout" }
  ]
}
```

There is no prose rendering of the result. A payload made of key-value pairs
travels as key-value pairs, and flattening it into a document is exactly the
parsing burden this server exists to remove.

The payload rides in `content`, and is deliberately **not** duplicated into
`structuredContent`. Hosts surface `content` to the model and several ignore
`structuredContent` entirely, so a payload sent only there is invisible to the
agent; sending it in both places doubles the tokens on every response.

JSON-as-text is also the most structured shape `content` can carry. MCP content
blocks are a closed set — `text`, `image`, `audio`, `resource_link`,
`resource` — and none of them holds a raw object. An off-spec block type such
as `application/json` fails schema validation in the client and kills the whole
call, so it is not an option.

Errors are the exception and carry real text — a failure has no typed shape
beyond the API's stable error `code`, which is already in the message.

> **Not exposed as tools:** API-key rotation (`/keys/rotate`) and webhook-secret
> rotation (`/webhook/rotate`). Both are destructive and irreversible — the old
> credential dies the instant the call returns, with no recovery flow — which is
> the wrong shape for an autonomous agent. Rotate from the dashboard or the SDK.

## Setup

There are two ways to connect, depending on your host:

- **Remote (hosted, OAuth)** — for Claude.ai and other hosts that support
  remote MCP servers. No API key to copy; you sign in and authorize in the
  browser. See [Remote server](#remote-server-hosted--oauth) below.
- **Local (stdio, API key)** — for Claude Desktop, Claude Code, Cursor, and any
  host that launches a local server. You supply a `wm_...` key via the
  environment. Generate one at [wellmarked.io](https://wellmarked.io).

### Remote server (hosted — OAuth)

Add WellMarked as a **custom connector** and point it at:

```
https://mcp.wellmarked.io/mcp
```

Your host discovers the authorization server automatically (via
`/.well-known/oauth-protected-resource`), walks you through signing in to
WellMarked and approving the connection, and receives a scoped, expiring token —
no key to paste. The connector can `extract`, `bulk`, `crawl`, and `search`; it
cannot mint or rotate credentials.

In **Claude.ai**: Settings → Connectors → Add custom connector → paste the URL
above → follow the sign-in and consent prompts.

The remote server speaks MCP over Streamable HTTP and, under the hood, calls the
same tools as the local server — the tool surface is identical (enforced by the
parity test in `test/`).

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

Local (stdio) server:

| Variable | Required | Description |
| --- | --- | --- |
| `WELLMARKED_API_KEY` | yes | Your `wm_...` API key. |
| `WELLMARKED_TIMEOUT_MS` | no | Per-request timeout in ms (default `30000`). |

Remote (Streamable HTTP) server — only if you self-host it (`npm run start:http`):

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no | Listen port (default `3000`; Railway sets it). |
| `MCP_PUBLIC_URL` | no | This server's public URL, used in the protected-resource metadata. Derived from the request Host if unset. |
| `WELLMARKED_TIMEOUT_MS` | no | Per-request timeout in ms. |

The remote server takes **no** `WELLMARKED_API_KEY` — each request authenticates
with its own OAuth bearer token.

## Develop locally

```bash
npm install
npm run build        # compile TypeScript to dist/
npm start            # run the compiled server on stdio
npm run start:http   # OR run the remote (Streamable HTTP) server
npm test             # tool-list parity across both entry points

# Inspect the stdio server interactively with the MCP Inspector:
WELLMARKED_API_KEY=wm_... npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT — see [LICENSE](./LICENSE).
