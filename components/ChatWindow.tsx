"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DocumentReference, type SearchSource } from "./DocumentReference";
import { rehypeMergedCells } from "@/lib/rehype-merged-cells";
import { BUILD_NUMBER, BUILD_DATE } from "@/lib/build-info";
import {
  CHAT_HEADINGS,
  CHAT_SUBTITLES,
  SAMPLE_QUESTIONS,
  pickRandom,
  sampleN,
} from "@/lib/sample-prompts";

const DISPLAY_QUESTION_COUNT = 5;

interface FollowupContext {
  doc_ids: string[];
  language: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SearchSource[];
  error?: boolean;
  streaming?: boolean;
  // Drill-down suggestions rendered as clickable chips below the answer.
  followups?: string[];
  // Carry context for a chip click: re-sending one of `followups` with this
  // focus lets the server skip Step 1.
  followupContext?: FollowupContext;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Last 3 round-trips (6 messages) of clean history, with a soft char budget so
// even chatty sessions don't blow the Step 1 prompt budget. Error bubbles and
// empty placeholders are excluded so we don't echo failed turns back to the
// model.
function buildHistory(msgs: ChatMessage[]): ChatTurn[] {
  const usable = msgs.filter(
    (m) => !m.error && !m.streaming && m.content.trim().length > 0,
  );
  const tail = usable.slice(-6);
  const turns: ChatTurn[] = [];
  let budget = 1500;
  for (let i = tail.length - 1; i >= 0; i--) {
    const c = tail[i].content.slice(0, 500);
    if (budget - c.length < 0) break;
    budget -= c.length;
    turns.unshift({ role: tail[i].role, content: c });
  }
  return turns;
}

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // SSR と CSR 初回描画を一致させるため、初期値は配列の先頭で固定。
  // マウント直後の useEffect でランダム化することでハイドレーション崩れを避ける。
  const [heading, setHeading] = useState(CHAT_HEADINGS[0]);
  const [subtitle, setSubtitle] = useState(CHAT_SUBTITLES[0]);
  const [questions, setQuestions] = useState<string[]>(() =>
    SAMPLE_QUESTIONS.slice(0, DISPLAY_QUESTION_COUNT),
  );

