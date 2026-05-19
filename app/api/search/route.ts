import { NextResponse } from "next/server";
import {
  searchDocumentsStream,
  type ChatTurn,
  type SearchEvent,
} from "@/lib/gemini-search";
import { requireUser, UnauthenticatedError } from "@/lib/auth-helpers";

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

function formatRetryDelay(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `約${Math.max(1, Math.ceil(seconds))}秒後`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `約${minutes}分後`;
  const hours = Math.ceil(minutes / 60);
  return `約${hours}時間後`;
}

// Try to turn a Gemini 429 / quota error string into something a user can act on.
// Gemini errors include either a quota metric name (containing PerMinute / PerDay /
// input_token_count) or a `retryDelay: "23s"` field — we use both when present.
function explainQuotaError(message: string): string | null {
  if (!/429|rate|quota|RESOURCE_EXHAUSTED|exceeded/i.test(message)) return null;

  const isDay = /per[_-]?day|daily|PerDay/i.test(message);
  const isMinute = /per[_-]?minute|PerMinute|\brpm\b/i.test(message);
  const isToken = /token[_-]?count|tokens?\b/i.test(message);

  const retryMatch = message.match(/retry[_-]?delay["':\s]+(\d+(?:\.\d+)?)\s*s/i);
  const retrySeconds = retryMatch ? parseFloat(retryMatch[1]) : 0;
  const wait = formatRetryDelay(retrySeconds);

  if (isDay) {
    const kind = isToken ? "トークン" : "リクエスト";
    const tail = wait
      ? `${wait}に制限がリセットされる見込みです。`
      : "制限のリセットまで時間を空けてから（通常は翌日）お試しください。";
    return `Gemini API の1日あたりの${kind}上限（無料枠）に達しました。${tail}`;
  }

  if (isMinute) {
    const tail = wait ? `${wait}に再度お試しください。` : "1〜2分ほど待ってから再度お試しください。";
    return `Gemini API の1分あたりのリクエスト上限（無料枠）に達しました。${tail}`;
  }

  // 429 だが粒度が読み取れない場合
  const tail = wait
    ? `${wait}に再度お試しください。`
    : "1〜2分ほど待ってから再度お試しください。それでも改善しない場合は1日あたりの上限の可能性があります。";
  return `Gemini API のレート制限（無料枠）に達しました。${tail}`;
}

function friendlyError(message: string): string {
  if (/GEMINI_API_KEY/.test(message)) {
    return "サーバーの設定が完了していません。管理者にお問い合わせください。";
  }
  const quota = explainQuotaError(message);
  if (quota) return quota;
  return "検索中にエラーが発生しました。";
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
