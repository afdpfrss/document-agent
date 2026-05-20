// Production configuration guard.
//
// The app is intentionally permissive in development — auth off, demo mode,
// an open MCP connector — so it runs with `npm run dev` and zero env. Those
// same defaults are dangerous in production: an unauthenticated deployment
// exposes the whole internal corpus to anyone with the URL, a left-on
// MCP_DEMO_MODE disables separation-of-duties for every PR, and an MCP
// connector with no allowlist accepts any Google account.
//
// productionGuardActive() lets route handlers fail closed in production.
// The escape hatch ALLOW_INSECURE_DEPLOY=true downgrades the hard denials
// to warnings for a deliberately-insecure internal staging environment.
//
// This module reads process.env only — no imports — so it is safe to use
// from auth-helpers, the MCP layer and instrumentation without import cycles.

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function insecureDeployAllowed(): boolean {
  return process.env.ALLOW_INSECURE_DEPLOY === "true";
}

// True when production fail-closed behaviour should apply. When this is true a
// route handler must deny the dangerous-by-default code paths instead of
// silently serving them.
export function productionGuardActive(): boolean {
  return isProduction() && !insecureDeployAllowed();
}

function authConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

function mcpAllowlistConfigured(): boolean {
  return Boolean(
    (process.env.MCP_ALLOWED_EMAILS ?? "").trim() ||
      (process.env.MCP_ALLOWED_EMAIL_DOMAINS ?? "").trim(),
  );
}

// Human-readable list of dangerous settings for the current environment.
// Empty when the configuration is safe (or not in production). instrumentation.ts
// logs these at server startup; SECURITY.md documents each one.
export function productionConfigIssues(): string[] {
  if (!isProduction()) return [];
  const issues: string[] = [];

  if (!authConfigured()) {
    issues.push(
      "認証が無効です（AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET 未設定）。本番では全ユーザーが無認証で全機能にアクセスできてしまいます。",
    );
  } else if (!mcpAllowlistConfigured()) {
    issues.push(
      "MCP コネクタの allowlist が未設定です（MCP_ALLOWED_EMAILS / MCP_ALLOWED_EMAIL_DOMAINS）。Google 認証を通った任意のアカウントが社内文書を検索できてしまいます。",
    );
  }
  if (process.env.MCP_DEMO_MODE === "true") {
    issues.push(
      "MCP_DEMO_MODE=true が設定されています。本番では職務分掌（提案者≠承認者）チェックが無効化されます。",
    );
  }

  if (issues.length > 0 && insecureDeployAllowed()) {
    issues.push(
      "ALLOW_INSECURE_DEPLOY=true のため、フェイルセキュアな拒否は無効化されています（警告のみ）。",
    );
  }
  return issues;
}
