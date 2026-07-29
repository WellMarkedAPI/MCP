// Structured tool output: every tool returns typed JSON, and ONLY typed JSON.
//
// The thing under test is the seam an agent actually consumes. Before this,
// `get_job` handed a model `status: running (12/50)` inside a sentence and the
// model had to pattern-match `status`, split `12/50`, and read `—` as null.
// Now the same call carries `structuredContent` with real JSON types, and the
// rendered prose is gone entirely — `content` is `[]` on every success, so
// there is no second, lossier copy of the payload for a model to read instead.
//
// The stub sits at `globalThis.fetch`, NOT at the client methods, so each test
// exercises the whole chain: canned API JSON → the real SDK parser (snake_case
// → camelCase, Date coercion, the computed `ok`/`done` getters) → jsonify →
// the MCP SDK's own output validation against the declared outputSchema.
// That last step is why a passing call is itself proof of schema conformance:
// McpServer.validateToolOutput throws if structuredContent is missing or fails
// the schema, and the throw surfaces as a rejected callTool.
//
// Zero test deps, matching test/tool-parity.test.mjs: Node's built-in runner
// and the SDK's in-memory transport, against the built dist/.
import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../dist/server.js";

const DUMMY_KEY = "wm_" + "0".repeat(40);

const META = {
  url: "https://example.com/a",
  title: "Hello",
  author: "Ada Lovelace",
  date: "2026-01-02",
  retrieved_at: "2026-01-03T04:05:06Z",
};

const METRICS = {
  content_bytes: 1024,
  input_tokens: 5000,
  output_tokens: 400,
  tokens_saved: 4600,
  reduction_pct: 92,
};

const EXTRACT_BODY = {
  markdown: "# Hello\n\nBody text.",
  metadata: META,
  metrics: METRICS,
  request_id: "req_123",
};

const BULK_BODY = {
  kind: "bulk",
  job_id: "job_abc",
  status: "done",
  total: 2,
  completed: 2,
  created_at: "2026-01-03T04:00:00Z",
  finished_at: "2026-01-03T04:00:30Z",
  results: [
    { url: "https://example.com/a", markdown: "# A", metadata: META, error: null },
    { url: "https://example.com/b", markdown: null, metadata: null, error: "target_timeout" },
  ],
};

const CRAWL_BODY = {
  kind: "crawl",
  job_id: "job_crawl",
  status: "done",
  total: 1,
  completed: 1,
  truncated: true,
  truncated_reason: "page_cap_reached",
  created_at: "2026-01-03T04:00:00Z",
  finished_at: "2026-01-03T04:01:00Z",
  results: [
    { url: "https://example.com/a", depth: 1, markdown: "# A", metadata: META, error: null },
  ],
};

const SEARCH_BODY = {
  query: "ada lovelace",
  request_id: "req_s1",
  results: [
    {
      url: "https://example.com/a",
      status: "ok",
      title: "Hello",
      snippet: "a snippet",
      markdown: "# A",
      metrics: METRICS,
    },
    {
      url: "https://example.com/b",
      status: "error",
      title: null,
      snippet: "another snippet",
      error: "target_timeout",
    },
  ],
};

const USAGE_BODY = { plan: "pro", period: "2026-01", used: 120, limit: 10000, remaining: 9880 };

/** Point globalThis.fetch at canned bodies keyed by "METHOD /path". */
function stubFetch(routes) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const { pathname } = new URL(String(url));
    const key = `${method} ${pathname}`;
    const entry = routes[key];
    if (entry === undefined) {
      throw new Error(`unstubbed request: ${key}`);
    }
    const { status = 200, body } = entry.body === undefined ? { body: entry } : entry;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = previous;
  };
}

