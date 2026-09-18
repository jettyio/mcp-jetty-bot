// Vercel function behind the `/mcp` rewrite (vercel.json). Web-standard
// handler signature; one stateless MCP request per invocation.
import { createMcpHandler } from "../src/server.js";

const handle = createMcpHandler();

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
