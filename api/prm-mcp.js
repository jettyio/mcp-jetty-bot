// RFC 9728 Protected Resource Metadata for the /mcp endpoint itself:
// /.well-known/oauth-protected-resource/mcp (rewritten here by vercel.json).
// This is the document the 401 challenge points at.
import { protectedResourceResponse } from "../src/server.js";

export function GET(request) {
  return protectedResourceResponse(request, { endpoint: true });
}

export function OPTIONS(request) {
  return protectedResourceResponse(request, { endpoint: true });
}
