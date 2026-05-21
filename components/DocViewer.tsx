"use client";

import { useEffect } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentMeta } from "@/lib/document-utils";
import { rehypeMergedCells } from "@/lib/rehype-merged-cells";
import { sectionScore } from "@/lib/text-score";

interface Props {
  doc: DocumentMeta;
  sections: Array<{ id: string; title: string; body: string }>;
  // Server-computed: true when the viewer should see the "編集" entry point.
  // Server still enforces auth on /edit and /api/edit; this just hides the
  // link from viewers who would only get a 403.
  canEdit?: boolean;
}

export function DocViewer({ doc, sections, canEdit = false }: Props) {
  // A chat citation deep-links to a specific 条/項. The section id arrives as
  // ?sec= and the cited clause text as ?cite= — deliberately NOT as a URL
  // #hash: a hash makes the browser and Next.js's router (layout-router.js)
  // scroll to the section element, which overrides the clause-level scroll
  // below. With the target in query params nothing else scrolls, so this
  // effect lands on — and highlights — the exact clause.
  //
  // A plain section/ToC link still uses a #hash (Next.js handles it natively);
  // we re-honor it here too so a direct /docs/[id]#sec_N load lands cleanly.
  // Keyed on doc.id so it also re-runs on in-app navigation between /docs/[id]
  // routes (which reuse this component).
  //
  // Clause matching: the server resolved the exact 条/項 and passed its text,
  // so an exact, whitespace-insensitive substring match against the rendered
  // 条/項 elements (<p>/<li>) wins; a bigram fallback covers markdown drift.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sectionId = params.get("sec") || window.location.hash.slice(1);
    if (!sectionId) return;
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) return;

    const cite = params.get("cite") ?? "";
    let target: Element = sectionEl;
    let highlightClass = "doc-section-highlight";

    if (cite) {
      const candidates = Array.from(sectionEl.querySelectorAll("li, p"));
      const needle = cite.replace(/\s+/g, "");
      let best: Element | null = null;
      for (const el of candidates) {
        if ((el.textContent ?? "").replace(/\s+/g, "").includes(needle)) {
          best = el;
          break;
        }
      }
      if (!best) {
        let bestScore = 0;
        for (const el of candidates) {
          const score = sectionScore(cite, el.textContent ?? "");
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }
      if (best) {
        target = best;
        highlightClass = "doc-clause-highlight";
      }
    }

    target.scrollIntoView({
      behavior: "auto",
      block: target === sectionEl ? "start" : "center",
    });
    target.classList.add(highlightClass);
    const t = setTimeout(() => target.classList.remove(highlightClass), 1800);
    return () => clearTimeout(t);
  }, [doc.id]);

  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-indigo-900 hover:text-indigo-700 mb-6"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path
            d="M9 3 L4 7 L9 11"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
          />
        </svg>
        検索に戻る
      </Link>

      <header className="mb-8 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-2 py-0.5">
            {doc.category}
          </span>
          <span className="text-xs text-slate-400">{doc.id}</span>
        </div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 leading-tight">
            {doc.title}
          </h1>
          {canEdit && (
            <Link
              href={`/edit/${doc.id}`}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-indigo-900 text-white rounded-md hover:bg-indigo-800"
            >
              この文書を編集
            </Link>
          )}
        </div>
        {doc.summary && (
          <p className="mt-3 text-sm text-slate-600 leading-relaxed">
            {doc.summary}
          </p>
        )}
      </header>

      {sections.length > 1 && (
        <nav className="mb-8 p-4 bg-white border border-slate-200 rounded-lg">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            目次
          </div>
          <ol className="space-y-1 text-sm">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="text-indigo-900 hover:text-indigo-700 hover:underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {sections.map((s) => (
        <section
          key={s.id}
          id={s.id}
          className="doc-section scroll-mt-24 mb-8 pl-4 py-2 -ml-4 transition-colors"
        >
          <h2 className="text-xl font-bold text-indigo-900 mb-3">
            {s.title}
          </h2>
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeMergedCells]}
            >
              {s.body}
            </ReactMarkdown>
          </div>
        </section>
      ))}
    </article>
  );
}
