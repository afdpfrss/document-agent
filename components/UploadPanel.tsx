"use client";

// Multi-file upload UI (v2 design Phase 3 / B-1).
//
// Flow:
//   1. Drag-and-drop or <input multiple> picks one or more files.
//   2. We POST them to /api/upload/preview, which runs the ingest pipeline
//      (convert → section markers → LLM frontmatter) without writing
//      anything. The response is a list of editable previews.
//   3. The user can correct title / category / keywords / summary / body
//      per file. Changing the category live-updates the outPath.
//   4. "提出" posts the edited previews to /api/upload/submit, which routes
//      them to either a GitHub PR or local disk (lib/commit-files.ts).

import { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeMergedCells } from "@/lib/rehype-merged-cells";

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

interface SectionMeta {
  id: string;
  title: string;
}

interface IndexEntry {
  id: string;
  title: string;
  category: string;
  path: string;
  keywords: string[];
  summary: string;
  sections: SectionMeta[];
}

interface PreviewItem {
  tempId: string;
  id: string;
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  sourceFormat: string;
  sections: SectionMeta[];
  outPath: string;
  frontmatter: string;
  body: string;
  finalMarkdown: string;
  indexEntry: IndexEntry;
  metaSource: "llm" | "fallback";
  metaError?: string;
}

interface PreviewResponse {
  previews: PreviewItem[];
  knownCategories: string[];
  warnings: string[];
}

interface SubmitResponseGithub {
  mode: "github";
  branch: string;
  prNumber: number;
  prUrl: string;
  commitSha: string;
  notices?: string[];
}
interface SubmitResponseLocal {
  mode: "local";
  written: string[];
  notices?: string[];
}
type SubmitResponse = SubmitResponseGithub | SubmitResponseLocal;

