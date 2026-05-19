// Auth.js v5 configuration for v2 design Phase 7.
//
// One provider (Google), two roles (一般 / 編集). Role is derived from an
// EDITOR_EMAILS allowlist in the environment — keeps the design's "no DB
// for content" principle intact (docs/v2-design.md §10) and means promoting
// or demoting an editor is a single env-var edit rather than a migration.

import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";

export type Role = "一般" | "編集";

function editorEmails(): string[] {
  return (process.env.EDITOR_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function roleFor(email: string | null | undefined): Role {
  if (!email) return "一般";
  return editorEmails().includes(email.trim().toLowerCase()) ? "編集" : "一般";
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [Google],
  pages: {
    // Default Auth.js pages are fine for the PoC — branding can come later.
  },
  callbacks: {
    // Attach the derived role to both the JWT (so middleware can read it on
    // every request without an env lookup) and the session (so client +
    // server components share the same shape).
    jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email as string;
        token.role = roleFor(token.email);
      } else if (token.email && !token.role) {
        token.role = roleFor(token.email as string);
      }
      return token;
    },
    session({ session, token }) {
      session.user.role = (token.role as Role | undefined) ?? roleFor(session.user.email);
      return session;
    },
  },
});

// Module augmentation — make session.user.role show up wherever Session is
// referenced (server components, route handlers, client useSession()).
// We deliberately don't augment JWT here: that interface lives in
// @auth/core/jwt (an internal subpath that's awkward to depend on); the
// callback above casts token.role locally where it's needed.
declare module "next-auth" {
  interface Session {
    user: { role: Role } & DefaultSession["user"];
  }
}
