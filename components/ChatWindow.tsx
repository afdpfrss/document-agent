"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DocumentReference, type SearchSource } from "./DocumentReference";
import { LoadingIndicator } from "./LoadingIndicator";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SearchSource[];
  error?: boolean;
  streaming?: boolean;
}

const SAMPLE_QUESTIONS = [
  "有給休暇は何日もらえますか？",
  "リモートワークの条件は？",
  "セキュリティポリシーで禁止されていることは？",
  "出張時の経費申請の流れを教えてください",
  "育休中の給与はどうなりますか？",
];

export function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  async function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    setMessages((m) => [...m, { role: "user", content: trimmed }]);
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
        body: JSON.stringify({ question: trimmed }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: data.error ?? "エラーが発生しました。",
            error: true,
          },
        ]);
        return;
      }

      // Placeholder assistant message we'll fill incrementally.
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "", sources: [], streaming: true },
      ]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let firstDelta = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev: {
            type: "sources" | "delta" | "done" | "error";
            sources?: SearchSource[];
            text?: string;
            error?: string;
          };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
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
          } else if (ev.type === "done") {
            updateAssistant({ streaming: false });
          } else if (ev.type === "error") {
            updateAssistant({
              content: ev.error ?? "エラーが発生しました。",
              error: true,
              streaming: false,
            });
          }
        }
      }
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
              社内ドキュメントについて、なんでも聞いてください
            </h2>
            <p className="text-sm text-slate-500 mb-8">
              自然言語で質問すると、関連ドキュメントを横断検索して回答します。
            </p>
            <div className="grid sm:grid-cols-2 gap-2 max-w-2xl mx-auto">
              {SAMPLE_QUESTIONS.map((q) => (
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
          <MessageBubble key={i} message={m} />
        ))}

        {loading && <LoadingIndicator />}
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
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
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
        ) : (
          <>
            <div className="markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
              {message.streaming && <span className="streaming-caret" aria-hidden />}
            </div>
            {message.streaming && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
                <span className="streaming-dot" />
                <span className="streaming-dot" style={{ animationDelay: "150ms" }} />
                <span className="streaming-dot" style={{ animationDelay: "300ms" }} />
                <span className="ml-1">生成中…</span>
              </div>
            )}
            {message.sources && message.sources.length > 0 && (
              <DocumentReference sources={message.sources} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
