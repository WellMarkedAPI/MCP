// Structured tool output: every tool returns typed JSON, not prose to parse.
//
// The thing under test is the seam an agent actually consumes: `content`.
// Before this, `get_job` handed a model `status: running (12/50)` inside a
// sentence and the model had to pattern-match `status`, split `12/50`, and
// read `—` as null. Now the same call carries the payload as JSON, so every
// key-value pair arrives intact and addressable.
//
// The payload rides in `content`, NOT in `structuredContent`. Hosts surface
// `content` to the model and several ignore `structuredContent` entirely, so a
// payload sent only there is invisible — that is exactly what 1.2.0 shipped,
// with `content` reduced to the literal string `[See "structuredContent"]`.
// The first test below fails against that build.
//
// The stub sits at `globalThis.fetch`, NOT at the client methods, so each test
// exercises the whole chain: canned API JSON → the real SDK parser (snake_case
// → camelCase, Date coercion, the computed `ok`/`done` getters) → JSON.stringify
// → the transport → the client. A field that survives all of that is a field an
// agent can really read.
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

/**
 * The payload an agent actually receives, read the way a host reads it.
 *
 * Deliberately goes through `content` and `JSON.parse`, so a result that
 * carries prose, a pointer, or nothing at all fails here rather than silently
 * passing on some other field.
 */
function payload(res) {
  assert.equal(res.content.length, 1, "expected exactly one content block");
  assert.equal(res.content[0].type, "text");
  return JSON.parse(res.content[0].text);
}

// ── The contract ─────────────────────────────────────────────────────────────

test("every tool puts its payload in content, parseable as JSON", async () => {
  // This is the regression test for 1.2.0, which moved the payload into
  // `structuredContent` and left `content` holding only `[See
  // "structuredContent"]`. JSON.parse throws on that pointer, and on any
  // prose rendering, so this fails loudly against either.
  const cases = [
    ["extract", { url: "https://example.com/a" }, { "POST /extract": EXTRACT_BODY }],
    ["search", { query: "q" }, { "POST /search": SEARCH_BODY }],
    ["get_usage", {}, { "GET /usage": USAGE_BODY }],
    ["bulk", { urls: ["https://example.com/a"], wait: false }, { "POST /bulk": BULK_BODY }],
    ["crawl", { url: "https://example.com", depth: 1, wait: false }, { "POST /crawl": CRAWL_BODY }],
    [
      "get_job",
      { job_id: "job_abc" },
      { "GET /jobs/job_abc": BULK_BODY, "GET /bulk/job_abc": BULK_BODY },
    ],
    [
      "wait_for_job",
      { job_id: "job_abc" },
      { "GET /jobs/job_abc": BULK_BODY, "GET /bulk/job_abc": BULK_BODY },
    ],
  ];

  for (const [name, args, routes] of cases) {
    const restore = stubFetch(routes);
    try {
      const res = await callTool(name, args);
      assert.notEqual(res.isError, true, `${name} errored: ${res.content?.[0]?.text}`);

      const p = payload(res);
      assert.equal(typeof p, "object", `${name} did not return a JSON object`);
      assert.ok(Object.keys(p).length > 0, `${name} returned an empty payload`);

      // One copy only. Sending it twice doubles the tokens on every response.
      assert.equal(
        res.structuredContent,
        undefined,
        `${name} must not also send structuredContent`,
      );
    } finally {
      restore();
    }
  }
});

test("no tool declares an outputSchema", async () => {
  // An outputSchema makes structuredContent mandatory — McpServer's
  // validateToolOutput throws when one is declared and structuredContent is
  // absent. Declaring one here would force the payload back out of `content`,
  // so this guards the fix from the other direction.
  const tools = await listTools();
  const declared = tools.filter((t) => t.outputSchema).map((t) => t.name);
  assert.deepEqual(declared, [], `tools declaring an outputSchema: ${declared.join(", ")}`);
  assert.equal(tools.length, 7);
});

// ── Field fidelity ───────────────────────────────────────────────────────────

test("extract keeps its metadata and metrics as addressable fields", async () => {
  const restore = stubFetch({ "POST /extract": EXTRACT_BODY });
  try {
    const p = payload(await callTool("extract", { url: "https://example.com/a" }));

    assert.equal(p.requestId, "req_123");
    assert.equal(p.markdown, "# Hello\n\nBody text.");
    // Nested objects survive as objects, not flattened into a "Title: …" header.
    assert.equal(p.metadata.title, "Hello");
    assert.equal(p.metadata.author, "Ada Lovelace");
    // Date -> ISO string, not a serialized Date object or an em dash.
    assert.equal(p.metadata.retrievedAt, "2026-01-03T04:05:06.000Z");
    // Metrics arrive as numbers, not "saved 4600, -92%" inside a sentence.
    assert.equal(p.metrics.tokensSaved, 4600);
    assert.equal(typeof p.metrics.reductionPct, "number");
  } finally {
    restore();
  }
});

