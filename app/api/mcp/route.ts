// Remote MCP server endpoint (v2 design §4 — 提供レイヤーの追加).
//
// Exposes the document-search tools over the MCP Streamable HTTP transport so
// users can add this as a custom connector in their own Claude. Query-time
// inference moves to the user's side: this endpoint never calls an
// answer-generating LLM, it only serves structured slices of the corpus.
//
// Transport: WebStandardStreamableHTTPServerTransport — the SDK's Web-standard
// (Request/Response) transport, which plugs straight into a Next.js route
// handler with no Node http bridge.
//
// NOTE: Phase 1 ships WITHOUT auth. Do not deploy this publicly until the
// OAuth layer (Phase 2) is in place — internal documents would otherwise be
// reachable by anyone who knows the URL.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

// Node runtime: the search tools read documents/ off the filesystem via
// node:fs (see lib/document-utils.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handleMcp(req: Request): Promise<Response> {
  // Stateless: a fresh server + transport per request. The Streamable HTTP
  // transport explicitly forbids reusing a stateless transport across
  // requests (JSON-RPC id collisions between clients), and serverless
  // deployments don't share memory between invocations regardless.
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    console.error(
      "[/api/mcp] error:",
      err instanceof Error ? err.message : err,
    );
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      { status: 500 },
    );
  }
}

export { handleMcp as GET, handleMcp as POST, handleMcp as DELETE };
