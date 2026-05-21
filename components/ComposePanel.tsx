"use client";

// Dedicated chat page for creating or editing documents (v2 design Phase 6).
//
// One page, two modes selected by the top bar:
//   - 新規作成 (create): chat with the AI to draft a brand-new document. The
//     AI returns the full markdown body + suggested metadata; the user reviews
//     it in a Monaco editor and opens a PR via /api/compose/submit.
//   - 既存を編集 (edit): pick an existing document, then drop into the proven
//     chat editor (EditorPanel) — same {find, replace} structured-edit flow as
//     /edit/[docId], embedded inline so it all lives on one page.

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeMergedCells } from "@/lib/rehype-merged-cells";
import { EditorPanel } from "./EditorPanel";
import type { CommitResult } from "@/lib/commit-files";

const Editor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false, loading: () => <EditorLoading /> },
);

function EditorLoading() {
  return (
    <div className="h-full grid place-items-center text-sm text-slate-500">
      エディタを読み込み中…
    </div>
  );
}

export interface DocLite {
  id: string;
  title: string;
  category: string;
}

interface EditTarget {
  docId: string;
  docTitle: string;
  docCategory: string;
  docPath: string;
  initialContent: string;
}

type Mode = "create" | "edit";

interface Props {
  docs: DocLite[];
  categories: string[];
}

