// Pinpoint the 条/項 inside a document's sections that best answers a question.
//
// Search and section selection (lib/section-select.ts) work at 章 (section)
// granularity — that is all the corpus marks with section_id. But a chat
// citation should point a reader at the exact 条 (article) / 項 (paragraph),
// not just the chapter. The .md files already carry that structure as plain
// text (`**第N条(...)**` headers and `1.` / `2.` numbered 項), so we parse it
// here at request time — no corpus change, no precomputed artifact — and
// score each clause with the same bigram metric used everywhere else.

import { sectionScore } from "./text-score";

export interface ClauseLocation {
  section_id: string;
  // The 章 heading, e.g. "第3章 機器貸与と費用負担".
  section_title: string;
  // The 条 header, e.g. "第13条(機器貸与)". Empty when the section carries no
  // 条 structure — the citation then degrades to section granularity.
  article: string;
  // 1-based 項 number, or null when the 条 has no numbered 項.
  paragraph: number | null;
  // Leading text of the cited clause. The doc viewer matches this against
  // rendered DOM text to scroll to (and highlight) the exact clause. Empty
  // for a section-level fallback.
  snippet: string;
}

interface Section {
  id: string;
  title: string;
  body: string;
}

interface Paragraph {
  number: number | null;
  text: string;
}

interface Article {
  label: string;
  paragraphs: Paragraph[];
}

// A whole line that is just a bold 条 header (`**第N条(...)**`) or `**附則**`.
const ARTICLE_RE = /^\*\*\s*(第\d+条.*?|附則)\s*\*\*\s*$/;
// A top-level numbered 項: `1. text`, `2. text`, …
const PARAGRAPH_RE = /^(\d+)\.\s+(.+)$/;

const SNIPPET_CHARS = 40;
// Small boost so a query word appearing in the 条 title can break ties
// between otherwise similar 項.
const LABEL_BOOST = 0.4;

// Parse one section body into its 条 → 項 structure. Returns [] when the body
// has no 条 headers at all (prose-only sections, non-規程 categories).
export function parseArticles(body: string): Article[] {
  const articles: Article[] = [];
  let current: Article | null = null;
  // The 条 chapeau accumulated before its first numbered 項.
  let lead: string[] = [];
  let para: Paragraph | null = null;
  let paraLines: string[] = [];

  const flushPara = () => {
    if (para && current) {
      para.text = paraLines.join(" ").trim();
      current.paragraphs.push(para);
    }
    para = null;
    paraLines = [];
  };
  const flushArticle = () => {
    flushPara();
    if (current) {
      // A 条 with no numbered 項 is itself the finest citable unit; keep its
      // chapeau prose as a single null-項 so it can still be scored.
      if (current.paragraphs.length === 0) {
        current.paragraphs.push({ number: null, text: lead.join(" ").trim() });
      }
      articles.push(current);
    }
    current = null;
    lead = [];
  };

  for (const line of body.split("\n")) {
    const art = line.match(ARTICLE_RE);
    if (art) {
      flushArticle();
      current = { label: art[1].trim(), paragraphs: [] };
      continue;
    }
    if (!current) continue; // prose before the first 条 — not citable
    const p = line.match(PARAGRAPH_RE);
    if (p) {
      flushPara();
      para = { number: Number(p[1]), text: "" };
      paraLines = [p[2]];
      continue;
    }
    if (para) paraLines.push(line);
    else lead.push(line);
  }
  flushArticle();
  return articles;
}

function snippetOf(p: Paragraph, article: Article): string {
  // A numbered 項 is matched by its own leading text; a 条 with no 項 is
  // matched by its header label, which is short and unique within a section.
  const basis = p.number === null ? article.label : p.text;
  return basis.trim().slice(0, SNIPPET_CHARS);
}

// Find the single 条/項 across `sections` that best matches `question`. Falls
// back to section granularity (article "", paragraph null, snippet "") when
// nothing scores or the sections carry no 条 structure.
export function locateClause(
  question: string,
  sections: Section[],
): ClauseLocation | null {
  if (sections.length === 0) return null;

  let best: ClauseLocation | null = null;
  let bestScore = 0;
  for (const sec of sections) {
    for (const article of parseArticles(sec.body)) {
      const labelScore = LABEL_BOOST * sectionScore(question, article.label);
      for (const p of article.paragraphs) {
        const score = sectionScore(question, p.text) + labelScore;
        if (score > bestScore) {
          bestScore = score;
          best = {
            section_id: sec.id,
            section_title: sec.title,
            article: article.label,
            paragraph: p.number,
            snippet: snippetOf(p, article),
          };
        }
      }
    }
  }
  if (best) return best;

  // Nothing scored: cite the first selected section as-is.
  const sec = sections[0];
  return {
    section_id: sec.id,
    section_title: sec.title,
    article: "",
    paragraph: null,
    snippet: "",
  };
}
