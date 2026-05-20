// Read-only MCP tool logic for the document-agent MCP connector.
//
// These functions are the server-side implementation behind the read tools
// exposed by app/api/mcp/route.ts. They deliberately call NO answer-generating
// LLM: candidate selection and answer generation are the job of the *user's*
// Claude (docs/v2-design.md §4, MCP connector layer). The server only does
// metadata filtering + best-effort vector similarity, and returns a
// deliberately narrow slice of the corpus so the staged-disclosure structure
// (docs/v2-design.md §2, §3) is preserved on the tool boundary.

import { loadIndex, loadSections, type DocumentMeta } from "@/lib/document-utils";
import { vectorSearch } from "@/lib/hybrid-search";

export interface DocCandidate {
  doc_id: string;
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  sections: { id: string; title: string }[];
  score: number;
  matched_via: Array<"metadata" | "vector">;
}

export interface SearchDocumentsResult {
  query: string;
  vector_search_used: boolean;
  total_documents: number;
  candidate_count: number;
  candidates: DocCandidate[];
  note: string;
}

// Character bigrams, whitespace-stripped + lowercased. Bigram overlap is a
// tokenizer-free fuzzy match that works for Japanese (no word spaces) as well
// as for Latin-script keywords.
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

// Metadata-driven relevance score (docs/v2-design.md §2: metadata is primary).
// Exact substring hits on keywords / title / category are strong signals;
// bigram overlap on title+keywords+summary is a soft fuzzy fallback.
function metadataScore(query: string, doc: DocumentMeta): number {
  const q = query.toLowerCase();
  let score = 0;
  for (const kw of doc.keywords) {
    if (kw && q.includes(kw.toLowerCase())) score += 3;
  }
  if (doc.title && q.includes(doc.title.toLowerCase())) score += 4;
  if (doc.category && q.includes(doc.category.toLowerCase())) score += 2;
  for (const s of doc.sections) {
    if (s.title && q.includes(s.title.toLowerCase())) score += 1;
  }
  const qb = bigrams(query);
  if (qb.size > 0) {
    const db = bigrams(`${doc.title} ${doc.keywords.join(" ")} ${doc.summary}`);
    let overlap = 0;
    for (const g of qb) if (db.has(g)) overlap++;
    score += (overlap / qb.size) * 3;
  }
  return score;
}

const DEFAULT_CANDIDATE_LIMIT = 12;

// search_documents — returns a candidate pool (frontmatter + summary only,
// no section bodies). The union of metadata matches and vector-similarity
// hits; final TOP selection is left to the caller's Claude.
export async function searchDocuments(
  query: string,
  limit = DEFAULT_CANDIDATE_LIMIT,
): Promise<SearchDocumentsResult> {
  const index = await loadIndex();

  const metaScores = new Map<string, number>();
  for (const doc of index) {
    const s = metadataScore(query, doc);
    if (s > 0) metaScores.set(doc.id, s);
  }

  // Vector layer is best-effort: a missing embeddings.json, a missing
  // GEMINI_API_KEY, or a failed embed call all degrade silently to
  // metadata-only (docs/v2-design.md §2; lib/hybrid-search.ts contract).
  const hits = await vectorSearch(query, 15).catch(() => null);
  const vecScores = new Map<string, number>();
  if (hits) {
    for (const h of hits) {
      const prev = vecScores.get(h.doc_id) ?? 0;
      if (h.score > prev) vecScores.set(h.doc_id, h.score);
    }
  }

  const ids = new Set<string>([...metaScores.keys(), ...vecScores.keys()]);
  const candidates: DocCandidate[] = [];
  for (const id of ids) {
    const doc = index.find((d) => d.id === id);
    if (!doc) continue;
    const m = metaScores.get(id) ?? 0;
    const v = vecScores.get(id) ?? 0;
    const matched_via: Array<"metadata" | "vector"> = [];
    if (m > 0) matched_via.push("metadata");
    if (v > 0) matched_via.push("vector");
    candidates.push({
      doc_id: doc.id,
      title: doc.title,
      category: doc.category,
      keywords: doc.keywords,
      summary: doc.summary,
      sections: doc.sections.map((s) => ({ id: s.id, title: s.title })),
      // Metadata stays primary; the cosine score (0..1) is scaled but bounded
      // so a pure-vector hit augments rather than overrides metadata ranking.
      score: Number((m + v * 5).toFixed(3)),
      matched_via,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit);

  return {
    query,
    vector_search_used: hits !== null,
    total_documents: index.length,
    candidate_count: top.length,
    candidates: top,
    note: "これは候補プールです。フロントマターと要約だけが含まれます。読むべきセクションを選び、get_sections で本文を取得して最終判断してください。",
  };
}

export interface GetSectionsResult {
  doc_id: string;
  title: string;
  category: string;
  sections: { id: string; title: string; body: string }[];
  missing_section_ids: string[];
}

const MAX_SECTIONS_PER_CALL = 10;

// get_sections — returns the body text of the requested sections. Bodies are
// capped (loadSections truncates at ~3000 chars each) to keep the staged-
// disclosure token budget bounded.
export async function getSections(
  docId: string,
  sectionIds: string[],
): Promise<GetSectionsResult | { error: string }> {
  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) {
    return {
      error: `doc_id が見つかりません: ${docId}。search_documents で正しい doc_id を確認してください。`,
    };
  }
  const requested = sectionIds.slice(0, MAX_SECTIONS_PER_CALL);
  const sections = await loadSections(docId, requested);
  const found = new Set(sections.map((s) => s.id));
  return {
    doc_id: doc.id,
    title: doc.title,
    category: doc.category,
    sections,
    missing_section_ids: requested.filter((id) => !found.has(id)),
  };
}

export interface ListCategoriesResult {
  total_documents: number;
  category_count: number;
  categories: { name: string; document_count: number }[];
}

// list_categories — category names + per-category document counts, derived
// from documents/index.json.
export async function listCategories(): Promise<ListCategoriesResult> {
  const index = await loadIndex();
  const counts = new Map<string, number>();
  for (const d of index) {
    counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  }
  const categories = [...counts.entries()]
    .map(([name, document_count]) => ({ name, document_count }))
    .sort(
      (a, b) =>
        b.document_count - a.document_count || a.name.localeCompare(b.name),
    );
  return {
    total_documents: index.length,
    category_count: categories.length,
    categories,
  };
}
