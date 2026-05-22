// Server shell for the create/edit chat page (/compose). Auth gate runs here
// so an unauthorised user gets a clean message instead of a half-rendered
// editor with API 403s on every action — same pattern as /upload.

import { loadIndex } from "@/lib/document-utils";
import { categoriesFromIndex } from "@/lib/ingest-core";
import { ComposePanel, type DocLite } from "@/components/ComposePanel";
import {
  requireRole,
  ForbiddenError,
  UnauthenticatedError,
} from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  try {
    await requireRole("編集");
  } catch (e) {
    if (e instanceof UnauthenticatedError || e instanceof ForbiddenError) {
      return (
        <div className="min-h-screen grid place-items-center p-8">
          <div className="max-w-md text-center">
            <h1 className="text-xl font-bold text-slate-800 mb-2">
              編集権限が必要です
            </h1>
            <p className="text-sm text-slate-600">{e.message}</p>
          </div>
        </div>
      );
    }
    throw e;
  }

  const index = await loadIndex();
  const docs: DocLite[] = index
    .map((d) => ({ id: d.id, title: d.title, category: d.category }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const categories = categoriesFromIndex(index);

  return <ComposePanel docs={docs} categories={categories} />;
}
