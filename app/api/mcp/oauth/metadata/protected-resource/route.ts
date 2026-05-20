// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP connector.
// Served at /.well-known/oauth-protected-resource via a rewrite (next.config.ts).
// An MCP client discovers the authorization server from here after it gets a
// 401 from /api/mcp.

import { baseUrl, mcpResourceUrl, SUPPORTED_SCOPES } from "@/lib/mcp/oauth";
import { corsPreflight, jsonResponse } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return corsPreflight();
}

export function GET(req: Request): Response {
  return jsonResponse({
    resource: mcpResourceUrl(req),
    authorization_servers: [baseUrl(req)],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "社内ドキュメントエージェント MCP コネクタ",
  });
}