/** Call one tool over a real client↔server transport pair. */
async function callTool(name, args = {}) {
  const server = createServer({ apiKey: DUMMY_KEY });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "structured-output-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

async function listTools() {
  const server = createServer({ apiKey: DUMMY_KEY });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "structured-output-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

// ── Discovery ────────────────────────────────────────────────────────────────

test("every tool advertises an outputSchema", async () => {
  const tools = await listTools();
  const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
  assert.deepEqual(missing, [], `tools without an outputSchema: ${missing.join(", ")}`);
  assert.equal(tools.length, 7);
});

test("the advertised job schema types the fields an agent branches on", async () => {
  const tools = await listTools();
  const props = tools.find((t) => t.name === "get_job").outputSchema.properties;
  assert.equal(props.status.type, "string");
  assert.deepEqual(props.status.enum, ["queued", "processing", "done"]);
  assert.equal(props.completed.type, "integer");
  assert.equal(props.total.type, "integer");
  assert.equal(props.done.type, "boolean");
});

test("no successful tool call returns a text block", async () => {
  // The whole point of the change: a result is key-value pairs, not a document.
  // Asserted across every tool rather than one, because a single `ok()` helper
  // is easy to bypass by hand-rolling a result in one handler.
  const cases = [
    ["extract", { url: "https://example.com/a" }, { "POST /extract": EXTRACT_BODY }],
    ["search", { query: "q" }, { "POST /search": SEARCH_BODY }],
    ["get_usage", {}, { "GET /usage": USAGE_BODY }],
    ["bulk", { urls: ["https://example.com/a"], wait: false }, { "POST /bulk": BULK_BODY }],
    ["crawl", { url: "https://example.com", depth: 1, wait: false }, { "POST /crawl": CRAWL_BODY }],
    ["get_job", { job_id: "job_abc" }, { "GET /jobs/job_abc": BULK_BODY }],
    ["wait_for_job", { job_id: "job_abc" }, { "GET /jobs/job_abc": BULK_BODY }],
  ];

  for (const [name, args, routes] of cases) {
    const restore = stubFetch(routes);
    try {
      const res = await callTool(name, args);
      assert.notEqual(res.isError, true, `${name} errored: ${res.content?.[0]?.text}`);
      assert.deepEqual(res.content, [], `${name} still returns a content block`);
      assert.ok(res.structuredContent, `${name} returned no structuredContent`);
      assert.equal(typeof res.structuredContent, "object");
    } finally {
      restore();
    }
  }
});

// ── Payloads ─────────────────────────────────────────────────────────────────

test("extract returns the payload as typed fields, with no text block", async () => {
  const restore = stubFetch({ "POST /extract": EXTRACT_BODY });
  try {
    const res = await callTool("extract", { url: "https://example.com/a" });
    const sc = res.structuredContent;

    assert.ok(sc, "extract must return structuredContent");
    assert.equal(sc.requestId, "req_123");
    assert.equal(sc.markdown, "# Hello\n\nBody text.");
    assert.equal(sc.metadata.title, "Hello");
    assert.equal(sc.metadata.author, "Ada Lovelace");
    // Date -> ISO string, not a serialized Date object or an em dash.
    assert.equal(sc.metadata.retrievedAt, "2026-01-03T04:05:06.000Z");
    // Metrics arrive as numbers, not "saved 4600, -92%" inside a sentence.
    assert.equal(sc.metrics.tokensSaved, 4600);
    assert.equal(typeof sc.metrics.reductionPct, "number");

    // The payload travels ONCE. There is no prose copy to fall back to, and
    // the markdown lives in a field rather than inside a rendered document.
    assert.deepEqual(res.content, []);
    assert.notEqual(res.isError, true);
  } finally {
    restore();
  }
});

test("get_job returns job state as real JSON types, not prose", async () => {
  // Both routes are stubbed on purpose. Which URL the SDK polls is its
  // implementation detail — it moved from /bulk/{id} to the kind-agnostic
  // /jobs/{id} — and this test is about the MCP layer's structured output,
  // not the SDK's routing. Pinning one path would make it fail on an SDK
  // upgrade that changed nothing here.
  const restore = stubFetch({
    "GET /jobs/job_abc": BULK_BODY,
    "GET /bulk/job_abc": BULK_BODY,
  });
  try {
    const res = await callTool("get_job", { job_id: "job_abc" });
    const sc = res.structuredContent;

    assert.equal(sc.kind, "bulk");
    assert.equal(sc.jobId, "job_abc");
    assert.equal(sc.status, "done");
    // The three fields that previously only existed as "(2/2)" in a sentence.
    assert.equal(sc.completed, 2);
    assert.equal(sc.total, 2);
    assert.equal(sc.done, true);
    assert.equal(typeof sc.completed, "number");
    assert.equal(typeof sc.done, "boolean");
    assert.equal(sc.createdAt, "2026-01-03T04:00:00.000Z");

    // Per-item success is a boolean, not a ✓/✗ glyph.
    assert.equal(sc.results.length, 2);
    assert.equal(sc.results[0].ok, true);
    assert.equal(sc.results[1].ok, false);
    assert.equal(sc.results[1].error, "target_timeout");
  } finally {
    restore();
  }
});

test("a finished job with no results still validates", async () => {
  // The empty-results branch renders "(no results)" as text; the structured
  // side must stay a real empty array rather than that string.
  const EMPTY = { ...BULK_BODY, job_id: "job_empty", total: 0, completed: 0, results: [] };
  const restore = stubFetch({
    "GET /jobs/job_empty": EMPTY,
    "GET /bulk/job_empty": EMPTY,
  });
  try {
    const res = await callTool("get_job", { job_id: "job_empty" });
    assert.deepEqual(res.structuredContent.results, []);
    assert.equal(res.structuredContent.total, 0);
  } finally {
    restore();
  }
});

test("crawl carries its crawl-only fields through the shared job schema", async () => {
  const restore = stubFetch({
    "POST /crawl": CRAWL_BODY,
    "GET /crawl/job_crawl": CRAWL_BODY,
  });
  try {
    const res = await callTool("crawl", { url: "https://example.com", depth: 1 });
    const sc = res.structuredContent;

    assert.equal(sc.kind, "crawl");
    assert.equal(sc.truncated, true);
    assert.equal(sc.truncatedReason, "page_cap_reached");
    assert.equal(sc.results[0].depth, 1);
  } finally {
    restore();
  }
});

test("search returns per-result status as a boolean", async () => {
  const restore = stubFetch({ "POST /search": SEARCH_BODY });
  try {
    const res = await callTool("search", { query: "ada lovelace" });
    const sc = res.structuredContent;

    assert.equal(sc.query, "ada lovelace");
    assert.equal(sc.requestId, "req_s1");
    assert.equal(sc.results[0].ok, true);
    assert.equal(sc.results[1].ok, false);
    assert.equal(sc.results[1].error, "target_timeout");
    assert.equal(sc.results[0].metrics.tokensSaved, 4600);
  } finally {
    restore();
  }
});

test("get_usage returns numbers, not a formatted percentage line", async () => {
  const restore = stubFetch({ "GET /usage": USAGE_BODY });
  try {
    const res = await callTool("get_usage", {});
    const sc = res.structuredContent;

    assert.deepEqual(sc, {
      plan: "pro",
      period: "2026-01",
      used: 120,
      limit: 10000,
      remaining: 9880,
    });
  } finally {
    restore();
  }
});

// ── Input bounds ─────────────────────────────────────────────────────────────
// Lives here because this file already owns the fetch stub, which is the only
// way to prove a value survived the whole chain rather than being rejected at
// the tool boundary.

test("num_results is not bounded locally, so a big-plan count reaches the API", async () => {
  // `num_results` used to carry .max(10) in the tool's inputSchema. A Growth
  // caller entitled to 50 got a zod rejection from THIS server and the API
  // never saw the request — so the 422 that names the real plan cap could
  // never be returned. The cap lives on the plan, which this server can't see.
  let sentBody;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ...SEARCH_BODY, results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const res = await callTool("search", { query: "q", num_results: 50 });
    assert.notEqual(res.isError, true, "50 must not be rejected at the tool boundary");
    assert.equal(sentBody.num_results, 50);
  } finally {
    globalThis.fetch = previous;
  }
});

// ── Error path ───────────────────────────────────────────────────────────────

test("an API error stays text-only and does not trip output validation", async () => {
  // Declaring an outputSchema makes structuredContent mandatory on success.
  // Errors are exempt (McpServer.validateToolOutput returns early on isError),
  // and this pins that: if the exemption ever stopped applying, the tool would
  // reject with an output-validation McpError instead of returning isError.
  const restore = stubFetch({
    "POST /extract": {
      status: 422,
      body: { error: { code: "unsafe_url", message: "URL resolves to a private address." } },
    },
  });
  try {
    const res = await callTool("extract", { url: "https://example.com/a" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent, undefined);
    assert.match(res.content[0].text, /unsafe_url/);
  } finally {
    restore();
  }
});