test("get_job returns job state as real JSON types, not prose", async () => {
  // Both routes are stubbed on purpose. Which URL the SDK polls is its
  // implementation detail — it moved from /bulk/{id} to the kind-agnostic
  // /jobs/{id} — and this test is about the MCP layer's output shape, not the
  // SDK's routing. Pinning one path would make it fail on an SDK upgrade that
  // changed nothing here.
  const restore = stubFetch({
    "GET /jobs/job_abc": BULK_BODY,
    "GET /bulk/job_abc": BULK_BODY,
  });
  try {
    const p = payload(await callTool("get_job", { job_id: "job_abc" }));

    assert.equal(p.kind, "bulk");
    assert.equal(p.jobId, "job_abc");
    assert.equal(p.status, "done");
    // The three fields that previously only existed as "(2/2)" in a sentence.
    assert.equal(p.completed, 2);
    assert.equal(p.total, 2);
    assert.equal(p.done, true);
    assert.equal(typeof p.completed, "number");
    // `done` is a computed getter on the SDK object; it must survive serialization.
    assert.equal(typeof p.done, "boolean");
    assert.equal(p.createdAt, "2026-01-03T04:00:00.000Z");

    // Per-item success is a boolean, not a ✓/✗ glyph.
    assert.equal(p.results.length, 2);
    assert.equal(p.results[0].ok, true);
    assert.equal(p.results[1].ok, false);
    assert.equal(p.results[1].error, "target_timeout");
  } finally {
    restore();
  }
});

test("a finished job with no results returns an empty array, not a sentence", async () => {
  // The old renderer emitted "(no results)" here; an agent had to string-match
  // it. The array must stay an array.
  const EMPTY = { ...BULK_BODY, job_id: "job_empty", total: 0, completed: 0, results: [] };
  const restore = stubFetch({
    "GET /jobs/job_empty": EMPTY,
    "GET /bulk/job_empty": EMPTY,
  });
  try {
    const p = payload(await callTool("get_job", { job_id: "job_empty" }));
    assert.deepEqual(p.results, []);
    assert.equal(p.total, 0);
  } finally {
    restore();
  }
});

test("crawl carries its crawl-only fields", async () => {
  const restore = stubFetch({
    "POST /crawl": CRAWL_BODY,
    "GET /crawl/job_crawl": CRAWL_BODY,
  });
  try {
    const p = payload(await callTool("crawl", { url: "https://example.com", depth: 1 }));

    assert.equal(p.kind, "crawl");
    assert.equal(p.truncated, true);
    assert.equal(p.truncatedReason, "page_cap_reached");
    assert.equal(p.results[0].depth, 1);
  } finally {
    restore();
  }
});

test("search returns per-result status as a boolean and keeps the page content", async () => {
  const restore = stubFetch({ "POST /search": SEARCH_BODY });
  try {
    const p = payload(await callTool("search", { query: "ada lovelace" }));

    assert.equal(p.query, "ada lovelace");
    assert.equal(p.requestId, "req_s1");
    assert.equal(p.results[0].ok, true);
    assert.equal(p.results[1].ok, false);
    assert.equal(p.results[1].error, "target_timeout");
    assert.equal(p.results[0].metrics.tokensSaved, 4600);
    // The extracted page is the point of the call — it must ride along.
    assert.equal(p.results[0].markdown, "# A");
    assert.equal(p.results[0].snippet, "a snippet");
  } finally {
    restore();
  }
});

test("get_usage returns numbers, not a formatted percentage line", async () => {
  const restore = stubFetch({ "GET /usage": USAGE_BODY });
  try {
    const p = payload(await callTool("get_usage", {}));
    assert.deepEqual(p, {
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

test("num_results is not bounded locally, so the plan cap is what applies", async () => {
  // The API caps this per plan (Free 5 / Pro 10 / Growth 50 / Enterprise
  // uncapped) and answers search_cap_exceeded. A local .max() would reject a
  // legitimate Growth request before it ever left the process.
  const tools = await listTools();
  const schema = tools.find((t) => t.name === "search").inputSchema;
  assert.equal(schema.properties.num_results.maximum, undefined);
});

// ── Error path ───────────────────────────────────────────────────────────────

test("an API error comes back as readable prose with isError", async () => {
  // Errors are the one case that stays prose: there is no typed shape beyond
  // the code, and the agent needs to read the reason.
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