  useEffect(() => {
    // 連続表示で同じ内容が出ないよう、前回値を localStorage で覚えて除外する。
    const HEADING_KEY = "chat:last-heading";
    const SUBTITLE_KEY = "chat:last-subtitle";
    const QUESTIONS_KEY = "chat:last-questions";

    const lastHeading = localStorage.getItem(HEADING_KEY);
    const lastSubtitle = localStorage.getItem(SUBTITLE_KEY);
    let lastQuestions: string[] = [];
    try {
      const raw = localStorage.getItem(QUESTIONS_KEY);
      if (raw) lastQuestions = JSON.parse(raw);
    } catch {
      lastQuestions = [];
    }

    const headingPool = CHAT_HEADINGS.filter((h) => h !== lastHeading);
    const subtitlePool = CHAT_SUBTITLES.filter((s) => s !== lastSubtitle);
    // 質問は前回表示した5件を除いた中から5件抽出。残数が足りなければ全体から補完。
    const questionPool = SAMPLE_QUESTIONS.filter(
      (q) => !lastQuestions.includes(q),
    );
    const nextQuestions =
      questionPool.length >= DISPLAY_QUESTION_COUNT
        ? sampleN(questionPool, DISPLAY_QUESTION_COUNT)
        : sampleN(SAMPLE_QUESTIONS, DISPLAY_QUESTION_COUNT);

    const nextHeading = pickRandom(headingPool);
    const nextSubtitle = pickRandom(subtitlePool);

    setHeading(nextHeading);
    setSubtitle(nextSubtitle);
    setQuestions(nextQuestions);

    localStorage.setItem(HEADING_KEY, nextHeading);
    localStorage.setItem(SUBTITLE_KEY, nextSubtitle);
    localStorage.setItem(QUESTIONS_KEY, JSON.stringify(nextQuestions));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  async function submit(question: string, focus?: FollowupContext) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    // Snapshot history BEFORE we push the new user message — the new one is
    // sent as `question`, prior turns as `history`.
    const history = buildHistory(messages);
    // Push the user message AND the assistant placeholder in a single state
    // update. The placeholder must appear immediately so the loading dots
    // render right away — waiting until after `await fetch()` resolved was
    // adding several seconds of dead air before any UI feedback (the server
    // doesn't flush response headers until Step 1 starts producing output).
    setMessages((m) => [
      ...m,
      { role: "user", content: trimmed },
      { role: "assistant", content: "", sources: [], streaming: true },
    ]);
    setInput("");
    setLoading(true);

    const updateAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (!last || last.role !== "assistant") return m;
        copy[copy.length - 1] = { ...last, ...patch };
        return copy;
      });
    };

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          history,
          ...(focus ? { focus } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        updateAssistant({
          content: data.error ?? "エラーが発生しました。",
          error: true,
          streaming: false,
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let firstDelta = true;

      const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        let ev: {
          type: "sources" | "delta" | "followups" | "done" | "error";
          sources?: SearchSource[];
          text?: string;
          error?: string;
          items?: string[];
          language?: string;
          doc_ids?: string[];
        };
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "sources") {
          updateAssistant({ sources: ev.sources ?? [] });
        } else if (ev.type === "delta") {
          content += ev.text ?? "";
          if (firstDelta) {
            firstDelta = false;
            setLoading(false);
          }
          updateAssistant({ content });
        } else if (ev.type === "followups") {
          updateAssistant({
            followups: ev.items ?? [],
            followupContext: {
              doc_ids: ev.doc_ids ?? [],
              language: ev.language ?? "ja",
            },
          });
        } else if (ev.type === "done") {
          updateAssistant({ streaming: false });
        } else if (ev.type === "error") {
          updateAssistant({
            content: ev.error ?? "エラーが発生しました。",
            error: true,
            streaming: false,
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      // Flush any trailing line not terminated by "\n" (e.g. a proxy stripped
      // the final newline) — otherwise a last done/error event would be lost.
      buffer += decoder.decode();
      handleLine(buffer);
      updateAssistant({ streaming: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "通信エラーが発生しました。";
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === "assistant" && last.content === "") {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", content: msg, error: true };
          return copy;
        }
        return [...m, { role: "assistant", content: msg, error: true }];
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto w-full">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-5"
      >
        {messages.length === 0 && (
          <div className="text-center mt-10 sm:mt-16">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-800 mb-2">
              {heading}
            </h2>
            <p className="text-sm text-slate-500 mb-8">
              {subtitle}
            </p>
            <div className="grid sm:grid-cols-2 gap-2 max-w-2xl mx-auto">
              {questions.map((q) => (
                <button
                  key={q}
                  onClick={() => submit(q)}
                  className="text-left text-sm px-4 py-3 rounded-lg border border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <MessageBubble
            key={i}
            message={m}
            disabled={loading}
            onFollowup={submit}
          />
        ))}
      </div>

      <div className="border-t border-slate-200 bg-white px-4 sm:px-6 py-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="flex gap-2 max-w-4xl mx-auto"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="質問を入力（例：有給休暇について）"
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
            maxLength={500}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-5 py-2.5 rounded-lg bg-indigo-900 text-white font-medium hover:bg-indigo-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            送信
          </button>
        </form>
        <p className="text-xs text-slate-400 mt-2 text-center">
          回答はAI（Gemini）が生成しています。重要事項は必ず原文を確認してください。
        </p>
        <p className="text-[11px] text-slate-400 mt-1 text-center">
          Build {BUILD_NUMBER}（{BUILD_DATE}）
        </p>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  disabled,
  onFollowup,
}: {
  message: ChatMessage;
  disabled: boolean;
  onFollowup: (question: string, focus?: FollowupContext) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-indigo-900 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[92%] w-full bg-white border rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm ${
          message.error ? "border-red-200" : "border-slate-200"
        }`}
      >
        {message.error ? (
          <p className="text-sm text-red-700">{message.content}</p>
        ) : message.streaming && !message.content ? (
          <div className="flex items-center gap-1.5 py-1" aria-label="読み込み中">
            <span className="streaming-dot" />
            <span className="streaming-dot" style={{ animationDelay: "150ms" }} />
            <span className="streaming-dot" style={{ animationDelay: "300ms" }} />
          </div>
        ) : (
          <>
            <div className="markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeMergedCells]}
              >
                {message.content}
              </ReactMarkdown>
              {message.streaming && (
                <span className="streaming-caret" aria-hidden />
              )}
            </div>
            {message.sources && message.sources.length > 0 && (
              <DocumentReference sources={message.sources} />
            )}
            {!message.streaming &&
              message.followups &&
              message.followups.length > 0 && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <p className="text-xs font-semibold text-slate-500 mb-2">
                    次に知りたいこと
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {message.followups.map((f) => (
                      <button
                        key={f}
                        onClick={() => onFollowup(f, message.followupContext)}
                        disabled={disabled}
                        className="text-left text-xs px-3 py-1.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-900 hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
