"use client";

// Chat-based editor PoC (v2 design Phase 6, §4-D).
//
// Layout: doc header up top, instruction chat at the bottom, AI proposal
// cards on the right, Monaco DiffEditor (original vs working copy) filling
// the rest. The user can:
//   1. Send an instruction → AI returns {find, replace, reason}[].
//   2. Each edit is shown as a card with its status (ok / not_found /
//      ambiguous) — failed ones can't be applied silently.
//   3. Clicking "適用" replaces the working copy with applyEdits(...).
//   4. The DiffEditor's right side is editable, so reviewers can fine-tune
//      before submission.
//   5. "PR を立てる" posts to /api/edit/[id]/submit which opens the GitHub
//      PR via lib/github.ts proposeEdit.

import { useState } from "react";
import dynamic from "next/dynamic";
import {
  applyEdits,
  type FindReplaceEdit,
  type EditApplyStatus,
} from "@/lib/edit-schema";

// Monaco needs the DOM — must be ssr:false. We import the DiffEditor
// specifically (not the whole module) to keep the client bundle smaller.
const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false, loading: () => <DiffLoading /> },
);

function DiffLoading() {
  return (
    <div className="flex-1 grid place-items-center text-sm text-slate-500">
      エディタを読み込み中…
    </div>
  );
}

interface Props {
  docId: string;
  docTitle: string;
  docCategory: string;
  docPath: string;
  initialContent: string;
}

interface ProposalCard {
  edit: FindReplaceEdit;
  status: EditApplyStatus;
}

