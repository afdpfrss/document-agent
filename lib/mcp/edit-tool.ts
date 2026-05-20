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
import { loadIndex, type DocumentMeta } from "@/lib/document-utils";
import { applyEdits, type FindReplaceEdit } from "@/lib/edit-schema";
import {
  addPullRequestLabels,
  isGithubConfigured,
  proposeEdit,
  proposeEditMulti,
} from "@/lib/github";

const ROOT = process.cwd();

// PR 本文に埋め込む機械可読マーカー（ポカヨケ設計 柱3）。separation-of-duties
// ワークフローが提案者を読み取り、提案者≠承認者を強制するのに使う。<email> は
// 認証済み OAuth のメールアドレスで、利用者が直接詐称できる値ではない。
const PROPOSER_MARKER_RE = /<!--\s*poka-yoke:proposer=(\S+?)\s*-->/;

export function buildProposerMarker(proposer: string): string {
  return `<!-- poka-yoke:proposer=${proposer} -->`;
}

export function parseProposerMarker(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const m = PROPOSER_MARKER_RE.exec(body);
  return m ? m[1] : null;
}

// 認証オフ時に server.ts が渡す提案者センチネル。SoD では検証不能なので
// マーカー値・ラベルとも "unverified" にして fail closed させる。
export const AUTH_OFF_PROPOSER = "mcp-connector (認証オフ)";

function proposerMarkerValue(proposer: string): string {
  return proposer === AUTH_OFF_PROPOSER ? "unverified" : proposer;
}

function proposerLabel(proposer: string): string {
  const slug =
    proposer === AUTH_OFF_PROPOSER
      ? "unverified"
      : proposer.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `proposer:${slug}`;
}

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

interface DocEditOutcome {
  doc: DocumentMeta;
  original: string;
  content: string;
  failures: EditFailure[];
  unchanged: boolean;
}

// 1文書に編集を逐語適用する共有ヘルパー（propose_edit と propose_related_edit
// が共用）。doc が見つからなければ null。failures が空でなければ逐語不一致が
// あるということ — 呼び出し側はその場合 PR を作らない。
async function applyDocEdits(
  index: DocumentMeta[],
  docId: string,
  edits: FindReplaceEdit[],
): Promise<DocEditOutcome | null> {
  const doc = index.find((d) => d.id === docId);
  if (!doc) return null;
  const original = await fs.readFile(path.join(ROOT, doc.path), "utf8");
  const { content, statuses } = applyEdits(original, edits);
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
  return { doc, original, content, failures, unchanged: content === original };
}

const VERBATIM_FAIL_MSG =
  "一部の編集が原文に逐語一致しませんでした（0 件一致 または 複数箇所一致）。find により多くの周辺文脈を含めて一意にし、再試行してください。PR は作成していません。";

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
  const outcome = await applyDocEdits(index, docId, edits);
  if (!outcome) {
    return {
      ok: false,
      error: `doc_id が見つかりません: ${docId}。search_documents で正しい doc_id を確認してください。`,
    };
  }

  // Every edit must match verbatim exactly once. If any does not, we open NO
  // PR and hand the per-edit diagnosis back so the caller can fix its `find`
  // strings and retry — a PR should reflect the full intended change.
  if (outcome.failures.length > 0) {
    return { ok: false, error: VERBATIM_FAIL_MSG, failures: outcome.failures };
  }
  if (outcome.unchanged) {
    return {
      ok: false,
      error: "編集後の内容が原文と同一です。PR は作成していません。",
    };
  }

  const { doc } = outcome;
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
    "",
    buildProposerMarker(proposerMarkerValue(proposer)),
  ].join("\n");

  const result = await proposeEdit({
    path: doc.path,
    content: outcome.content,
    message: summary,
    prBody,
  });

  // 提案者ラベルはベストエフォート — SoD の正本は本文の提案者マーカー。
  // ラベル付けに失敗しても PR 作成自体は成功しているので握りつぶす。
  try {
    await addPullRequestLabels(result.prNumber, [proposerLabel(proposer)]);
  } catch {
    // ignore — labelling is a UI nicety; the body marker is authoritative.
  }

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

// --- 横展開（複数文書を1つの PR にまとめて修正） --------------------------

