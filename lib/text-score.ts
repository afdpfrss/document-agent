// Tokenizer-free text utilities shared by server and browser. Dependency-free
// and free of server-only imports, so it runs in both places.
//
// - sectionScore: character-bigram overlap, for fuzzy relevance ranking.
// - canonical / textHash: a content fingerprint. `canonical` reduces a string
//   to just its letters and numbers, so markdown-derived text (server) and
//   rendered textContent (browser) collapse to the same value; `textHash` turns
//   that into a short token used as a chat-citation deep-link (?cite=).

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

// Reduce a string to its letters and numbers only — dropping markdown syntax,
// punctuation and whitespace. Markdown link URLs are stripped first so only the
// link text survives. The server (markdown text) and the browser (rendered
// textContent) thus produce the same value for the same passage.
export function canonical(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// FNV-1a (32-bit) → 8-char hex. Deterministic and stable across server and
// browser, used as the opaque ?cite= deep-link token.
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
