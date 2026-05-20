// OAuth 2.0 Authorization Server Metadata (RFC 8414) for the MCP connector.
// Served at /.well-known/oauth-authorization-server via a rewrite
// (next.config.ts). Advertises the authorize / token / registration
// endpoints so a client can run dynamic registration + the auth-code+PKCE
// flow with no manual configuration.

import { baseUrl, SUPPORTED_SCOPES } from "@/lib/mcp/oauth";
import { corsPreflight, jsonResponse } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return corsPreflight();
}

export function GET(req: Request): Response {
  const base = baseUrl(req);
  return jsonResponse({
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}
