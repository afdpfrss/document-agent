// Server-side auth assertions. Throwing here instead of returning Responses
// directly lets the same helper work in both route handlers and server
// components — the caller decides how to translate the error.

import { auth, type Role } from "@/auth";

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

export async function requireUser(): Promise<AuthorizedUser> {
  if (!isAuthEnabled()) return AUTH_DISABLED_USER;
  const session = await auth();
  if (!session?.user?.email) throw new UnauthenticatedError();
  return {
    email: session.user.email,
    role: session.user.role,
    name: session.user.name ?? null,
  };
}

export async function requireRole(role: Role): Promise<AuthorizedUser> {
  if (!isAuthEnabled()) return AUTH_DISABLED_USER;
  const user = await requireUser();
  if (user.role !== role) throw new ForbiddenError(role);
  return user;
}

// Convenience for route handlers: maps the auth exceptions to NextResponse
// status codes so each handler doesn't repeat the same try/catch boilerplate.
// Returns null on success, a Response on failure (return it as-is).
export async function gateForRole(
  role: Role,
): Promise<{ user: AuthorizedUser; response: null } | { user: null; response: Response }> {
  if (!isAuthEnabled()) return { user: AUTH_DISABLED_USER, response: null };
  try {
    const user = await requireRole(role);
    return { user, response: null };
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return {
        user: null,
        response: new Response(JSON.stringify({ error: e.message }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    if (e instanceof ForbiddenError) {
      return {
        user: null,
        response: new Response(JSON.stringify({ error: e.message }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    throw e;
  }
}
