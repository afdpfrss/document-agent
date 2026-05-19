// POST /api/upload/submit
// Body: { items: SubmitItem[], message?: string, prBody?: string }
// Response: CommitResult (github → {prUrl, prNumber, branch, ...} | local → {written: paths[]})
//
// Takes the user-edited previews from the upload UI, re-checks id uniqueness
// against the latest index.json, builds the final batch (md files + a single
// updated index.json), and hands it to commitFiles() — which routes to
// GitHub PR or local disk depending on env (lib/commit-files.ts).

import { NextResponse } from "next/server";
import { gateForRole } from "@/lib/auth-helpers";
import {
  invalidateIndexCache,
  loadIndex,
  type DocumentMeta,
} from "@/lib/document-utils";
import { commitFiles, type CommitResult } from "@/lib/commit-files";
import { nextDocId } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ITEMS = 10;
const MAX_FINAL_BYTES = 200_000; // per markdown file
const INDEX_PATH = "documents/index.json";

interface SubmitItem {
  id: string;
  outPath: string;
  finalMarkdown: string;
  indexEntry: DocumentMeta;
}

interface Body {
  items?: SubmitItem[];
  message?: string;
  prBody?: string;
}

export async function POST(req: Request) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const items = body.items ?? [];
  if (items.length === 0) {
    return NextResponse.json({ error: "items[] is empty" }, { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `最大 ${MAX_ITEMS} 件まで同時に提出できます` },
      { status: 413 },
    );
  }

  for (const item of items) {
    if (!item.outPath?.startsWith("documents/")) {
      return NextResponse.json(
        { error: `outPath が不正です: ${item.outPath}` },
        { status: 400 },
      );
    }
    if (item.outPath.includes("..")) {
      return NextResponse.json(
        { error: `outPath に .. を含めることはできません` },
        { status: 400 },
      );
    }
    if (Buffer.byteLength(item.finalMarkdown, "utf8") > MAX_FINAL_BYTES) {
      return NextResponse.json(
        { error: `${item.outPath}: 本文サイズが上限を超えています` },
        { status: 413 },
      );
    }
  }

  // Refresh against the latest index — preview was taken at request-time and
  // another user may have ingested in the meantime.
  invalidateIndexCache();
  const index = await loadIndex();

  // Reassign any id that collides with the current index or with a sibling
  // in the same batch. UI surfaces these via the `notices` field so the
  // submitter knows the doc_037 they previewed is now doc_038.
  const notices: string[] = [];
  const occupied = new Set(index.map((d) => d.id));
  const reIded: SubmitItem[] = [];
  const runningSeen: { id: string }[] = [...index];
  for (const item of items) {
    let nextId = item.id;
    if (occupied.has(nextId)) {
      nextId = nextDocId(runningSeen);
      notices.push(`${item.id} は既に存在するため ${nextId} に振り直しました`);
      const oldId = item.id;
      const newPath = item.outPath.replace(`${oldId}_`, `${nextId}_`);
      const finalMarkdown = item.finalMarkdown.replace(
        new RegExp(`^id: "${oldId}"`, "m"),
        `id: "${nextId}"`,
      );
      reIded.push({
        id: nextId,
        outPath: newPath,
        finalMarkdown,
        indexEntry: { ...item.indexEntry, id: nextId, path: newPath },
      });
      runningSeen.push({ id: nextId });
      occupied.add(nextId);
    } else {
      reIded.push(item);
      runningSeen.push({ id: nextId });
      occupied.add(nextId);
    }
  }

  // Build the new index.json: existing entries plus the new ones (upsert by id).
  const indexById = new Map<string, DocumentMeta>(index.map((d) => [d.id, d]));
  for (const item of reIded) {
    indexById.set(item.id, item.indexEntry);
  }
  const newIndex = [...indexById.values()];
  const newIndexJson = JSON.stringify(newIndex, null, 2) + "\n";

  const files = [
    ...reIded.map((item) => ({ path: item.outPath, content: item.finalMarkdown })),
    { path: INDEX_PATH, content: newIndexJson },
  ];

  const titlesPreview = reIded
    .slice(0, 3)
    .map((i) => i.indexEntry.title)
    .join(", ");
  const more = reIded.length > 3 ? ` ほか${reIded.length - 3}件` : "";
  const message =
    (body.message ?? "").trim() ||
    `Upload: ${titlesPreview}${more} (${reIded.length} 件)`;

  let result: CommitResult;
  try {
    result = await commitFiles(files, {
      message,
      prBody:
        body.prBody ??
        `Uploaded via /upload (${reIded.length} 件)\n\n` +
          reIded.map((i) => `- ${i.id} ${i.indexEntry.title} (\`${i.outPath}\`)`).join("\n"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/upload/submit] error:", msg);
    return NextResponse.json(
      { error: `提出に失敗しました: ${msg}`, notices },
      { status: 502 },
    );
  }

  // On local-mode success the on-disk index.json has been replaced; clear
  // the in-process cache so search picks up the new docs immediately.
  if (result.mode === "local") {
    invalidateIndexCache();
  }

  return NextResponse.json({ ...result, notices });
}
