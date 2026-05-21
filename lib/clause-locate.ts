// Locate the passage of a document that best answers a question, and produce a
// citation: a short content-hash token the chat links to and the doc viewer
// scrolls to + marks.
//
// The corpus is multi-format: only the section is a guaranteed structural unit.
// The link is therefore format-independent — the server hashes the canonical
// form (lib/text-score canonical()) of the cited passage's text, and the viewer
// hashes each rendered block the same way to find the match. 条/項 are detected
// best-effort, for display only.

import { sectionScore, canonical, textHash } from "./text-score";

export interface CitedLocation {
  // The 章 heading, e.g. "第3章 機器貸与と費用負担". Always present.
  section_title: string;
  // The 条 header, e.g. "第13条(機器貸与)". Empty for non-規程 documents.
  article: string;
  // 1-based 項 number, or null.
  paragraph: number | null;
  // Content-hash of the cited passage — the deep-link token (?cite=). Empty
  // only when no passage could be matched.
  token: string;
  // A short readable excerpt of the passage, shown in the citation card.
  quote: string;
}

interface Section {
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

const QUOTE_MAX = 60;

// Parse a section body into 条 → 項. A 項 (and a 条 chapeau) ends at the first
// blank line, so a following table or block is NOT absorbed into its text —
// that keeps the text equal to what renders as one DOM element.
export function parseArticles(body: string): Article[] {
  const articles: Article[] = [];
  let current: Article | null = null;
  let lead: string[] = [];
  let para: Paragraph | null = null;
  let paraLines: string[] = [];
  let blocked = false; // past a blank line — ignore lines until the next 項/条

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
      if (current.paragraphs.length === 0) {
        current.paragraphs.push({ number: null, text: lead.join(" ").trim() });
      }
      articles.push(current);
    }
    current = null;
    lead = [];
    blocked = false;
  };

  for (const line of body.split("\n")) {
    const art = line.match(ARTICLE_RE);
    if (art) {
      flushArticle();
      current = { label: art[1].trim(), paragraphs: [] };
      continue;
    }
    if (!current) continue; // prose before the first 条 — not citable
    if (line.trim() === "") {
      flushPara();
      blocked = true;
      continue;
    }
    const p = line.match(PARAGRAPH_RE);
    if (p) {
      flushPara();
      blocked = false;
      para = { number: Number(p[1]), text: "" };
      paraLines = [p[2]];
      continue;
    }
    if (blocked) continue;
    if (para) paraLines.push(line);
    else lead.push(line);
  }
  flushArticle();
  return articles;
}

// Strip leading/inline markdown so a passage reads cleanly in the citation card.
function stripInline(s: string): string {
  return s
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*(?:\d+\.|[-*])\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

// Fallback passage splitter for documents with no 条 structure: blank-line
// separated blocks, with lists exploded per item (each renders as its own
// element). Headings and tables are skipped — they make poor citation targets.
export function splitBlocks(body: string): string[] {
  const out: string[] = [];
  for (const block of body.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    if (lines[0].startsWith("#") || lines[0].startsWith("|")) continue;
    const isList = lines.every((l) => /^\s*(?:\d+\.|[-*])\s/.test(l));
    if (isList) {
      for (const l of lines) out.push(stripInline(l));
    } else {
      out.push(stripInline(lines.join(" ")));
    }
  }
  return out.filter((b) => b.length >= 8);
}

interface Candidate {
  sectionTitle: string;
  article: string;
  paragraph: number | null;
  content: string; // readable passage text — used for scoring and the quote
  hashText: string; // text that matches the rendered element's textContent
}

function candidatesOf(sectionTitle: string, body: string): Candidate[] {
  const articles = parseArticles(body);
  if (articles.length > 0) {
    const out: Candidate[] = [];
    for (const art of articles) {
      for (const p of art.paragraphs) {
        if (!p.text) continue;
        out.push({
          sectionTitle,
          article: art.label,
          paragraph: p.number,
          content: p.text,
          // A numbered 項 renders as a bare <li>; a 条 with no numbered 項
          // renders as a <p> that also contains the bold 条 header text.
          hashText: p.number === null ? `${art.label} ${p.text}` : p.text,
        });
      }
    }
    return out;
  }
  return splitBlocks(body).map((b) => ({
    sectionTitle,
    article: "",
    paragraph: null,
    content: b,
    hashText: b,
  }));
}

function quoteOf(content: string): string {
  const c = content.trim();
  return c.length > QUOTE_MAX ? c.slice(0, QUOTE_MAX) + "…" : c;
}

// Find the passage across `sections` that best answers `question`, and return a
// citation: its 章 (and best-effort 条/項), a content-hash deep-link token, and
// a short quote. Falls back to section granularity when nothing scores.
export function locateCitation(
  question: string,
  sections: Section[],
): CitedLocation | null {
  if (sections.length === 0) return null;

  const sectionFallback = (): CitedLocation => ({
    section_title: sections[0].title,
    article: "",
    paragraph: null,
    token: "",
    quote: "",
  });

  const cands: Candidate[] = [];
  for (const sec of sections) cands.push(...candidatesOf(sec.title, sec.body));
  if (cands.length === 0) return sectionFallback();

  let best = cands[0];
  let bestScore = -1;
  for (const c of cands) {
    const score = sectionScore(question, c.content);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore <= 0) return sectionFallback();

  return {
    section_title: best.sectionTitle,
    article: best.article,
    paragraph: best.paragraph,
    token: textHash(canonical(best.hashText)),
    quote: quoteOf(best.content),
  };
}
