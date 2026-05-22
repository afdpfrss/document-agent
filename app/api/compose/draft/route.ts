// POST /api/compose/draft
// Body: { messages: {role, content}[], currentDraft: string }
// Response: { title, category, keywords, summary, markdown, notes }
//
// Drives the chat-based new-document drafting on /compose. The client sends
// the running conversation plus whatever it is currently showing in the
// editor; the LLM returns a fresh full-document draft + suggested metadata +
// a short chat reply. Nothing is written here — submission is a separate,
// human-confirmed step (POST /api/compose/submit).

import { NextResponse } from "next/server";
import { gateForRole } from "@/lib/auth-helpers";
import { loadIndex } from "@/lib/document-utils";
import { categoriesFromIndex } from "@/lib/ingest-core";
import { draftDocumentViaLlm, type DraftMessage } from "@/lib/draft-llm";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 4000;
const MAX_DRAFT_CHARS = 80_000;

interface Body {
  messages?: DraftMessage[];
  currentDraft?: string;
}

export async function POST(req: Request) {
  const gate = await gateForRole("編集");
  if (gate.response) return gate.response;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const currentDraft = body.currentDraft ?? "";

  if (messages.length === 0) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 });
  }
  if (messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "会話が長くなりすぎました。" }, { status: 413 });
  }
  for (const m of messages) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return NextResponse.json({ error: "messages の形式が不正です。" }, { status: 400 });
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json(
        { error: `メッセージが長すぎます（最大 ${MAX_MESSAGE_CHARS} 字）。` },
        { status: 413 },
      );
    }
  }
  if (currentDraft.length > MAX_DRAFT_CHARS) {
    return NextResponse.json(
      { error: `下書きが長すぎます（最大 ${MAX_DRAFT_CHARS} 字）。` },
      { status: 413 },
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "サーバーの設定が完了していません。管理者にお問い合わせください。" },
      { status: 503 },
    );
  }

  const index = await loadIndex();
  const knownCategories = categoriesFromIndex(index);

  try {
    const result = await draftDocumentViaLlm({
      messages,
      currentDraft,
      knownCategories,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/compose/draft] error:", message);
    return NextResponse.json(
      { error: message.slice(0, 300) },
      { status: 502 },
    );
  }
}
