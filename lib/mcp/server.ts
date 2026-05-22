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
import {
  findTextOccurrences,
  getSections,
  listCategories,
  searchDocuments,
} from "./tools";
import {
  AUTH_OFF_PROPOSER,
  parseProposerMarker,
  proposeDocumentEdit,
  proposeRelatedEdit,
} from "./edit-tool";
import { ingestDocuments } from "./ingest-tool";
import { isMcpAuthEnabled, SCOPE_EDIT, SCOPE_MERGE } from "./oauth";
import {
  getPullRequest,
  getPullRequestChecks,
  getPullRequestDiff,
  getPullRequestReviews,
  isGithubConfigured,
  mergePullRequest,
} from "@/lib/github";

export const MCP_SERVER_NAME = "document-agent";
export const MCP_SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `社内ドキュメント検索エージェントの MCP コネクタです。

使い方（段階的開示）:
1. search_documents — 質問に関連する候補ドキュメントを絞り込む。返るのはフロントマター（タイトル・カテゴリ・キーワード・要約・セクション見出し）のみで本文は含まない。
2. get_sections — 候補から読むべきセクションを選び、本文を取得する。
3. 取得した本文だけを根拠に回答を組み立てる。
list_categories でカテゴリ一覧と文書数を確認できます。

ドキュメントの編集（編集→レビュー→承認→マージ）:
- propose_edit — 1つの文書に {find, replace, reason} の構造化編集を適用し PR を作成する。
- find_text_occurrences / propose_related_edit — 同じ記述を複数の関連資料にまとめて修正する「横展開」。先に find_text_occurrences で影響範囲を全件確認してから propose_related_edit に渡す。
- ingest_documents — 新規ドキュメント（複数可）をコーパスに追加し PR を作成する。元ファイルの Markdown 化とフロントマター生成は呼び出し側（あなた）が行い、このサーバは決定的な組み立てと PR 作成だけを担う。
- review_edit — PR の差分・CI・承認状況を取得する。承認自体は GitHub の PR ページで行う。
- merge_edit — ゲート（CI・CODEOWNERS 承認・提案者≠承認者）をすべて満たした PR をマージする。

逐語マッチに失敗した編集が1件でもあれば PR は作られず診断が返ります。反映（マージ）は人間レビューを経た PR でのみ行われ、自動マージはありません。

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
        "自然言語クエリで社内ドキュメントの候補プールを返す。メタデータ駆動（キーワード・タイトル・カテゴリ・見出しの一致）で絞り込む。返すのは各文書のフロントマター（doc_id・タイトル・カテゴリ・キーワード・要約・セクション見出し）のみで、本文は含まない。本文は get_sections で取得すること。最終的にどの文書を採用するかは呼び出し側で判断する。",
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
    "find_text_occurrences",
    {
      title: "文字列の横断検索（横展開の影響範囲調査）",
      description:
        "指定した文字列が逐語で出現する全文書・全セクションを列挙する読み取り専用ツール。横展開編集（同じ記述を複数の関連資料にまとめて修正する）の前に、その文字列がどこに何箇所あるかを漏れなく把握するために使う。ここで挙がった文書を propose_related_edit に渡すと1つの PR にまとめて修正できる。",
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(500)
          .describe("出現箇所を調べたい逐語文字列"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text }) => asToolResult(await findTextOccurrences(text)),
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
        typeof email === "string" ? email : AUTH_OFF_PROPOSER;
      return asToolResult(
        await proposeDocumentEdit(doc_id, edits, summary, proposer),
      );
    },
  );

  server.registerTool(
    "propose_related_edit",
    {
      title: "横展開編集の提案（複数文書を1つの PR に）",
      description:
        "関連する複数の文書に構造化編集を適用し、すべてを1つの GitHub PR にまとめて作成する。changes は {doc_id, edits} の配列で、edits は各文書ごとの {find, replace, reason} 配列。全文書・全編集が原文に逐語一致して初めて PR を作る — 1件でも不一致なら PR を作らず doc_id 別に診断を返すので、find を修正して再試行する。影響範囲は事前に find_text_occurrences で確認すること。複数カテゴリに跨る場合は各カテゴリの CODEOWNERS のレビューが必要になる。summary は PR タイトル兼コミットメッセージ。反映（マージ）は人間の PR レビュー後。",
      inputSchema: {
        changes: z
          .array(
            z.object({
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
                .describe("その文書への構造化編集の配列"),
            }),
          )
          .min(1)
          .max(20)
          .describe("文書ごとの編集の配列。同じ doc_id を複数回含めないこと"),
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
    async ({ changes, summary }, extra) => {
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
      const proposer = typeof email === "string" ? email : AUTH_OFF_PROPOSER;
      return asToolResult(
        await proposeRelatedEdit(changes, summary, proposer),
      );
    },
  );

  server.registerTool(
    "ingest_documents",
    {
      title: "新規ドキュメントの取り込み（PR 作成）",
      description:
        "1件以上の新規ドキュメントをコーパスに追加し、GitHub に branch + PR を作成する。呼び出し側（あなた）が、元ファイル（Word/Excel/PDF/Markdown 等）の Markdown 化と、各文書のフロントマター（title / category / keywords / summary）の生成の両方を行うこと。このサーバは AI 推論を一切行わず、セクションマーカー付与・doc_id 採番・フロントマター組み立て・index.json 更新・PR 作成という決定的な処理だけを担う。\n\n各 documents 要素の body は本文 Markdown のみ（フロントマターは含めない。title 等は別フィールドで渡す）。本文中の `## ` 見出しがセクションとして認識される。category は事前に list_categories で既存カテゴリを確認してから指定すること（新規カテゴリも可だが、既存への統一を推奨）。\n\n複数ファイルは documents 配列にまとめて1回で渡すと、すべてが1つの PR にまとまる。1件でも不正があれば PR は作られず診断が返る（all-or-nothing）。反映（マージ）は人間の PR レビュー後。",
      inputSchema: {
        documents: z
          .array(
            z.object({
              body: z
                .string()
                .min(1)
                .describe(
                  "本文 Markdown（フロントマターは含めない）。`## ` 見出しがセクションになる",
                ),
              title: z
                .string()
                .min(1)
                .max(120)
                .describe("ドキュメントのタイトル"),
              category: z
                .string()
                .min(1)
                .max(60)
                .describe(
                  "カテゴリ。list_categories で既存カテゴリを確認してから指定する",
                ),
              keywords: z
                .array(z.string().min(1))
                .max(12)
                .describe(
                  "検索用キーワード（メタデータ駆動検索の精度に直結するので必ず付ける）",
                ),
              summary: z
                .string()
                .min(1)
                .max(400)
                .describe("本文の要約（80〜200字程度）"),
              source_format: z
                .enum(["html", "docx", "pdf", "xlsx", "csv", "txt", "md"])
                .optional()
                .describe("元ファイルの形式（任意・既定 md）"),
            }),
          )
          .min(1)
          .max(10)
          .describe(
            "取り込む新規ドキュメントの配列（最大10件、すべて1つの PR にまとまる）",
          ),
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
    async ({ documents, summary }, extra) => {
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
      const proposer = typeof email === "string" ? email : AUTH_OFF_PROPOSER;
      return asToolResult(
        await ingestDocuments(documents, summary, proposer),
      );
    },
  );

  server.registerTool(
    "review_edit",
    {
      title: "編集 PR のレビュー支援",
      description:
        "指定した PR の差分・ファイル別変更量・CI チェック状況・承認状況・記録された提案者を返す読み取り専用ツール。propose_edit / propose_related_edit が作成した PR をレビューするのに使う。このツール自体は承認・マージを行わない。差分が正しいと判断したら GitHub の PR ページを開き、CODEOWNERS レビュアーとして GitHub 上で承認すること。",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .positive()
          .describe("レビュー対象の PR 番号"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pr_number }) => {
      if (!isGithubConfigured()) {
        return asToolResult({
          ok: false,
          error: "GitHub バックエンドが未設定です（GITHUB_TOKEN）。",
        });
      }
      try {
        const [pr, diff, checks, reviewInfo] = await Promise.all([
          getPullRequest(pr_number),
          getPullRequestDiff(pr_number),
          getPullRequestChecks(pr_number),
          getPullRequestReviews(pr_number),
        ]);
        // 差分が極端に長い場合だけ切り詰める。文書編集の差分は通常小さい。
        const MAX_DIFF = 50000;
        const diffText =
          diff.diff.length > MAX_DIFF
            ? `${diff.diff.slice(0, MAX_DIFF)}\n…(差分が長いため ${MAX_DIFF} 文字で切り詰め。全体は PR ページで確認すること)`
            : diff.diff;
        return asToolResult({
          ok: true,
          pr_number: pr.number,
          title: pr.title,
          url: pr.url,
          branch: pr.branch,
          state: pr.state,
          merged: pr.merged,
          proposer: parseProposerMarker(pr.body),
          files: diff.files,
          diff: diffText,
          checks,
          reviews: reviewInfo.reviews,
          mergeable: reviewInfo.mergeable,
          mergeable_state: reviewInfo.mergeableState,
          next_step:
            "差分を確認し、内容が正しければ GitHub の PR ページ（上記 url）を開き、CODEOWNERS レビュアーとして承認すること。このチャットで「承認」と返信しても承認にはならない。",
        });
      } catch (err) {
        return asToolResult({
          ok: false,
          error: `PR #${pr_number} を取得できませんでした: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  );

  server.registerTool(
    "merge_edit",
    {
      title: "編集 PR のマージ",
      description:
        "指定した PR をマージする。GitHub のブランチ保護が「CI green・CODEOWNERS 承認・base 最新・SoD pass」をすべて満たさないマージを API レベルで拒否するため、ゲート未達なら何が未達かを構造化エラーで返す。これは自動マージではない — 人間が GitHub 上で差分を確認・承認した後に人間が明示的に起動するアクション。confirm_pr_url は対象 PR の URL で、pr_number の PR の URL と一致しなければマージしない（PR 取り違え防止）。",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .positive()
          .describe("マージ対象の PR 番号"),
        confirm_pr_url: z
          .string()
          .url()
          .describe(
            "マージ対象 PR の URL。pr_number の PR の html_url と一致しなければマージを中止する",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ pr_number, confirm_pr_url }, extra) => {
      // 書き込み操作: 認証 ON のとき mcp:merge スコープを要求する。
      if (isMcpAuthEnabled()) {
        const scopes = extra.authInfo?.scopes ?? [];
        if (!scopes.includes(SCOPE_MERGE)) {
          return asToolResult({
            ok: false,
            error:
              "この操作には mcp:merge スコープが必要です。MERGER_EMAILS に登録されたアカウントでコネクタを認可し直してください。",
          });
        }
      }
      if (!isGithubConfigured()) {
        return asToolResult({
          ok: false,
          error: "GitHub バックエンドが未設定です（GITHUB_TOKEN）。",
        });
      }
      try {
        const pr = await getPullRequest(pr_number);
        // 取り違え防止 — URL 不一致ならマージしない。
        if (pr.url !== confirm_pr_url) {
          return asToolResult({
            ok: false,
            error: `confirm_pr_url が PR #${pr_number} の URL と一致しません（指定: ${confirm_pr_url} / 実際: ${pr.url}）。マージを中止しました。`,
          });
        }
        if (pr.merged) {
          return asToolResult({
            ok: false,
            error: `PR #${pr_number} は既にマージ済みです。`,
          });
        }
        if (pr.state !== "open") {
          return asToolResult({
            ok: false,
            error: `PR #${pr_number} は open ではありません（state: ${pr.state}）。`,
          });
        }

        const result = await mergePullRequest(pr_number);
        if (result.ok) {
          return asToolResult({
            ok: true,
            pr_number,
            merged: true,
            merge_commit_sha: result.mergeCommitSha,
            message: `PR #${pr_number} をマージしました。`,
          });
        }

        // ブロックされた — 何が red かを具体的に示す。
        const [checks, reviewInfo] = await Promise.all([
          getPullRequestChecks(pr_number).catch(() => []),
          getPullRequestReviews(pr_number).catch(() => null),
        ]);
        return asToolResult({
          ok: false,
          blocked_by: result.blockedBy ?? "other",
          error: `PR #${pr_number} はマージできません（ブランチ保護のゲート未達）。`,
          github_message: result.message,
          checks,
          reviews: reviewInfo?.reviews ?? [],
          mergeable_state: reviewInfo?.mergeableState ?? "unknown",
          next_step:
            "review_edit で差分と CI 状況を確認し、未達のゲート（CI / CODEOWNERS 承認 / base 最新化 / SoD）を解消してから再試行すること。",
        });
      } catch (err) {
        return asToolResult({
          ok: false,
          error: `マージ処理でエラーが発生しました: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  );

  return server;
}
