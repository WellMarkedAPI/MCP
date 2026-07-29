/**
 * WellMarked MCP server.
 *
 * Exposes the WellMarked API to MCP-speaking AI agents (Claude Desktop,
 * Claude Code, Cursor, etc.) as a set of tools. This is a thin adapter on
 * top of the official `wellmarked` JavaScript SDK — the SDK owns auth,
 * transport, retries, typed errors, and polymorphic job polling, so this
 * layer only translates MCP tool calls into SDK calls and hands the results
 * back to the agent.
 *
 * Every tool returns its payload as JSON in the result's text block, so an
 * agent reads fields off directly (`status`, `completed`, `ok`, `tokensSaved`)
 * instead of pattern-matching them out of a rendered sentence — see `ok()`.
 *
 * Tools:
 *   - extract        — one URL → clean Markdown.
 *   - bulk           — many URLs → an async job.
 *   - crawl          — crawl a site from a root URL → an async job.
 *   - get_job        — poll a bulk/crawl job once.
 *   - wait_for_job   — block until a job finishes (or times out).
 *   - get_usage      — current billing-period quota state.
 *
 * The credential-rotation endpoints (`POST /keys/rotate`,
 * `POST /webhook/rotate`) are intentionally NOT exposed as tools: they are
 * destructive and irreversible (the previous secret dies the instant the
 * call returns, with no recovery flow), which is the wrong shape for an
 * autonomous agent to invoke. Rotate keys from the dashboard or the SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  WellMarked,
  WellMarkedError,
  type WellMarkedOptions,
  type BulkJob,
  type CrawlJob,
} from "wellmarked";

import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * Tool result helpers.
 *
 * A success carries the payload ONCE, as JSON in the text block.
 *
 * It deliberately does NOT go in `structuredContent`. Hosts surface `content`
 * to the model and several ignore `structuredContent` entirely, so a payload
 * sent only there is invisible to the agent; sending it in both places just
 * doubles the tokens on every response.
 *
 * JSON-as-text is also the most structured shape `content` can hold. MCP's
 * `ContentBlockSchema` is a closed union — text | image | audio |
 * resource_link | resource — so no block type carries a raw object, and an
 * off-spec `type` (e.g. "application/json") fails that union in the client
 * and kills the whole call.
 *
 * `JSON.stringify` handles the SDK's shapes directly: `Date` fields
 * (`createdAt`, `finishedAt`, `retrievedAt`) serialize to ISO strings, and the
 * SDK's computed fields (`ok`, `done`) are object-literal getters, i.e. own
 * enumerable properties, so they materialize as plain booleans.
 *
 * Errors stay prose: a failure has no shape beyond the code already in the
 * message.
 */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Translate any throwable from an SDK call into an `isError` tool result.
 *
 * `WellMarkedError` (and its subclasses) carry a stable `code`, the HTTP
 * `statusCode`, and — on 429s — a `retryAfter`. We surface all of them so
 * the agent can decide whether to back off, upgrade the plan, fix the URL,
 * or give up, rather than just seeing a opaque stack trace.
 */
function toErrorResult(err: unknown): ToolResult {
  if (err instanceof WellMarkedError) {
    const parts: string[] = [`WellMarked API error: ${err.message}`];
    if (err.code) parts.push(`code=${err.code}`);
    if (err.statusCode !== undefined) parts.push(`status=${err.statusCode}`);
    if (err.retryAfter !== undefined) {
      parts.push(`retry_after=${err.retryAfter}s`);
    }
    if (err.retryAfterMs !== undefined) {
      parts.push(`retry_after_ms=${err.retryAfterMs}`);
    }
    return fail(parts.join(" | "));
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail(`Unexpected error: ${message}`);
}

// ── Compliance overrides ────────────────────────────────────────────────────
// Shared across extract / bulk / crawl. These can only NARROW the API key's own
// policy server-side (add denies, restrict domains, upgrade robots to strict),
// never widen it — so exposing them to an agent is safe.
const policyInputSchema = {
  allow_domains: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict this request to these domains (and their subdomains). Can only " +
        "narrow the key's own allow-list, never widen it.",
    ),
  deny_patterns: z
    .array(z.string())
    .optional()
    .describe(
      "Extra deny globs for this request, matched against the hostname and the " +
        "full URL. Added to the key's deny list.",
    ),
  respect_robots: z
    .enum(["strict", "lax"])
    .optional()
    .describe(
      "'strict' honors robots.txt on this request (extract/bulk too, not just " +
        "crawl); can tighten the key's setting but never loosen it.",
    ),
};

