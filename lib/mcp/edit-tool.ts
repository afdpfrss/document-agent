// propose_edit MCP tool logic (v2 design Phase 3, §4-D / §4-E / §10).
//
// The caller's Claude generates structured {find, replace, reason} edits — the
// MCP tool input_schema enforces that shape, the structured-output equivalent
// of Gemini's responseSchema. The server applies them verbatim with
// edit-schema.applyEdits() and, if every edit matches cleanly, opens a GitHub
// PR via github.proposeEdit(). Human review happens on the PR (no auto-merge,
// docs/v2-design.md §10).

import fs from "node:fs/promises";
import path from "node:path";
import { loadIndex } from "@/lib/document-utils";
import { applyEdits, type FindReplaceEdit } from "@/lib/edit-schema";
import { isGithubConfigured, proposeEdit } from "@/lib/github";

const ROOT = process.cwd();

interface EditFailure {
  index: number;
  problem: "not_found" | "ambiguous";
  find: string;
  matches?: number;
}

export type ProposeEditResult =
  | {
      ok: true;
      doc_id: string;
      title: string;
      branch: string;
      pr_number: number;
      pr_url: string;
      applied_edits: number;
      summary: string;
    }
  | {
      ok: false;
      error: string;
      failures?: EditFailure[];
    };

// Truncate a find-string for echoing back in an error payload.
function clip(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function proposeDocumentEdit(
  docId: string,
  edits: FindReplaceEdit[],
  summary: string,
  proposer: string,
): Promise<ProposeEditResult> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      error:
        "GitHub バックエンドが未設定です（GITHUB_TOKEN）。PR を作成できません。管理者に連絡してください。",
    };
  }

  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return {
      ok: false,
      error: `doc_id が見つかりません: ${docId}。search_documents で正しい doc_id を確認してください。`,
    };
  }

  const original = await fs.readFile(path.join(ROOT, doc.path), "utf8");
  const { content, statuses } = applyEdits(original, edits);

  // Every edit must match verbatim exactly once. If any does not, we open NO
  // PR and hand the per-edit diagnosis back so the caller can fix its `find`
  // strings and retry — a PR should reflect the full intended change.
  const failures: EditFailure[] = statuses
    .filter((s) => s.kind !== "ok")
    .map((s) =>
      s.kind === "ambiguous"
        ? {
            index: s.index,
            problem: "ambiguous" as const,
            find: clip(s.find),
            matches: s.matches,
          }
        : { index: s.index, problem: "not_found" as const, find: clip(s.find) },
    );
  if (failures.length > 0) {
    return {
      ok: false,
      error:
        "一部の編集が原文に逐語一致しませんでした（0 件一致 または 複数箇所一致）。find により多くの周辺文脈を含めて一意にし、再試行してください。PR は作成していません。",
      failures,
    };
  }

  if (content === original) {
    return {
      ok: false,
      error: "編集後の内容が原文と同一です。PR は作成していません。",
    };
  }

  const prBody = [
    `MCP コネクタ経由の編集提案です。`,
    `提案者: ${proposer}`,
    `対象: \`${doc.path}\` (${doc.id} — ${doc.title})`,
    "",
    `## 概要`,
    summary,
    "",
    `## 各編集の理由`,
    ...edits.map((e, i) => `${i + 1}. ${e.reason}`),
    "",
    `---`,
    `この PR は人間レビュー前提です。差分を確認のうえマージしてください（自動マージなし / v2 設計 §10）。`,
  ].join("\n");

  const result = await proposeEdit({
    path: doc.path,
    content,
    message: summary,
    prBody,
  });

  return {
    ok: true,
    doc_id: doc.id,
    title: doc.title,
    branch: result.branch,
    pr_number: result.prNumber,
    pr_url: result.prUrl,
    applied_edits: edits.length,
    summary,
  };
}
