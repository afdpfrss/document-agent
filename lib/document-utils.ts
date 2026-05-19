import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export interface SectionMeta {
  id: string;
  title: string;
}

export interface DocumentMeta {
  id: string;
  title: string;
  category: string;
  path: string;
  keywords: string[];
  summary: string;
  sections: SectionMeta[];
}

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "documents", "index.json");

let indexCache: DocumentMeta[] | null = null;

export async function loadIndex(): Promise<DocumentMeta[]> {
  if (indexCache) return indexCache;
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  indexCache = JSON.parse(raw) as DocumentMeta[];
  return indexCache;
}

function parseAllSections(content: string): Array<{ id: string; title: string; body: string }> {
  const lines = content.split("\n");
  const out: Array<{ id: string; title: string; body: string }> = [];
  let currentId: string | null = null;
  let currentTitle = "";
  let buffer: string[] = [];

  const flush = () => {
    if (currentId) {
      out.push({ id: currentId, title: currentTitle, body: buffer.join("\n").trim() });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      flush();
      currentTitle = line.slice(3).trim();
      const next = lines[i + 1] ?? "";
      const m = next.match(/<!--\s*section_id:\s*(\S+)\s*-->/);
      currentId = m ? m[1] : null;
      buffer = [];
      if (m) i++; // skip the marker line
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

export async function loadAllSections(
  docId: string,
): Promise<{ doc: DocumentMeta; sections: Array<{ id: string; title: string; body: string }> } | null> {
  const index = await loadIndex();
  const doc = index.find((d) => d.id === docId);
  if (!doc) return null;
  const raw = await fs.readFile(path.join(ROOT, doc.path), "utf8");
  const { content } = matter(raw);
  return { doc, sections: parseAllSections(content) };
}

export async function loadSections(
  docId: string,
  sectionIds: string[],
  maxChars = 3000,
): Promise<Array<{ id: string; title: string; body: string }>> {
  const data = await loadAllSections(docId);
  if (!data) return [];
  const byId = new Map(data.sections.map((s) => [s.id, s]));
  return sectionIds
    .map((sid) => {
      const s = byId.get(sid);
      if (!s) return null;
      const body = s.body.length > maxChars ? s.body.slice(0, maxChars) + "…" : s.body;
      return { id: sid, title: s.title, body };
    })
    .filter((x): x is { id: string; title: string; body: string } => x !== null);
}

const snippetCache = new WeakMap<DocumentMeta[], string>();

export function buildIndexSnippet(index: DocumentMeta[]): string {
  const cached = snippetCache.get(index);
  if (cached) return cached;
  const snippet = index
    .map((d) => {
      const secs = d.sections.map((s) => `${s.id}:${s.title}`).join(" | ");
      return `[${d.id}] (${d.category}) ${d.title}\n  keywords: ${d.keywords.join(", ")}\n  summary: ${d.summary}\n  sections: ${secs}`;
    })
    .join("\n\n");
  snippetCache.set(index, snippet);
  return snippet;
}
