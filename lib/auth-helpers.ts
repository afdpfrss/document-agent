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

export async function requireUser(): Promise<AuthorizedUser> {
  const session = await auth();
  if (!session?.user?.email) throw new UnauthenticatedError();
  return {
    email: session.user.email,
    role: session.user.role,
    name: session.user.name ?? null,
  };
}

export async function requireRole(role: Role): Promise<AuthorizedUser> {
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
