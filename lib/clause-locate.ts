// Locate the passage of a document that best answers a question, and produce a
// citation the chat can link to and the doc viewer can scroll to + mark.
//
// The corpus is multi-format: only the section (<!-- section_id -->) is a
// guaranteed structural unit; below it, structure is arbitrary. So the link
// target is plain text — the leading text of the cited passage, extended until
// it is unique within the whole document, so the viewer's match is collision-
// free regardless of format. 条/項 are detected best-effort, for display only.

import { sectionScore } from "./text-score";
import { loadAllSections } from "./document-utils";

export interface CitedLocation {
  section_id: string;
  // The 章 heading, e.g. "第3章 機器貸与と費用負担". Always present.
  section_title: string;
  // The 条 header, e.g. "第13条(機器貸与)". Empty for documents with no 条
  // structure — the citation then relies on section + quote alone.
  article: string;
  // 1-based 項 number, or null.
  paragraph: number | null;
  // Leading text of the cited passage, guaranteed unique within the document.
  // The viewer scrolls to and marks the element containing it; the card shows
  // it as a quote. Empty only when no passage could be matched.
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

// Parse one section body into its 条 → 項 structure. Returns [] when the body
// has no 条 headers at all (prose-only sections, non-規程 categories).
export function parseArticles(body: string): Article[] {
  const articles: Article[] = [];
  let current: Article | null = null;
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

// Strip the inline/leading markdown that does not survive into rendered
// textContent, so a candidate passage's text matches what the viewer sees.
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
// separated blocks, inline markdown stripped, tables dropped.
export function splitParagraphs(body: string): string[] {
  return body
    .split(/\n[ \t]*\n/)
    .map((b) => stripInline(b.replace(/[ \t]*\n[ \t]*/g, " ").trim()))
    .filter((b) => b.length >= 8 && !b.startsWith("|"));
}

interface Candidate {
  sectionId: string;
  sectionTitle: string;
  sectionBody: string;
  text: string;
}

// Every passage in the selected sections that could be the cited one: 項 (and
// 条 chapeaux) for 規程-format documents, blank-line blocks otherwise.
function candidates(sections: Section[]): Candidate[] {
  const out: Candidate[] = [];
  for (const sec of sections) {
    const articles = parseArticles(sec.body);
    if (articles.length > 0) {
      for (const art of articles) {
        for (const p of art.paragraphs) {
          if (p.text) {
            out.push({
              sectionId: sec.id,
              sectionTitle: sec.title,
              sectionBody: sec.body,
              text: p.text,
            });
          }
        }
      }
    } else {
      for (const para of splitParagraphs(sec.body)) {
        out.push({
          sectionId: sec.id,
          sectionTitle: sec.title,
          sectionBody: sec.body,
          text: para,
        });
      }
    }
  }
  return out;
}

// Best-effort 条/項 for a chosen 規程 passage. It came straight out of
// parseArticles, so an exact text match against the same parse is reliable.
function articleOf(
  body: string,
  text: string,
): { article: string; paragraph: number | null } {
  for (const art of parseArticles(body)) {
    for (const p of art.paragraphs) {
      if (p.text === text) return { article: art.label, paragraph: p.number };
    }
  }
  return { article: "", paragraph: null };
}

const collapse = (s: string) => s.replace(/\s+/g, "");
const SNIPPET_MIN = 30;
const SNIPPET_MAX = 120;
const SNIPPET_STEP = 20;

// Shortest leading slice of `text` that occurs exactly once in `fullText`.
// Whitespace is ignored on both sides (markdown line breaks vs. rendered text).
export function uniquePrefix(text: string, fullText: string): string {
  const hay = collapse(fullText);
  for (
    let len = SNIPPET_MIN;
    len < text.length && len < SNIPPET_MAX;
    len += SNIPPET_STEP
  ) {
    const cand = text.slice(0, len);
    if (hay.split(collapse(cand)).length - 1 <= 1) return cand;
  }
  return text.slice(0, SNIPPET_MAX);
}

// Find the passage across `sections` that best answers `question`, and return
// a citation: the section it sits in, a document-unique snippet of its text,
// and (best-effort) the 条/項 it falls under for display.
export async function locateCitation(
  question: string,
  sections: Section[],
  docId: string,
): Promise<CitedLocation | null> {
  if (sections.length === 0) return null;

  const sectionFallback = (): CitedLocation => ({
    section_id: sections[0].id,
    section_title: sections[0].title,
    article: "",
    paragraph: null,
    snippet: "",
  });

  const cands = candidates(sections);
  if (cands.length === 0) return sectionFallback();

  let best = cands[0];
  let bestScore = -1;
  for (const c of cands) {
    const score = sectionScore(question, c.text);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (bestScore <= 0) return sectionFallback();

  const { article, paragraph } = articleOf(best.sectionBody, best.text);

  // Uniqueness is checked against the whole document — the viewer searches the
  // whole article. Fall back to the selected sections if the load fails.
  const full = await loadAllSections(docId);
  const fullText = (full?.sections ?? sections).map((s) => s.body).join("\n");

  return {
    section_id: best.sectionId,
    section_title: best.sectionTitle,
    article,
    paragraph,
    snippet: uniquePrefix(best.text, fullText),
  };
}
