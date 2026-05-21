import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { corpus } from "./generated/corpus";

// Cloudflare Workers (the OpenNext deployment) have no project filesystem at
// runtime — documents/ cannot be read with fs. There the corpus comes from a
// build-time bundle (lib/generated/corpus.ts, scripts/build-corpus.mjs). Node
// runtimes (next dev / next start) keep reading documents/ off disk so the
// upload pipeline's in-place edits are visible immediately.
// navigator.userAgent is the documented Workers runtime probe.
const ON_WORKERS =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

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
const INDEX_REL = "documents/index.json";
const INDEX_PATH = path.join(ROOT, INDEX_REL);

// Reads a repo-root-relative file (e.g. "documents/foo/doc_001.md"). On
// Workers it is served from the bundled corpus; on Node it is read off disk.
export async function readRepoFile(repoRelPath: string): Promise<string> {
  if (ON_WORKERS) {
    const content = corpus[repoRelPath];
    if (content === undefined) {
      throw new Error(`corpus bundle has no entry for ${repoRelPath}`);
    }
    return content;
  }
  return fs.readFile(path.join(ROOT, repoRelPath), "utf8");
}

let indexCache: { mtimeMs: number; data: DocumentMeta[] } | null = null;
let workerIndexCache: DocumentMeta[] | null = null;

// On Workers the corpus is immutable per deploy — parse the bundled index
// once. On Node an mtime-keyed cache keeps reads fresh: the upload pipeline
// rewrites index.json in-place, and the search/edit/docs routes need to see
// new data even across separate Next.js dev bundles. Checking stat is ~50 µs
// and avoids the explicit invalidation dance.
export async function loadIndex(): Promise<DocumentMeta[]> {
  if (ON_WORKERS) {
    if (!workerIndexCache) {
      workerIndexCache = JSON.parse(corpus[INDEX_REL]) as DocumentMeta[];
    }
    return workerIndexCache;
  }
  const stat = await fs.stat(INDEX_PATH);
  if (indexCache && indexCache.mtimeMs === stat.mtimeMs) return indexCache.data;
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  const data = JSON.parse(raw) as DocumentMeta[];
  indexCache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

// Kept for explicit invalidation paths (e.g. after a successful local commit
// when we want the very next read to see the change without a stat). The
// mtime check above handles the common path; this is belt-and-suspenders.
export function invalidateIndexCache(): void {
  indexCache = null;
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
    if (line.startsWith("# ")) {
      // An h1 (e.g. a 章 divider in a 規程 whose 条 are the "## " sections)
      // is not itself a section. Flush so its text never bleeds into the
      // body of the section that precedes it; the divider belongs to no
      // section and is dropped.
      flush();
      currentId = null;
      currentTitle = "";
      buffer = [];
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
  const raw = await readRepoFile(doc.path);
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

// One dense line per document — id, category, title, keywords, summary.
// Section lists are intentionally omitted: Step 1 selects documents only, and
// section selection happens downstream (lib/section-select.ts). This is a
// lossless re-encoding (no field's content is shortened) that just drops the
// per-line labels/indentation, cutting Step 1's input tokens.
export function buildIndexSnippet(index: DocumentMeta[]): string {
  const cached = snippetCache.get(index);
  if (cached) return cached;
  const snippet = index
    .map(
      (d) =>
        `[${d.id}|${d.category}] ${d.title} / kw: ${d.keywords.join(", ")} / ${d.summary}`,
    )
    .join("\n");
  snippetCache.set(index, snippet);
  return snippet;
}