// ── Output format ───────────────────────────────────────────────────────────
// Shared across extract / bulk / crawl. Kept off `search`, which always returns
// markdown — search hands an agent N pages to read, and the other formats serve
// pipelines that already know which URL they want.
const formatInputSchema = {
  format: z
    .enum(["markdown", "json", "chunks", "html", "links"])
    .optional()
    .describe(
      "Output format. 'markdown' (default) is clean prose; 'json' returns typed " +
        "heading/paragraph/list/code blocks; 'chunks' returns contiguous " +
        "500-token windows ready for embedding; 'html' returns the raw fetched " +
        "HTML; 'links' returns every http(s) link on the page. 'json' and " +
        "'chunks' require a Pro, Growth, or Enterprise plan.",
    ),
};

// ── Timeout retries ─────────────────────────────────────────────────────────
// Shared across extract / bulk / crawl. Kept off `search`: its 15s per-result
// deadline can't absorb a retry, so the API doesn't take one there.
const retryInputSchema = {
  retry: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Server-side re-attempts when the target times out, each on a fresh " +
        "connection. Default 0 (one attempt). On the synchronous extract " +
        "each timed-out attempt takes 20-30s, so prefer bulk for aggressive " +
        "values.",
    ),
};

interface PolicyToolArgs {
  allow_domains?: string[];
  deny_patterns?: string[];
  respect_robots?: "strict" | "lax";
}

/** Map the snake_case tool args to the SDK's camelCase policy options. Unset
 * fields stay undefined; the SDK omits them so the key's policy is untouched. */
function toPolicyOptions(a: PolicyToolArgs): {
  allowDomains?: string[];
  denyPatterns?: string[];
  respectRobots?: "strict" | "lax";
} {
  return {
    allowDomains: a.allow_domains,
    denyPatterns: a.deny_patterns,
    respectRobots: a.respect_robots,
  };
}

/**
 * Build a configured MCP server. The `WellMarked` client is created once and
 * shared across all tool invocations for the life of the process.
 *
 * Throws (via the SDK) if no API key is resolvable — callers (index.ts)
 * catch this to print a friendly setup hint before exiting.
 */
