// Site-wide auth gate (v2 design Phase 7).
//
// Strategy: require an authenticated session for every page and API route
// except Auth.js's own endpoints. Role-level gating (一般 vs 編集) is
// enforced per-route at the handler level — middleware only ensures the
// caller is logged in at all.

import { auth } from "@/auth";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Auth.js's own pages must be reachable while unauthenticated, otherwise
  // sign-in becomes a redirect loop. Same for static assets.
  if (pathname.startsWith("/api/auth")) return;

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
