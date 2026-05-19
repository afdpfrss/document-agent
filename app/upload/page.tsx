// Server shell for the upload UI. Auth gate runs here so unauthorised users
// get a clean error page rather than a Monaco-shaped 403.

import { UploadPanel } from "@/components/UploadPanel";
import { requireRole, ForbiddenError, UnauthenticatedError } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  try {
    await requireRole("編集");
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof ForbiddenError) {
      return (
        <div className="min-h-screen grid place-items-center p-8">
          <div className="max-w-md text-center">
            <h1 className="text-xl font-bold text-slate-800 mb-2">編集権限が必要です</h1>
            <p className="text-sm text-slate-600">{e.message}</p>
          </div>
        </div>
      );
    }
    throw e;
  }
  return (
    <div className="h-[calc(100vh-2.75rem)]">
      <UploadPanel />
    </div>
  );
}
