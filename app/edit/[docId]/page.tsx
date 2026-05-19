// Server shell for the chat-based editor. The actual UI is a client
// component (Monaco needs the browser); we just resolve the doc on the
// server so a 404 surfaces before any client JS loads.

import fs from "node:fs/promises";
import path from "node:path";
import { notFound } from "next/navigation";
import { loadIndex } from "@/lib/document-utils";
import { EditorPanel } from "@/components/EditorPanel";

export const dynamic = "force-dynamic";

export default async function EditPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
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
