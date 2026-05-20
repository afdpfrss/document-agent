import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/search": ["./documents/**/*"],
    "/api/mcp": ["./documents/**/*"],
  },
};

export default nextConfig;
