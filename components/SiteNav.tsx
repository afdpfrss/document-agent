"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "チャット" },
  { href: "/documents", label: "文書一覧" },
  { href: "/compose", label: "作成・編集" },
  { href: "/upload", label: "アップロード" },
  { href: "/mcp-setup", label: "MCP接続ガイド" },
] as const;

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs text-slate-600 whitespace-nowrap">
      {NAV_ITEMS.map(({ href, label }) =>
        pathname === href ? (
          // 現在ページと同一パスは <a> でフル再読み込み
          <a key={href} href={href} className="hover:text-indigo-700">
            {label}
          </a>
        ) : (
          <Link key={href} href={href} className="hover:text-indigo-700">
            {label}
          </Link>
        ),
      )}
    </nav>
  );
}
