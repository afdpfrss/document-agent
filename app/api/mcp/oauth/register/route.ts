// OAuth 2.0 Dynamic Client Registration (RFC 7591) for the MCP connector.
//
// MCP clients (e.g. claude.ai's custom connector) self-register here. We issue
// a stateless client_id — a signed token encoding the registered redirect
// URIs — so no client store is needed. Clients are public (PKCE, no secret).

import {
  isAllowedRedirectUri,
  issueClientId,
  isMcpAuthEnabled,
  SUPPORTED_SCOPES,
} from "@/lib/mcp/oauth";
import { corsPreflight, jsonResponse, oauthError } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return corsPreflight();
}

export async function POST(req: Request): Promise<Response> {
  if (!isMcpAuthEnabled()) {
    return oauthError(
      "invalid_request",
      "MCP OAuth is not enabled on this server.",
      503,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError(
      "invalid_client_metadata",
      "Request body must be JSON.",
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array.",
    );
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      return oauthError(
        "invalid_redirect_uri",
        `redirect_uri must be https (or http on loopback): ${uri}`,
      );
    }
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim()
      : "MCP Client";

  let clientId: string;
  try {
    clientId = issueClientId({
      redirect_uris: redirectUris,
      client_name: clientName,
    });
  } catch {
    return oauthError(
      "server_error",
      "Server is missing AUTH_SECRET — cannot register clients.",
      503,
    );
  }

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SUPPORTED_SCOPES.join(" "),
    },
    201,
  );
}
