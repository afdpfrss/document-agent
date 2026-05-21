#!/usr/bin/env node
// Precompute section embeddings for hybrid search (docs/v2-design.md §4-A).
//
// Embeddings run on Cloudflare Workers AI (@cf/baai/bge-m3, multilingual).
// The model name is written into embeddings.json so the query side
// (lib/hybrid-search.ts) always embeds with the exact same model.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "documents", "index.json");
const OUT_PATH = path.join(ROOT, "documents", "embeddings.json");

const BATCH = 50;
const DELAY_MS = 500;
const MAX_BODY_CHARS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvLocal() {
  // Tiny .env.local loader so we don't add a dependency.
  const envPath = path.join(ROOT, ".env.local");
  return fs
    .readFile(envPath, "utf8")
    .then((raw) => {
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const k = m[1];
        let v = m[2];
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
      }
    })
    .catch(() => {});
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

// Embed a batch of strings via Workers AI. Retries 429 and 5xx with
// exponential backoff. Returns one vector per input, in input order.
async function embedBatch({ accountId, apiToken, model, texts }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: texts }),
      });
    } catch (err) {
      if (attempt < 4) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
    if (res.ok) {
      const json = await res.json();
      if (!json.success) {
        throw new Error(`Workers AI error: ${JSON.stringify(json.errors)}`);
      }
      return json.result.data;
    }
    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => "");
    if (retryable && attempt < 4) {
      console.warn(`  Workers AI HTTP ${res.status}, retrying…`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Workers AI HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
}

async function main() {
  await loadEnvLocal();
  // The embedding model name is env-driven (docs/v2-design.md §7). It is
  // recorded in embeddings.json so the query side uses the identical model.
  const MODEL = process.env.LLM_EMBEDDING_MODEL || "@cf/baai/bge-m3";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_AI_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN must be set. Add them to .env.local.",
    );
    process.exit(1);
  }

  const indexRaw = await fs.readFile(INDEX_PATH, "utf8");
  const index = JSON.parse(indexRaw);

  const targets = [];
  for (const doc of index) {
    const md = await fs.readFile(path.join(ROOT, doc.path), "utf8");
    const sections = parseSections(md);
    for (const s of sections) {
      const truncated =
        s.body.length > MAX_BODY_CHARS ? s.body.slice(0, MAX_BODY_CHARS) : s.body;
      // Title + summary context + body — helps the embedding capture topical info
      const text = `${doc.title} / ${s.title}\nカテゴリ: ${doc.category}\nキーワード: ${doc.keywords.join(", ")}\n\n${truncated}`;
      targets.push({
        doc_id: doc.id,
        section_id: s.id,
        section_title: s.title,
        text,
      });
    }
  }

  console.log(
    `Embedding ${targets.length} sections from ${index.length} documents via Workers AI (${MODEL})…`,
  );

  const results = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const vectors = await embedBatch({
      accountId,
      apiToken,
      model: MODEL,
      texts: slice.map((t) => t.text),
    });
    vectors.forEach((vec, k) => {
      const t = slice[k];
      results.push({
        doc_id: t.doc_id,
        section_id: t.section_id,
        section_title: t.section_title,
        vector: vec,
      });
    });
    console.log(`  ${Math.min(i + BATCH, targets.length)} / ${targets.length}`);
    if (i + BATCH < targets.length) {
      await sleep(DELAY_MS);
    }
  }

  await fs.writeFile(
    OUT_PATH,
    JSON.stringify(
      {
        model: MODEL,
        dim: results[0]?.vector.length ?? 0,
        count: results.length,
        items: results,
      },
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