export function UploadPanel() {
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previews, setPreviews] = useState<PreviewItem[]>([]);
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/upload/preview", { method: "POST", body: form });
      const data = (await res.json()) as PreviewResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "プレビューの生成に失敗しました。");
        return;
      }
      setPreviews((prev) => [...prev, ...data.previews]);
      setKnownCategories(data.knownCategories);
      setWarnings((prev) => [...prev, ...data.warnings]);
      if (!activeTab && data.previews[0]) setActiveTab(data.previews[0].tempId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setUploading(false);
    }
  }, [activeTab]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    },
    [handleFiles],
  );

  const onSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    handleFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  function updatePreview(tempId: string, patch: Partial<PreviewItem>) {
    setPreviews((prev) =>
      prev.map((p) => {
        if (p.tempId !== tempId) return p;
        const merged: PreviewItem = { ...p, ...patch };
        // outPath embeds category + title-slug + id — recompute on edit.
        merged.outPath = `documents/${merged.category}/${merged.id}_${slugify(merged.title)}.md`;
        merged.frontmatter = rebuildFrontmatter(merged);
        merged.finalMarkdown = merged.frontmatter + merged.body;
        merged.indexEntry = {
          ...merged.indexEntry,
          id: merged.id,
          title: merged.title,
          category: merged.category,
          path: merged.outPath,
          keywords: merged.keywords,
          summary: merged.summary,
        };
        return merged;
      }),
    );
  }

  function addCategory(c: string) {
    setKnownCategories((prev) =>
      prev.includes(c) ? prev : [...prev, c].sort((a, b) => a.localeCompare(b, "ja")),
    );
  }

  function removePreview(tempId: string) {
    setPreviews((prev) => prev.filter((p) => p.tempId !== tempId));
    setActiveTab((cur) => {
      if (cur !== tempId) return cur;
      const next = previews.find((p) => p.tempId !== tempId);
      return next?.tempId ?? null;
    });
  }

  async function submit() {
    if (previews.length === 0) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/upload/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: previews.map((p) => ({
            id: p.id,
            outPath: p.outPath,
            finalMarkdown: p.finalMarkdown,
            indexEntry: p.indexEntry,
          })),
        }),
      });
      const data = (await res.json()) as SubmitResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "提出に失敗しました。");
        if ("notices" in data && data.notices) setWarnings((w) => [...w, ...data.notices!]);
        return;
      }
      setResult(data);
      setPreviews([]);
      setActiveTab(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setSubmitting(false);
    }
  }

  const active = useMemo(() => previews.find((p) => p.tempId === activeTab) ?? null, [previews, activeTab]);

  // Surface the first distinct LLM error across all previews — if 10 files
  // all hit the same quota, the user should see it once at the top, not
  // have to open every tab to find out.
  const llmNotice = useMemo(() => {
    const errs = previews
      .map((p) => p.metaError)
      .filter((m): m is string => !!m);
    if (errs.length === 0) return null;
    const unique = [...new Set(errs)];
    return {
      message: unique[0],
      affected: previews.filter((p) => p.metaError).length,
      total: previews.length,
    };
  }, [previews]);

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-slate-800">文書アップロード</h1>
          <p className="text-xs text-slate-500">
            PDF / Word / Excel / CSV / HTML / Markdown / TXT に対応。複数ファイル同時可。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{previews.length} 件プレビュー中</span>
          <button
            type="button"
            onClick={submit}
            disabled={previews.length === 0 || submitting}
            className="px-4 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800 disabled:bg-slate-300"
          >
            {submitting ? "提出中…" : `${previews.length} 件を提出`}
          </button>
        </div>
      </header>

      {result && <ResultBanner result={result} />}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {llmNotice && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 text-sm text-amber-900">
          <div className="font-semibold mb-1">
            AIによる自動メタデータが使えませんでした
            {llmNotice.affected < llmNotice.total
              ? `（${llmNotice.affected} / ${llmNotice.total} 件）`
              : ""}
          </div>
          <p className="text-xs leading-relaxed">{llmNotice.message}</p>
          <p className="text-xs text-amber-800 mt-1">
            該当ファイルはタイトル・カテゴリ・要約を手動で入力してから提出してください。
          </p>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-900">
          <ul className="list-disc pl-5 space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button
            onClick={() => setWarnings([])}
            className="mt-1 underline hover:no-underline"
          >
            閉じる
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`mx-6 mt-4 mb-2 border-2 border-dashed rounded-md p-6 text-center text-sm ${
          drag ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-slate-50"
        }`}
      >
        <p className="text-slate-700 mb-2">
          ここにファイルをドラッグ&ドロップ、または
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onSelect}
          accept=".pdf,.docx,.xlsx,.xls,.csv,.html,.htm,.md,.markdown,.txt"
          className="hidden"
          id="upload-input"
        />
        <label
          htmlFor="upload-input"
          className="inline-block px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 cursor-pointer hover:bg-slate-100"
        >
          ファイルを選択
        </label>
        {uploading && (
          <div
            className="mt-3 flex items-center justify-center gap-2 text-indigo-900"
            aria-label="変換 + メタデータ生成中"
          >
            <span className="streaming-dot" />
            <span className="streaming-dot" style={{ animationDelay: "150ms" }} />
            <span className="streaming-dot" style={{ animationDelay: "300ms" }} />
            <span className="text-xs">変換 + メタデータ生成中</span>
          </div>
        )}
      </div>

      {previews.length > 0 && (
        <div className="flex-1 min-h-0 flex flex-col px-6 pb-6">
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200">
            {previews.map((p) => (
              <button
                key={p.tempId}
                type="button"
                onClick={() => setActiveTab(p.tempId)}
                className={`px-3 py-2 text-xs whitespace-nowrap border-t border-x rounded-t-md -mb-px ${
                  activeTab === p.tempId
                    ? "bg-white border-slate-300 text-slate-800 font-medium"
                    : "bg-slate-100 border-transparent text-slate-600 hover:bg-slate-200"
                }`}
              >
                {p.id} · {truncate(p.title, 18)}
                {p.metaSource === "fallback" && (
                  <span className="ml-1 text-amber-700">!</span>
                )}
              </button>
            ))}
          </div>
          {active && (
            <PreviewEditor
              key={active.tempId}
              item={active}
              knownCategories={knownCategories}
              onChange={(patch) => updatePreview(active.tempId, patch)}
              onRemove={() => removePreview(active.tempId)}
              onAddCategory={addCategory}
            />
          )}
        </div>
      )}
    </div>
  );
}

