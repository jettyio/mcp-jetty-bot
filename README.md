# mcp.jetty.bot

Hosted, stateless MCP server for [Jetty](https://jetty.io), served from Vercel functions at `https://mcp.jetty.bot/mcp`.

It serves the tool catalog of [`jetty-mcp-server`](https://github.com/jettyio/jettyio-skills/tree/main/mcp-server) (the `npx` stdio server) over Streamable HTTP. Every request is self-contained: a fresh `McpServer` per request, sessions disabled, JSON responses. The caller's bearer token is verified against `GET /api/v1/auth/whoami` and then passed straight through to the Jetty API, so results are scoped exactly as they would be for that key locally. Nothing is stored.

## Endpoints

| Path | Purpose |
|------|---------|
| `POST /mcp` | MCP Streamable HTTP endpoint. `GET`/`DELETE` answer 405 (stateless). |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata for the endpoint (`resource` = `https://mcp.jetty.bot/mcp`). Named by the 401 challenge. |
| `/.well-known/oauth-protected-resource` | RFC 9728 metadata for the origin. |
| `/` | Landing page with client configs. |

Authentication: `Authorization: Bearer <token>`. flows-api accepts collection-scoped `mlc_` API keys and Clerk-issued OAuth access tokens. Without a token the server answers `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, which is what MCP clients use to start OAuth. OAuth sign-in for clients without header support (Claude.ai, ChatGPT connectors) additionally needs dynamic client registration enabled on Clerk and mise's `JWT_EXPECTED_AZP` relaxed for registered clients; neither is done yet.

Catalog: every `jetty-mcp-server` tool except `run-workflow-sync` (`HOSTED_EXCLUDED_TOOLS` in `src/server.js`), because runs outlast any function ceiling. Use `run-workflow` and poll `get-trajectory`.

## Layout

- `src/server.js` — the handler: token verification (hashed 60 s cache), per-request server, stateless transport, PRM documents, CORS.
- `api/mcp.js`, `api/prm.js`, `api/prm-mcp.js` — Vercel function entrypoints (web-standard `Request`/`Response`); `vercel.json` rewrites the public paths onto them.
- `src/node-server.js` — the same handlers on a plain Node `http` server for tests and `npm run dev`.
- `public/index.html` — landing page.
- `tests/` — `node --test`: RFC 9728 challenge, stateless initialize / tools/list / tools/call against a fake Jetty API, and an end-to-end run with the official SDK client.

## Develop

```bash
npm install
npm test
npm run dev          # http://localhost:8787/mcp
MISE_HOST=http://localhost:8000 npm run dev   # point at a local mise
```

## Deploy

```bash
vercel deploy          # preview
vercel deploy --prod   # https://mcp.jetty.bot
```

Configuration is environment-free by default (`MISE_HOST` defaults to `https://flows-api.jetty.io`). `maxDuration` is 120 s in `vercel.json`; every tool is a short proxy call.
