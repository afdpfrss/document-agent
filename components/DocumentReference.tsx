"use client";

import { useState } from "react";

export interface SearchSource {
  doc_id: string;
  title: string;
  category: string;
  section_ids: string[];
  section_titles: string[];
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
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 bg-white border border-indigo-200 rounded px-1.5 py-0.5">
                  {s.category}
                </span>
                <span className="font-semibold text-slate-800">{s.title}</span>
                <span className="text-slate-400 text-[10px]">{s.doc_id}</span>
              </div>
              {s.section_titles.length > 0 && (
                <div className="text-slate-600 ml-1">
                  {s.section_titles.map((t) => (
                    <span
                      key={t}
                      className="inline-block mr-2 mb-0.5 before:content-['§_'] before:text-slate-400"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
