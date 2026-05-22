"use client";

import { useState } from "react";

// Small clipboard-copy button reused by the MCP setup page for the server URL
// and each client's config snippet.
export function CopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API is unavailable (e.g. non-HTTPS context) — fail silently.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 px-2 py-1 text-[11px] font-medium rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 ${className}`}
    >
      {copied ? "コピー済み" : "コピー"}
    </button>
  );
}
