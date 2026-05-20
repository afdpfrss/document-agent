import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

// oauth.ts only needs isAuthEnabled() from auth-helpers. Mocking it keeps the
// heavy NextAuth import (@/auth) out of the test.
vi.mock("@/lib/auth-helpers", () => ({
  isAuthEnabled: () => true,
}));

import {
  signJwt,
  verifyJwt,
  verifyPkceS256,
  isAllowedMcpUser,
  entitledScope,
  isAllowedRedirectUri,
  issueClientId,
  parseClientId,
  issueAccessToken,
  issueRefreshToken,
  verifyAccessToken,
} from "@/lib/mcp/oauth";

const SECRET = "test-secret-key";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("MCP_ALLOWED_EMAILS", "");
  vi.stubEnv("MCP_ALLOWED_EMAIL_DOMAINS", "");
  vi.stubEnv("EDITOR_EMAILS", "");
  vi.stubEnv("MERGER_EMAILS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Build a token with an arbitrary header but a valid HMAC-SHA256 signature.
function craftToken(
  header: object,
  payload: object,
  secret: string,
): string {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

describe("JWT sign / verify", () => {
  it("round-trips signed claims", () => {
    const token = signJwt({ use: "access", sub: "a@example.com" }, 60);
    const claims = verifyJwt(token);
    expect(claims?.sub).toBe("a@example.com");
    expect(claims?.use).toBe("access");
  });

  it("rejects an expired token", () => {
    const token = signJwt({ use: "access" }, -1);
    expect(verifyJwt(token)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signJwt({ use: "access", sub: "a@example.com" }, 60);
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A");
    expect(verifyJwt(parts.join("."))).toBeNull();
  });

  it("rejects a token whose header claims a non-HS256 alg (alg confusion)", () => {
    const token = craftToken(
      { alg: "HS512", typ: "JWT" },
      { use: "access", exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
    );
    expect(verifyJwt(token)).toBeNull();
  });

  it("verifyAccessToken rejects a refresh token (token-use is pinned)", () => {
    const refresh = issueRefreshToken({
      email: "a@example.com",
      name: "A",
      scope: "mcp:read",
      resource: "https://example.com/api/mcp",
    });
    expect(verifyAccessToken(refresh)).toBeNull();
    const access = issueAccessToken({
      email: "a@example.com",
      name: "A",
      scope: "mcp:read",
      resource: "https://example.com/api/mcp",
    });
    expect(verifyAccessToken(access)?.sub).toBe("a@example.com");
  });
});

describe("PKCE S256", () => {
  it("accepts a matching verifier / challenge pair", () => {
    const verifier = "the-code-verifier-1234567890";
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a mismatched verifier", () => {
    const challenge = crypto
      .createHash("sha256")
      .update("right")
      .digest("base64url");
    expect(verifyPkceS256("wrong", challenge)).toBe(false);
  });
});

describe("isAllowedMcpUser", () => {
  it("allows any authenticated email when no allowlist is set", () => {
    expect(isAllowedMcpUser("anyone@anywhere.com")).toBe(true);
  });

  it("rejects an empty / missing email", () => {
    expect(isAllowedMcpUser("")).toBe(false);
    expect(isAllowedMcpUser(null)).toBe(false);
    expect(isAllowedMcpUser(undefined)).toBe(false);
  });

  it("honours an explicit email allowlist", () => {
    vi.stubEnv("MCP_ALLOWED_EMAILS", "ok@example.com");
    expect(isAllowedMcpUser("ok@example.com")).toBe(true);
    expect(isAllowedMcpUser("OK@example.com")).toBe(true);
    expect(isAllowedMcpUser("nope@example.com")).toBe(false);
  });

  it("honours a domain allowlist", () => {
    vi.stubEnv("MCP_ALLOWED_EMAIL_DOMAINS", "example.com");
    expect(isAllowedMcpUser("anyone@example.com")).toBe(true);
    expect(isAllowedMcpUser("anyone@other.com")).toBe(false);
  });
});

describe("entitledScope", () => {
  it("grants only mcp:read by default", () => {
    expect(entitledScope("user@example.com")).toBe("mcp:read");
  });

  it("adds mcp:edit for EDITOR_EMAILS and mcp:merge for MERGER_EMAILS", () => {
    vi.stubEnv("EDITOR_EMAILS", "editor@example.com");
    vi.stubEnv("MERGER_EMAILS", "merger@example.com");
    expect(entitledScope("editor@example.com")).toBe("mcp:read mcp:edit");
    expect(entitledScope("merger@example.com")).toBe("mcp:read mcp:merge");
  });
});

describe("isAllowedRedirectUri", () => {
  it("accepts https and loopback http, rejects everything else", () => {
    expect(isAllowedRedirectUri("https://claude.ai/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:3000/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("not-a-url")).toBe(false);
  });
});

describe("client registration", () => {
  it("round-trips redirect URIs through a signed client_id", () => {
    const clientId = issueClientId({
      redirect_uris: ["https://claude.ai/callback"],
      client_name: "Test Client",
    });
    const parsed = parseClientId(clientId);
    expect(parsed?.redirect_uris).toEqual(["https://claude.ai/callback"]);
    expect(parsed?.client_name).toBe("Test Client");
  });

  it("rejects a client_id that is not a valid signed token", () => {
    expect(parseClientId("garbage")).toBeNull();
  });
});
