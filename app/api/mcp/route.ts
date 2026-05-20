// Remote MCP server endpoint (v2 design §4 — 提供レイヤーの追加).
//
// Exposes the document-search tools over the MCP Streamable HTTP transport so
// users can add this as a custom connector in their own Claude. Query-time
// inference moves to the user's side: this endpoint never calls an
// answer-generating LLM, it only serves structured slices of the corpus.
//
// Transport: WebStandardStreamableHTTPServerTransport — the SDK's Web-standard
// (Request/Response) transport, which plugs straight into a Next.js route
// handler with no Node http bridge.
//
// Auth (Phase 2): when the app's auth layer is on (Google OIDC configured),
// every call must carry an OAuth 2.1 bearer token issued by this server's own
// authorization endpoints (app/api/mcp/oauth/*). Unauthenticated calls get a
// 401 + WWW-Authenticate so the MCP client can discover and run the OAuth
// flow. When auth is off (local dev) the endpoint is open, as in Phase 1.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpServer } from "@/lib/mcp/server";
import {
  hasMcpAllowlist,
  isAllowedMcpUser,
  isMcpAuthEnabled,
  mcpResourceUrl,
  protectedResourceMetadataUrl,
  verifyAccessToken,
} from "@/lib/mcp/oauth";
import { productionGuardActive } from "@/lib/config-guard";

// Node runtime: the search tools read documents/ off the filesystem via
// node:fs (see lib/document-utils.ts), and the OAuth layer uses node:crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

function unauthorized(req: Request, description: string): Response {
  const metadata = protectedResourceMetadataUrl(req);
  return withCors(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: description },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metadata}"`,
        },
      },
    ),
  );
}

// 503 for a misconfigured production deployment — distinct from 401 (which
// means "authenticate"), this means "the server refuses to serve until an
// operator fixes the configuration".
function serviceUnavailable(description: string): Response {
  return withCors(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32002, message: description },
        id: null,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ),
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

async function handleMcp(req: Request): Promise<Response> {
  // Production guard: the MCP connector exposes the whole corpus to whoever
  // holds the URL. In production it must sit behind OAuth AND an internal-user
  // allowlist — fail closed otherwise. Escape hatch: ALLOW_INSECURE_DEPLOY.
  if (productionGuardActive()) {
    if (!isMcpAuthEnabled()) {
      return serviceUnavailable(
        "本番環境では MCP コネクタに認証が必須です（AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET を設定してください）。",
      );
    }
    if (!hasMcpAllowlist()) {
      return serviceUnavailable(
        "本番環境では MCP コネクタに allowlist が必須です（MCP_ALLOWED_EMAILS または MCP_ALLOWED_EMAIL_DOMAINS を設定してください）。",
      );
    }
  }

  let authInfo: AuthInfo | undefined;

  if (isMcpAuthEnabled()) {
    const header = (req.headers.get("authorization") ?? "").trim();
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return unauthorized(req, "Authentication required.");
    }
    const token = match[1];
    const claims = verifyAccessToken(token);
    if (!claims) {
      return unauthorized(req, "Invalid or expired access token.");
    }
    const email = typeof claims.sub === "string" ? claims.sub : "";
    // Re-check the allowlist on every call so removing an email takes effect
    // without waiting for the token to expire.
    if (!isAllowedMcpUser(email)) {
      return unauthorized(req, "User is not allowed to use this connector.");
    }
    const expectedAud = mcpResourceUrl(req);
    // Require a string `aud` that matches this resource. issueAccessToken
    // always sets one, so an absent/non-string audience means a malformed or
    // foreign token — reject it rather than letting it through unchecked.
    if (
      typeof claims.aud !== "string" ||
      normalizeUrl(claims.aud) !== normalizeUrl(expectedAud)
    ) {
      return unauthorized(req, "Access token audience mismatch.");
    }
    authInfo = {
      token,
      clientId: "mcp-connector",
      scopes: (typeof claims.scope === "string" ? claims.scope : "")
        .split(" ")
        .filter(Boolean),
      expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
      resource: new URL(expectedAud),
      extra: {
        email,
        name: typeof claims.name === "string" ? claims.name : email,
      },
    };
  }

  // Stateless: a fresh server + transport per request. The Streamable HTTP
  // transport explicitly forbids reusing a stateless transport across
  // requests (JSON-RPC id collisions between clients), and serverless
  // deployments don't share memory between invocations regardless.
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const res = await transport.handleRequest(
      req,
      authInfo ? { authInfo } : undefined,
    );
    return withCors(res);
  } catch (err) {
    console.error(
      "[/api/mcp] error:",
      err instanceof Error ? err.message : err,
    );
    return withCors(
      Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        { status: 500 },
      ),
    );
  }
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
