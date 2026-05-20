// OAuth 2.1 authorization endpoint for the MCP connector.
//
// Flow: validate the (dynamically registered) client + PKCE params, require a
// Google sign-in via the existing NextAuth setup, enforce the internal-user
// allowlist, then redirect back to the client with a short-lived
// authorization code. No server-side state — the whole request is carried in
// the URL across the NextAuth round trip.

import { auth } from "@/auth";
import {
  baseUrl,
  entitledScope,
  isAllowedMcpUser,
  isMcpAuthEnabled,
  issueAuthCode,
  mcpResourceUrl,
  parseClientId,
  sha256Hex,
} from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlError(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>認可エラー</title>` +
      `<body style="font-family:sans-serif;padding:2rem"><h1>認可エラー</h1><p>${message}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

export async function GET(req: Request): Promise<Response> {
  if (!isMcpAuthEnabled()) {
    return htmlError(503, "このサーバでは MCP OAuth が有効になっていません。");
  }

  const url = new URL(req.url);
  const p = url.searchParams;
  const responseType = p.get("response_type") ?? "";
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const codeChallenge = p.get("code_challenge") ?? "";
  const codeChallengeMethod = p.get("code_challenge_method") ?? "";
  const state = p.get("state") ?? "";
  const resource = p.get("resource") ?? "";

  // 1. Validate the client + redirect_uri BEFORE trusting the redirect target.
  //    Errors here must NOT redirect — they render an error page instead.
  const client = parseClientId(clientId);
  if (!client) {
    return htmlError(
      400,
      "client_id が不正です。先に動的クライアント登録を行ってください。",
    );
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return htmlError(
      400,
      "redirect_uri が登録済みの値と一致しません。",
    );
  }

  // From here on, protocol errors are reported back to the client by redirect.
  const errorRedirect = (error: string, description: string): Response => {
    const out = new URL(redirectUri);
    out.searchParams.set("error", error);
    out.searchParams.set("error_description", description);
    if (state) out.searchParams.set("state", state);
    return Response.redirect(out.toString(), 302);
  };

  if (responseType !== "code") {
    return errorRedirect(
      "unsupported_response_type",
      "response_type=code のみサポートしています。",
    );
  }
  if (!codeChallenge) {
    return errorRedirect("invalid_request", "PKCE の code_challenge が必須です。");
  }
  if (codeChallengeMethod !== "S256") {
    return errorRedirect(
      "invalid_request",
      "code_challenge_method は S256 のみ対応しています。",
    );
  }

  const mcpResource = mcpResourceUrl(req);
  if (resource && normalizeUrl(resource) !== normalizeUrl(mcpResource)) {
    return errorRedirect(
      "invalid_target",
      "resource がこの MCP サーバと一致しません。",
    );
  }

  // 2. Require a Google (NextAuth) session. If absent, bounce through the
  //    NextAuth sign-in and come straight back to this same authorize URL.
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    const selfUrl = `${baseUrl(req)}${url.pathname}${url.search}`;
    const signin = new URL(`${baseUrl(req)}/api/auth/signin`);
    signin.searchParams.set("callbackUrl", selfUrl);
    return Response.redirect(signin.toString(), 302);
  }

  // 3. Enforce the internal-user allowlist.
  if (!isAllowedMcpUser(email)) {
    return errorRedirect(
      "access_denied",
      "このアカウントはコネクタの利用を許可されていません。",
    );
  }

  // 4. Issue the authorization code and hand it back to the client.
  try {
    const code = issueAuthCode({
      email,
      name: session?.user?.name ?? email,
      clientIdHash: sha256Hex(clientId),
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      scope: entitledScope(email),
      resource: mcpResource,
    });
    const out = new URL(redirectUri);
    out.searchParams.set("code", code);
    if (state) out.searchParams.set("state", state);
    return Response.redirect(out.toString(), 302);
  } catch {
    return errorRedirect(
      "server_error",
      "サーバに AUTH_SECRET が設定されていません。",
    );
  }
}
