"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentMeta } from "@/lib/document-utils";

interface Props {
  doc: DocumentMeta;
  sections: Array<{ id: string; title: string; body: string }>;
}

export function DocViewer({ doc, sections }: Props) {
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
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 leading-tight">
          {doc.title}
        </h1>
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.body}</ReactMarkdown>
          </div>
        </section>
      ))}
    </article>
  );
}
