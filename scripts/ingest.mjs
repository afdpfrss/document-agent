#!/usr/bin/env node
// Multi-format document ingestion pipeline (v2 design Phase 3, §4-B).
//
// Usage:
//   node scripts/ingest.mjs <input> [--out path] [--id doc_NNN] [--category CAT]
//                                    [--dry-run] [--no-llm]
//
// Pipeline:
//   1. Convert input (pdf|docx|xlsx|csv|html|md|txt) → plain markdown body.
//   2. Walk H2 headings, assign sequential sec_N ids, inject the
//      `<!-- section_id: sec_N -->` markers that lib/document-utils.ts looks for.
//   3. (Optional) Ask the LLM to fill in {title, category, keywords, summary}
//      from the body and the existing category vocabulary.
//   4. Emit a markdown file with full YAML frontmatter matching the v1 schema.
//   5. Append/replace the entry in documents/index.json.
//
// The script is dev tooling — it lives in scripts/ and is not bundled with the
// Next.js app. Heavy converters (mammoth, xlsx, pdfjs-dist, turndown) are
// devDependencies and loaded lazily so we only pay for the formats we use.
//
// NOTE: lib/ingest-core.ts holds a parallel copy of this conversion logic for
// the web upload path (app/api/upload/...). The duplication is intentional —
// Node's type-stripping for .ts imports from .mjs is brittle, so this CLI keeps
// its own copy. The two are kept in sync by hand: when you change one, change
// the other.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "documents", "index.json");
const DOCS_DIR = path.join(ROOT, "documents");

// ---------- argv ----------

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[k] = true;
      } else {
        out.flags[k] = next;
        i++;
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

// ---------- env ----------

async function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {
    // .env.local missing is fine — caller may have set vars via the shell.
  }
}

// ---------- format converters ----------

async function convertHtml(buf) {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return td.turndown(buf.toString("utf8"));
}

async function convertDocx(buf) {
  const mammoth = await import("mammoth");
  // convertToMarkdown emits ATX-style headings and standard markdown, which
  // matches the section-marker convention parsed by lib/document-utils.ts.
  const r = await mammoth.convertToMarkdown({ buffer: buf });
  return r.value;
}

async function convertPdf(buf) {
  // pdfjs-dist's legacy build runs under plain Node without DOM polyfills.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Silence the verbose font/structure warnings — we only want text.
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Each item has .str (the glyph cluster) and .hasEOL. Join with spaces,
    // insert a newline on EOL hints so paragraph structure survives roughly.
    let text = "";
    for (const item of content.items) {
      if ("str" in item) {
        text += item.str;
        if (item.hasEOL) text += "\n";
        else text += " ";
      }
    }
    pages.push(text.trim());
  }
  // PDFs rarely have semantic H2s, so we just emit page boundaries as headings
  // — the LLM frontmatter step can later resummarise into more meaningful
  // sections, but at least the section splitter has something to chew on.
  return pages
    .map((t, i) => `## Page ${i + 1}\n\n${t}`)
    .join("\n\n");
}


// Merge markers — viewer (lib/rehype-merged-cells.ts) collapses these
// cells into rowspan/colspan at render time. Storage stays as plain GFM.
const MERGE_LEFT = "←";
const MERGE_UP = "↑";

async function convertXlsx(buf) {
  const xlsx = await import("xlsx");
  const wb = xlsx.read(buf, { type: "buffer" });
  const blocks = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const merges = sheet["!merges"] ?? [];
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

function convertCsv(buf) {
  return csvToMarkdownTable(buf.toString("utf8"));
}

function convertText(buf) {
  // Treat plain text as a single section so it gets a section marker.
  const text = buf.toString("utf8").trim();
  return `## 本文\n\n${text}`;
}

function convertMarkdown(buf) {
  // Pass through — section markers (if missing) get injected downstream.
  return buf.toString("utf8");
}

// Minimal CSV → GFM table. Doesn't try to handle every RFC-4180 edge case;
// good enough for the spreadsheets we expect in internal documents.
function csvToMarkdownTable(csv) {
  const rows = parseCsv(csv);
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    const out = r.slice();
    while (out.length < width) out.push("");
    return out.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "));
  });
  const header = padded[0];
  const body = padded.slice(1);
  const sep = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
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

