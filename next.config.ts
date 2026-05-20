import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/search": ["./documents/**/*"],
    "/api/mcp": ["./documents/**/*"],
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

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
