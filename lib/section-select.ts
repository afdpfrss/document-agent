// Section selection for staged-disclosure search.
//
// Step 1's LLM now picks documents only (docs/v2-design.md §3). Choosing which
// sections of a picked document to disclose to Step 3 happens here, with a
// tokenizer-free bigram-overlap score: the section body matched against the
// query, plus a weighted boost from the section title. No LLM tokens and no
// precomputed artifact, so the .md files stay the single source of truth.

import { loadAllSections } from "./document-utils";

// Character bigrams, whitespace-stripped + lowercased. Bigram overlap is a
// tokenizer-free fuzzy match that works for Japanese (no word spaces).
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

// Relevance of a section to the query: the fraction of the query's bigrams
// that also occur in the section text. Range 0..1.
export function sectionScore(query: string, sectionText: string): number {
  const q = bigrams(query);
  if (q.size === 0) return 0;
  const s = bigrams(sectionText);
  let overlap = 0;
  for (const g of q) if (s.has(g)) overlap++;
  return overlap / q.size;
}

export interface SelectedSection {
  id: string;
  title: string;
  body: string;
}

// Per-section body cap — mirrors the previous loadSections() behaviour so the
// Step 3 token budget is unchanged.
const MAX_SECTION_CHARS = 3000;

// The section title is a curated topic label and the single strongest signal,
// but it is far shorter than the body — concatenating the two lets the body
// drown the title out. So the title is scored separately and added as a
// boost. 0.8 was tuned on the corpus: it lifts exact-topic precision while
// still letting a body match win when the query and title use different
// words (e.g. the query "残業代" and the section titled "時間外勤務手当").
const TITLE_BOOST = 0.8;

// Pick the most query-relevant sections of one document. When no section
// scores (e.g. a very short query, or wording that shares no bigrams), falls
// back to the document's leading sections so Step 3 always has context.
// Returns sections in document order.
export async function selectSections(
  query: string,
  docId: string,
  limit = 3,
): Promise<SelectedSection[]> {
  const data = await loadAllSections(docId);
  if (!data || data.sections.length === 0) return [];

  const scored = data.sections.map((s) => ({
    section: s,
    score:
      sectionScore(query, s.body) +
      TITLE_BOOST * sectionScore(query, s.title),
  }));
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const hits = ranked.filter((x) => x.score > 0);
  const chosen = (hits.length > 0 ? hits : ranked).slice(0, limit);
  const chosenIds = new Set(chosen.map((x) => x.section.id));

  return data.sections
    .filter((s) => chosenIds.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      body:
        s.body.length > MAX_SECTION_CHARS
          ? s.body.slice(0, MAX_SECTION_CHARS) + "…"
          : s.body,
    }));
}
