// Top-bar showing the signed-in user + role and a sign-out link.
// Server component — renders once per request with the auth() session.

import Link from "next/link";
import { auth, signOut } from "@/auth";
import { isAuthEnabled } from "@/lib/auth-helpers";

export async function SiteHeader() {
  // Auth off → no session lookup (would just return null anyway), no
  // sign-in link. A small badge advertises the state so it's not silently
  // surprising that role gates are bypassed.
  if (!isAuthEnabled()) {
    return (
      <header className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 flex items-center justify-between">
        <Link href="/" className="font-bold text-slate-800 text-sm sm:text-base">
          社内ドキュメントエージェント
        </Link>
        <span
          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-amber-100 text-amber-800"
          title="AUTH_GOOGLE_ID と AUTH_GOOGLE_SECRET を .env.local に設定すると Phase 7 の Google OAuth が有効になります。"
        >
          認証オフ
        </span>
      </header>
    );
  }

  const session = await auth();
  return (
    <header className="border-b border-slate-200 bg-white px-4 sm:px-6 py-2 flex items-center justify-between">
      <Link href="/" className="font-bold text-slate-800 text-sm sm:text-base">
        社内ドキュメントエージェント
      </Link>
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
    </header>
  );
}
