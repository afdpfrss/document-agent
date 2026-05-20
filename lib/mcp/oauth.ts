// OAuth 2.1 primitives for the remote MCP connector (v2 design Phase 2).
//
// The MCP server is protected as an OAuth 2.1 resource server AND acts as its
// own minimal authorization server, so a client (e.g. claude.ai's custom
// connector) can dynamically register and run the authorization-code + PKCE
// flow against it. The actual *user* login is delegated to Google via the
// existing NextAuth setup (auth.ts) — this layer never sees a Google password,
// it only checks "is there a NextAuth session, and is the email allowed".
//
// Design choices:
// - Stateless. Access tokens, refresh tokens, authorization codes and the
//   dynamically-issued client_id are all HS256 JWTs signed with AUTH_SECRET.
//   No database (docs/v2-design.md §10 — "DB で文書本体を管理しない" and the
//   general no-extra-persistence principle). The only server state is a small
//   in-memory replay guard for authorization codes (best-effort).
// - HS256 via node:crypto — we are the sole issuer and verifier of these
//   tokens, so a symmetric key is sufficient and avoids an extra dependency.
// - PKCE S256 is mandatory; "plain" is rejected (OAuth 2.1).

import crypto from "node:crypto";
import { isAuthEnabled } from "@/lib/auth-helpers";

export const ACCESS_TOKEN_TTL = 3600; // 1 hour
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
export const AUTH_CODE_TTL = 120; // 2 minutes
export const CLIENT_ID_TTL = 60 * 60 * 24 * 365; // 1 year

export const SCOPE_READ = "mcp:read";
export const SCOPE_EDIT = "mcp:edit";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_EDIT] as const;

// MCP OAuth is enabled exactly when the app's auth layer is on (Google OIDC
// configured). When auth is off the whole app is open for local dev and the
// MCP endpoint stays open too — see app/api/mcp/route.ts.
export function isMcpAuthEnabled(): boolean {
  return isAuthEnabled();
}

function getSecret(): string | null {
  return process.env.AUTH_SECRET || null;
}

// --- base / resource URLs -------------------------------------------------

// Public origin of this deployment. Prefer an explicit env override; otherwise
// derive from forwarded headers (works behind the Vercel / proxy edge).
export function baseUrl(req: Request): string {
  const override = process.env.MCP_PUBLIC_URL || process.env.AUTH_URL;
  if (override) return override.replace(/\/+$/, "");
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export function mcpResourceUrl(req: Request): string {
  return `${baseUrl(req)}/api/mcp`;
}

export function protectedResourceMetadataUrl(req: Request): string {
  return `${baseUrl(req)}/.well-known/oauth-protected-resource`;
}

// --- HS256 JWT ------------------------------------------------------------

type TokenUse = "client" | "code" | "access" | "refresh";

export interface JwtClaims {
  [k: string]: unknown;
  use: TokenUse;
  iat?: number;
  exp?: number;
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function hmac(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Signs a JWT. Throws if AUTH_SECRET is missing — callers issuing tokens must
// translate that into a 503 (the deployment is misconfigured).
export function signJwt(claims: JwtClaims, ttlSeconds: number): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — cannot issue MCP OAuth tokens.");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...claims, iat: now, exp: now + ttlSeconds };
  const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  return `${body}.${hmac(body, secret)}`;
}

// Verifies a JWT's signature + expiry. Returns the claims, or null for any
// failure (bad shape, bad signature, expired, missing secret) — verification
// fails closed so a missing AUTH_SECRET denies access rather than granting it.
export function verifyJwt(token: string): JwtClaims | null {
  const secret = getSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  if (!timingEqual(sig, hmac(`${h}.${p}`, secret))) return null;
  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) return null;
  return claims;
}

function verifyTyped(token: string, use: TokenUse): JwtClaims | null {
  const claims = verifyJwt(token);
  if (!claims || claims.use !== use) return null;
  return claims;
}

// --- dynamic client registration -----------------------------------------

export interface ClientMetadata {
  redirect_uris: string[];
  client_name?: string;
}

// The client_id is itself a signed token carrying the registered redirect
// URIs, so /authorize can validate redirect_uri with no server-side storage.
export function issueClientId(meta: ClientMetadata): string {
  return signJwt(
    {
      use: "client",
      redirect_uris: meta.redirect_uris,
      client_name: meta.client_name ?? "MCP Client",
    },
    CLIENT_ID_TTL,
  );
}

export interface ParsedClient {
  redirect_uris: string[];
  client_name: string;
}

export function parseClientId(clientId: string): ParsedClient | null {
  const claims = verifyTyped(clientId, "client");
  if (!claims) return null;
  const uris = Array.isArray(claims.redirect_uris)
    ? (claims.redirect_uris as unknown[]).filter(
        (u): u is string => typeof u === "string",
      )
    : [];
  if (uris.length === 0) return null;
  return {
    redirect_uris: uris,
    client_name:
      typeof claims.client_name === "string" ? claims.client_name : "MCP Client",
  };
}

// A redirect URI must be https, or http on loopback (for local testing).
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

// --- authorization codes --------------------------------------------------

export interface AuthCodeData {
  email: string;
  name: string;
  clientIdHash: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function issueAuthCode(data: AuthCodeData): string {
  return signJwt(
    {
      use: "code",
      jti: crypto.randomUUID(),
      sub: data.email,
      name: data.name,
      cid: data.clientIdHash,
      redirect_uri: data.redirect_uri,
      code_challenge: data.code_challenge,
      scope: data.scope,
      resource: data.resource,
    },
    AUTH_CODE_TTL,
  );
}

export function verifyAuthCode(code: string): JwtClaims | null {
  return verifyTyped(code, "code");
}

// Best-effort single-use guard for authorization codes. A stateless JWT
// cannot be made truly single-use without storage; this in-memory set blocks
// replay within a single server process. Combined with the 2-minute code
// lifetime it closes the practical replay window. On a multi-instance
// serverless deployment a code could in theory be replayed once per cold
// instance inside that 2-minute window — acceptable for an internal tool and
// documented in docs/v2-design.md §4-F.
const usedCodeJtis = new Map<string, number>();

export function consumeAuthCode(jti: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of usedCodeJtis) {
    if (v < now) usedCodeJtis.delete(k);
  }
  if (usedCodeJtis.has(jti)) return false;
  usedCodeJtis.set(jti, exp);
  return true;
}

// --- PKCE -----------------------------------------------------------------

// OAuth 2.1: only S256 is accepted. `plain` is rejected outright.
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
  return timingEqual(hash, challenge);
}