const CONVERTERS = {
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

function detectConverter(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const conv = CONVERTERS[ext];
  if (!conv) {
    throw new Error(
      `Unsupported file extension: ${ext}. Supported: ${Object.keys(CONVERTERS).join(", ")}`,
    );
  }
  return conv;
}

// ---------- section markers ----------

// Walk the body, find every "## " heading, and ensure the next line is a
// `<!-- section_id: sec_N -->` marker. Returns the rewritten body plus the
// list of {id, title} for frontmatter.
export function injectSectionMarkers(body) {
  const lines = body.split("\n");
  const out = [];
  const sections = [];
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
  // If the document had zero H2 headings, wrap the whole thing as sec_1 so the
  // staged-disclosure search has at least one addressable section.
  if (sections.length === 0) {
    const wrapped = `## 本文\n<!-- section_id: sec_1 -->\n\n${body.trim()}`;
    return { body: wrapped, sections: [{ id: "sec_1", title: "本文" }] };
  }
  return { body: out.join("\n"), sections };
}

// ---------- LLM frontmatter ----------

async function generateFrontmatterWithLlm({ body, knownCategories, hintTitle }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: process.env.LLM_CANDIDATE_MODEL ?? "gemini-2.5-flash-lite",
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
    },
  });

  // 8 KB body sample is more than enough for metadata extraction and keeps
  // us inside the lite model's free-tier sweet spot. Larger files would
  // burn tokens for diminishing accuracy gains here.
  const truncated = body.slice(0, 8000);
  const prompt = `次の社内ドキュメントの本文を読み、フロントマターのメタデータを JSON で生成してください。

# カテゴリ候補（必ずこの中から1つ選ぶこと）
${knownCategories.map((c) => `- ${c}`).join("\n")}

# 出力スキーマ（JSON のみ。前置きや説明文は禁止）
{
  "title": "ドキュメントのタイトル（30字以内）",
  "category": "上のカテゴリ候補から1つ。判別が難しければ 'その他業務ガイド'",
  "keywords": ["検索キーワード", "...", "最大8件"],
  "summary": "本文の要約（80〜200字）"
}

${hintTitle ? `# 参考: ファイル名由来のタイトル候補\n${hintTitle}\n\n` : ""}# 本文（最初の${truncated.length}文字）
${truncated}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(extractJson(text));
  if (!knownCategories.includes(parsed.category)) {
    parsed.category = "その他業務ガイド";
  }
  if (!Array.isArray(parsed.keywords)) parsed.keywords = [];
  parsed.keywords = parsed.keywords.slice(0, 8).map((k) => String(k));
  return {
    title: String(parsed.title ?? hintTitle ?? "Untitled"),
    category: parsed.category,
    keywords: parsed.keywords,
    summary: String(parsed.summary ?? ""),
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
  return raw.slice(start).trim();
}

// ---------- frontmatter writer ----------

