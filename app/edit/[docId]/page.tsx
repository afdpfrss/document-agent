// Server shell for the chat-based editor. The actual UI is a client
// component (Monaco needs the browser); we just resolve the doc on the
// server so a 404 surfaces before any client JS loads.

import fs from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { loadIndex } from "@/lib/document-utils";
import { EditorPanel } from "@/components/EditorPanel";
import { requireRole, ForbiddenError, UnauthenticatedError } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export default async function EditPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  // Defence-in-depth: middleware already requires login, but role checks
  // happen here so an 一般 user gets a clear page instead of a half-rendered
  // editor with API 403s on every action.
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

  const { docId } = await params;
  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) notFound();
  const initialContent = await fs.readFile(
    path.join(process.cwd(), doc.path),
    "utf8",
  );
  return (
    <EditorPanel
      docId={doc.id}
      docTitle={doc.title}
      docCategory={doc.category}
      docPath={doc.path}
      initialContent={initialContent}
    />
  );
}
