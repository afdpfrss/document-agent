// POST /api/delete
// Body: { ids: string[], message?: string }
// Response: CommitResult (github → {prUrl, prNumber, ...} | local → {written: paths[]})
//
// Removes the listed documents from documents/ and the matching entries from
// documents/index.json in a single atomic commit. Both single-doc and
// whole-category deletes funnel through this — the UI passes whichever set
// of ids it wants gone. Goes through the PR backend in github mode so the
// audit trail is identical to uploads/edits.

import { NextResponse } from "next/server";
import { gateForRole } from "@/lib/auth-helpers";
import { invalidateIndexCache, loadIndex } from "@/lib/document-utils";
import { commitFiles, type CommitResult } from "@/lib/commit-files";

export const runtime = "nodejs";
export const maxDuration = 60;

// Generous compared to upload (10) — a category delete can naturally hit
// ~10 docs in one shot, and the operation itself is cheap server-side.
const MAX_IDS = 50;
const INDEX_PATH = "documents/index.json";

interface Body {
  ids?: string[];
  message?: string;
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

  const ids = (body.ids ?? []).filter((s): s is string => typeof s === "string");
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids[] is empty" }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `最大 ${MAX_IDS} 件まで同時に削除できます` },
      { status: 413 },
    );
  }

  invalidateIndexCache();
  const index = await loadIndex();
  const byId = new Map(index.map((d) => [d.id, d]));

  const missing: string[] = [];
  const targets: { id: string; title: string; path: string }[] = [];
  for (const id of ids) {
    const d = byId.get(id);
    if (!d) {
      missing.push(id);
      continue;
    }
    // Defence-in-depth: index.json could in principle hold a bogus path.
    // Refuse anything that would escape documents/ before passing it to fs.rm.
    if (!d.path.startsWith("documents/") || d.path.includes("..")) {
      return NextResponse.json(
        { error: `不正な path: ${d.path}` },
        { status: 400 },
      );
    }
    targets.push({ id: d.id, title: d.title, path: d.path });
  }
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `存在しない id: ${missing.join(", ")}` },
      { status: 404 },
    );
  }

  const remaining = index.filter((d) => !ids.includes(d.id));
  const newIndexJson = JSON.stringify(remaining, null, 2) + "\n";

  const titlesPreview = targets
    .slice(0, 3)
    .map((t) => t.title)
    .join(", ");
  const more = targets.length > 3 ? ` ほか${targets.length - 3}件` : "";
  const message =
    (body.message ?? "").trim() ||
    `Delete: ${titlesPreview}${more} (${targets.length} 件)`;

  let result: CommitResult;
  try {
    result = await commitFiles(
      [{ path: INDEX_PATH, content: newIndexJson }],
      {
        message,
        prBody:
          `Deleted via /documents (${targets.length} 件)\n\n` +
          targets.map((t) => `- ${t.id} ${t.title} (\`${t.path}\`)`).join("\n"),
        deletions: targets.map((t) => t.path),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/delete] error:", msg);
    return NextResponse.json(
      { error: `削除に失敗しました: ${msg}` },
      { status: 502 },
    );
  }

  if (result.mode === "local") {
    invalidateIndexCache();
  }

  return NextResponse.json(result);
}
