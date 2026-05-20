// OAuth 2.1 token endpoint for the MCP connector.
//
// Supports the authorization_code grant (with mandatory PKCE) and the
// refresh_token grant. Public clients only — no client authentication. All
// issued tokens are stateless HS256 JWTs (see lib/mcp/oauth.ts).

import {
  ACCESS_TOKEN_TTL,
  consumeAuthCode,
  isAllowedMcpUser,
  isMcpAuthEnabled,
  issueAccessToken,
  issueRefreshToken,
  mcpResourceUrl,
  SCOPE_READ,
  sha256Hex,
  verifyAuthCode,
  verifyPkceS256,
  verifyRefreshToken,
  type TokenSubject,
} from "@/lib/mcp/oauth";
import { corsPreflight, jsonResponse, oauthError } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(): Response {
  return corsPreflight();
}

function tokenResponse(subject: TokenSubject): Response {
  let accessToken: string;
  let refreshToken: string;
  try {
    accessToken = issueAccessToken(subject);
    refreshToken = issueRefreshToken(subject);
  } catch {
    return oauthError(
      "server_error",
      "Server is missing AUTH_SECRET — cannot issue tokens.",
      503,
    );
  }
  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope: subject.scope,
  });
}

function handleAuthorizationCode(req: Request, form: FormData): Response {
  const code = String(form.get("code") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return oauthError(
      "invalid_request",
      "code, redirect_uri, client_id and code_verifier are all required.",
    );
  }

  const claims = verifyAuthCode(code);
  if (!claims) {
    return oauthError(
      "invalid_grant",
      "Authorization code is invalid or expired.",
    );
  }
  // Single-use guard (best-effort, in-process).
  if (
    typeof claims.jti !== "string" ||
    !consumeAuthCode(claims.jti, typeof claims.exp === "number" ? claims.exp : 0)
  ) {
    return oauthError("invalid_grant", "Authorization code has already been used.");
  }
  if (claims.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the code.");
  }
  if (claims.cid !== sha256Hex(clientId)) {
    return oauthError("invalid_grant", "client_id does not match the code.");
  }
  if (
    typeof claims.code_challenge !== "string" ||
    !verifyPkceS256(codeVerifier, claims.code_challenge)
  ) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  const email = typeof claims.sub === "string" ? claims.sub : "";
  if (!isAllowedMcpUser(email)) {
    return oauthError(
      "invalid_grant",
      "User is no longer allowed to use this connector.",
    );
  }

  return tokenResponse({
    email,
    name: typeof claims.name === "string" ? claims.name : email,
    scope: typeof claims.scope === "string" ? claims.scope : SCOPE_READ,
    resource:
      typeof claims.resource === "string"
        ? claims.resource
        : mcpResourceUrl(req),
  });
}

function handleRefreshToken(req: Request, form: FormData): Response {
  const refreshToken = String(form.get("refresh_token") ?? "");
  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required.");
  }
  const claims = verifyRefreshToken(refreshToken);
  if (!claims) {
    return oauthError("invalid_grant", "refresh_token is invalid or expired.");
  }
  const email = typeof claims.sub === "string" ? claims.sub : "";
  if (!isAllowedMcpUser(email)) {
    return oauthError(
      "invalid_grant",
      "User is no longer allowed to use this connector.",
    );
  }
  return tokenResponse({
    email,
    name: typeof claims.name === "string" ? claims.name : email,
    scope: typeof claims.scope === "string" ? claims.scope : SCOPE_READ,
    resource:
      typeof claims.aud === "string" ? claims.aud : mcpResourceUrl(req),
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!isMcpAuthEnabled()) {
    return oauthError(
      "invalid_request",
      "MCP OAuth is not enabled on this server.",
      503,
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return oauthError(
      "invalid_request",
      "Request body must be application/x-www-form-urlencoded.",
    );
  }

  const grantType = String(form.get("grant_type") ?? "");
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(req, form);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(req, form);
  }
  return oauthError(
    "unsupported_grant_type",
    `grant_type "${grantType}" is not supported.`,
  );
}
