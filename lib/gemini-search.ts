import { GoogleGenerativeAI, type UsageMetadata } from "@google/generative-ai";
import {
  buildIndexSnippet,
  loadIndex,
  loadSections,
  type DocumentMeta,
} from "./document-utils";
import { llmConfig, requireApiKey } from "./llm-config";
import { renderVectorBlock, vectorSearch } from "./hybrid-search";
import { getOrCreateStep1Cache, STEP1_SYSTEM_INSTRUCTION } from "./prompt-cache";

export interface SearchSource {
  doc_id: string;
  title: string;
  category: string;
  section_ids: string[];
  section_titles: string[];
}

// Per-stage token + implicit-cache observation. v2 design Phase 2: we don't
// configure explicit caching yet — we just measure what Gemini's implicit
// cache gives us (cachedContentTokenCount on UsageMetadata) so we can decide
// whether explicit caching (Phase 8) is worth the engineering effort.
export interface UsageSummary {
  stage: "candidates" | "answer";
  model: string;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  // cachedTokens / promptTokens, 0 when promptTokens === 0.
  cacheRatio: number;
}

export type SearchEvent =
  | { type: "sources"; sources: SearchSource[] }
  | { type: "delta"; text: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "done" }
  | { type: "error"; error: string };

interface Step1Candidate {
  doc_id: string;
  section_ids: string[];
  reason: string;
}

interface Step1Result {
  // BCP-47 primary subtag detected from the user's question (e.g. "ja", "en", "zh", "ko").
  // Used by Step 3 to lock response language and by the no-match fallback.
  language: string;
  candidates: Step1Candidate[];
  usage: UsageSummary | null;
}

function getClient(): GoogleGenerativeAI {
  return new GoogleGenerativeAI(requireApiKey());
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

function summarizeUsage(
  stage: UsageSummary["stage"],
  model: string,
  meta: UsageMetadata | undefined,
): UsageSummary | null {
  if (!meta) return null;
  const promptTokens = meta.promptTokenCount ?? 0;
  const cachedTokens = meta.cachedContentTokenCount ?? 0;
  return {
    stage,
    model,
    promptTokens,
    cachedTokens,
    outputTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
    cacheRatio: promptTokens > 0 ? cachedTokens / promptTokens : 0,
  };
}

// Structured single-line log so it's easy to grep server logs or pipe into
// any log aggregator without a parser. Keys match UsageSummary fields.
function logUsage(u: UsageSummary): void {
  console.log(
    `[search.usage] stage=${u.stage} model=${u.model} prompt=${u.promptTokens} cached=${u.cachedTokens} ratio=${u.cacheRatio.toFixed(3)} output=${u.outputTokens} total=${u.totalTokens}`,
  );
}

function normalizeLanguage(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "ja";
  // Take the first run of letters and cap at 3 — BCP-47 primary subtags are
  // 2-3 alpha (ISO 639-1/-2/-3). This collapses both legitimate region tags
  // like "zh-CN" → "zh" and any garbled/hostile model output to a safe value
  // that won't poison the downstream prompt.
  const primary = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] ?? "";
  const capped = primary.slice(0, 3);
  return capped.length >= 2 ? capped : "ja";
}

const STEP1_GENERATION_CONFIG = {
  temperature: 0.1,
  responseMimeType: "application/json",
  maxOutputTokens: 512,
} as const;

async function step1FindCandidates(
  question: string,
  index: DocumentMeta[],
): Promise<Step1Result> {
  // Hybrid search and snippet build run in parallel — the vector RTT overlaps
  // with the (synchronous, cached) snippet build. Vector path is best-effort.
  const [vectorHits, indexSnippet] = await Promise.all([
    vectorSearch(question, 10).catch((e) => {
      console.warn("[search] vectorSearch threw, falling back:", e instanceof Error ? e.message : e);
      return null;
    }),
    Promise.resolve(buildIndexSnippet(index)),
  ]);
  if (vectorHits) {
    console.log(
      `[search.hybrid] vector_hits=${vectorHits.length} top_score=${vectorHits[0]?.score.toFixed(3) ?? "n/a"}`,
    );
  }
  const vectorBlock = vectorHits ? renderVectorBlock(vectorHits) : "";

  // Phase 8: try explicit context caching for the fixed prefix (system
  // instruction + doc list). The cache layer returns null on any failure —
  // missing key, too-small content, transient API error — and we fall back
  // to the inline path that Phases 1-4 used.
  const cached = await getOrCreateStep1Cache(indexSnippet);

  const client = getClient();
  let result;
  if (cached) {
    const model = client.getGenerativeModelFromCachedContent(cached, {
      generationConfig: STEP1_GENERATION_CONFIG,
    });
    // Per-request body only carries the variable parts (vector hint + the
    // actual question). Everything else lives in the cached prefix.
    const variablePrompt = `${vectorBlock}# ユーザーの質問\n${question}`;
    result = await withRetry(() => model.generateContent(variablePrompt));
  } else {
    const model = client.getGenerativeModel({
      model: llmConfig.candidateModel,
      systemInstruction: STEP1_SYSTEM_INSTRUCTION,
      generationConfig: STEP1_GENERATION_CONFIG,
    });
    const inlinePrompt = `${vectorBlock}# ドキュメント一覧
${indexSnippet}

# ユーザーの質問
${question}`;
    result = await withRetry(() => model.generateContent(inlinePrompt));
  }

  const text = result.response.text();
  const parsed = extractJson(text) as Partial<Step1Result>;
  return {
    language: normalizeLanguage(parsed.language),
    candidates: parsed.candidates ?? [],
    usage: summarizeUsage(
      "candidates",
      llmConfig.candidateModel,
      result.response.usageMetadata,
    ),
  };
}

