#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "documents", "index.json");
const OUT_PATH = path.join(ROOT, "documents", "embeddings.json");

const BATCH = 5;
const DELAY_MS = 13000;
const MAX_BODY_CHARS = 2000;

function loadEnvLocal() {
  // Tiny .env.local loader so we don't add a dependency.
  const envPath = path.join(ROOT, ".env.local");
  return fs.readFile(envPath, "utf8").then((raw) => {
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  }).catch(() => {});
}

function parseSections(markdown) {
  // Strip frontmatter
  let body = markdown;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  const lines = body.split("\n");
  const out = [];
  let currentId = null;
  let currentTitle = "";
  let buf = [];
  const flush = () => {
    if (currentId) {
      out.push({ id: currentId, title: currentTitle, body: buf.join("\n").trim() });
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
      buf = [];
      if (m) i++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

async function main() {
  await loadEnvLocal();
  // 埋め込みモデル名は環境変数で抽象化する（v2 設計 §2 / §7 — Gemini→さくら
  // 等への切替余地を残す）。クエリ側 (lib/hybrid-search.ts) は
  // embeddings.json に記録された model を使うため、ここで使った値が
  // そのまま検索時のクエリ埋め込みにも使われ、両者は常に一致する。
  const MODEL = process.env.LLM_EMBEDDING_MODEL || "gemini-embedding-001";
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set. Add it to .env.local.");
    process.exit(1);
  }
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: MODEL });

  const indexRaw = await fs.readFile(INDEX_PATH, "utf8");
  const index = JSON.parse(indexRaw);

  const targets = [];
  for (const doc of index) {
    const md = await fs.readFile(path.join(ROOT, doc.path), "utf8");
    const sections = parseSections(md);
    for (const s of sections) {
      const truncated = s.body.length > MAX_BODY_CHARS ? s.body.slice(0, MAX_BODY_CHARS) : s.body;
      // Title + summary context + body — helps the embedding capture topical info
      const text = `${doc.title} / ${s.title}\nカテゴリ: ${doc.category}\nキーワード: ${doc.keywords.join(", ")}\n\n${truncated}`;
      targets.push({
        doc_id: doc.id,
        doc_title: doc.title,
        category: doc.category,
        section_id: s.id,
        section_title: s.title,
        text,
      });
    }
  }

  console.log(`Embedding ${targets.length} sections from ${index.length} documents…`);

  const results = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    let res;
    let attempt = 0;
    while (true) {
      try {
        res = await model.batchEmbedContents({
          requests: slice.map((t) => ({
            content: { role: "user", parts: [{ text: t.text }] },
            taskType: TaskType.RETRIEVAL_DOCUMENT,
            title: `${t.doc_title} / ${t.section_title}`,
          })),
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/429|rate|quota/i.test(msg) && attempt < 4) {
          const wait = 5000 * 2 ** attempt;
          console.warn(`  rate limited, retrying in ${wait}ms…`);
          await new Promise((r) => setTimeout(r, wait));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    res.embeddings.forEach((e, k) => {
      const t = slice[k];
      results.push({
        doc_id: t.doc_id,
        section_id: t.section_id,
        section_title: t.section_title,
        vector: e.values,
      });
    });
    console.log(`  ${Math.min(i + BATCH, targets.length)} / ${targets.length}`);
    if (i + BATCH < targets.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  await fs.writeFile(
    OUT_PATH,
    JSON.stringify(
      { model: MODEL, dim: results[0]?.vector.length ?? 0, count: results.length, items: results },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Wrote ${results.length} embeddings to ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
