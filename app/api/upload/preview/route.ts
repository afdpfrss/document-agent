// POST /api/upload/preview
// multipart/form-data with one or more `files` parts.
// Returns { previews: PreviewItem[], knownCategories: string[], warnings: string[] }
//
// Runs the full ingest pipeline (convert → section markers → LLM frontmatter)
// for each file in parallel but writes nothing — the UI shows the result so
// the user can correct title/category/keywords/summary/body before commit.

import { NextResponse } from "next/server";
import { gateForRole } from "@/lib/auth-helpers";
import { loadIndex } from "@/lib/document-utils";
import {
  buildPreview,
  isSupportedExtension,
  nextDocId,
  SUPPORTED_EXTENSIONS,
  categoriesFromIndex,
  type IngestPreview,
} from "@/lib/ingest-core";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total
const MAX_FILES = 10;

export interface PreviewResponse {
  previews: (IngestPreview & { tempId: string })[];
  knownCategories: string[];
  warnings: string[];
}

export async function POST(req: Request) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
  }

  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "files[] is empty" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `最大 ${MAX_FILES} ファイルまで同時にアップロードできます` },
      { status: 413 },
    );
  }
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: `合計サイズが上限 ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB を超えています` },
      { status: 413 },
    );
  }

  const index = await loadIndex();
  const knownCategories = categoriesFromIndex(index);
  const warnings: string[] = [];

  // id allocation: nextDocId needs the *latest* index plus any siblings
  // assigned in this same batch, so we maintain a running list as we go.
  const seen: { id: string }[] = [...index];

  // Convert in parallel but assign ids sequentially after they all finish —
  // the LLM call dominates wall time anyway, so ordering ids by input order
  // doesn't cost us much and keeps the UI predictable.
  const settled = await Promise.all(
    files.map(async (file): Promise<{ ok: true; file: File; raw: Awaited<ReturnType<typeof buildOne>> } | { ok: false; file: File; error: string }> => {
      if (file.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          file,
          error: `${file.name}: ファイルサイズが上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB を超えています`,
        };
      }
      const ext = file.name.slice(file.name.lastIndexOf("."));
      if (!isSupportedExtension(ext)) {
        return {
          ok: false,
          file,
          error: `${file.name}: 未対応の形式 (${ext})。対応: ${SUPPORTED_EXTENSIONS.join(", ")}`,
        };
      }
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const raw = await buildOne(buffer, file.name, index);
        return { ok: true, file, raw };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, file, error: `${file.name}: 変換失敗 (${msg})` };
      }
    }),
  );

  const previews: (IngestPreview & { tempId: string })[] = [];
  for (const r of settled) {
    if (!r.ok) {
      warnings.push(r.error);
      continue;
    }
    // Re-id sequentially against `seen` so two files in the same batch
    // don't both claim doc_037.
    const newId = nextDocId(seen);
    seen.push({ id: newId });
    const preview = { ...r.raw, id: newId };
    // outPath and indexEntry both embed the id — rebuild them.
    preview.outPath = preview.outPath.replace(/doc_\d+_/, `${newId}_`);
    preview.indexEntry = { ...preview.indexEntry, id: newId, path: preview.outPath };
    preview.frontmatter = preview.frontmatter.replace(/^id: "doc_\d+"/m, `id: "${newId}"`);
    preview.finalMarkdown = preview.frontmatter + preview.body;
    previews.push({ ...preview, tempId: crypto.randomUUID() });
  }

  const res: PreviewResponse = { previews, knownCategories, warnings };
  return NextResponse.json(res);
}

async function buildOne(buffer: Buffer, filename: string, index: Awaited<ReturnType<typeof loadIndex>>) {
  return buildPreview({ buffer, filename, index });
}
