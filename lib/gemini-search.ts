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
import { OFFTOPIC_FALLBACK_INSTRUCTION, PERSONA_INSTRUCTION } from "./persona";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SearchSource {
  doc_id: string;
  title: string;
  category: string;
  section_ids: string[];
  section_titles: string[];
}

// Render recent chat turns as a prompt block. Caller is responsible for any
// trimming/sanitisation — we just format what we're given. Returns "" for
// empty input so callers can unconditionally interpolate.
function renderHistoryBlock(history: ChatTurn[] | undefined): string {
  if (!history || history.length === 0) return "";
  const lines = history.map(
    (t) => `${t.role === "user" ? "ユーザー" : "アシスタント"}: ${t.content}`,
  );
  return `# これまでの会話\n${lines.join("\n")}\n\n`;
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
  | { type: "intermission" }
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

// Quick intro generation — a single short sentence that acknowledges the
// question in シャイン's voice. Runs in parallel with Step 1 so it doesn't
// add latency to the body. Uses the small candidate model since the output
// is tiny. Always falls back to a generic line on failure rather than
// throwing — the search must not fail because the intro call did.
async function generateIntro(
  question: string,
  history: ChatTurn[] | undefined,
): Promise<string> {
  const FALLBACK = "ご質問ありがとうございます、関連する資料を確認しますね。";
  try {
    const client = getClient();
    const model = client.getGenerativeModel({
      model: llmConfig.candidateModel,
      generationConfig: { temperature: 0.6, maxOutputTokens: 80 },
    });
    const historyBlock = renderHistoryBlock(history);
    const prompt = `${PERSONA_INSTRUCTION}

これからユーザーの質問について社内ドキュメントを検索します。検索を始める前に、シャインらしい「短い受け止めの一言」を 1 文だけ出力してください。

# ルール
- 1 文のみ。25〜50 字程度。
- 質問の主題に軽く触れて、これから資料を確認する旨をやさしく伝える。
- 「了解しました」「承知しました」のような定型句や、挨拶・自己紹介・絵文字は使わない。
- Markdown 記法は使わない。前置き・後置きの説明文は禁止。出力は一言そのものだけ。

${historyBlock}# ユーザーの質問
${question}

# 出力（1 文のみ）`;
    const result = await withRetry(() => model.generateContent(prompt));
    const text = result.response.text().trim();
    if (!text) return FALLBACK;
    // Strip surrounding quotes or stray newlines, cap length defensively.
    const cleaned = text.replace(/^["'「『]+|["'」』]+$/g, "").split(/\r?\n/)[0].trim();
    return cleaned.length > 0 ? cleaned.slice(0, 80) : FALLBACK;
  } catch (e) {
    console.warn(
      `[search.intro] failed, using fallback: ${e instanceof Error ? e.message : e}`,
    );
    return FALLBACK;
  }
}

async function step1FindCandidates(
  question: string,
  index: DocumentMeta[],
  history?: ChatTurn[],
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
  const historyBlock = renderHistoryBlock(history);

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
    // Per-request body only carries the variable parts (vector hint + history
    // + the actual question). Everything else lives in the cached prefix, so
    // history must stay in this tail to keep the cache key stable.
    const variablePrompt = `${vectorBlock}${historyBlock}# ユーザーの質問\n${question}`;
    result = await withRetry(() => model.generateContent(variablePrompt));
  } else {
    const model = client.getGenerativeModel({
      model: llmConfig.candidateModel,
      systemInstruction: STEP1_SYSTEM_INSTRUCTION,
      generationConfig: STEP1_GENERATION_CONFIG,
    });
    const inlinePrompt = `${vectorBlock}# ドキュメント一覧
${indexSnippet}

${historyBlock}# ユーザーの質問
${question}`;
    result = await withRetry(() => model.generateContent(inlinePrompt));
  }

  // Blocked responses / non-JSON output must degrade to "no candidates" rather
  // than throw — otherwise vague follow-ups bubble up as "検索中にエラー" in
  // the route catch. The fallback path will pick this up and respond in
  // persona.
  let parsed: Partial<Step1Result> = {};
  try {
    const text = result.response.text();
    parsed = extractJson(text) as Partial<Step1Result>;
  } catch (e) {
    console.warn(
      `[search.step1] parse/blocked: ${e instanceof Error ? e.message : e}`,
    );
  }
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
  history?: ChatTurn[],
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

  const historyBlock = renderHistoryBlock(history);

  const prompt = `${PERSONA_INSTRUCTION}

以下の参考資料のみを根拠に、簡潔かつ正確に回答してください。

# 回答言語
ユーザーの質問の言語: ${language}（BCP-47 主言語サブタグ。例: ja=日本語, en=英語, zh=中国語, ko=韓国語）
出力するすべての自然言語をこの言語で記述すること。

${historyBlock}# ユーザーの質問
${question}

# 参考資料（原文の言語のまま提示。翻訳が必要な場合は引用箇所のみ自然に翻訳してよい）
${contextText}

# 回答ルール（厳守）
- 挨拶や自己紹介・前置きの一言は **不要**（UI 側で別途表示するため）。いきなり本文を書き始める。
- **本文はしっかり書く**: 全体で 400〜800 字程度を目安。要点だけでなく、適用条件・手続きの流れ・期限や金額などの具体的な数値・注意点や例外までカバーする。要点は 4〜8 項目程度を目安に、必要なら短い補足説明を添えて読みやすく整える。
- 参考資料に書かれている事実のみを使い、推測で補わない。資料に書かれていない条件・例外は「資料の記載なし」と明示する。
- Markdown を使ってよい。見出し（##）の多用は避けつつ、必要に応じて短い箇条書きや太字での強調を使って構造を整える。
- 参考資料の網羅的なコピー貼り付けは禁止。条文を要約しつつ、判断に必要な条件・数値・期限は省略せず正確に残す。
- **末尾に「参考ドキュメント一覧」のセクションは付けない**（UI 側で別途表示するため）。
- ドキュメント名・セクション名・固有名詞は原文（日本語）のまま引用してよい。
- 参考資料に答えがない場合は、回答言語で「該当する記載がありません」に相当する旨を 1〜2 文で示し、隣接領域に関する記載があれば触れる程度に留める。`;

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

// Persona-tinted fallback when Step 1 finds nothing usable. No document
// context — token cost stays bounded. Uses the answer model since it's a
// natural-language reply, not a structured selection.
async function* step3FallbackStream(
  question: string,
  language: string,
  history?: ChatTurn[],
): AsyncGenerator<string, UsageSummary | null, void> {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: llmConfig.answerModel,
    generationConfig: { temperature: 0.4 },
  });

  const historyBlock = renderHistoryBlock(history);
  const prompt = `${OFFTOPIC_FALLBACK_INSTRUCTION}

# 回答言語
${language}（BCP-47 主言語サブタグ）

${historyBlock}# ユーザーの質問
${question}`;

  const result = await withRetry(() => model.generateContentStream(prompt));
  for await (const chunk of result.stream) {
    const t = chunk.text();
    if (t) yield t;
  }
  const final = await result.response;
  return summarizeUsage("answer", llmConfig.answerModel, final.usageMetadata);
}

// Last-resort static fallback used only if the LLM fallback call itself
// throws. The persona-tinted Step 3' is the normal no-match path.
const NO_MATCH_BY_LANG: Record<string, string> = {
  ja: "ご質問に該当する社内ドキュメントが見つかりませんでした。質問を具体化していただくか、人事部までお問い合わせください。",
  en: "No matching internal documents were found. Please try rephrasing your question, or contact the HR team.",
  zh: "未找到符合您问题的内部文档。请尝试更具体地提问，或联系人事部门。",
  ko: "질문에 해당하는 사내 문서를 찾을 수 없습니다. 질문을 구체화하시거나 인사팀에 문의해 주세요.",
};

function noMatchMessage(language: string): string {
  return NO_MATCH_BY_LANG[language] ?? NO_MATCH_BY_LANG.ja;
}

async function* runFallback(
  question: string,
  language: string,
  history: ChatTurn[] | undefined,
): AsyncGenerator<SearchEvent> {
  yield { type: "sources", sources: [] };
  try {
    const gen = step3FallbackStream(question, language, history);
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
  } catch (e) {
    console.warn(
      `[search.fallback] persona reply failed, using static: ${e instanceof Error ? e.message : e}`,
    );
    yield { type: "delta", text: noMatchMessage(language) };
  }
  yield { type: "done" };
}

export async function* searchDocumentsStream(
  question: string,
  history?: ChatTurn[],
): AsyncGenerator<SearchEvent> {
  const index = await loadIndex();

  // Kick off the intro (短い一言) and Step 1 in parallel so the intro's
  // latency is hidden behind Step 1's. The intro is a separate small LLM
  // call rather than a marker inside Step 3's output — much more reliable
  // than asking the model to emit a custom token at a specific spot.
  const introPromise = generateIntro(question, history);
  const step1Promise = step1FindCandidates(question, index, history);

  // Stream the intro first so the user sees a personalized 一言 quickly.
  const intro = await introPromise;
  if (intro) yield { type: "delta", text: intro };

  const step1 = await step1Promise;
  const { language, candidates } = step1;
  if (step1.usage) {
    logUsage(step1.usage);
    yield { type: "usage", usage: step1.usage };
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
    // Off-topic / no usable docs: skip the "検索開始です。" announcement
    // since we're not actually searching anymore. Brief intermission, then
    // a persona-style fallback reply.
    yield { type: "intermission" };
    await new Promise((r) => setTimeout(r, 300));
    yield* runFallback(question, language, history);
    return;
  }

  // On-topic: announce the search, pause briefly with dots, then stream
  // the body. The intermission + small delay guarantees the second-phase
  // loading dots are visible even when Step 3's first chunk lands fast.
  yield { type: "delta", text: "\n\n検索開始です。" };
  yield { type: "intermission" };
  await new Promise((r) => setTimeout(r, 450));

  const sources: SearchSource[] = blocks.map((b) => ({
    doc_id: b.doc.id,
    title: b.doc.title,
    category: b.doc.category,
    section_ids: b.sections.map((s) => s.id),
    section_titles: b.sections.map((s) => s.title),
  }));

  // Step 3 now generates the body only (no 一言, no marker). Prefix a
  // paragraph break so the body renders cleanly below the announcement.
  let bodyStarted = false;
  const gen = step3StreamAnswer(question, language, blocks, history);
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      if (value) {
        logUsage(value);
        yield { type: "usage", usage: value };
      }
      break;
    }
    if (!bodyStarted) {
      bodyStarted = true;
      yield { type: "delta", text: "\n\n" + value.replace(/^\s+/, "") };
    } else {
      yield { type: "delta", text: value };
    }
  }
  yield { type: "sources", sources };
  yield { type: "done" };
}
