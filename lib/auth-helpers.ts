// Server-side auth assertions. Throwing here instead of returning Responses
// directly lets the same helper work in both route handlers and server
// components — the caller decides how to translate the error.

import { auth, type Role } from "@/auth";
import { productionGuardActive } from "@/lib/config-guard";

export interface AuthorizedUser {
  email: string;
  role: Role;
  name: string | null;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("ログインが必要です。");
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends Error {
  constructor(needed: Role) {
    super(`このアクションには「${needed}」ロールが必要です。`);
    this.name = "ForbiddenError";
  }
}

// Thrown when auth is disabled but the deployment is a production environment
// (and the ALLOW_INSECURE_DEPLOY escape hatch is not set). Running unauthen-
// ticated in production would expose the whole corpus, so the gates below fail
// closed instead of handing back the synthetic AUTH_DISABLED_USER.
export class MisconfiguredError extends Error {
  constructor() {
    super(
      "本番環境では認証の設定（AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET）が必須です。サーバー管理者に連絡してください。",
    );
    this.name = "MisconfiguredError";
  }
}

// Feature switch: auth is on only when the Google OAuth credentials are
// present. When off, every gate below short-circuits to a synthetic
// AUTH_DISABLED_USER (編集) so the rest of the app (search, edit, PR) keeps
// working without anyone signing in. Setting AUTH_GOOGLE_ID +
// AUTH_GOOGLE_SECRET (and AUTH_SECRET for prod) flips Phase 7 behaviour
// back on with no code change.
export function isAuthEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

// The identity callers see when auth is disabled. Marked as 編集 so the
// editor / PR flows are exercisable locally without an OAuth round-trip.
const AUTH_DISABLED_USER: AuthorizedUser = {
  email: "local-dev@auth-disabled",
  role: "編集",
  name: "Local Dev (auth disabled)",
};

// In production, refuse the auth-disabled bypass — running open is treated as
// a misconfiguration, not a valid mode. dev / staging keep the synthetic user.
function authDisabledUserOrThrow(): AuthorizedUser {
  if (productionGuardActive()) throw new MisconfiguredError();
  return AUTH_DISABLED_USER;
}

export async function requireUser(): Promise<AuthorizedUser> {
  if (!isAuthEnabled()) return authDisabledUserOrThrow();
  const session = await auth();
  if (!session?.user?.email) throw new UnauthenticatedError();
  return {
    email: session.user.email,
    role: session.user.role,
    name: session.user.name ?? null,
  };
}

export async function requireRole(role: Role): Promise<AuthorizedUser> {
  if (!isAuthEnabled()) return authDisabledUserOrThrow();
  const user = await requireUser();
  if (user.role !== role) throw new ForbiddenError(role);
  return user;
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Convenience for route handlers: maps the auth exceptions to NextResponse
// status codes so each handler doesn't repeat the same try/catch boilerplate.
// Returns null on success, a Response on failure (return it as-is).
export async function gateForRole(
  role: Role,
): Promise<{ user: AuthorizedUser; response: null } | { user: null; response: Response }> {
  if (!isAuthEnabled()) {
    if (productionGuardActive()) {
      return { user: null, response: errorResponse(new MisconfiguredError().message, 503) };
    }
    return { user: AUTH_DISABLED_USER, response: null };
  }
  try {
    const user = await requireRole(role);
    return { user, response: null };
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return { user: null, response: errorResponse(e.message, 401) };
    }
    if (e instanceof ForbiddenError) {
      return { user: null, response: errorResponse(e.message, 403) };
    }
    if (e instanceof MisconfiguredError) {
      return { user: null, response: errorResponse(e.message, 503) };
    }
    throw e;
  }
}