export function ComposePanel({ docs, categories }: Props) {
  const [mode, setMode] = useState<Mode>("create");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 flex items-center gap-3">
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-xs">
          {(["create", "edit"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 ${
                mode === m
                  ? "bg-indigo-900 text-white font-medium"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {m === "create" ? "新規作成" : "既存を編集"}
            </button>
          ))}
        </div>
        {mode === "edit" && editTarget && (
          <button
            type="button"
            onClick={() => setEditTarget(null)}
            className="text-xs text-slate-600 hover:text-indigo-700"
          >
            ← 別の文書を選ぶ
          </button>
        )}
        <span className="ml-auto text-xs text-slate-400 hidden sm:inline">
          {mode === "create"
            ? "AI と対話して新しい文書を作成します"
            : "既存の文書を AI と対話して編集します"}
        </span>
      </div>

      <div className="flex-1 min-h-0">
        {/* Kept mounted so switching modes doesn't discard an in-progress draft. */}
        <div className={mode === "create" ? "h-full" : "hidden"}>
          <CreateView categories={categories} />
        </div>
        {mode === "edit" && (
          <div className="h-full">
            {editTarget ? (
              <EditorPanel
                docId={editTarget.docId}
                docTitle={editTarget.docTitle}
                docCategory={editTarget.docCategory}
                docPath={editTarget.docPath}
                initialContent={editTarget.initialContent}
              />
            ) : (
              <EditPicker docs={docs} onPick={setEditTarget} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- edit mode: document picker ----------

function EditPicker({
  docs,
  onPick,
}: {
  docs: DocLite[];
  onPick: (t: EditTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(id: string) {
    setLoadingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/edit/${id}`);
      const data = (await res.json()) as {
        id?: string;
        title?: string;
        category?: string;
        path?: string;
        content?: string;
        error?: string;
      };
      if (!res.ok || !data.id || data.content === undefined) {
        setError(data.error ?? "文書の読み込みに失敗しました。");
        return;
      }
      onPick({
        docId: data.id,
        docTitle: data.title ?? data.id,
        docCategory: data.category ?? "",
        docPath: data.path ?? "",
        initialContent: data.content,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setLoadingId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? docs.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q),
      )
    : docs;
  const grouped = groupByCategory(filtered);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        <h2 className="text-lg font-bold text-slate-800">編集する文書を選択</h2>
        <p className="text-sm text-slate-500 mt-1 mb-4">
          選んだ文書を AI と対話しながら編集できます（{"{find, replace}"} 形式の構造化提案）。
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="タイトル・ID・カテゴリで絞り込み"
          className="w-full px-3 py-2 mb-4 rounded-md border border-slate-300 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        />
        {error && (
          <div className="mb-3 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}
        {grouped.length === 0 && (
          <p className="text-sm text-slate-500">該当する文書がありません。</p>
        )}
        <div className="space-y-4">
          {grouped.map(({ category, items }) => (
            <div key={category}>
              <h3 className="text-xs font-bold tracking-wide text-indigo-900 mb-1">
                {category}
                <span className="ml-1 text-slate-400 font-normal">
                  ({items.length})
                </span>
              </h3>
              <ul className="border border-slate-200 rounded-md divide-y divide-slate-100 bg-white">
                {items.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => pick(d.id)}
                      disabled={loadingId !== null}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="text-sm text-slate-800 flex-1 min-w-0 truncate">
                        {d.title}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">
                        {d.id}
                      </span>
                      {loadingId === d.id && (
                        <span className="text-xs text-indigo-700">読み込み中…</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function groupByCategory(
  docs: DocLite[],
): { category: string; items: DocLite[] }[] {
  const map = new Map<string, DocLite[]>();
  for (const d of docs) {
    const arr = map.get(d.category) ?? [];
    arr.push(d);
    map.set(d.category, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .map(([category, items]) => ({
      category,
      items: items.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

// ---------- create mode: chat-based drafting ----------

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

interface DraftResponse {
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  markdown: string;
  notes: string;
}

type MetaField = "title" | "category" | "keywords" | "summary";

const STARTER_PROMPTS = [
  "在宅勤務の申請ルールを新しい規程として整理して",
  "出張旅費の精算手順をまとめたマニュアルのたたき台を作って",
  "新入社員向けの入社初日の流れを説明する文書を作成して",
  "情報セキュリティの基本方針をわかりやすくまとめて",
];

function CreateView({ categories }: { categories: string[] }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  // Fields the user has hand-edited — the AI must not overwrite these on the
  // next turn, but it may keep refining anything still untouched.
  const [touched, setTouched] = useState<Set<MetaField>>(new Set());
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [drafting, setDrafting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<CommitResult | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, drafting]);

  function markTouched(f: MetaField) {
    setTouched((prev) => (prev.has(f) ? prev : new Set(prev).add(f)));
  }

  async function send(raw: string) {
    const text = raw.trim();
    if (!text || drafting || submission) return;
    const visible: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(visible);
    setInput("");
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch("/api/compose/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: visible
            .filter((m) => !m.error)
            .map((m) => ({ role: m.role, content: m.content })),
          currentDraft: draft,
        }),
      });
      const data = (await res.json()) as DraftResponse & { error?: string };
      if (!res.ok) {
        setMessages([
          ...visible,
          {
            role: "assistant",
            content: data.error ?? "下書きの生成に失敗しました。",
            error: true,
          },
        ]);
        return;
      }
      setDraft(data.markdown ?? "");
      if (!touched.has("title") && data.title) setTitle(data.title);
      if (!touched.has("category") && data.category) setCategory(data.category);
      if (!touched.has("keywords") && data.keywords?.length)
        setKeywords(data.keywords);
      if (!touched.has("summary") && data.summary) setSummary(data.summary);
      setMessages([
        ...visible,
        {
          role: "assistant",
          content: data.notes || "下書きを更新しました。",
        },
      ]);
    } catch (e) {
      setMessages([
        ...visible,
        {
          role: "assistant",
          content: e instanceof Error ? e.message : "通信エラーが発生しました。",
          error: true,
        },
      ]);
    } finally {
      setDrafting(false);
    }
  }

  async function submitDoc() {
    if (submitting || submission) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/compose/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          category: category.trim(),
          keywords,
          summary: summary.trim(),
          body: draft,
        }),
      });
      const data = (await res.json()) as CommitResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "提出に失敗しました。");
        return;
      }
      setSubmission(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setMessages([]);
    setInput("");
    setDraft("");
    setTitle("");
    setCategory("");
    setKeywords([]);
    setSummary("");
    setKeywordInput("");
    setTouched(new Set());
    setView("edit");
    setError(null);
    setSubmission(null);
  }

  function addKeyword() {
    const v = keywordInput.trim().replace(/,$/, "");
    if (v && !keywords.includes(v)) {
      setKeywords([...keywords, v].slice(0, 8));
      markTouched("keywords");
    }
    setKeywordInput("");
  }

  const canSubmit =
    !!draft.trim() &&
    !!title.trim() &&
    !!category.trim() &&
    !submitting &&
    !submission;

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-slate-200 bg-white px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-bold text-slate-800">新しい文書を作成</h1>
          <p className="text-xs text-slate-500">
            AI が生成した下書きは PR レビューを経て反映されます（自動マージなし）。
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {submission ? (
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800"
            >
              別の文書を作成
            </button>
          ) : (
            <button
              type="button"
              onClick={submitDoc}
              disabled={!canSubmit}
              className="px-4 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800 disabled:bg-slate-300"
            >
              {submitting ? "提出中…" : "PR を作成"}
            </button>
          )}
        </div>
      </header>

      {submission && <SubmissionBanner result={submission} />}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-4 sm:px-6 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 flex flex-col border-r border-slate-200">
          <div className="border-b border-slate-200 bg-white px-4 py-3 space-y-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <label className="flex-1 block">
                <span className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5 block">
                  タイトル
                </span>
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    markTouched("title");
                  }}
                  placeholder="例：在宅勤務規程"
                  className="w-full px-2 py-1 border border-slate-300 rounded-md text-sm"
                />
              </label>
              <label className="sm:w-56 block">
                <span className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5 block">
                  カテゴリ
                </span>
                <input
                  list="compose-category-list"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    markTouched("category");
                  }}
                  placeholder="既存から選択 / 新規入力"
                  className="w-full px-2 py-1 border border-slate-300 rounded-md text-sm"
                />
                <datalist id="compose-category-list">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5 block">
                要約
              </span>
              <textarea
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                  markTouched("summary");
                }}
                rows={2}
                placeholder="文書の概要（検索結果に表示されます）"
                className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
              />
            </label>
            <div>
              <span className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5 block">
                キーワード
              </span>
              <div className="flex flex-wrap gap-1 mb-1">
                {keywords.map((k, i) => (
                  <span
                    key={`${k}-${i}`}
                    className="inline-flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded text-xs"
                  >
                    {k}
                    <button
                      type="button"
                      onClick={() => {
                        setKeywords(keywords.filter((_, j) => j !== i));
                        markTouched("keywords");
                      }}
                      className="text-slate-500 hover:text-red-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                placeholder="Enter または , で追加"
                className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
              />
            </div>
          </div>

          <div className="flex border-b border-slate-200 bg-slate-50">
            {(
              [
                ["edit", "編集"],
                ["preview", "プレビュー"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setView(m)}
                className={`px-4 py-2 text-xs border-b-2 transition-colors ${
                  view === m
                    ? "border-indigo-700 text-slate-900 bg-white font-medium"
                    : "border-transparent text-slate-600 hover:text-slate-800 hover:bg-slate-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {view === "edit" ? (
              <Editor
                height="100%"
                language="markdown"
                value={draft}
                theme="vs"
                onChange={(v) => setDraft(v ?? "")}
                options={{
                  wordWrap: "on",
                  minimap: { enabled: false },
                  fontSize: 13,
                  automaticLayout: true,
                }}
              />
            ) : (
              <div className="h-full overflow-y-auto px-6 py-5 markdown bg-white">
                {draft.trim() ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeMergedCells]}
                  >
                    {draft}
                  </ReactMarkdown>
                ) : (
                  <p className="text-sm text-slate-400">
                    まだ下書きがありません。
                  </p>
                )}
              </div>
            )}
          </div>
        </main>

        <aside className="w-[340px] lg:w-[380px] flex flex-col bg-slate-50">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          >
            {messages.length === 0 && !drafting && (
              <div className="mt-4">
                <h2 className="text-sm font-bold text-slate-700 mb-1">
                  どんな文書を作りますか？
                </h2>
                <p className="text-xs text-slate-500 mb-3">
                  作りたい文書を説明すると、AI が本文の下書きを生成します。
                </p>
                <div className="space-y-2">
                  {STARTER_PROMPTS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => send(q)}
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <ChatBubble key={i} message={m} />
            ))}
            {drafting && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3">
                  <div
                    className="flex items-center gap-1.5"
                    aria-label="下書きを生成中"
                  >
                    <span className="streaming-dot" />
                    <span
                      className="streaming-dot"
                      style={{ animationDelay: "150ms" }}
                    />
                    <span
                      className="streaming-dot"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="border-t border-slate-200 px-4 py-3 bg-white"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={
                submission
                  ? "提出済みです。「別の文書を作成」で続けられます。"
                  : messages.length === 0
                    ? "例：育児休業の申請手順をまとめた文書を作って"
                    : "修正や追記を指示（例：第2章に注意事項を追加）"
              }
              rows={3}
              maxLength={2000}
              disabled={drafting || !!submission}
              className="w-full text-sm rounded-md border border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 p-2 disabled:bg-slate-50"
            />
            <button
              type="submit"
              disabled={drafting || !input.trim() || !!submission}
              className="mt-2 w-full px-3 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800 disabled:bg-slate-300"
            >
              {drafting
                ? "下書きを生成中…"
                : messages.length === 0
                  ? "AI に下書きを依頼"
                  : "AI に修正を依頼"}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMsg }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-indigo-900 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[90%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap border ${
          message.error
            ? "bg-red-50 border-red-200 text-red-800"
            : "bg-white border-slate-200 text-slate-700"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

function SubmissionBanner({ result }: { result: CommitResult }) {
  if (result.mode === "github") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-4 sm:px-6 py-3 text-sm">
        PR を作成しました:{" "}
        <a
          href={result.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-green-800 underline font-medium"
        >
          #{result.prNumber} ({result.branch})
        </a>
      </div>
    );
  }
  return (
    <div className="bg-green-50 border-b border-green-200 px-4 sm:px-6 py-3 text-sm text-green-900">
      ローカルに書き込みました（{result.written.length} ファイル）。
    </div>
  );
}