export interface RelatedEditChange {
  doc_id: string;
  edits: FindReplaceEdit[];
}

interface RelatedEditFailure extends EditFailure {
  doc_id: string;
}

export type ProposeRelatedEditResult =
  | {
      ok: true;
      doc_ids: string[];
      branch: string;
      pr_number: number;
      pr_url: string;
      applied_edits: number;
      summary: string;
    }
  | {
      ok: false;
      error: string;
      failures?: RelatedEditFailure[];
    };

// 関連する複数文書を1つの PR にまとめて修正する。全文書・全編集が逐語一致して
// 初めて PR を作る（横展開の all-or-nothing）。1件でも不一致なら PR を作らず
// doc_id 別の診断を返す。複数カテゴリに跨ると CODEOWNERS が各カテゴリチームの
// 承認を要求する。
export async function proposeRelatedEdit(
  changes: RelatedEditChange[],
  summary: string,
  proposer: string,
): Promise<ProposeRelatedEditResult> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      error:
        "GitHub バックエンドが未設定です（GITHUB_TOKEN）。PR を作成できません。管理者に連絡してください。",
    };
  }

  // 同じ文書への編集は1エントリにまとめさせる（applyEdits は逐次適用なので
  // 同一文書を分割すると2件目が古い原文に対して走り混乱する）。
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.doc_id)) {
      return {
        ok: false,
        error: `doc_id が重複しています: ${c.doc_id}。同じ文書への編集は1つの changes エントリにまとめてください。`,
      };
    }
    seen.add(c.doc_id);
  }

  const index = await loadIndex();
  const outcomes: { docId: string; outcome: DocEditOutcome }[] = [];
  const failures: RelatedEditFailure[] = [];

  for (const c of changes) {
    const outcome = await applyDocEdits(index, c.doc_id, c.edits);
    if (!outcome) {
      return {
        ok: false,
        error: `doc_id が見つかりません: ${c.doc_id}。search_documents で正しい doc_id を確認してください。PR は作成していません。`,
      };
    }
    for (const f of outcome.failures) {
      failures.push({ doc_id: c.doc_id, ...f });
    }
    outcomes.push({ docId: c.doc_id, outcome });
  }

  if (failures.length > 0) {
    return { ok: false, error: VERBATIM_FAIL_MSG, failures };
  }

  const changedFiles = outcomes
    .filter((o) => !o.outcome.unchanged)
    .map((o) => ({ path: o.outcome.doc.path, content: o.outcome.content }));
  if (changedFiles.length === 0) {
    return {
      ok: false,
      error: "すべての編集が原文と同一でした。PR は作成していません。",
    };
  }

  const totalEdits = changes.reduce((n, c) => n + c.edits.length, 0);
  const prBody = [
    `MCP コネクタ経由の横展開編集提案です（関連する複数文書をまとめて修正）。`,
    `提案者: ${proposer}`,
    "",
    `## 概要`,
    summary,
    "",
    `## 対象文書と編集理由`,
    ...outcomes.flatMap(({ docId, outcome }) => {
      const c = changes.find((x) => x.doc_id === docId)!;
      const suffix = outcome.unchanged ? "（変更なし — PR から除外）" : "";
      return [
        `### ${outcome.doc.id} — ${outcome.doc.title} \`${outcome.doc.path}\`${suffix}`,
        ...c.edits.map((e, i) => `${i + 1}. ${e.reason}`),
        "",
      ];
    }),
    `---`,
    `この PR は人間レビュー前提です。関連文書をまとめて変更しているため、影響する各カテゴリの CODEOWNERS による確認が必要です（自動マージなし / v2 設計 §10）。`,
    "",
    buildProposerMarker(proposerMarkerValue(proposer)),
  ].join("\n");

  const result = await proposeEditMulti({
    files: changedFiles,
    message: summary,
    prBody,
  });

  try {
    await addPullRequestLabels(result.prNumber, [proposerLabel(proposer)]);
  } catch {
    // ignore — labelling is a UI nicety; the body marker is authoritative.
  }

  return {
    ok: true,
    doc_ids: outcomes.filter((o) => !o.outcome.unchanged).map((o) => o.docId),
    branch: result.branch,
    pr_number: result.prNumber,
    pr_url: result.prUrl,
    applied_edits: totalEdits,
    summary,
  };
}
