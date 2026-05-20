// Site-wide auth gate (v2 design Phase 7).
//
// Strategy: require an authenticated session for every page and API route
// except Auth.js's own endpoints. Role-level gating (一般 vs 編集) is
// enforced per-route at the handler level — middleware only ensures the
// caller is logged in at all.

import { auth } from "@/auth";

export default auth((req) => {
  // Feature switch: when Google OAuth env vars aren't set, the entire auth
  // layer is off (per Phase 7 toggle in lib/auth-helpers.ts). Bail before
  // reading req.auth so we don't depend on AUTH_SECRET either.
  if (!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET) return;

  const { pathname } = req.nextUrl;

  // Auth.js's own pages must be reachable while unauthenticated, otherwise
  // sign-in becomes a redirect loop. Same for static assets.
  if (pathname.startsWith("/api/auth")) return;

  // MCP connector endpoints self-gate with OAuth bearer tokens, not browser
  // sessions: /api/mcp returns a 401 + WWW-Authenticate (never an HTML
  // redirect), and the OAuth discovery / authorize / token / register
  // endpoints must be reachable unauthenticated. The authorize endpoint runs
  // its own NextAuth session check internally.
  if (pathname.startsWith("/api/mcp")) return;
  if (pathname.startsWith("/.well-known/")) return;

  if (!req.auth) {
    const signIn = new URL("/api/auth/signin", req.nextUrl.origin);
    signIn.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return Response.redirect(signIn);
  }
});

export const config = {
  // Exclude Next's internals and static files from middleware so we don't
  // chew CPU on every image/JS chunk request. /favicon.ico is also public.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico)$).*)"],
};
