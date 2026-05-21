// POST /api/edit/[docId]/propose
// Body: { instruction: string, originalContent: string }
// Response: { edits: [{find, replace, reason}], applied: {content, statuses} }
//
// Generates AI edit proposals against the supplied originalContent (the
// client passes the content it's currently editing, not necessarily the
// on-disk version, so the user can iterate without race conditions against
// the underlying file).

import { NextResponse } from "next/server";
import { loadIndex } from "@/lib/document-utils";
import { proposeEditsViaLlm } from "@/lib/edit-llm";
import { applyEdits } from "@/lib/edit-schema";
import { gateForRole } from "@/lib/auth-helpers";
import { isLlmConfigured } from "@/lib/llm-config";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  instruction?: string;
  originalContent?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  const { docId } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const instruction = (body.instruction ?? "").trim();
  const originalContent = body.originalContent ?? "";
  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }
  if (!originalContent) {
    return NextResponse.json({ error: "originalContent is required" }, { status: 400 });
  }
  if (instruction.length > 2000) {
    return NextResponse.json({ error: "instruction too long (max 2000 chars)" }, { status: 400 });
  }
  if (originalContent.length > 80_000) {
    return NextResponse.json(
      { error: "originalContent too long (max 80k chars)" },
      { status: 413 },
    );
  }

  if (!isLlmConfigured()) {
    return NextResponse.json(
      { error: "サーバーの設定が完了していません。管理者にお問い合わせください。" },
      { status: 503 },
    );
  }

  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }

  try {
    const proposal = await proposeEditsViaLlm({
      docTitle: doc.title,
      docCategory: doc.category,
      originalContent,
      instruction,
    });
    const applied = applyEdits(originalContent, proposal.edits);
    return NextResponse.json({ edits: proposal.edits, applied });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/edit/propose] error:", message);
    return NextResponse.json({ error: "編集提案の生成に失敗しました。" }, { status: 502 });
  }
}
