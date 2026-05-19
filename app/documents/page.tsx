// Document browser — hierarchical tree using native <details>/<summary>.
// L1 = category (open by default), L2 = document (closed by default,
// reveals sections + keywords + actions on expand).

import Link from "next/link";
import { loadIndex, type DocumentMeta } from "@/lib/document-utils";
import { requireUser, UnauthenticatedError } from "@/lib/auth-helpers";
import { DeleteButton } from "@/components/DeleteButton";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  let canEdit = false;
  try {
    const user = await requireUser();
    canEdit = user.role === "編集";
  } catch (e) {
    if (!(e instanceof UnauthenticatedError)) throw e;
  }

  const index = await loadIndex();
  const grouped = groupByCategory(index);

  return (
    <article className="w-full max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">文書一覧</h1>
          <p className="text-sm text-slate-500 mt-1">
            登録ドキュメント {index.length} 件 · {grouped.length} カテゴリ
          </p>
        </div>
        {canEdit && (
          <Link
            href="/upload"
            className="px-3 py-1.5 text-xs font-medium bg-indigo-900 text-white rounded-md hover:bg-indigo-800"
          >
            + 新規アップロード
          </Link>
        )}
      </header>

      <div className="space-y-2">
        {grouped.map(({ category, docs }) => (
          <details
            key={category}
            className="group/cat border border-slate-200 rounded-lg bg-white"
          >
            <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none select-none hover:bg-slate-50 rounded-lg">
              <Chevron className="text-indigo-900 transition-transform group-open/cat:rotate-90" />
              <h2 className="text-sm font-bold tracking-wide text-indigo-900">
                {category}
              </h2>
              <span className="text-xs text-slate-400 font-normal">
                ({docs.length})
              </span>
              {canEdit && (
                <span className="ml-auto text-xs">
                  <DeleteButton
                    ids={docs.map((d) => d.id)}
                    label={`${category} カテゴリ（${docs.length}件）`}
                  >
                    カテゴリ削除
                  </DeleteButton>
                </span>
              )}
            </summary>

            <ul className="border-t border-slate-100 divide-y divide-slate-100">
              {docs.map((d) => (
                <li key={d.id}>
                  <details className="group/doc">
                    <summary className="flex items-start gap-2 pl-8 pr-3 py-2 cursor-pointer list-none hover:bg-slate-50">
                      <Chevron className="text-slate-400 mt-1 transition-transform group-open/doc:rotate-90" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-900 group-hover/doc:text-indigo-700">
                            {d.title}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {d.id}
                          </span>
                          {d.sections.length > 1 && (
                            <span className="text-[10px] text-slate-400">
                              · {d.sections.length}章
                            </span>
                          )}
                        </div>
                        {d.summary && (
                          <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">
                            {d.summary}
                          </p>
                        )}
                      </div>
                    </summary>

                    <div className="pl-14 pr-3 pb-3 pt-1 space-y-2">
                      {d.summary && (
                        <p className="text-xs text-slate-600 leading-relaxed">
                          {d.summary}
                        </p>
                      )}

                      {d.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {d.keywords.map((k) => (
                            <span
                              key={k}
                              className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      )}

                      {d.sections.length > 1 && (
                        <ol className="space-y-0.5 text-xs">
                          {d.sections.map((s) => (
                            <li key={s.id} className="flex items-start gap-1.5">
                              <span className="text-slate-300 select-none">└</span>
                              <Link
                                href={`/docs/${d.id}#${s.id}`}
                                className="text-indigo-800 hover:text-indigo-600 hover:underline"
                              >
                                {s.title}
                              </Link>
                            </li>
                          ))}
                        </ol>
                      )}

                      <div className="flex items-center gap-3 text-xs pt-1">
                        <Link
                          href={`/docs/${d.id}`}
                          className="text-indigo-700 hover:underline font-medium"
                        >
                          閲覧
                        </Link>
                        {canEdit && (
                          <Link
                            href={`/edit/${d.id}`}
                            className="text-slate-600 hover:text-indigo-700 hover:underline"
                          >
                            編集
                          </Link>
                        )}
                        {canEdit && (
                          <DeleteButton
                            ids={[d.id]}
                            label={d.title}
                          />
                        )}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </article>
  );
}

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <path
        d="M4 2.5L7.5 6L4 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function groupByCategory(
  index: DocumentMeta[],
): { category: string; docs: DocumentMeta[] }[] {
  const map = new Map<string, DocumentMeta[]>();
  for (const d of index) {
    const arr = map.get(d.category) ?? [];
    arr.push(d);
    map.set(d.category, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .map(([category, docs]) => ({
      category,
      docs: docs.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
