/**
 * Plain Node http server around the same web-standard handlers Vercel runs.
 * Used by the tests and by `npm run dev` (http://localhost:8787/mcp).
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMcpHandler, protectedResourceResponse } from "./server.js";

const LANDING = new URL("../public/index.html", import.meta.url);

export async function toWebRequest(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const hasBody = body && !["GET", "HEAD"].includes(req.method);
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? body : undefined,
  });
}

export async function sendWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

export function createNodeServer(options = {}) {
  const handleMcp = createMcpHandler(options);
  return http.createServer(async (req, res) => {
    try {
      const request = await toWebRequest(req);
      const { pathname } = new URL(request.url);
      let response;
      if (pathname === "/mcp") {
        response = await handleMcp(request);
      } else if (pathname === "/.well-known/oauth-protected-resource") {
        response = protectedResourceResponse(request, { endpoint: false });
      } else if (pathname === "/.well-known/oauth-protected-resource/mcp") {
        response = protectedResourceResponse(request, { endpoint: true });
      } else if (pathname === "/" || pathname === "/index.html") {
        response = new Response(await readFile(LANDING), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } else {
        response = Response.json({ error: "not_found" }, { status: 404 });
      }
      await sendWebResponse(res, response);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal", message: err instanceof Error ? err.message : String(err) }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8787);
  createNodeServer().listen(port, () => {
    console.log(`mcp-jetty-bot listening on http://localhost:${port}/mcp`);
  });
}
