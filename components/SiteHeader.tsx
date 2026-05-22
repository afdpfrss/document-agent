// Top-bar showing the signed-in user + role and a sign-out link.
// Server component — renders once per request with the auth() session.

import Link from "next/link";
import { auth, signOut } from "@/auth";
import { isAuthEnabled } from "@/lib/auth-helpers";
import { SiteNav } from "./SiteNav";

// Shared header shell. On mobile the row wraps: title + status info stay on
// the first line and the nav drops to its own full-width (horizontally
// scrollable) line, so a long nav can't squeeze the title into a vertical
// stack. On sm+ everything sits on a single line.
function HeaderShell({ children }: { children: React.ReactNode }) {
  return (
    <header className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-nowrap">
      <Link
        href="/"
        className="order-1 shrink-0 whitespace-nowrap font-bold text-slate-800 text-sm sm:text-base"
      >
        社内ドキュメントエージェント
      </Link>
      <div className="order-3 sm:order-2 basis-full sm:basis-auto overflow-x-auto">
        <SiteNav />
      </div>
      <div className="order-2 sm:order-3 ml-auto shrink-0">{children}</div>
    </header>
  );
}

export async function SiteHeader() {
  // Auth off → no session lookup (would just return null anyway), no
  // sign-in link. A small badge advertises the state so it's not silently
  // surprising that role gates are bypassed.
  if (!isAuthEnabled()) {
    return (
      <HeaderShell>
        <span
          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-amber-100 text-amber-800"
          title="AUTH_GOOGLE_ID と AUTH_GOOGLE_SECRET を .env.local に設定すると Phase 7 の Google OAuth が有効になります。"
        >
          認証オフ
        </span>
      </HeaderShell>
    );
  }

  const session = await auth();
  return (
    <HeaderShell>
      {session?.user ? (
        <div className="flex items-center gap-3 text-xs sm:text-sm">
          <span className="text-slate-700">
            {session.user.name ?? session.user.email}
            <span className="ml-2 px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] uppercase tracking-wide">
              {session.user.role}
            </span>
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline"
            >
              サインアウト
            </button>
          </form>
        </div>
      ) : (
        <Link
          href="/api/auth/signin"
          className="text-xs sm:text-sm text-indigo-700 hover:text-indigo-900 underline-offset-2 hover:underline"
        >
          サインイン
        </Link>
      )}
    </HeaderShell>
  );
}
