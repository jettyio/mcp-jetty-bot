/**
 * Stateless MCP over Streamable HTTP against a fake Jetty API — no handshake
 * state, no sessions. The last test drives the official SDK client end to end.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JETTY_TOOLS } from "jetty-mcp-server/tool-definitions";
import { createNodeServer } from "../src/node-server.js";
import {
  CATALOG_VERSION,
  HOSTED_EXCLUDED_TOOLS,
  createMcpHandler,
  hostedTools,
  protectedResourceMetadata,
  publicOrigin,
} from "../src/server.js";

const GOOD_TOKEN = "mlc_good";
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Minimal flows-api stand-in: whoami + collections, recording every request. */
function createFakeMise() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization });
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token !== GOOD_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      return res.end(JSON.stringify({ detail: "Invalid or expired token" }));
    }
    if (req.url === "/api/v1/auth/whoami") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ auth_type: "api_key", access_level: "WRITE", identifier: "demo", collection_scope: "demo" })
      );
    }
    if (req.url === "/api/v1/collections/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{ name: "demo", description: "fake" }]));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "not found" }));
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const rpc = (method, params = {}, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("mcp.jetty.bot", () => {
  const mise = createFakeMise();
  let misePort;
  let handle;
  let app;
  let appPort;

  before(async () => {
    misePort = await listen(mise.server);
    handle = createMcpHandler({ miseHost: `http://127.0.0.1:${misePort}` });
    app = createNodeServer({ miseHost: `http://127.0.0.1:${misePort}` });
    appPort = await listen(app);
  });
  after(() => {
    mise.server.close();
    app.close();
  });

  const post = (body, headers = {}) =>
    handle(
      new Request("https://mcp.jetty.bot/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, ...headers },
        body,
      })
    );

  it("catalog is jetty-mcp-server minus the excluded tools", () => {
    const names = hostedTools().map((t) => t.name);
    assert.equal(names.length, JETTY_TOOLS.length - HOSTED_EXCLUDED_TOOLS.size);
    assert.ok(names.includes("list-collections"));
    assert.ok(names.includes("run-workflow"));
    for (const excluded of HOSTED_EXCLUDED_TOOLS) assert.ok(!names.includes(excluded), excluded);
  });

  it("answers 401 with an RFC 9728 challenge when no bearer is sent", async () => {
    const res = await post(rpc("tools/list"));
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate");
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /resource_metadata="https:\/\/mcp\.jetty\.bot\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.ok(!/invalid_token/.test(challenge));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(mise.seen.length, 0, "no upstream call without a token");
  });

  it("answers 401 invalid_token when the Jetty API rejects the bearer", async () => {
    const res = await post(rpc("tools/list"), { Authorization: "Bearer mlc_wrong" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
    assert.match(res.headers.get("www-authenticate"), /Invalid or expired token/);
    const body = await res.json();
    assert.equal(body.error, "invalid_token");
  });

  it("initialize works without a session (stateless)", async () => {
    const res = await post(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
      { Authorization: `Bearer ${GOOD_TOKEN}` }
    );
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = JSON.parse(text);
    assert.equal(body.result.serverInfo.name, "jetty");
    assert.equal(body.result.serverInfo.version, CATALOG_VERSION);
    assert.ok(body.result.instructions.includes("list-collections"));
  });

  it("tools/list without a prior handshake returns the hosted catalog", async () => {
    const res = await post(rpc("tools/list"), { Authorization: `Bearer ${GOOD_TOKEN}` });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    const names = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      hostedTools()
        .map((t) => t.name)
        .sort()
    );
    const listCollections = body.result.tools.find((t) => t.name === "list-collections");
    assert.equal(listCollections.annotations.readOnlyHint, true);
  });

  it("tools/call passes the caller's bearer straight through to the Jetty API", async () => {
    mise.seen.length = 0;
    const res = await post(rpc("tools/call", { name: "list-collections", arguments: {} }), {
      Authorization: `Bearer ${GOOD_TOKEN}`,
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.result.isError, undefined);
    assert.deepEqual(JSON.parse(body.result.content[0].text), [{ name: "demo", description: "fake" }]);
    const upstream = mise.seen.find((r) => r.path === "/api/v1/collections/");
    assert.ok(upstream, "collections call reached upstream");
    assert.equal(upstream.authorization, `Bearer ${GOOD_TOKEN}`);
  });

  it("verification is cached: one whoami per token within the TTL", async () => {
    mise.seen.length = 0;
    await post(rpc("tools/list"), { Authorization: `Bearer ${GOOD_TOKEN}` });
    await post(rpc("tools/list"), { Authorization: `Bearer ${GOOD_TOKEN}` });
    assert.equal(mise.seen.filter((r) => r.path === "/api/v1/auth/whoami").length, 0, "still cached from earlier tests");
  });

  it("upstream API errors come back as isError tool results, not transport failures", async () => {
    const res = await post(rpc("tools/call", { name: "get-collection", arguments: { collection: "nope" } }), {
      Authorization: `Bearer ${GOOD_TOKEN}`,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /404/);
  });

  it("GET /mcp is 405 in stateless mode (no server-initiated SSE stream)", async () => {
    const res = await handle(
      new Request("https://mcp.jetty.bot/mcp", {
        method: "GET",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${GOOD_TOKEN}` },
      })
    );
    assert.equal(res.status, 405);
  });

  it("OPTIONS preflight succeeds without a token", async () => {
    const res = await handle(new Request("https://mcp.jetty.bot/mcp", { method: "OPTIONS" }));
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
  });

  it("protected resource metadata names its own origin (RFC 9728 §3.3)", () => {
    const root = protectedResourceMetadata("https://mcp.jetty.bot");
    assert.equal(root.resource, "https://mcp.jetty.bot");
    assert.deepEqual(root.authorization_servers, ["https://clerk.jetty.io"]);
    const endpoint = protectedResourceMetadata("https://mcp.jetty.bot", { endpoint: true });
    assert.equal(endpoint.resource, "https://mcp.jetty.bot/mcp");
  });

  it("derives the public origin from forwarded headers, defaulting to https", () => {
    const behindVercel = new Request("http://internal/api/mcp", {
      headers: { "x-forwarded-host": "mcp.jetty.bot", "x-forwarded-proto": "https" },
    });
    assert.equal(publicOrigin(behindVercel), "https://mcp.jetty.bot");
    const preview = new Request("https://mcp-jetty-bot-git-x.vercel.app/api/mcp");
    assert.equal(publicOrigin(preview), "https://mcp-jetty-bot-git-x.vercel.app");
    const local = new Request("http://localhost:8787/mcp");
    assert.equal(publicOrigin(local), "http://localhost:8787");
  });

  it("serves both PRM documents and the landing page over HTTP", async () => {
    const base = `http://127.0.0.1:${appPort}`;
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(root.resource, base);
    const endpoint = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(endpoint.resource, `${base}/mcp`);
    const landing = await fetch(`${base}/`);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Jetty MCP/);
  });

  it("the official SDK client completes initialize → listTools → callTool", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${appPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } },
    });
    const client = new Client({ name: "sdk-smoke", version: "0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, hostedTools().length);
    const result = await client.callTool({ name: "list-collections", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /"demo"/);
    await client.close();
  });
});
