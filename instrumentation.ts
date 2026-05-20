// Next.js instrumentation hook — runs once when the server process starts.
//
// Used to surface dangerous production configuration in the logs so a
// misconfigured deployment is noisy rather than silently insecure. The
// actual fail-closed enforcement lives in the route handlers (see
// lib/config-guard.ts); this is the operator-facing early warning.

import { productionConfigIssues } from "@/lib/config-guard";

export function register(): void {
  // register() also runs in the edge runtime — env-only checks are fine there
  // too, but keep startup logging to the node server to avoid duplicate lines.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const issues = productionConfigIssues();
  if (issues.length === 0) return;

  console.warn("[config-guard] ⚠ 本番環境で危険な設定が検出されました:");
  for (const issue of issues) {
    console.warn(`[config-guard] - ${issue}`);
  }
}
