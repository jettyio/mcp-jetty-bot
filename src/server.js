/**
 * Hosted, stateless MCP server for Jetty.
 *
 * Every request is self-contained: a fresh McpServer is built per request,
 * the caller's bearer token is passed straight through to the Jetty API
 * (flows-api accepts `mlc_` keys and Clerk-issued OAuth access tokens), and
 * the Streamable HTTP transport runs with sessions disabled. Nothing is kept
 * between requests except a short-lived verification cache, so the server
 * scales horizontally and survives cold starts for free.
 *
 * Web-standard Request/Response only — the same handler runs on Vercel
 * functions (api/*.js) and on a plain Node http server (node-server.js).
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { JettyApiClient, DEFAULT_API_URL } from "jetty-mcp-server/api-client";
import { JETTY_TOOLS, jsonResult } from "jetty-mcp-server/tool-definitions";

const require = createRequire(import.meta.url);

/** Version of the tool catalog this host serves (the jetty-mcp-server release). */
export const CATALOG_VERSION = require("jetty-mcp-server/package.json").version;

/** The authorization server MCP clients are sent to (RFC 9728). */
export const AUTHORIZATION_SERVER = "https://clerk.jetty.io";

/** Scopes registered on Jetty's Clerk OAuth applications. */
export const SCOPES_SUPPORTED = ["email", "profile", "offline_access", "user:org:read"];

/** Origin used when a request carries no usable Host header. */
export const DEFAULT_PUBLIC_ORIGIN = "https://mcp.jetty.bot";

/**
 * Tools not offered by the hosted server. `run-workflow-sync` blocks until
 * a run finishes, and runs routinely outlast any HTTP function ceiling; use
 * `run-workflow` and poll `get-trajectory` instead.
 */
export const HOSTED_EXCLUDED_TOOLS = new Set(["run-workflow-sync"]);

export const SERVER_INSTRUCTIONS =
  "Jetty runs runbooks (markdown instructions for a coding agent) in isolated " +
  "sandboxes and records every run as a trajectory. Start with `list-collections`, " +
  "then `list-tasks` for a collection. `run-workflow` starts a run and returns a " +
  "trajectory id; poll `get-trajectory` (every ~30s) until its status is " +
  "completed or failed. `get-stats` summarises runs of a task. Routine tools " +
  "manage schedules. Each request is authenticated with the caller's own Jetty " +
  "API key, so results are scoped to that key's collection.";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

/** The tool definitions the hosted server registers. */
export function hostedTools() {
  return JETTY_TOOLS.filter((tool) => !HOSTED_EXCLUDED_TOOLS.has(tool.name));
}

/**
 * Register the hosted catalog on an McpServer, executing through `client`.
 * Mirrors jetty-mcp-server's registerTools minus the excluded tools; errors
 * surface as `isError` results so the client sees the API's message.
 */
export function registerHostedTools(server, client) {
  for (const tool of hostedTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return jsonResult(await tool.handler(client, args));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: message }], isError: true };
        }
      }
    );
  }
}

/** The public origin a request arrived on (behind Vercel's proxy or locally). */
export function publicOrigin(request) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const url = new URL(request.url);
  const host = (forwardedHost || url.host || "").split(",")[0].trim();
  if (!host) return DEFAULT_PUBLIC_ORIGIN;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = (forwardedProto || (isLocal ? url.protocol.replace(":", "") : "https"))
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

/**
 * RFC 9728 Protected Resource Metadata. `resource` must equal the identifier
 * the well-known URL was derived from: the bare origin for
 * /.well-known/oauth-protected-resource, the endpoint URL for
 * /.well-known/oauth-protected-resource/mcp.
 */
export function protectedResourceMetadata(origin, { endpoint = false } = {}) {
  return {
    resource: endpoint ? `${origin}/mcp` : origin,
    resource_name: "Jetty MCP",
    resource_documentation: "https://jetty.io/docs/integrations/mcp-server",
    resource_policy_uri: "https://jetty.io/privacy",
    resource_tos_uri: "https://jetty.io/terms",
    authorization_servers: [AUTHORIZATION_SERVER],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  };
}