async function* step3StreamAnswer(
  question: string,
  language: string,
  contextBlocks: Array<{
    doc: DocumentMeta;
    sections: Array<{ id: string; title: string; body: string }>;
  }>,
): AsyncGenerator<string, UsageSummary | null, void> {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: llmConfig.answerModel,
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

  const prompt = `あなたは社内ドキュメントに基づいて質問に回答する専門アシスタントです。以下の参考資料のみを根拠に、簡潔かつ正確に回答してください。

# 回答言語
ユーザーの質問の言語: ${language}（BCP-47 主言語サブタグ。例: ja=日本語, en=英語, zh=中国語, ko=韓国語）
出力するすべての自然言語をこの言語で記述すること。

# ユーザーの質問
${question}

# 参考資料（原文の言語のまま提示。翻訳が必要な場合は引用箇所のみ自然に翻訳してよい）
${contextText}

# 回答ルール（厳守）
- **冒頭に短い一言** を 1 文だけ添える。質問への共感・受け止め・案内のニュアンスで、自然なトーンで（例: 「お問い合わせの件、関連規程からご案内します。」「いくつかの規程に定めがありますので、要点をまとめます。」）。挨拶や自己紹介は不要。
- 一言のあと、改行して本文を続ける。
- **本文は短く**: 全体で 200〜400 字程度を目安。冗長な列挙、補足、前置きは省く。要点を 3〜6 項目以内に絞る。
- 参考資料に書かれている事実のみを使い、推測で補わない。
- Markdown を使ってよいが、見出し（##）の多用は避ける。必要なら短い箇条書きを 1 セクションまで。
- 参考資料の網羅的なコピー貼り付けは禁止。「重要なポイント」だけを抜き出す。
- **末尾に「参考ドキュメント一覧」のセクションは付けない**（UI 側で別途表示するため）。
- ドキュメント名・セクション名・固有名詞は原文（日本語）のまま引用してよい。
- 参考資料に答えがない場合は、回答言語で「該当する記載がありません」に相当する旨を 1 文で示すのみ。`;

  const result = await withRetry(() => model.generateContentStream(prompt));
  for await (const chunk of result.stream) {
    const t = chunk.text();
    if (t) yield t;
  }
  // After the stream is drained, result.response resolves with the aggregated
  // response — including usageMetadata for the full call. Returned via the
  // generator's TReturn so the caller can emit a typed usage event.
  const final = await result.response;
  return summarizeUsage("answer", llmConfig.answerModel, final.usageMetadata);
}

// Fallback messages used when Step 1 returns zero candidates. Kept as a small
// static map so we don't burn another LLM call just to localise an apology.
// Falls back to Japanese for any language not listed here.
const NO_MATCH_BY_LANG: Record<string, string> = {
  ja: "ご質問に該当する社内ドキュメントが見つかりませんでした。質問を具体化していただくか、人事部までお問い合わせください。",
  en: "No matching internal documents were found. Please try rephrasing your question, or contact the HR team.",
  zh: "未找到符合您问题的内部文档。请尝试更具体地提问，或联系人事部门。",
  ko: "질문에 해당하는 사내 문서를 찾을 수 없습니다. 질문을 구체화하시거나 인사팀에 문의해 주세요.",
};

function noMatchMessage(language: string): string {
  return NO_MATCH_BY_LANG[language] ?? NO_MATCH_BY_LANG.ja;
}

export async function* searchDocumentsStream(
  question: string,
): AsyncGenerator<SearchEvent> {
  const index = await loadIndex();

  const step1 = await step1FindCandidates(question, index);
  const { language, candidates } = step1;
  if (step1.usage) {
    logUsage(step1.usage);
    yield { type: "usage", usage: step1.usage };
  }

  if (candidates.length === 0) {
    yield { type: "sources", sources: [] };
    yield { type: "delta", text: noMatchMessage(language) };
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
    yield { type: "delta", text: noMatchMessage(language) };
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

  // Explicit iteration (not for-await-of) so we can capture the generator's
  // return value — the Step 3 UsageSummary — and emit it as a typed event.
  const gen = step3StreamAnswer(question, language, blocks);
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      if (value) {
        logUsage(value);
        yield { type: "usage", usage: value };
      }
      break;
    }
    yield { type: "delta", text: value };
  }
  yield { type: "sources", sources };
  yield { type: "done" };
}
