// GET /api/edit/[docId] — returns the current markdown for the doc id, plus
// the lightweight metadata the editor UI needs to render its header.

import { NextResponse } from "next/server";
import { loadIndex, readRepoFile } from "@/lib/document-utils";
import { gateForRole } from "@/lib/auth-helpers";

export const runtime = "nodejs";

// Next 16: dynamic route params are a Promise — must await.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  const { docId } = await params;
  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const content = await readRepoFile(doc.path);
  return NextResponse.json({
    id: doc.id,
    title: doc.title,
    category: doc.category,
    path: doc.path,
    content,
  });
}
