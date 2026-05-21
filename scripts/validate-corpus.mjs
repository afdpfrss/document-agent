#!/usr/bin/env node
// Corpus-integrity validator — ポカヨケ設計 柱1（機械判定できるミスは機械が止める）。
//
// documents/**/*.md のすべてを、実行時パーサ（lib/document-utils.ts）と
// 検索・編集レイヤが前提とする規約に照らして検証し、documents/index.json の
// 整合性も確認する。エラーが1件でもあれば非ゼロ終了するので、GitHub Actions の
// 必須チェックとして PR のマージを止められる。
//
// 使い方:
//   node scripts/validate-corpus.mjs          人間向けのグループ化レポート
//   node scripts/validate-corpus.mjs --json   機械可読な JSON 出力
//
// 重要: 下の parseAllSections は lib/document-utils.ts:parseAllSections の
// 逐語コピー。あちらのマーカー判定規則が変わったら、このコピーも必ず同時に
// 更新すること（lockstep）。さもないと CI が実行時挙動と乖離する。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "documents");
const INDEX_PATH = path.join(DOCS_DIR, "index.json");

const REQUIRED_FRONTMATTER = [
  "id",
  "title",
  "category",
  "source_format",
  "created_date",
  "last_updated",
  "version",
  "keywords",
  "summary",
  "sections",
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER_RE = /<!--\s*section_id:\s*(\S+)\s*-->/;

// --- error sink — fail-fast せず全件集約する（CI 1回で全問題を見せる） ------
const errors = [];
function fail(code, file, message) {
  errors.push({ code, file, message });
}

// --- lib/document-utils.ts:parseAllSections の逐語コピー（lockstep 必須） ---
function parseAllSections(content) {
  const lines = content.split("\n");
  const out = [];
  let currentId = null;
  let currentTitle = "";
  let buffer = [];

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

// --- markdown ファイル列挙（再帰） ----------------------------------------
async function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function relOf(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

// --- 1文書の検証 — frontmatter をパースできれば data を返す ---------------
function validateDocFile(rel, raw) {
  let parsed;
  try {
    parsed = matter(raw);
  } catch (e) {
    fail("INVALID_FRONTMATTER", rel, `frontmatter の YAML パースに失敗: ${e.message}`);
    return null;
  }
  const data = parsed.data ?? {};
  if (Object.keys(data).length === 0) {
    fail("INVALID_FRONTMATTER", rel, "frontmatter が空、または存在しません");
    return null;
  }

  // 必須フィールド
  for (const f of REQUIRED_FRONTMATTER) {
    if (data[f] === undefined || data[f] === null) {
      fail("MISSING_FIELD", rel, `必須フィールド欠落: ${f}`);
    }
  }
  // 型
  if (data.keywords !== undefined && !Array.isArray(data.keywords)) {
    fail("BAD_FIELD_TYPE", rel, "keywords は配列である必要があります");
  }
  if (data.sections !== undefined && !Array.isArray(data.sections)) {
    fail("BAD_FIELD_TYPE", rel, "sections は配列である必要があります");
  }
  for (const f of ["created_date", "last_updated"]) {
    if (data[f] !== undefined && data[f] !== null) {
      if (typeof data[f] !== "string" || !DATE_RE.test(data[f])) {
        fail(
          "BAD_FIELD_TYPE",
          rel,
          `${f} は引用符付き YYYY-MM-DD 文字列である必要があります: ${JSON.stringify(data[f])}`,
        );
      }
    }
  }

  // 配置整合性 — frontmatter category = 親ディレクトリ名
  const parentDir = path.basename(path.dirname(rel));
  if (typeof data.category === "string" && data.category !== parentDir) {
    fail(
      "PATH_MISMATCH",
      rel,
      `category「${data.category}」が配置ディレクトリ「${parentDir}」と一致しません`,
    );
  }

  const content = parsed.content ?? "";

  // section マーカー — 全 "## " 見出しの直後行にマーカーが必要
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      const next = lines[i + 1] ?? "";
      if (!MARKER_RE.test(next)) {
        fail(
          "MISSING_SECTION_MARKER",
          rel,
          `見出し「${lines[i].slice(3).trim()}」の直後行に section_id マーカーがありません`,
        );
      }
    }
  }

  // section_id の連番・一意性
  const bodySections = parseAllSections(content);
  const seen = new Set();
  for (const s of bodySections) {
    if (seen.has(s.id)) {
      fail("DUPLICATE_SECTION_ID", rel, `section_id が重複しています: ${s.id}`);
    }
    seen.add(s.id);
  }
  bodySections.forEach((s, idx) => {
    const expected = `sec_${idx + 1}`;
    if (s.id !== expected) {
      fail(
        "NON_SEQUENTIAL_SECTION_IDS",
        rel,
        `section_id は連番である必要があります: ${idx + 1} 番目は ${expected} を期待、実際は ${s.id}`,
      );
    }
  });

  // frontmatter sections ↔ 本文マーカーの一致
  if (Array.isArray(data.sections)) {
    const fm = data.sections;
    if (fm.length !== bodySections.length) {
      fail(
        "SECTIONS_DESYNC",
        rel,
        `frontmatter の sections 数(${fm.length})と本文のセクション数(${bodySections.length})が一致しません`,
      );
    } else {
      fm.forEach((s, idx) => {
        const b = bodySections[idx];
        const sid = s && typeof s === "object" ? s.id : undefined;
        const stitle = s && typeof s === "object" ? s.title : undefined;
        if (sid !== b.id || stitle !== b.title) {
          fail(
            "SECTIONS_DESYNC",
            rel,
            `sections[${idx}] が本文と不一致: frontmatter={id:${sid}, title:${stitle}} / 本文={id:${b.id}, title:${b.title}}`,
          );
        }
      });
    }
  }

  return data;
}

// --- index.json の検証 ----------------------------------------------------
async function validateIndex(docRelList, docDataByRel) {
  let raw;
  try {
    raw = await fs.readFile(INDEX_PATH, "utf8");
  } catch (e) {
    fail("INVALID_INDEX_JSON", "documents/index.json", `読み込めません: ${e.message}`);
    return;
  }
  let index;
  try {
    index = JSON.parse(raw);
  } catch (e) {
    fail("INVALID_INDEX_JSON", "documents/index.json", `JSON パースエラー: ${e.message}`);
    return;
  }
  if (!Array.isArray(index)) {
    fail("INVALID_INDEX_JSON", "documents/index.json", "配列ではありません");
    return;
  }

  const seenIds = new Set();
  const indexedPaths = new Set();

  for (const entry of index) {
    const where = `index entry [${entry && entry.id ? entry.id : "(id 不明)"}]`;
    if (!entry || typeof entry.id !== "string") {
      fail("INDEX_DESYNC", "documents/index.json", `${where}: id が不正です`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      fail("DUPLICATE_DOC_ID", "documents/index.json", `doc_id が重複しています: ${entry.id}`);
    }
    seenIds.add(entry.id);

    if (typeof entry.path !== "string") {
      fail("INDEX_DESYNC", "documents/index.json", `${where}: path が不正です`);
      continue;
    }
    const rel = entry.path.replace(/\\/g, "/");
    indexedPaths.add(rel);

    const data = docDataByRel.get(rel);
    if (!data) {
      fail(
        "DANGLING_INDEX_ENTRY",
        "documents/index.json",
        `${where}: path のファイルが存在しないか frontmatter 不正です: ${rel}`,
      );
      continue;
    }

    for (const f of ["id", "title", "category"]) {
      if (entry[f] !== data[f]) {
        fail(
          "INDEX_DESYNC",
          "documents/index.json",
          `${where}: ${f} が文書 frontmatter と不一致 (index=${JSON.stringify(entry[f])} / file=${JSON.stringify(data[f])})`,
        );
      }
    }

    const eSecs = Array.isArray(entry.sections) ? entry.sections : [];
    const dSecs = Array.isArray(data.sections) ? data.sections : [];
    const secMismatch =
      eSecs.length !== dSecs.length ||
      eSecs.some(
        (s, i) =>
          !s ||
          !dSecs[i] ||
          s.id !== dSecs[i].id ||
          s.title !== dSecs[i].title,
      );
    if (secMismatch) {
      fail(
        "INDEX_DESYNC",
        "documents/index.json",
        `${where}: sections が文書 frontmatter と不一致です`,
      );
    }
  }

  // index に登録されていない md ファイル
  for (const rel of docRelList) {
    if (!indexedPaths.has(rel)) {
      fail("ORPHAN_FILE", rel, "documents/index.json に登録されていません");
    }
  }
}

// --- レポート -------------------------------------------------------------
function report(jsonOutput, fileCount) {
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        { ok: errors.length === 0, file_count: fileCount, error_count: errors.length, errors },
        null,
        2,
      ),
    );
    return;
  }
  if (errors.length === 0) {
    console.log(`corpus 検証 OK — ${fileCount} 文書、エラーなし`);
    return;
  }
  console.error(`corpus 検証 NG — ${fileCount} 文書中 ${errors.length} 件のエラー\n`);
  const byFile = new Map();
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  for (const [file, errs] of byFile) {
    console.error(`  ${file}`);
    for (const e of errs) console.error(`    [${e.code}] ${e.message}`);
    console.error("");
  }
}

async function main() {
  const jsonOutput = process.argv.includes("--json");

  const mdAbsFiles = await walkMarkdown(DOCS_DIR);
  const docRelList = [];
  const docDataByRel = new Map();

  for (const abs of mdAbsFiles) {
    const rel = relOf(abs);
    docRelList.push(rel);
    let raw;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch (e) {
      fail("READ_ERROR", rel, `読み込めません: ${e.message}`);
      continue;
    }
    const data = validateDocFile(rel, raw);
    if (data) docDataByRel.set(rel, data);
  }

  await validateIndex(docRelList, docDataByRel);

  report(jsonOutput, docRelList.length);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