// --- access / refresh tokens ---------------------------------------------

export interface TokenSubject {
  email: string;
  name: string;
  scope: string;
  resource: string;
}

export function issueAccessToken(s: TokenSubject): string {
  return signJwt(
    {
      use: "access",
      sub: s.email,
      name: s.name,
      scope: s.scope,
      aud: s.resource,
    },
    ACCESS_TOKEN_TTL,
  );
}

export function issueRefreshToken(s: TokenSubject): string {
  return signJwt(
    {
      use: "refresh",
      sub: s.email,
      name: s.name,
      scope: s.scope,
      aud: s.resource,
    },
    REFRESH_TOKEN_TTL,
  );
}

export function verifyAccessToken(token: string): JwtClaims | null {
  return verifyTyped(token, "access");
}

export function verifyRefreshToken(token: string): JwtClaims | null {
  return verifyTyped(token, "refresh");
}

// --- internal-user allowlist ("社内 Google アカウントのみ") ----------------

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Restricts the connector to internal users. Tightened by either an explicit
// email allowlist (MCP_ALLOWED_EMAILS) or a Google Workspace hosted-domain
// allowlist (MCP_ALLOWED_EMAIL_DOMAINS). If NEITHER is configured, any
// successfully Google-authenticated account is allowed — set at least one in
// production to actually scope the connector to your organisation.
export function isAllowedMcpUser(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const emails = envList("MCP_ALLOWED_EMAILS");
  const domains = envList("MCP_ALLOWED_EMAIL_DOMAINS");
  if (emails.length === 0 && domains.length === 0) return true;
  if (emails.includes(e)) return true;
  const domain = e.split("@")[1] ?? "";
  return domain.length > 0 && domains.includes(domain);
}

// Whether the connector currently has an internal-user allowlist configured.
export function hasMcpAllowlist(): boolean {
  return (
    envList("MCP_ALLOWED_EMAILS").length > 0 ||
    envList("MCP_ALLOWED_EMAIL_DOMAINS").length > 0
  );
}

// Scope a user is entitled to. Editors (EDITOR_EMAILS — the existing Phase 7
// allowlist) additionally get mcp:edit, which Phase 3's propose_edit checks.
export function entitledScope(email: string): string {
  const editors = envList("EDITOR_EMAILS");
  const isEditor = editors.includes(email.trim().toLowerCase());
  return isEditor ? `${SCOPE_READ} ${SCOPE_EDIT}` : SCOPE_READ;
}