export function createServer(options: WellMarkedOptions = {}): McpServer {
  const client = new WellMarked(options);

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ── extract ──────────────────────────────────────────────────────────────
  server.registerTool(
    "extract",
    {
      title: "Extract Markdown from a URL",
      description:
        "Fetch a single web page and return its main content as clean " +
        "Markdown, stripped of nav, ads, and boilerplate. Use this to read " +
        "an article, doc page, or any URL the user references. Returns the " +
        "Markdown plus metadata (title, author, published date).",
      inputSchema: {
        url: z.string().url().describe("The absolute http(s) URL to extract."),
        render_js: z
          .boolean()
          .optional()
          .describe(
            "Render JavaScript with a headless browser before extracting. " +
              "Needed for SPA / client-rendered pages. Requires a Pro+ plan " +
              "and the feature enabled on the API instance. Default false.",
          ),
        ...policyInputSchema,
        ...formatInputSchema,
        ...retryInputSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ url, render_js, format, retry, allow_domains, deny_patterns, respect_robots }) => {
      try {
        const result = await client.extract(url, {
          renderJs: render_js,
          format,
          retry,
          ...toPolicyOptions({ allow_domains, deny_patterns, respect_robots }),
        });
        return ok(result);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── bulk ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "bulk",
    {
      title: "Bulk-extract many URLs",
      description:
        "Submit a batch of URLs for concurrent extraction. Returns a job " +
        "that runs asynchronously. By default this blocks until the job " +
        "finishes and returns all results; set wait=false to return the " +
        "queued job id immediately and poll with get_job / wait_for_job. " +
        "Available on every plan; the plan caps URLs per job (Free 5, " +
        "Pro 50, Growth 200, Enterprise unlimited).",
      inputSchema: {
        urls: z
          .array(z.string().url())
          .min(1)
          .describe("One or more absolute http(s) URLs to extract."),
        render_js: z
          .boolean()
          .optional()
          .describe(
            "Render JavaScript before extracting each page. Requires a Pro+ " +
              "plan, even though bulk itself does not. Default false.",
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Block until the job finishes and return all results. " +
              "Default true. Set false to return the queued job id at once.",
          ),
        wait_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max ms to wait when wait=true. Default 300000 (5 min)."),
        ...policyInputSchema,
        ...formatInputSchema,
        ...retryInputSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ urls, render_js, format, retry, wait, wait_timeout_ms, allow_domains, deny_patterns, respect_robots }) => {
      try {
        let job = await client.bulk(urls, {
          renderJs: render_js,
          format,
          retry,
          ...toPolicyOptions({ allow_domains, deny_patterns, respect_robots }),
        });
        if (wait !== false) {
          job = (await client.waitForJob(job.jobId, {
            timeoutMs: wait_timeout_ms ?? 300_000,
          })) as BulkJob;
        }
        return ok(job);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── crawl ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "crawl",
    {
      title: "Crawl a site",
      description:
        "Crawl a website starting from a root URL, following links " +
        "breadth-first up to the given depth, and extract every page to " +
        "Markdown. Returns an async job. Crawls can be long-running, so " +
        "this returns the queued job id immediately by default — poll with " +
        "get_job or block with wait_for_job. Requires a Pro+ plan (Pro caps " +
        "depth at 5 and 2,000 pages).",
      inputSchema: {
        url: z.string().url().describe("Root absolute http(s) URL to crawl from."),
        depth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("BFS depth from the root. Default 1. Must be >= 0."),
        render_js: z
          .boolean()
          .optional()
          .describe("Render JavaScript before extracting each page. Default false."),
        wait: z
          .boolean()
          .optional()
          .describe(
            "Block until the crawl finishes and return all pages. " +
              "Default false — crawls can take minutes. Use get_job to poll.",
          ),
        wait_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max ms to wait when wait=true. Default 300000 (5 min)."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Stop the crawl after this many successful pages. Can only " +
              "narrow the plan's page cap, never widen it.",
          ),
        ...policyInputSchema,
        ...formatInputSchema,
        ...retryInputSchema,
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, depth, render_js, format, retry, max_pages, wait, wait_timeout_ms, allow_domains, deny_patterns, respect_robots }) => {
      try {
        let job: BulkJob | CrawlJob = await client.crawl(url, {
          depth,
          renderJs: render_js,
          format,
          retry,
          maxPages: max_pages,
          ...toPolicyOptions({ allow_domains, deny_patterns, respect_robots }),
        });
        if (wait === true) {
          job = await client.waitForJob(job.jobId, {
            timeoutMs: wait_timeout_ms ?? 300_000,
          });
        }
        return ok(job);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── search ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "search",
    {
      title: "Search the web and extract the results",
      description:
        "Search the web for a query and get each result page back as clean " +
        "Markdown — search plus extraction in one synchronous call, no job to " +
        "poll. Use this to answer a question from the live web when you don't " +
        "already have the URLs. Returns up to num_results pages, each with a " +
        "status (a slow or blocked page comes back as an error item, not a " +
        "failure of the whole call). Available on every plan.",
      inputSchema: {
        query: z.string().min(1).describe("The search query."),
        num_results: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "How many results to fetch + extract. Default 5. The ceiling is " +
              "set by your plan (Free 5, Pro 10, Growth 50, Enterprise " +
              "uncapped); asking for more returns search_cap_exceeded.",
          ),
        render_js: z
          .boolean()
          .optional()
          .describe(
            "Render JavaScript on each result page before extracting. " +
              "Requires a Pro+ plan, even though search itself does not. " +
              "Default false.",
          ),
        ...policyInputSchema,
        ...formatInputSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, num_results, render_js, format, allow_domains, deny_patterns, respect_robots }) => {
      try {
        const res = await client.search(query, {
          numResults: num_results,
          renderJs: render_js,
          format,
          ...toPolicyOptions({ allow_domains, deny_patterns, respect_robots }),
        });
        return ok(res);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── get_job ──────────────────────────────────────────────────────────────
  server.registerTool(
    "get_job",
    {
      title: "Poll a bulk/crawl job",
      description:
        "Fetch the current status and any available results of a bulk or " +
        "crawl job by id. Works for both job kinds. Jobs are retained for " +
        "6 hours after they finish.",
      inputSchema: {
        job_id: z.string().describe("The job id returned by bulk or crawl."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ job_id }) => {
      try {
        const job = await client.getJob(job_id);
        return ok(job);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── wait_for_job ───────────────────────────────────────────────────────────
  server.registerTool(
    "wait_for_job",
    {
      title: "Wait for a job to finish",
      description:
        "Block until a bulk or crawl job reaches status=done (or the " +
        "timeout elapses), then return all results. Use after crawl() or " +
        "bulk(wait=false) when you want the finished output in one " +
        "call instead of polling get_job in a loop.",
      inputSchema: {
        job_id: z.string().describe("The job id to wait on."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max ms to wait before giving up. Default 300000 (5 min)."),
        poll_interval_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Ms between status polls. Default 2000."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id, timeout_ms, poll_interval_ms }) => {
      try {
        const job = await client.waitForJob(job_id, {
          timeoutMs: timeout_ms ?? 300_000,
          pollIntervalMs: poll_interval_ms ?? 2_000,
        });
        return ok(job);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  // ── get_usage ──────────────────────────────────────────────────────────────
  server.registerTool(
    "get_usage",
    {
      title: "Check API usage / quota",
      description:
        "Return the account's request usage for the current billing period: " +
        "plan, period, used, limit, and remaining. Does not count against " +
        "the quota. Check this before a large bulk or crawl to avoid " +
        "hitting the monthly limit mid-job.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const usage = await client.getUsage();
        return ok(usage);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  return server;
}
