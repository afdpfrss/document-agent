// POST /api/edit/[docId]/submit
// Body: { newContent: string, message?: string, prBody?: string }
// Response: { branch, prNumber, prUrl, commitSha }
//
// Opens a PR against the configured base branch with the user-approved
// content. All edits funnel through this single endpoint so the audit
// trail (branch + PR + reviewer sign-off via CODEOWNERS) is uniform.

import { NextResponse } from "next/server";
import { loadIndex } from "@/lib/document-utils";
import { isGithubConfigured, proposeEdit } from "@/lib/github";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  newContent?: string;
  message?: string;
  prBody?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ docId: string }> },
) {
  const { docId } = await params;
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const newContent = body.newContent ?? "";
  const message = (body.message ?? "").trim();
  if (!newContent) {
    return NextResponse.json({ error: "newContent is required" }, { status: 400 });
  }
  if (newContent.length > 200_000) {
    return NextResponse.json({ error: "newContent too long" }, { status: 413 });
  }

  if (!isGithubConfigured()) {
    return NextResponse.json(
      { error: "GitHub バックエンドが未設定です。GITHUB_TOKEN を環境変数に設定してください。" },
      { status: 503 },
    );
  }

  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }

  const commitMessage = message || `Edit: ${doc.title}`;
  try {
    const result = await proposeEdit({
      path: doc.path,
      content: newContent,
      message: commitMessage,
      prBody:
        body.prBody ??
        `Edit proposed via chat-edit UI for \`${doc.path}\` (${docId} — ${doc.title}).`,
    });
    return NextResponse.json(result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[/api/edit/submit] error:", errMsg);
    return NextResponse.json(
      { error: `PR の作成に失敗しました: ${errMsg}` },
      { status: 502 },
    );
  }
}
