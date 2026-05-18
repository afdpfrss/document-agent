import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  buildIndexSnippet,
  loadIndex,
  loadSections,
  type DocumentMeta,
} from "./document-utils";

const MODEL_LITE = "gemini-2.5-flash-lite";
const MODEL_FULL = "gemini-2.5-flash";

export interface SearchSource {
  doc_id: string;
  title: string;
  category: string;
  section_ids: string[];
  section_titles: string[];
}

export type SearchEvent =
  | { type: "sources"; sources: SearchSource[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

interface Step1Candidate {
  doc_id: string;
  section_ids: string[];
  reason: string;
}

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Set it in .env.local before running the search.",
    );
  }
  return new GoogleGenerativeAI(key);
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error(`No JSON found in model output: ${text.slice(0, 200)}`);
  return JSON.parse(raw.slice(start).trim());
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|rate|quota|5\d\d|unavailable|deadline/i.test(msg) && i < attempts - 1) {
        const delay = 500 * 2 ** i;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function step1FindCandidates(
  question: string,
  index: DocumentMeta[],
): Promise<Step1Candidate[]> {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: MODEL_LITE,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
    },
  });

  const indexSnippet = buildIndexSnippet(index);
  const prompt = `あなたは社内ドキュメント検索のアシスタントです。下記のドキュメント一覧（フロントマター+サマリー）から、ユーザーの質問に答えるために本文を読むべきドキュメントとセクションを最大3件まで選んでください。

# ドキュメント一覧
${indexSnippet}

# ユーザーの質問
${question}

# 出力形式（JSONのみ。説明文や前置きは禁止）
{
  "candidates": [
    {"doc_id": "doc_xxx", "section_ids": ["sec_x", "sec_y"], "reason": "なぜこのセクションが必要か（1-2文）"}
  ]
}

注意:
- 質問と関係ないドキュメントは含めない。
- 1ドキュメントあたりセクションは最大3つまで。
- 該当なしの場合は {"candidates": []} を返す。`;

  const result = await withRetry(() => model.generateContent(prompt));
  const text = result.response.text();
  const parsed = extractJson(text) as { candidates?: Step1Candidate[] };
  return parsed.candidates ?? [];
}

async function* step3StreamAnswer(
  question: string,
  contextBlocks: Array<{
    doc: DocumentMeta;
    sections: Array<{ id: string; title: string; body: string }>;
  }>,
): AsyncGenerator<string> {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: MODEL_FULL,
    generationConfig: { temperature: 0.2 },
  });

  const contextText = contextBlocks
    .map((b) => {
      const secs = b.sections
        .map((s) => `### ${s.title} (${s.id})\n${s.body}`)
        .join("\n\n");
      return `## ドキュメント: ${b.doc.title} [${b.doc.id}] (カテゴリ: ${b.doc.category})\n要約: ${b.doc.summary}\n\n${secs}`;
    })
    .join("\n\n---\n\n");

  const prompt = `あなたは社内ドキュメントに基づいて質問に回答する専門アシスタントです。以下の参考資料のみを根拠に、日本語で正確に回答してください。

# ユーザーの質問
${question}

# 参考資料
${contextText}

# 回答ルール
- 参考資料に書かれている事実のみを使う。推測で補わない。
- 複数のドキュメントの情報を統合し、わかりやすく整理する。
- Markdownを使い、必要に応じて見出し・箇条書き・太字を活用する。
- 回答末尾に必ず「## 参考ドキュメント」セクションを設け、根拠とした各ドキュメント名とセクション名を箇条書きで列挙する。
- 参考資料に答えがない場合は「該当する記載がありません」と明示する。`;

  const result = await withRetry(() => model.generateContentStream(prompt));
  for await (const chunk of result.stream) {
    const t = chunk.text();
    if (t) yield t;
  }
}

const NO_MATCH_MESSAGE =
  "ご質問に該当する社内ドキュメントが見つかりませんでした。質問を具体化していただくか、人事部までお問い合わせください。";

export async function* searchDocumentsStream(
  question: string,
): AsyncGenerator<SearchEvent> {
  const index = await loadIndex();

  const candidates = await step1FindCandidates(question, index);

  if (candidates.length === 0) {
    yield { type: "sources", sources: [] };
    yield { type: "delta", text: NO_MATCH_MESSAGE };
    yield { type: "done" };
    return;
  }

  const blocks: Array<{
    doc: DocumentMeta;
    sections: Array<{ id: string; title: string; body: string }>;
  }> = [];
  for (const c of candidates.slice(0, 3)) {
    const doc = index.find((d) => d.id === c.doc_id);
    if (!doc) continue;
    const sections = await loadSections(c.doc_id, c.section_ids.slice(0, 3));
    if (sections.length === 0) continue;
    blocks.push({ doc, sections });
  }

  if (blocks.length === 0) {
    yield { type: "sources", sources: [] };
    yield { type: "delta", text: NO_MATCH_MESSAGE };
    yield { type: "done" };
    return;
  }

  const sources: SearchSource[] = blocks.map((b) => ({
    doc_id: b.doc.id,
    title: b.doc.title,
    category: b.doc.category,
    section_ids: b.sections.map((s) => s.id),
    section_titles: b.sections.map((s) => s.title),
  }));
  yield { type: "sources", sources };

  for await (const chunk of step3StreamAnswer(question, blocks)) {
    yield { type: "delta", text: chunk };
  }
  yield { type: "done" };
}
