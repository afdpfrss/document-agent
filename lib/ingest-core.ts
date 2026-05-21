// Pure ingestion primitives for the web upload pipeline
// (app/api/upload/...). No file I/O — callers decide where bytes come from
// and where the rendered markdown goes.
//
// Logic mirrors scripts/ingest.mjs (which keeps its own copy because Node's
// type-stripping for .ts imports from .mjs is brittle). When you change one,
// change the other.
//
// Mirrors the v1 pipeline documented in scripts/ingest.mjs:
//   buffer → convertToMarkdown → injectSectionMarkers → generateFrontmatterWithLlm
//          → buildFrontmatter → finalMarkdown
//
// Heavy converters (mammoth, pdfjs-dist, xlsx, turndown) are loaded lazily so
// we only pay for the formats actually used in a given invocation.

import { llmConfig } from "./llm-config";
import { friendlyLlmError } from "./llm-errors";
import type { DocumentMeta } from "./document-utils";

// ---------- format converters ----------

async function convertHtml(buf: Buffer): Promise<string> {
  // turndown ships no .d.ts; suppress the resolution error and cast at the
  // boundary. Adding @types/turndown for a single call site felt heavy.
  // @ts-expect-error -- no types shipped with turndown
  const mod = await import("turndown");
  const Ctor = mod.default as unknown as new (opts: Record<string, unknown>) => {
    turndown: (html: string) => string;
  };
  const td = new Ctor({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return td.turndown(buf.toString("utf8"));
}

async function convertDocx(buf: Buffer): Promise<string> {
  // mammoth's types omit convertToMarkdown (it's documented but not in
  // @types). Cast at the boundary rather than monkey-patching the type.
  const mammoth = (await import("mammoth")) as unknown as {
    convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const r = await mammoth.convertToMarkdown({ buffer: buf });
  return r.value;
}

async function convertPdf(buf: Buffer): Promise<string> {
  // The legacy build runs under plain Node without DOM polyfills.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if ("str" in item) {
        const it = item as { str: string; hasEOL?: boolean };
        text += it.str;
        text += it.hasEOL ? "\n" : " ";
      }
    }
    pages.push(text.trim());
  }
  // PDFs rarely carry semantic H2s — emit page boundaries so the section
  // splitter has something to chew on. The LLM frontmatter step can refine.
  return pages.map((t, i) => `## Page ${i + 1}\n\n${t}`).join("\n\n");
}


// Merge markers — see lib/rehype-merged-cells.ts for the renderer side.
// We keep markdown plain (GFM tables) so it's diffable and editable, and
// let the viewer plugin collapse marker cells into rowspan/colspan at
// render time.
const MERGE_LEFT = "←";
const MERGE_UP = "↑";

async function convertXlsx(buf: Buffer): Promise<string> {
  const xlsx = await import("xlsx");
  const wb = xlsx.read(buf, { type: "buffer" });
  const blocks: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const merges = (sheet["!merges"] ?? []) as Array<{
      s: { r: number; c: number };
      e: { r: number; c: number };
    }>;
    // Write merge markers into the sheet before CSV-ifying. Anchor (top-
    // left) keeps its value; top-row cells → ←, left-col cells → ↑,
    // interior cells → ← (cascades through the already-resolved row).
    for (const m of merges) {
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (r === m.s.r && c === m.s.c) continue;
          const addr = xlsx.utils.encode_cell({ r, c });
          const marker = c === m.s.c ? MERGE_UP : MERGE_LEFT;
          sheet[addr] = { t: "s", v: marker };
        }
      }
    }
    const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
    blocks.push(`## ${name}\n\n${csvToMarkdownTable(csv)}`);
  }
  return blocks.join("\n\n");
}

function convertCsv(buf: Buffer): string {
  return csvToMarkdownTable(buf.toString("utf8"));
}

function convertText(buf: Buffer): string {
  // Single section so it picks up a section marker downstream.
  return `## 本文\n\n${buf.toString("utf8").trim()}`;
}

function convertMarkdown(buf: Buffer): string {
  return buf.toString("utf8");
}

// Minimal CSV → GFM table. Good enough for internal spreadsheets; doesn't
// chase every RFC-4180 corner.
function csvToMarkdownTable(csv: string): string {
  const rows = parseCsv(csv);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const out = r.slice();
    while (out.length < width) out.push("");
    // A GFM row must stay on one physical line: escape pipes, and turn any
    // in-cell line break (Excel Alt+Enter survives CSV quoting as CRLF/CR/LF)
    // into a literal "<br>". rehypeMergedCells renders those back as real
    // breaks; collapsing them to spaces would fuse a multi-line cell into
    // one run-on line.
    return out.map((c) =>
      c.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>"),
    );
  });
  const header = padded[0];
  const body = padded.slice(1);
  const sep = header.map(() => "---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += c;
      }
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

export type SourceFormat = "html" | "docx" | "pdf" | "xlsx" | "csv" | "txt" | "md";

interface ConverterEntry {
  fn: (buf: Buffer) => string | Promise<string>;
  source_format: SourceFormat;
}

