// ingest_documents MCP tool logic.
//
// Adds brand-new documents to the corpus through the same poka-yoke path as
// edits: branch → PR → CODEOWNERS review → merge (docs/v2-design.md §4-E / §10).
//
// All AI work — converting the source file (Word/Excel/PDF/Markdown …) to
// Markdown AND authoring each document's frontmatter — is done by the caller's
// own Claude. This server runs only the deterministic, non-AI steps:
// section-marker injection, doc_id assignment, frontmatter assembly, index.json
// update, and opening the PR. No answer-generating LLM and no developer-side
// Gemini are involved, so the MCP ingestion path stays entirely on the user's
// AI (no fallback).

import { loadIndex, type DocumentMeta } from "@/lib/document-utils";
import {
  buildFrontmatter,
  injectSectionMarkers,
  nextDocId,
  slugifyForFilename,
  todayIso,
  type SourceFormat,
} from "@/lib/ingest-core";
import {
  addPullRequestLabels,
  isGithubConfigured,
  proposeEditMulti,
} from "@/lib/github";
import { prDecoration, sanitizeForPrBody } from "./edit-tool";

const INDEX_PATH = "documents/index.json";
// Per-document body cap. Matches the web /upload pipeline's MAX_FINAL_BYTES.
const MAX_BODY_BYTES = 200_000;

export interface IngestDocumentInput {
  body: string;
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  source_format?: SourceFormat;
}

interface IngestFailure {
  index: number;
  title: string;
  problem: string;
}

export type IngestDocumentsResult =
  | {
      ok: true;
      doc_ids: string[];
      branch: string;
      pr_number: number;
      pr_url: string;
      ingested: number;
      summary: string;
    }
  | {
      ok: false;
      error: string;
      failures?: IngestFailure[];
    };

// A category string becomes a directory under documents/. Reject anything
// that would escape that directory or break the committed path.
function categoryIsSafe(category: string): boolean {
  return (
    category.length > 0 &&
    !category.includes("/") &&
    !category.includes("\\") &&
    !category.includes("..") &&
    !category.startsWith(".")
  );
}

export async function ingestDocuments(
  documents: IngestDocumentInput[],
  summary: string,
  proposer: string,
): Promise<IngestDocumentsResult> {
  if (!isGithubConfigured()) {
    return {
      ok: false,
      error:
        "GitHub バックエンドが未設定です（GITHUB_TOKEN）。PR を作成できません。管理者に連絡してください。",
    };
  }

  const index = await loadIndex();

  // doc_id はバッチ内で連番に採番する。nextDocId を素朴に N 回呼ぶと全件が
  // 同じ番号になるため、確定したエントリを runningSeen に積みながら採番する。
  const runningSeen: { id: string }[] = index.map((d) => ({ id: d.id }));
  const today = todayIso();

  const failures: IngestFailure[] = [];
  const newEntries: DocumentMeta[] = [];
  const files: { path: string; content: string }[] = [];

  for (let i = 0; i < documents.length; i++) {
    const d = documents[i];
    const title = d.title.trim();
    const category = d.category.trim();

    if (d.body.trim().length === 0) {
      failures.push({ index: i, title, problem: "本文が空です" });
      continue;
    }
    if (Buffer.byteLength(d.body, "utf8") > MAX_BODY_BYTES) {
      failures.push({
        index: i,
        title,
        problem: `本文サイズが上限（${MAX_BODY_BYTES} バイト）を超えています`,
      });
      continue;
    }
    if (!categoryIsSafe(category)) {
      failures.push({
        index: i,
        title,
        problem: `category が不正です: "${category}"（パス区切り文字や .. は使用不可）`,
      });
      continue;
    }
    if (title.length === 0) {
      failures.push({ index: i, title, problem: "title が空です" });
      continue;
    }

    const id = nextDocId(runningSeen);
    runningSeen.push({ id });

    const { body: bodyWithMarkers, sections } = injectSectionMarkers(
      d.body.trim() + "\n",
    );
    const keywords = d.keywords.map((k) => k.trim()).filter(Boolean);
    const docSummary = d.summary.trim();
    const sourceFormat: SourceFormat = d.source_format ?? "md";

    const frontmatter = buildFrontmatter({
      id,
      title,
      category,
      sourceFormat,
      keywords,
      summary: docSummary,
      sections,
      today,
    });
    const outPath = `documents/${category}/${id}_${slugifyForFilename(title)}.md`;
    const finalMarkdown = frontmatter + bodyWithMarkers.trim() + "\n";

    newEntries.push({
      id,
      title,
      category,
      path: outPath,
      keywords,
      summary: docSummary,
      sections,
    });
    files.push({ path: outPath, content: finalMarkdown });
  }

  // 取り込みは all-or-nothing。1 件でも不正なら PR を作らず診断を返す。
  if (failures.length > 0) {
    return {
      ok: false,
      error:
        "一部のドキュメントを取り込めませんでした。下記を修正して再試行してください。PR は作成していません。",
      failures,
    };
  }

  const newIndex = [...index, ...newEntries];
  files.push({
    path: INDEX_PATH,
    content: JSON.stringify(newIndex, null, 2) + "\n",
  });

  const deco = prDecoration(summary, proposer);
  const prBody = [
    `MCP コネクタ経由の新規ドキュメント取り込み提案です。`,
    `提案者: ${proposer}`,
    `取り込み件数: ${newEntries.length}`,
    "",
    `## 概要`,
    sanitizeForPrBody(summary),
    "",
    `## 取り込む文書`,
    ...newEntries.map(
      (e) =>
        `- ${e.id} — ${sanitizeForPrBody(e.title)}（${sanitizeForPrBody(
          e.category,
        )}） \`${e.path}\``,
    ),
    "",
    `---`,
    `この PR は人間レビュー前提です。差分を確認のうえマージしてください（自動マージなし / v2 設計 §10）。複数カテゴリに跨る場合は各カテゴリの CODEOWNERS の承認が必要です。`,
    "",
    ...deco.markerLines,
  ].join("\n");

  const result = await proposeEditMulti({
    files,
    message: deco.title,
    prBody,
  });

  // ラベルはベストエフォート — SoD の正本は本文のマーカー（提案者・デモ印）。
  try {
    await addPullRequestLabels(result.prNumber, deco.labels);
  } catch {
    // ignore — labelling is a UI nicety; the body markers are authoritative.
  }

  return {
    ok: true,
    doc_ids: newEntries.map((e) => e.id),
    branch: result.branch,
    pr_number: result.prNumber,
    pr_url: result.prUrl,
    ingested: newEntries.length,
    summary,
  };
}
