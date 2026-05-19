// Top-bar showing the signed-in user + role and a sign-out link.
// Server component — renders once per request with the auth() session.

import Link from "next/link";
import { auth, signOut } from "@/auth";

export async function SiteHeader() {
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