const CONVERTERS: Record<string, ConverterEntry> = {
  ".html": { fn: convertHtml, source_format: "html" },
  ".htm": { fn: convertHtml, source_format: "html" },
  ".docx": { fn: convertDocx, source_format: "docx" },
  ".pdf": { fn: convertPdf, source_format: "pdf" },
  ".xlsx": { fn: convertXlsx, source_format: "xlsx" },
  ".xls": { fn: convertXlsx, source_format: "xlsx" },
  ".csv": { fn: convertCsv, source_format: "csv" },
  ".txt": { fn: convertText, source_format: "txt" },
  ".md": { fn: convertMarkdown, source_format: "md" },
  ".markdown": { fn: convertMarkdown, source_format: "md" },
};

export const SUPPORTED_EXTENSIONS = Object.keys(CONVERTERS);

export function isSupportedExtension(ext: string): boolean {
  return ext.toLowerCase() in CONVERTERS;
}

export async function convertToMarkdown(
  buf: Buffer,
  ext: string,
): Promise<{ body: string; sourceFormat: SourceFormat }> {
  const conv = CONVERTERS[ext.toLowerCase()];
  if (!conv) {
    throw new Error(
      `Unsupported file extension: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }
  const body = await conv.fn(buf);
  return { body, sourceFormat: conv.source_format };
}

// ---------- section markers ----------

// Walk the body, ensure every "## " heading is followed by a
// `<!-- section_id: sec_N -->` marker. Returns the rewritten body plus the
// list of {id, title} for frontmatter.
export function injectSectionMarkers(body: string): {
  body: string;
  sections: Array<{ id: string; title: string }>;
} {
  const lines = body.split("\n");
  const out: string[] = [];
  const sections: Array<{ id: string; title: string }> = [];
  let counter = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      const next = lines[i + 1] ?? "";
      const m = next.match(/<!--\s*section_id:\s*(\S+)\s*-->/);
      if (m) {
        sections.push({ id: m[1], title });
      } else {
        counter++;
        const id = `sec_${counter}`;
        out.push(`<!-- section_id: ${id} -->`);
        sections.push({ id, title });
      }
    }
  }
  if (sections.length === 0) {
    const wrapped = `## 本文\n<!-- section_id: sec_1 -->\n\n${body.trim()}`;
    return { body: wrapped, sections: [{ id: "sec_1", title: "本文" }] };
  }
  return { body: out.join("\n"), sections };
}

// ---------- LLM frontmatter ----------

export interface FrontmatterMeta {
  title: string;
  category: string;
  keywords: string[];
  summary: string;
}

export interface GenerateFrontmatterOptions {
  body: string;
  knownCategories: string[];
  hintTitle?: string;
}

export async function generateFrontmatterWithLlm(
  opts: GenerateFrontmatterOptions,
): Promise<FrontmatterMeta> {
  const apiKey = llmConfig.apiKey;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: llmConfig.candidateModel,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
    },
  });

  // 8 KB body sample is enough for metadata extraction and stays inside the
  // lite model's free-tier sweet spot.
  const truncated = opts.body.slice(0, 8000);
  const prompt = `次の社内ドキュメントの本文を読み、フロントマターのメタデータを JSON で生成してください。

# カテゴリ候補（必ずこの中から1つ選ぶこと）
${opts.knownCategories.map((c) => `- ${c}`).join("\n")}

# 出力スキーマ（JSON のみ。前置きや説明文は禁止）
{
  "title": "ドキュメントのタイトル（30字以内）",
  "category": "上のカテゴリ候補から1つ。判別が難しければ 'その他業務ガイド'",
  "keywords": ["検索キーワード", "...", "最大8件"],
  "summary": "本文の要約（80〜200字）"
}

${opts.hintTitle ? `# 参考: ファイル名由来のタイトル候補\n${opts.hintTitle}\n\n` : ""}# 本文（最初の${truncated.length}文字）
${truncated}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(extractJson(text)) as Partial<FrontmatterMeta>;
  let category = String(parsed.category ?? "その他業務ガイド");
  if (opts.knownCategories.length > 0 && !opts.knownCategories.includes(category)) {
    category = "その他業務ガイド";
  }
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.slice(0, 8).map((k) => String(k))
    : [];
  return {
    title: String(parsed.title ?? opts.hintTitle ?? "Untitled"),
    category,
    keywords,
    summary: String(parsed.summary ?? ""),
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
  return raw.slice(start).trim();
}

// ---------- frontmatter writer ----------

