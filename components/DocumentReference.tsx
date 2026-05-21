"use client";

import { useState } from "react";
import type { CitedLocation } from "@/lib/clause-locate";

export interface SearchSource {
  doc_id: string;
  title: string;
  category: string;
  // The passage this document contributed to the answer.
  cited: CitedLocation;
}

// "第3章 機器貸与と費用負担 · 第13条(機器貸与) · 第1項" — the 条/項 parts are
// appended only when the document actually has that structure.
function locationLabel(c: CitedLocation): string {
  const parts = [c.section_title];
  if (c.article) parts.push(c.article);
  if (c.paragraph != null) parts.push(`第${c.paragraph}項`);
  return parts.join(" · ");
}

// Deep-link to the cited passage. The unique snippet is passed as ?cite= (no
// URL #hash — a hash would make the browser scroll to the section instead).
function citationHref(c: CitedLocation, docId: string): string {
  return c.snippet
    ? `/docs/${docId}?cite=${encodeURIComponent(c.snippet)}`
    : `/docs/${docId}`;
}

export function DocumentReference({ sources }: { sources: SearchSource[] }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-semibold text-indigo-900 hover:text-indigo-700"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
        参考ドキュメント ({sources.length})
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5">
          {sources.map((s) => (
            <li
              key={s.doc_id}
              className="text-xs bg-indigo-50 border border-indigo-100 rounded-md px-3 py-2"
            >
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 bg-white border border-indigo-200 rounded px-1.5 py-0.5">
                  {s.category}
                </span>
                <span className="font-semibold text-indigo-900">{s.title}</span>
                <span className="text-slate-400 text-[10px]">{s.doc_id}</span>
                <a
                  href={`/edit/${s.doc_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-slate-500 hover:text-indigo-700 hover:underline ml-auto"
                  title="編集権限が必要です"
                >
                  編集
                </a>
              </div>
              <a
                href={citationHref(s.cited, s.doc_id)}
                target="_blank"
                rel="noopener noreferrer"
                className="group block"
              >
                <span className="text-[10px] font-semibold text-indigo-700">
                  参考にした箇所
                </span>
                <span className="block text-slate-600">
                  {locationLabel(s.cited)}
                </span>
                {s.cited.snippet && (
                  <span className="block mt-0.5 text-slate-700 group-hover:text-indigo-700 group-hover:underline">
                    「{s.cited.snippet}…」
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