function quoteYaml(s) {
  // Always emit as a double-quoted scalar with backslash escaping. Simpler
  // than predicting which strings YAML would parse unquoted, and matches the
  // style of existing documents/<cat>/doc_NNN_*.md files.
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildFrontmatter({ id, title, category, sourceFormat, keywords, summary, sections, today }) {
  const lines = [
    "---",
    `id: ${quoteYaml(id)}`,
    `title: ${quoteYaml(title)}`,
    `category: ${quoteYaml(category)}`,
    `source_format: ${quoteYaml(sourceFormat)}`,
    `created_date: ${quoteYaml(today)}`,
    `last_updated: ${quoteYaml(today)}`,
    `version: ${quoteYaml("1.0")}`,
    `keywords: [${keywords.map(quoteYaml).join(", ")}]`,
    `summary: ${quoteYaml(summary)}`,
    "sections:",
    ...sections.flatMap((s) => [`  - id: ${quoteYaml(s.id)}`, `    title: ${quoteYaml(s.title)}`]),
    "---",
    "",
  ];
  return lines.join("\n");
}

// ---------- index.json updater ----------

async function loadIndex() {
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  return JSON.parse(raw);
}

function nextDocId(index) {
  let max = 0;
  for (const d of index) {
    const m = String(d.id ?? "").match(/^doc_(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `doc_${String(max + 1).padStart(3, "0")}`;
}

function slugifyForFilename(s) {
  // Keep CJK characters; only strip filesystem-hostile ones.
  return String(s).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 60) || "doc";
}

async function upsertIndex(entry) {
  const index = await loadIndex();
  const i = index.findIndex((d) => d.id === entry.id);
  if (i >= 0) index[i] = entry;
  else index.push(entry);
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf8");
}

// ---------- main ----------

async function main() {
  await loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length === 0 || args.flags.help) {
    console.error(
      "Usage: node scripts/ingest.mjs <input> [--out path] [--id doc_NNN] [--category CAT] [--dry-run] [--no-llm]",
    );
    process.exit(args.positional.length === 0 ? 1 : 0);
  }
  const inputPath = path.resolve(args.positional[0]);
  const buf = await fs.readFile(inputPath);
  const { fn: convert, source_format } = detectConverter(inputPath);

  const rawBody = await convert(buf);
  const { body: bodyWithMarkers, sections } = injectSectionMarkers(rawBody.trim() + "\n");

  const index = await loadIndex();
  const knownCategories = [...new Set(index.map((d) => d.category))].sort();
  const id = String(args.flags.id ?? nextDocId(index));
  const hintTitle = path.basename(inputPath, path.extname(inputPath));

  let meta;
  if (args.flags["no-llm"]) {
    meta = {
      title: hintTitle,
      category: String(args.flags.category ?? "その他業務ガイド"),
      keywords: [],
      summary: "",
    };
  } else {
    meta = await generateFrontmatterWithLlm({ body: bodyWithMarkers, knownCategories, hintTitle });
    if (args.flags.category) meta.category = String(args.flags.category);
  }

  const today = new Date().toISOString().slice(0, 10);
  const fm = buildFrontmatter({
    id,
    title: meta.title,
    category: meta.category,
    sourceFormat: source_format,
    keywords: meta.keywords,
    summary: meta.summary,
    sections,
    today,
  });
  const finalMarkdown = fm + bodyWithMarkers.trim() + "\n";

  const outPath = args.flags.out
    ? path.resolve(String(args.flags.out))
    : path.join(DOCS_DIR, meta.category, `${id}_${slugifyForFilename(meta.title)}.md`);
  const relOut = path.relative(ROOT, outPath);

  const indexEntry = {
    id,
    title: meta.title,
    category: meta.category,
    path: relOut,
    keywords: meta.keywords,
    summary: meta.summary,
    sections,
  };

  if (args.flags["dry-run"]) {
    console.log("--- frontmatter ---");
    console.log(fm.trimEnd());
    console.log("--- body (first 400 chars) ---");
    console.log(bodyWithMarkers.slice(0, 400));
    console.log("--- index entry ---");
    console.log(JSON.stringify(indexEntry, null, 2));
    console.log(`(would write to ${relOut})`);
    return;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, finalMarkdown, "utf8");
  await upsertIndex(indexEntry);
  console.log(`Wrote ${relOut}`);
  console.log(`Updated documents/index.json (${id})`);
}

// Only run when invoked as a script — keeps the file importable for tests.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
