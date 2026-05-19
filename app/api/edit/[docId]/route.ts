// GET /api/edit/[docId] — returns the current markdown for the doc id, plus
// the lightweight metadata the editor UI needs to render its header.

import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { loadIndex } from "@/lib/document-utils";

export const runtime = "nodejs";

// Next 16: dynamic route params are a Promise — must await.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const { docId } = await params;
  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const filePath = path.join(process.cwd(), doc.path);
  const content = await fs.readFile(filePath, "utf8");
  return NextResponse.json({
    id: doc.id,
    title: doc.title,
    category: doc.category,
    path: doc.path,
    content,
  });
}
