// MCP server definition for the document-agent connector.
//
// Builds an McpServer (official @modelcontextprotocol/sdk) with the read-only
// document-search tools. The HTTP/transport wiring lives in
// app/api/mcp/route.ts; this module only declares tools and delegates to the
// existing lib/ search code (lib/mcp/tools.ts) — keeping the MCP layer loosely
// coupled to the rest of v2.
//
// This server NEVER calls an answer-generating LLM: it returns narrow,
// structured slices of the corpus and lets the caller's own Claude do the
// reasoning. Staged disclosure (docs/v2-design.md §3) is preserved by limiting
// how much each tool returns.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSections, listCategories, searchDocuments } from "./tools";
import { proposeDocumentEdit } from "./edit-tool";
import { isMcpAuthEnabled, SCOPE_EDIT } from "./oauth";

export const MCP_SERVER_NAME = "document-agent";
export const MCP_SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `社内ドキュメント検索エージェントの MCP コネクタです。

使い方（段階的開示）:
1. search_documents — 質問に関連する候補ドキュメントを絞り込む。返るのはフロントマター（タイトル・カテゴリ・キーワード・要約・セクション見出し）のみで本文は含まない。
2. get_sections — 候補から読むべきセクションを選び、本文を取得する。
3. 取得した本文だけを根拠に回答を組み立てる。
list_categories でカテゴリ一覧と文書数を確認できます。

ドキュメントの修正提案は propose_edit で行います。{find, replace, reason} の構造化編集を渡すと、GitHub に PR が作成されます（反映は人間の PR レビュー後）。

このサーバは回答生成を行いません。候補の最終選定も回答文の作成も、すべて呼び出し側で行ってください。`;

// Tools return their payload as a pretty-printed JSON string in a single text
// content block. Plain text avoids the extra outputSchema/structuredContent
// machinery while staying trivially parseable by the calling model.
function asToolResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

// A fresh server is built per request (stateless transport) — see route.ts.
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_documents",
    {
      title: "社内ドキュメント検索",
      description:
        "自然言語クエリで社内ドキュメントの候補プールを返す。メタデータ絞り込みとベクトル類似度（利用可能な場合）の和集合。返すのは各文書のフロントマター（doc_id・タイトル・カテゴリ・キーワード・要約・セクション見出し）のみで、本文は含まない。本文は get_sections で取得すること。最終的にどの文書を採用するかは呼び出し側で判断する。",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe("検索したい内容を表す自然言語クエリ"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => asToolResult(await searchDocuments(query)),
  );

  server.registerTool(
    "get_sections",
    {
      title: "セクション本文取得",
      description:
        "指定したドキュメントの指定セクションの本文を返す。doc_id と section_ids は search_documents の結果から取得する。各セクション本文は最大約3000文字に切り詰められる。一度に取得できるのは最大10セクション。",
      inputSchema: {
        doc_id: z
          .string()
          .min(1)
          .describe("ドキュメント ID（例: doc_001）"),
        section_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe('取得するセクション ID の配列（例: ["sec_1","sec_2"]）'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ doc_id, section_ids }) =>
      asToolResult(await getSections(doc_id, section_ids)),
  );

  server.registerTool(
    "list_categories",
    {
      title: "カテゴリ一覧",
      description:
        "社内ドキュメントのカテゴリ一覧と各カテゴリの文書数を返す。検索範囲の把握や絞り込みの足がかりに使う。",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => asToolResult(await listCategories()),
  );

  server.registerTool(
    "propose_edit",
    {
      title: "ドキュメント編集提案（PR 作成）",
      description:
        "ドキュメントに構造化編集を適用し、GitHub に branch + PR を作成して PR URL を返す。edits は {find, replace, reason} の配列。find は対象ドキュメントの原文に逐語で一意一致する必要がある（一致しない編集が1件でもあれば PR は作られず、各編集の診断が返るので find を修正して再試行する）。replace が空文字列なら削除。summary は PR タイトル兼コミットメッセージ。反映（マージ）は GitHub 上で人間がレビューして行う。",
      inputSchema: {
        doc_id: z
          .string()
          .min(1)
          .describe("編集対象のドキュメント ID（例: doc_001）"),
        edits: z
          .array(
            z.object({
              find: z
                .string()
                .min(1)
                .describe(
                  "原文に逐語で一意一致する置換対象テキスト。一意にするため周辺文脈を十分に含めること",
                ),
              replace: z
                .string()
                .describe("置換後テキスト（空文字列なら該当箇所を削除）"),
              reason: z.string().min(1).describe("この変更を行う理由"),
            }),
          )
          .min(1)
          .max(50)
          .describe("構造化編集の配列"),
        summary: z
          .string()
          .min(1)
          .max(150)
          .describe("PR タイトル兼コミットメッセージ（簡潔に）"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ doc_id, edits, summary }, extra) => {
      // Write action: require the mcp:edit scope when auth is on. When the
      // app's auth layer is off (local dev) everyone is treated as an editor,
      // consistent with the rest of the app.
      if (isMcpAuthEnabled()) {
        const scopes = extra.authInfo?.scopes ?? [];
        if (!scopes.includes(SCOPE_EDIT)) {
          return asToolResult({
            ok: false,
            error:
              "この操作には mcp:edit スコープが必要です。編集権限のあるアカウント（EDITOR_EMAILS）でコネクタを認可し直してください。",
          });
        }
      }
      const email = extra.authInfo?.extra?.email;
      const proposer =
        typeof email === "string" ? email : "mcp-connector (認証オフ)";
      return asToolResult(
        await proposeDocumentEdit(doc_id, edits, summary, proposer),
      );
    },
  );

  return server;
}
