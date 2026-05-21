// Open-PR dashboard. Uses listOpenPullRequests() (lib/github.ts) — when the
// GitHub backend isn't configured, we render a calm "not configured" panel
// instead of a 500 so the page is safe to link from the global nav.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  isGithubConfigured,
  listOpenPullRequests,
  readGithubConfig,
  type PullRequestSummary,
} from "@/lib/github";
import { requireUser, UnauthenticatedError } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function PrListPage() {
  // 文書履歴ページは一旦非公開（404）。再公開時はこのブロックとナビ項目を戻す。
  notFound();

  try {
    await requireUser();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return (
        <Wrap>
          <Notice>サインインが必要です。</Notice>
        </Wrap>
      );
    }
    throw e;
  }

  if (!isGithubConfigured()) {
    return (
      <Wrap>
        <Notice>
          GitHub バックエンドが未設定です。<code>GITHUB_TOKEN</code> を環境変数に設定すると、提案中の PR をここに一覧表示します。
        </Notice>
      </Wrap>
    );
  }

  let prs: PullRequestSummary[];
  let error: string | null = null;
  try {
    prs = await listOpenPullRequests();
  } catch (e) {
    prs = [];
    error = e instanceof Error ? e.message : String(e);
  }

  const cfg = readGithubConfig();
  return (
    <Wrap>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">提案中の PR</h1>
        <p className="text-xs text-slate-500 mt-1">
          {cfg.owner}/{cfg.repo} · base: {cfg.baseBranch}
        </p>
      </header>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-md px-4 py-3 mb-4">
          PR の取得に失敗しました: {error}
        </div>
      )}
      {prs.length === 0 && !error ? (
        <p className="text-sm text-slate-500">オープン中の PR はありません。</p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-md bg-white">
          {prs.map((pr) => (
            <li key={pr.number} className="px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-indigo-900 hover:text-indigo-700 hover:underline"
                  >
                    #{pr.number} {pr.title}
                  </a>
                  <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      <span className="text-slate-400">branch:</span>{" "}
                      <code>{pr.branch}</code>
                    </span>
                    {pr.author && (
                      <span>
                        <span className="text-slate-400">author:</span> {pr.author}
                      </span>
                    )}
                    <span>
                      <span className="text-slate-400">updated:</span>{" "}
                      {formatDate(pr.updatedAt)}
                    </span>
                  </div>
                </div>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-indigo-700 hover:underline"
                >
                  GitHub で開く →
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-xs text-slate-400">
        新しい PR は <Link href="/upload" className="underline hover:text-indigo-700">/upload</Link> または{" "}
        <Link href="/documents" className="underline hover:text-indigo-700">/documents</Link> 経由の編集で作成できます。
      </p>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8">{children}</article>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-md px-4 py-3 text-sm text-slate-700">
      {children}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