function quoteYaml(s: unknown): string {
  // Double-quote everything with backslash escapes. Simpler than predicting
  // YAML's bare-scalar rules and matches the style of existing
  // documents/<cat>/doc_NNN_*.md files.
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface BuildFrontmatterOptions {
  id: string;
  title: string;
  category: string;
  sourceFormat: SourceFormat;
  keywords: string[];
  summary: string;
  sections: Array<{ id: string; title: string }>;
  today: string;
}

export function buildFrontmatter(opts: BuildFrontmatterOptions): string {
  const lines = [
    "---",
    `id: ${quoteYaml(opts.id)}`,
    `title: ${quoteYaml(opts.title)}`,
    `category: ${quoteYaml(opts.category)}`,
    `source_format: ${quoteYaml(opts.sourceFormat)}`,
    `created_date: ${quoteYaml(opts.today)}`,
    `last_updated: ${quoteYaml(opts.today)}`,
    `version: ${quoteYaml("1.0")}`,
    `keywords: [${opts.keywords.map(quoteYaml).join(", ")}]`,
    `summary: ${quoteYaml(opts.summary)}`,
    "sections:",
    ...opts.sections.flatMap((s) => [
      `  - id: ${quoteYaml(s.id)}`,
      `    title: ${quoteYaml(s.title)}`,
    ]),
    "---",
    "",
  ];
  return lines.join("\n");
}

// ---------- index helpers ----------

export function nextDocId(index: Pick<DocumentMeta, "id">[]): string {
  let max = 0;
  for (const d of index) {
    const m = String(d.id ?? "").match(/^doc_(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `doc_${String(max + 1).padStart(3, "0")}`;
}

export function slugifyForFilename(s: string): string {
  // Keep CJK characters; only strip filesystem-hostile ones.
  return String(s).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 60) || "doc";
}

export function categoriesFromIndex(index: Pick<DocumentMeta, "category">[]): string[] {
  return [...new Set(index.map((d) => d.category))].sort();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- one-shot helper used by both CLI and web ----------

export interface IngestPreview {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  sourceFormat: SourceFormat;
  sections: Array<{ id: string; title: string }>;
  outPath: string;
  frontmatter: string;
  body: string;
  finalMarkdown: string;
  indexEntry: DocumentMeta;
  metaSource: "llm" | "fallback";
  // Friendly explanation when LLM frontmatter fell back. Quota errors get
  // a chat-style message; key/other errors get a short generic notice.
  // Omitted when meta came from LLM successfully or LLM was disabled.
  metaError?: string;
}

export interface BuildPreviewOptions {
  buffer: Buffer;
  filename: string;
  index: DocumentMeta[];
  forceCategory?: string;
  forceId?: string;
  useLlm?: boolean;
  docsDirRel?: string; // default "documents"
}

// Full pipeline for one file. Useful for both the CLI's "no I/O during
// rendering" pattern and the web preview endpoint.
export async function buildPreview(opts: BuildPreviewOptions): Promise<IngestPreview> {
  const ext = opts.filename.slice(opts.filename.lastIndexOf("."));
  const { body: rawBody, sourceFormat } = await convertToMarkdown(opts.buffer, ext);
  const { body: bodyWithMarkers, sections } = injectSectionMarkers(rawBody.trim() + "\n");
  const knownCategories = categoriesFromIndex(opts.index);
  const hintTitle = opts.filename.replace(/\.[^.]+$/, "");
  const id = opts.forceId ?? nextDocId(opts.index);

  let meta: FrontmatterMeta;
  let metaSource: "llm" | "fallback" = "llm";
  let metaError: string | undefined;
  if (opts.useLlm === false || !llmConfig.apiKey) {
    meta = {
      title: hintTitle,
      category: opts.forceCategory ?? "その他業務ガイド",
      keywords: [],
      summary: "",
    };
    metaSource = "fallback";
    if (opts.useLlm !== false && !llmConfig.apiKey) {
      metaError = "サーバーの設定が完了していません。管理者にお問い合わせください。";
    }
  } else {
    try {
      meta = await generateFrontmatterWithLlm({
        body: bodyWithMarkers,
        knownCategories,
        hintTitle,
      });
      if (opts.forceCategory) meta.category = opts.forceCategory;
    } catch (e) {
      meta = {
        title: hintTitle,
        category: opts.forceCategory ?? "その他業務ガイド",
        keywords: [],
        summary: "",
      };
      metaSource = "fallback";
      const raw = e instanceof Error ? e.message : String(e);
      metaError = friendlyLlmError(
        raw,
        "AIによるメタデータ生成に失敗しました。タイトル・カテゴリ・要約を手動で入力してください。",
      );
    }
  }

  const today = todayIso();
  const frontmatter = buildFrontmatter({
    id,
    title: meta.title,
    category: meta.category,
    sourceFormat,
    keywords: meta.keywords,
    summary: meta.summary,
    sections,
    today,
  });
  const docsDir = opts.docsDirRel ?? "documents";
  const outPath = `${docsDir}/${meta.category}/${id}_${slugifyForFilename(meta.title)}.md`;
  const body = bodyWithMarkers.trim() + "\n";
  const finalMarkdown = frontmatter + body;
  const indexEntry: DocumentMeta = {
    id,
    title: meta.title,
    category: meta.category,
    path: outPath,
    keywords: meta.keywords,
    summary: meta.summary,
    sections,
  };

  return {
    id,
    title: meta.title,
    category: meta.category,
    keywords: meta.keywords,
    summary: meta.summary,
    sourceFormat,
    sections,
    outPath,
    frontmatter,
    body,
    finalMarkdown,
    indexEntry,
    metaSource,
    metaError,
  };
}
