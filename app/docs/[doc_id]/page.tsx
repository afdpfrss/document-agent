import { notFound } from "next/navigation";
import { DocViewer } from "@/components/DocViewer";
import { loadAllSections, loadIndex } from "@/lib/document-utils";
import { requireUser, UnauthenticatedError } from "@/lib/auth-helpers";

export async function generateStaticParams() {
  const index = await loadIndex();
  return index.map((d) => ({ doc_id: d.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ doc_id: string }>;
}) {
  const { doc_id } = await params;
  const index = await loadIndex();
  const doc = index.find((d) => d.id === doc_id);
  return { title: doc ? `${doc.title} — 社内ドキュメント` : "ドキュメント" };
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ doc_id: string }>;
}) {
  const { doc_id } = await params;
  const data = await loadAllSections(doc_id);
  if (!data) notFound();
  // Role check is best-effort: a viewer without 編集 just doesn't see the
  // edit button. /edit/[docId] and /api/edit/* still gate-check on the
  // server side.
  let canEdit = false;
  try {
    const user = await requireUser();
    canEdit = user.role === "編集";
  } catch (e) {
    if (!(e instanceof UnauthenticatedError)) throw e;
  }
  return <DocViewer doc={data.doc} sections={data.sections} canEdit={canEdit} />;
}
