// RFC 9728 Protected Resource Metadata for the origin:
// /.well-known/oauth-protected-resource (rewritten here by vercel.json).
import { protectedResourceResponse } from "../src/server.js";

export function GET(request) {
  return protectedResourceResponse(request, { endpoint: false });
}

export function OPTIONS(request) {
  return protectedResourceResponse(request, { endpoint: false });
}
