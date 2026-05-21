// Tokenizer-free fuzzy text scoring (character-bigram overlap).
//
// Character-bigram overlap works for Japanese, which has no word spaces. This
// module is kept dependency-free and free of any server-only imports so it can
// run both server-side (lib/section-select.ts ranks sections) and in the
// browser (components/DocViewer.tsx deep-links a chat citation to the most
// relevant 条/項 inside a section).

// Character bigrams, whitespace-stripped + lowercased.
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

// Relevance of a text to the query: the fraction of the query's bigrams that
// also occur in the text. Range 0..1.
export function sectionScore(query: string, text: string): number {
  const q = bigrams(query);
  if (q.size === 0) return 0;
  const s = bigrams(text);
  let overlap = 0;
  for (const g of q) if (s.has(g)) overlap++;
  return overlap / q.size;
}