export function EditorPanel(props: Props) {
  const [working, setWorking] = useState(props.initialContent);
  const [instruction, setInstruction] = useState("");
  const [proposing, setProposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cards, setCards] = useState<ProposalCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<{
    branch: string;
    prNumber: number;
    prUrl: string;
  } | null>(null);

  async function propose() {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    setProposing(true);
    setError(null);
    setSubmission(null);
    try {
      const res = await fetch(`/api/edit/${props.docId}/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: trimmed, originalContent: working }),
      });
      const data = (await res.json()) as {
        edits?: FindReplaceEdit[];
        applied?: { content: string; statuses: EditApplyStatus[] };
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "提案の生成に失敗しました。");
        return;
      }
      const edits = data.edits ?? [];
      const statuses = data.applied?.statuses ?? [];
      setCards(edits.map((edit, i) => ({ edit, status: statuses[i] ?? { kind: "ok", index: i } })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setProposing(false);
    }
  }

  function applyOkEdits() {
    // Re-apply with the shared applyEdits so the client matches the server's
    // semantics exactly. The stored statuses were computed at propose time;
    // the user may have hand-edited the diff since, so re-run the dry-run
    // against the CURRENT working copy and refuse to apply if anything no
    // longer matches uniquely — applying a stale edit would silently corrupt
    // the document headed into the PR.
    const okEdits = cards
      .filter((c) => c.status.kind === "ok")
      .map((c) => c.edit);
    if (okEdits.length === 0) return;
    const { content, statuses } = applyEdits(working, okEdits);
    const stale = statuses.filter((s) => s.kind !== "ok").length;
    if (stale > 0) {
      setError(
        `${stale} 件の提案が現在の本文に一致しなくなったため適用を中止しました（手動編集などで原文が変わった可能性があります）。AI に再依頼してください。`,
      );
      return;
    }
    setError(null);
    setWorking(content);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/edit/${props.docId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newContent: working,
          message: instruction.trim() || `Edit: ${props.docTitle}`,
          prBody: cards.length > 0 ? formatPrBody(cards) : undefined,
        }),
      });
      const data = (await res.json()) as {
        branch?: string;
        prNumber?: number;
        prUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.prUrl || data.prNumber === undefined || !data.branch) {
        setError(data.error ?? "PR の作成に失敗しました。");
        return;
      }
      setSubmission({ branch: data.branch, prNumber: data.prNumber, prUrl: data.prUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信エラーが発生しました。");
    } finally {
      setSubmitting(false);
    }
  }

  const dirty = working !== props.initialContent;
  const applicableCount = cards.filter((c) => c.status.kind === "ok").length;

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">{props.docCategory} / {props.docPath}</div>
          <h1 className="text-lg font-bold text-slate-800">{props.docTitle}</h1>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-xs text-amber-700">変更あり</span>}
          <button
            type="button"
            onClick={submit}
            disabled={!dirty || submitting}
            className="px-4 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800 disabled:bg-slate-300"
          >
            {submitting ? "送信中…" : "PR を立てる"}
          </button>
        </div>
      </header>

      {submission && (
        <div className="bg-green-50 border-b border-green-200 px-6 py-3 text-sm">
          PR を作成しました:{" "}
          <a
            href={submission.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-800 underline font-medium"
          >
            #{submission.prNumber} ({submission.branch})
          </a>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 border-r border-slate-200">
          <DiffEditor
            original={props.initialContent}
            modified={working}
            language="markdown"
            theme="vs"
            options={{
              originalEditable: false,
              renderSideBySide: true,
              wordWrap: "on",
              minimap: { enabled: false },
            }}
            onMount={(editor) => {
              const modifiedEditor = editor.getModifiedEditor();
              modifiedEditor.onDidChangeModelContent(() => {
                setWorking(modifiedEditor.getValue());
              });
            }}
          />
        </main>

        <aside className="w-[380px] flex flex-col bg-slate-50">
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {cards.length === 0 && (
              <p className="text-sm text-slate-500">
                編集指示を入力すると、AI が <code>{"{find, replace, reason}"}</code> 形式の提案を返します。失敗した提案は適用されません。
              </p>
            )}
            {cards.map((c, i) => (
              <ProposalCardView key={i} card={c} />
            ))}
          </div>
          {cards.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-200 flex items-center justify-between bg-white">
              <span className="text-xs text-slate-600">適用可能: {applicableCount} / {cards.length}</span>
              <button
                type="button"
                onClick={applyOkEdits}
                disabled={applicableCount === 0}
                className="px-3 py-1.5 rounded-md bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:bg-slate-300"
              >
                差分に適用
              </button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              propose();
            }}
            className="border-t border-slate-200 px-4 py-3 bg-white"
          >
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={'例：「~~です」を「~~である」に統一して、第2章末尾に注意書きを追加'}
              rows={3}
              maxLength={2000}
              className="w-full text-sm rounded-md border border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 p-2"
            />
            <button
              type="submit"
              disabled={proposing || !instruction.trim()}
              className="mt-2 w-full px-3 py-2 rounded-md bg-indigo-900 text-white text-sm font-medium hover:bg-indigo-800 disabled:bg-slate-300"
            >
              {proposing ? "提案を生成中…" : "AI に編集案を依頼"}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

function ProposalCardView({ card }: { card: ProposalCard }) {
  const statusLabel: Record<EditApplyStatus["kind"], { text: string; cls: string }> = {
    ok: { text: "適用可", cls: "bg-emerald-100 text-emerald-800" },
    not_found: { text: "原文に見つからない", cls: "bg-red-100 text-red-800" },
    ambiguous: { text: "複数箇所に一致", cls: "bg-amber-100 text-amber-800" },
  };
  const s = statusLabel[card.status.kind];
  return (
    <div className="bg-white border border-slate-200 rounded-md p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className={`inline-block px-2 py-0.5 rounded ${s.cls}`}>{s.text}</span>
        {card.status.kind === "ambiguous" && (
          <span className="text-amber-700">一致 {card.status.matches} 件</span>
        )}
      </div>
      <p className="text-slate-700 mb-2">{card.edit.reason}</p>
      <div className="font-mono whitespace-pre-wrap">
        <div className="bg-red-50 text-red-900 px-2 py-1 rounded mb-1">- {card.edit.find}</div>
        <div className="bg-emerald-50 text-emerald-900 px-2 py-1 rounded">+ {card.edit.replace || "（削除）"}</div>
      </div>
    </div>
  );
}

function formatPrBody(cards: ProposalCard[]): string {
  // These are the AI proposals — the reviewer may have hand-adjusted the diff
  // afterwards, so this is reference context, not a record of the final diff.
  const proposed = cards.filter((c) => c.status.kind === "ok");
  const lines = [
    "Chat-edit UI で生成・レビューされた編集です。",
    "最終的な変更内容は GitHub の diff で確認してください（提案後に手動調整された可能性があります）。",
    "",
    `AI 提案（参考）: ${proposed.length} 件`,
    "",
    ...proposed.map(
      (c, i) =>
        `### 提案 ${i + 1}\n**理由:** ${c.edit.reason}\n\n\`\`\`\n- ${c.edit.find}\n+ ${c.edit.replace}\n\`\`\``,
    ),
  ];
  return lines.join("\n");
}
