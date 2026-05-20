import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node/Vercel deployments read the document corpus off disk at runtime
  // (lib/document-utils.ts) — trace ./documents into every route bundle since
  // the .md paths come from index.json and can't be statically detected.
  // (The Cloudflare/OpenNext build instead embeds the corpus as a module via
  // scripts/build-corpus.mjs — Workers have no project filesystem.)
  outputFileTracingIncludes: {
    "/*": ["./documents/**/*"],
  },
  // Serve the OAuth discovery documents at their RFC-mandated /.well-known
  // paths (the MCP client builds these URLs itself). The actual handlers live
  // under /api/mcp/oauth/metadata/* so they share the MCP route tree.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/mcp/oauth/metadata/authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/mcp/oauth/metadata/protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/mcp/oauth/metadata/protected-resource",
      },
    ];
  },
};

export default nextConfig;

// Cloudflare (OpenNext) integration. This is a no-op for a plain `next build`
// /`next dev`; it only wires getCloudflareContext() so bindings declared in
// wrangler.jsonc are reachable while running `next dev`. The production build
// for Cloudflare is produced by `opennextjs-cloudflare build`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
