/**
 * WellMarked MCP server.
 *
 * Exposes the WellMarked API to MCP-speaking AI agents (Claude Desktop,
 * Claude Code, Cursor, etc.) as a set of tools. This is a thin adapter on
 * top of the official `wellmarked` JavaScript SDK — the SDK owns auth,
 * transport, retries, typed errors, and polymorphic job polling, so this
 * layer only translates MCP tool calls into SDK calls and renders the
 * results back as agent-readable text.
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
  type ExtractResult,
  type Usage,
} from "wellmarked";

import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/** Text-only tool result helpers. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
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

/** `Date | null` → ISO string or "—". */
function iso(d: Date | null): string {
  return d ? d.toISOString() : "—";
}

// ── Renderers ─────────────────────────────────────────────────────────────────
// Render SDK objects as text an LLM can consume directly: the Markdown is the
// payload the agent actually wants, so it goes in verbatim, with a compact
// metadata header for context.

function renderExtract(r: ExtractResult): string {
  const m = r.metadata;
  const header = [
    `URL: ${m.url}`,
    m.title ? `Title: ${m.title}` : null,
    m.author ? `Author: ${m.author}` : null,
    m.date ? `Published: ${m.date}` : null,
    `Retrieved: ${iso(m.retrievedAt)}`,
    `Request ID: ${r.requestId}`,
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n---\n\n${r.markdown}`;
}

function renderJob(job: BulkJob | CrawlJob): string {
  const lines: string[] = [];
  lines.push(
    `Job ${job.jobId} [${job.kind}] — status: ${job.status} ` +
      `(${job.completed}/${job.total})`,
  );
  lines.push(`Created: ${iso(job.createdAt)} | Finished: ${iso(job.finishedAt)}`);
  if (job.kind === "crawl" && job.truncated) {
    lines.push(`⚠ Truncated: ${job.truncatedReason ?? "unknown reason"}`);
  }
  if (job.webhookSigningSecret) {
    lines.push(
      `Webhook signing secret (shown ONCE — store it now): ` +
        `${job.webhookSigningSecret}`,
    );
  }

  if (job.results.length === 0) {
    lines.push("");
    lines.push(
      job.done
        ? "(no results)"
        : "(no results yet — job still running; poll get_job or use wait_for_job)",
    );
    return lines.join("\n");
  }

  for (const item of job.results) {
    lines.push("");
    const depth =
      "depth" in item ? `  (depth ${(item as { depth: number }).depth})` : "";
    const flag = item.ok ? "✓" : `✗ error: ${item.error ?? "unknown"}`;
    lines.push(`## ${item.url}${depth}  ${flag}`);
    if (item.ok && item.markdown) {
      lines.push("");
      lines.push(item.markdown);
    }
  }
  return lines.join("\n");
}

function renderUsage(u: Usage): string {
  const pct = u.limit > 0 ? Math.round((u.used / u.limit) * 100) : 0;
  return [
    `Plan: ${u.plan}`,
    `Period: ${u.period}`,
    `Used: ${u.used} / ${u.limit} (${pct}%)`,
    `Remaining: ${u.remaining}`,
  ].join("\n");
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
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ url, render_js }) => {
      try {
        const result = await client.extract(url, { renderJs: render_js });
        return ok(renderExtract(result));
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
        "Requires a Pro+ plan (Pro caps at 50 URLs per request).",
      inputSchema: {
        urls: z
          .array(z.string().url())
          .min(1)
          .describe("One or more absolute http(s) URLs to extract."),
        render_js: z
          .boolean()
          .optional()
          .describe("Render JavaScript before extracting each page. Default false."),
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
      },
      annotations: { openWorldHint: true },
    },
    async ({ urls, render_js, wait, wait_timeout_ms }) => {
      try {
        let job = await client.bulk(urls, { renderJs: render_js });
        if (wait !== false) {
          job = (await client.waitForJob(job.jobId, {
            timeoutMs: wait_timeout_ms ?? 300_000,
          })) as BulkJob;
        }
        return ok(renderJob(job));
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
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, depth, render_js, wait, wait_timeout_ms }) => {
      try {
        let job: BulkJob | CrawlJob = await client.crawl(url, {
          depth,
          renderJs: render_js,
        });
        if (wait === true) {
          job = await client.waitForJob(job.jobId, {
            timeoutMs: wait_timeout_ms ?? 300_000,
          });
        }
        return ok(renderJob(job));
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
        return ok(renderJob(job));
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
        return ok(renderJob(job));
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
        return ok(renderUsage(usage));
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  return server;
}