type ViewMode = "edit" | "preview" | "raw";

const ADD_SENTINEL = "__add_new_category__";

function PreviewEditor({
  item,
  knownCategories,
  onChange,
  onRemove,
  onAddCategory,
}: {
  item: PreviewItem;
  knownCategories: string[];
  onChange: (patch: Partial<PreviewItem>) => void;
  onRemove: () => void;
  onAddCategory: (c: string) => void;
}) {
  const [keywordInput, setKeywordInput] = useState("");
  const [view, setView] = useState<ViewMode>("edit");
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryInput, setNewCategoryInput] = useState("");

  function commitNewCategory() {
    const c = newCategoryInput.trim();
    if (!c) return;
    onAddCategory(c);
    onChange({ category: c });
    setAddingCategory(false);
    setNewCategoryInput("");
  }

  // Current category may not yet be in knownCategories (LLM-generated novel
  // value, or just-added via the input). Show it as a selectable option so
  // the select reflects state instead of falling back to the first option.
  const categoryInList = knownCategories.includes(item.category);

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr] gap-4 mt-3">
      <aside className="overflow-y-auto space-y-3 text-sm">
        {item.metaSource === "fallback" && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs px-3 py-2 space-y-1">
            <div className="font-semibold">AIによる自動メタデータが使えませんでした</div>
            <p className="leading-relaxed">
              {item.metaError ??
                "LLM が未設定のため、ファイル名から仮の値を入れています。"}
            </p>
            <p className="text-amber-800">
              タイトル・カテゴリ・要約を手動で入力してください。
            </p>
          </div>
        )}
        <Field label="ID">
          <input
            value={item.id}
            onChange={(e) => onChange({ id: e.target.value.trim() || item.id })}
            className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs font-mono"
          />
        </Field>
        <Field label="タイトル">
          <input
            value={item.title}
            onChange={(e) => onChange({ title: e.target.value })}
            className="w-full px-2 py-1 border border-slate-300 rounded-md"
          />
        </Field>
        <Field label="カテゴリ">
          {addingCategory ? (
            <div className="flex gap-1">
              <input
                autoFocus
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitNewCategory();
                  } else if (e.key === "Escape") {
                    setAddingCategory(false);
                    setNewCategoryInput("");
                  }
                }}
                placeholder="新カテゴリ名"
                className="flex-1 min-w-0 px-2 py-1 border border-slate-300 rounded-md"
              />
              <button
                type="button"
                onClick={commitNewCategory}
                disabled={!newCategoryInput.trim()}
                className="shrink-0 px-2 py-1 text-xs rounded-md bg-indigo-900 text-white hover:bg-indigo-800 disabled:bg-slate-300"
              >
                追加
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddingCategory(false);
                  setNewCategoryInput("");
                }}
                className="shrink-0 px-2 py-1 text-xs rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50"
              >
                ×
              </button>
            </div>
          ) : (
            <select
              value={item.category}
              onChange={(e) => {
                if (e.target.value === ADD_SENTINEL) {
                  setAddingCategory(true);
                  setNewCategoryInput("");
                } else {
                  onChange({ category: e.target.value });
                }
              }}
              className="w-full px-2 py-1 border border-slate-300 rounded-md bg-white"
            >
              {!categoryInList && item.category && (
                <option value={item.category}>{item.category}（新規）</option>
              )}
              {knownCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={ADD_SENTINEL}>+ 新規カテゴリを追加…</option>
            </select>
          )}
        </Field>
        <Field label="キーワード">
          <div className="flex flex-wrap gap-1 mb-1">
            {item.keywords.map((k, i) => (
              <span
                key={`${k}-${i}`}
                className="inline-flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded text-xs"
              >
                {k}
                <button
                  type="button"
                  onClick={() =>
                    onChange({ keywords: item.keywords.filter((_, j) => j !== i) })
                  }
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
                const v = keywordInput.trim().replace(/,$/, "");
                if (v && !item.keywords.includes(v)) {
                  onChange({ keywords: [...item.keywords, v].slice(0, 8) });
                }
                setKeywordInput("");
              }
            }}
            placeholder="Enter または , で追加"
            className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
          />
        </Field>
        <Field label="要約">
          <textarea
            value={item.summary}
            onChange={(e) => onChange({ summary: e.target.value })}
            rows={4}
            className="w-full px-2 py-1 border border-slate-300 rounded-md text-xs"
          />
        </Field>
        <Field label="出力先">
          <code className="block text-xs text-slate-700 break-all bg-slate-50 px-2 py-1 rounded">
            {item.outPath}
          </code>
        </Field>
        <Field label="セクション">
          <ul className="text-xs text-slate-600 space-y-0.5">
            {item.sections.map((s) => (
              <li key={s.id}>
                <span className="font-mono">{s.id}</span> — {s.title}
              </li>
            ))}
          </ul>
        </Field>
        <button
          type="button"
          onClick={onRemove}
          className="w-full mt-2 px-2 py-1.5 border border-red-300 text-red-700 rounded-md text-xs hover:bg-red-50"
        >
          このファイルを除外
        </button>
      </aside>
      <div className="border border-slate-200 rounded-md overflow-hidden flex flex-col min-h-0">
        <div className="flex border-b border-slate-200 bg-slate-50">
          {(
            [
              ["edit", "編集"],
              ["preview", "プレビュー"],
              ["raw", "Markdown 全文"],
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
          {view === "edit" && (
            <Editor
              height="100%"
              language="markdown"
              value={item.body}
              theme="vs"
              onChange={(v) => onChange({ body: v ?? "" })}
              options={{
                wordWrap: "on",
                minimap: { enabled: false },
                fontSize: 13,
              }}
            />
          )}
          {view === "preview" && (
            <div className="h-full overflow-y-auto px-6 py-5 markdown bg-white">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeMergedCells]}
              >
                {item.body}
              </ReactMarkdown>
            </div>
          )}
          {view === "raw" && (
            <pre className="h-full overflow-auto p-4 text-xs font-mono bg-slate-50 text-slate-800 whitespace-pre-wrap break-words">
              {item.finalMarkdown}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5 block">
        {label}
      </span>
      {children}
    </label>
  );
}

function ResultBanner({ result }: { result: SubmitResponse }) {
  if (result.mode === "github") {
    return (
      <div className="bg-green-50 border-b border-green-200 px-6 py-3 text-sm">
        PR を作成しました:{" "}
        <a
          href={result.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-green-800 underline font-medium"
        >
          #{result.prNumber} ({result.branch})
        </a>
        {result.notices && result.notices.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-xs text-green-900">
            {result.notices.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="bg-green-50 border-b border-green-200 px-6 py-3 text-sm">
      ローカルに書き込みました ({result.written.length} ファイル)
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-green-900">パス一覧</summary>
        <ul className="mt-1 list-disc pl-5">
          {result.written.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </details>
      {result.notices && result.notices.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-green-900">
          {result.notices.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function slugify(s: string): string {
  return String(s).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 60) || "doc";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function quote(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rebuildFrontmatter(p: PreviewItem): string {
  // Mirror lib/ingest-core.ts buildFrontmatter exactly. We rebuild client-
  // side on every field edit so the previewed finalMarkdown reflects the
  // user's tweaks (server validates again at submit time).
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    `id: ${quote(p.id)}`,
    `title: ${quote(p.title)}`,
    `category: ${quote(p.category)}`,
    `source_format: ${quote(p.sourceFormat)}`,
    `created_date: ${quote(today)}`,
    `last_updated: ${quote(today)}`,
    `version: ${quote("1.0")}`,
    `keywords: [${p.keywords.map(quote).join(", ")}]`,
    `summary: ${quote(p.summary)}`,
    "sections:",
    ...p.sections.flatMap((s) => [`  - id: ${quote(s.id)}`, `    title: ${quote(s.title)}`]),
    "---",
    "",
  ];
  return lines.join("\n");
}