export function protectedResourceResponse(request, options) {
  return withCors(
    Response.json(protectedResourceMetadata(publicOrigin(request), options), {
      headers: { "Cache-Control": "public, max-age=3600, s-maxage=3600" },
    })
  );
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

function withCors(response) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

function unauthorized(origin, { invalid = false, description } = {}) {
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const challenge = [
    'Bearer realm="jetty"',
    invalid ? 'error="invalid_token"' : null,
    invalid && description ? `error_description="${description.replace(/"/g, "'")}"` : null,
    `resource_metadata="${metadataUrl}"`,
  ]
    .filter(Boolean)
    .join(", ");
  return withCors(
    Response.json(
      {
        error: invalid ? "invalid_token" : "unauthorized",
        message: invalid
          ? description || "The bearer token was rejected by the Jetty API."
          : "Send `Authorization: Bearer <Jetty API key>`. How to get one: https://jetty.io/auth.md",
        resource_metadata: metadataUrl,
      },
      { status: 401, headers: { "WWW-Authenticate": challenge } }
    )
  );
}

/**
 * Verifies bearer tokens against the Jetty API's whoami endpoint, caching
 * positive verdicts briefly (keyed by a hash, never the token itself).
 */
export function createTokenVerifier({ miseHost, fetchImpl, ttlMs = 60_000, maxEntries = 1000, now = Date.now }) {
  const cache = new Map();
  return async function verify(token) {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return { status: "ok", identity: hit.identity };
    let res;
    try {
      res = await fetchImpl(`${miseHost}/api/v1/auth/whoami`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (err) {
      return { status: "unavailable", detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 401 || res.status === 403) {
      let detail = "";
      try {
        const body = await res.json();
        detail = typeof body?.detail === "string" ? body.detail : "";
      } catch {
        /* non-JSON body */
      }
      return { status: "invalid", detail };
    }
    if (!res.ok) return { status: "unavailable", detail: `whoami returned ${res.status}` };
    let identity = {};
    try {
      identity = await res.json();
    } catch {
      /* treat as opaque success */
    }
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, { until: now() + ttlMs, identity });
    return { status: "ok", identity };
  };
}

/**
 * Build the `/mcp` request handler: (Request) => Promise<Response>.
 */
export function createMcpHandler({
  miseHost = process.env.MISE_HOST || DEFAULT_API_URL,
  fetchImpl = (...args) => globalThis.fetch(...args),
  verifyTtlMs = 60_000,
  now = Date.now,
} = {}) {
  const host = miseHost.replace(/\/+$/, "");
  const verify = createTokenVerifier({ miseHost: host, fetchImpl, ttlMs: verifyTtlMs, now });

  return async function handleMcp(request) {
    const origin = publicOrigin(request);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (request.method !== "POST") {
      // Stateless: no server-initiated SSE stream to GET, no session to DELETE.
      // The spec lets a server answer 405 here and clients carry on with POST.
      return withCors(
        Response.json(
          { error: "method_not_allowed", message: "This MCP server is stateless: send JSON-RPC via POST." },
          { status: 405, headers: { Allow: "POST, OPTIONS" } }
        )
      );
    }

    const token = bearerToken(request);
    if (!token) return unauthorized(origin);
    const verdict = await verify(token);
    if (verdict.status === "invalid") return unauthorized(origin, { invalid: true, description: verdict.detail });
    if (verdict.status === "unavailable") {
      return withCors(
        Response.json(
          { error: "upstream_unavailable", message: `Jetty API unreachable: ${verdict.detail}` },
          { status: 503, headers: { "Retry-After": "5" } }
        )
      );
    }

    const server = new McpServer(
      { name: "jetty", title: "Jetty", version: CATALOG_VERSION },
      { instructions: SERVER_INSTRUCTIONS }
    );
    const client = new JettyApiClient({ token, apiUrl: host, fetch: fetchImpl });
    registerHostedTools(server, client);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no Mcp-Session-Id, GET/DELETE answer 405
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return withCors(await transport.handleRequest(request));
    } finally {
      // JSON mode: the response body is complete once handleRequest resolves.
      transport.close().catch(() => {});
    }
  };
}
