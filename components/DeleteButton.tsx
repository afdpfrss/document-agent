"use client";

// Confirm-and-delete trigger for the /documents page. Used both for single
// documents and for "delete every doc in this category". The server handles
// both shapes uniformly — this component just collects the ids and shows the
// confirm prompt.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  ids: string[];
  // Shown verbatim in the confirm dialog: "「X」を削除しますか？".
  label: string;
  // CSS class for the trigger. Lets the same component render as a subtle
  // text link (single doc) or a more prominent button (category).
  className?: string;
  // Trigger contents. Defaults to "削除".
  children?: React.ReactNode;
}

export function DeleteButton({ ids, label, className, children }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function handleClick(e: React.MouseEvent) {
    // Prevent the click from also toggling a parent <details>/<summary>.
    e.preventDefault();
    e.stopPropagation();
    if (busy || pending) return;
    const ok = window.confirm(
      `「${label}」を削除します。元に戻せません。よろしいですか？`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(`削除に失敗しました: ${data.error ?? res.statusText}`);
        return;
      }
      const data = (await res.json()) as
        | { mode: "local"; written: string[] }
        | { mode: "github"; prUrl: string; prNumber: number };
      if (data.mode === "github") {
        window.alert(
          `削除 PR を作成しました: #${data.prNumber}\nマージされると反映されます。\n${data.prUrl}`,
        );
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || pending}
      className={
        className ??
        "text-rose-600 hover:text-rose-800 hover:underline disabled:opacity-50"
      }
    >
      {busy || pending ? "削除中…" : (children ?? "削除")}
    </button>
  );
}
