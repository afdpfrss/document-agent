// POST /api/compose/submit
// Body: { title, category, keywords[], summary, body, message? }
// Response: CommitResult (github → {prUrl, prNumber, branch, ...} | local → {written})
//
// Takes the human-reviewed draft from the /compose creation chat and turns it
// into a real document: assigns the next doc id, injects section markers,
// builds the frontmatter, appends the new index.json entry, and hands the
// pair (md file + index.json) to commitFiles() — which opens a GitHub PR or
// writes to local disk depending on env. Reuses lib/ingest-core primitives so
// the output is byte-identical to the /upload pipeline.

import { NextResponse } from "next/server";
import { gateForRole } from "@/lib/auth-helpers";
import {
  invalidateIndexCache,
  loadIndex,
  type DocumentMeta,
} from "@/lib/document-utils";
import { commitFiles, type CommitResult } from "@/lib/commit-files";
import {
  buildFrontmatter,
  injectSectionMarkers,
  nextDocId,
  slugifyForFilename,
  todayIso,
} from "@/lib/ingest-core";
import { audit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

const INDEX_PATH = "documents/index.json";
const MAX_BODY_BYTES = 200_000;

interface Body {
  title?: string;
  category?: string;
  keywords?: string[];
  summary?: string;
  body?: string;
  message?: string;
}

export async function POST(req: Request) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  let input: Body;
  try {
    input = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = (input.title ?? "").trim();
  const category = (input.category ?? "").trim();
  const summary = (input.summary ?? "").trim();
  const docBody = (input.body ?? "").trim();
  const keywords = Array.isArray(input.keywords)
    ? input.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 8)
    : [];

  if (!title) {
    return NextResponse.json({ error: "タイトルを入力してください。" }, { status: 400 });
  }
  if (!category) {
    return NextResponse.json({ error: "カテゴリを入力してください。" }, { status: 400 });
  }
  if (!docBody) {
    return NextResponse.json({ error: "本文が空です。" }, { status: 400 });
  }
  // category becomes a path segment — keep it free of separators / traversal.
  if (/[\\/]|\.\./.test(category)) {
    return NextResponse.json({ error: "カテゴリ名に使用できない文字が含まれています。" }, { status: 400 });
  }
  if (Buffer.byteLength(docBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "本文が長すぎます。" }, { status: 413 });
  }

  // Preview-time index may be stale (another user ingested meanwhile) — refresh
  // so the assigned id is unique against the latest corpus.
  invalidateIndexCache();
  const index = await loadIndex();

  const { body: bodyWithMarkers, sections } = injectSectionMarkers(docBody + "\n");
  const id = nextDocId(index);
  const today = todayIso();
  const frontmatter = buildFrontmatter({
    id,
    title,
    category,
    sourceFormat: "md",
    keywords,
    summary,
    sections,
    today,
  });
  const outPath = `documents/${category}/${id}_${slugifyForFilename(title)}.md`;
  const finalMarkdown = frontmatter + bodyWithMarkers.trim() + "\n";

  const indexEntry: DocumentMeta = {
    id,
    title,
    category,
    path: outPath,
    keywords,
    summary,
    sections,
  };
  const newIndexJson = JSON.stringify([...index, indexEntry], null, 2) + "\n";

  const message = (input.message ?? "").trim() || `Create: ${title} (${id})`;

  let result: CommitResult;
  try {
    result = await commitFiles(
      [
        { path: outPath, content: finalMarkdown },
        { path: INDEX_PATH, content: newIndexJson },
      ],
      {
        message,
        prBody:
          `チャットで作成された新規文書です。\n\n` +
          `- ${id} ${title}（\`${outPath}\`）\n\n` +
          `最終的な内容は GitHub の diff で確認してください。`,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/compose/submit] error:", msg);
    return NextResponse.json(
      { error: `提出に失敗しました: ${msg}` },
      { status: 502 },
    );
  }

  // Local mode rewrote index.json in place — drop the cache so search sees it.
  if (result.mode === "local") invalidateIndexCache();

  const detail: Record<string, string | number | string[]> = { docIds: [id] };
  if (result.mode === "github") detail.prNumber = result.prNumber;
  audit({
    event: "pr.created",
    actor: gate.user.email,
    source: "web",
    outcome: "ok",
    detail,
  });

  return NextResponse.json(result);
}
