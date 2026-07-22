#!/usr/bin/env node
/**
 * Remote entry point for the WellMarked MCP server — Streamable HTTP + OAuth
 * (Phase 7).
 *
 * A sibling to index.ts (stdio). It speaks MCP over HTTP so hosted clients
 * (Claude.ai custom connectors, etc.) can reach it without launching a local
 * process, and it authenticates with OAuth 2.1 bearer tokens instead of an
 * env-var API key.
 *
 * The seam that makes this small: it calls the SAME `createServer` as the
 * stdio entry point, once per request, with the request's own bearer token as
 * the API key. No tool code changes — the tool surface is transport-independent
 * (see the parity test in test/).
 *
 * OAuth roles (RFC 9728 / the MCP authorization spec):
 *   - This process is the RESOURCE SERVER. It publishes
 *     `/.well-known/oauth-protected-resource` pointing at the WellMarked API as
 *     the authorization server, and rejects unauthenticated/expired requests
 *     with `401 WWW-Authenticate: Bearer resource_metadata=...` so the client
 *     knows to run (or refresh) the OAuth flow.
 *   - The WellMarked API is the AUTHORIZATION SERVER (api/routes/oauth.py).
 *   - An access token is just a `wm_...` key with an expiry, so validation is a
 *     single authenticated probe to the API — no bespoke token introspection.
 *
 * Runs STATELESS: a fresh transport + server per request. Access tokens expire
 * hourly, so binding one to a long-lived session would break mid-session;
 * per-request binding always uses the token the client just presented, and our
 * tools are all request/response (no server-initiated streaming to preserve).
 *
 * Environment:
 *   - MCP_PUBLIC_URL        (optional) — this server's public URL, used in the
 *                            protected-resource metadata. Derived from the
 *                            request Host if unset.
 *   - PORT                  (optional) — listen port. Default 3000 (Railway sets it).
 *   - WELLMARKED_TIMEOUT_MS (optional) — per-request timeout in ms.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { createServer } from "./server.js";

const API_BASE_URL = "https://api.wellmarked.io";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

// The scopes an OAuth connector token carries — the MCP tool surface. Mirrors
// api/services/oauth.OAUTH_SCOPES. Advertised in the protected-resource
// metadata; the API is the one that actually enforces them per tool.
const OAUTH_SCOPES = ["extract", "bulk", "crawl"];

function resolveTimeout(): number | undefined {
  const raw = process.env.WELLMARKED_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
const TIMEOUT_MS = resolveTimeout();

function publicBaseUrl(req: IncomingMessage): string {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function resourceMetadataUrl(req: IncomingMessage): string {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource`;
}

function setCors(res: ServerResponse): void {
  // Tokens are bearer, not cookies, so a wildcard origin is safe (no
  // credentialed CORS). Expose WWW-Authenticate so a browser client can read
  // the resource_metadata hint that starts the OAuth flow.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function unauthorized(req: IncomingMessage, res: ServerResponse, invalid: boolean): void {
  // RFC 6750 / MCP: point the client at the protected-resource metadata so it
  // can discover the authorization server and (re)authorize. `invalid_token`
  // distinguishes an expired/revoked token (refresh) from a missing one.
  const params = [`resource_metadata="${resourceMetadataUrl(req)}"`];
  if (invalid) params.unshift(`error="invalid_token"`);
  res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  sendJson(res, 401, {
    error: invalid ? "invalid_token" : "missing_token",
    error_description: invalid
      ? "The access token is invalid or expired."
      : "Authorization required. Provide a Bearer access token.",
  });
}

/**
 * Validate a bearer token against the WellMarked API. An access token is a
 * `wm_...` key, so a single authenticated probe to an unmetered, no-scope
 * endpoint (`/usage`) tells us validity: 200 → valid, 401/403 → invalid/expired,
 * anything else (or a network failure) → the API is unavailable (fail closed).
 */
async function verifyToken(token: string): Promise<"valid" | "invalid" | "unavailable"> {
  try {
    const resp = await fetch(`${API_BASE_URL}/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 200) return "valid";
    if (resp.status === 401 || resp.status === 403) return "invalid";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return unauthorized(req, res, false);

  const verdict = await verifyToken(token);
  if (verdict === "invalid") return unauthorized(req, res, true);
  if (verdict === "unavailable") {
    return sendJson(res, 503, {
      error: "service_unavailable",
      error_description: "Unable to reach the WellMarked API to validate the token.",
    });
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    // JSON-RPC parse error.
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  // Stateless: one transport + server per request, keyed on this request's token.
  const server = createServer({ apiKey: token, timeoutMs: TIMEOUT_MS });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);

  const auth: AuthInfo = { token, clientId: "wellmarked-mcp", scopes: OAUTH_SCOPES };
  const authedReq = req as IncomingMessage & { auth?: AuthInfo };
  authedReq.auth = auth;
  await transport.handleRequest(authedReq, res, body);
}

const httpServer = createHttpServer((req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return sendJson(res, 200, {
      resource: `${publicBaseUrl(req)}/mcp`,
      authorization_servers: [API_BASE_URL],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") {
      void handleMcp(req, res).catch((err) => {
        process.stderr.write(`[wellmarked-mcp] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
      });
      return;
    }
    // Stateless mode has no standalone SSE stream or session teardown.
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  sendJson(res, 404, { error: "not_found" });
});

httpServer.listen(PORT, () => {
  process.stderr.write(`[wellmarked-mcp] Streamable HTTP listening on :${PORT} (API ${API_BASE_URL})\n`);
});
