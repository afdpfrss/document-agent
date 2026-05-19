import { NextResponse } from "next/server";
import {
  searchDocumentsStream,
  type ChatTurn,
  type SearchEvent,
} from "@/lib/gemini-search";
import { requireUser, UnauthenticatedError } from "@/lib/auth-helpers";
import { friendlyLlmError } from "@/lib/llm-errors";

export const runtime = "nodejs";
export const maxDuration = 60;

// Defensive: cap the history we accept regardless of what the client sends.
// Client also trims, but the server is the trust boundary.
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CONTENT = 500;

function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    out.push({ role, content: trimmed.slice(0, MAX_HISTORY_CONTENT) });
  }
  return out.slice(-MAX_HISTORY_MESSAGES);
}

function friendlyError(message: string): string {
  return friendlyLlmError(message, "検索中にエラーが発生しました。");
}

export async function POST(req: Request) {
  // Any authenticated user (一般 or 編集) can search — only edit actions
  // require the elevated role.
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: e.message }, { status: 401 });
    }
    throw e;
  }

  let body: { question?: string; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const history = sanitizeHistory(body.history);
  const question = (body.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (question.length > 500) {
    return NextResponse.json(
      { error: "question is too long (max 500 chars)" },
      { status: 400 },
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "サーバーの設定が完了していません。管理者にお問い合わせください。" },
      { status: 503 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (ev: SearchEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      };
      try {
        for await (const ev of searchDocumentsStream(question, history)) {
          write(ev);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[/api/search] error:", message);
        write({ type: "error", error: friendlyError(message) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
