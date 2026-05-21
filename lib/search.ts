// Staged-disclosure document search, running on Cloudflare Workers AI.
//
//   Step 1  candidate selection  (lightweight model, JSON output)
//   Step 2  section body fetch   (file I/O, no LLM)
//   Step 3  answer generation    (high-quality model, streamed)
//
// docs/v2-design.md §3. The v3→v4 transition moved every LLM call here off
// Google Gemini onto Workers AI (lib/workers-ai.ts); Gemini context caching
// (the former lib/prompt-cache.ts) has no Workers AI equivalent and is gone.

import {
  buildIndexSnippet,
  loadIndex,
  loadSections,
  type DocumentMeta,
} from "./document-utils";
import { llmConfig } from "./llm-config";
import { renderVectorBlock, vectorSearch } from "./hybrid-search";
import { runJson, runTextStream, WorkersAiError, type WorkersAiUsage } from "./workers-ai";
import { OFFTOPIC_FALLBACK_INSTRUCTION, PERSONA_INSTRUCTION } from "./persona";
import { pickIntro } from "./intro-phrases";

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

// Step 1 system instruction. Selects which documents/sections to read and
// detects the question language.
const STEP1_SYSTEM_INSTRUCTION = `あなたは社内ドキュメント検索のアシスタントです。下記のドキュメント一覧（フロントマター+サマリー）から、ユーザーの質問に答えるために本文を読むべきドキュメントとセクションを **0〜3件** 選んでください。あわせて、ユーザーの質問の言語を検出してください。

# 出力形式（JSONのみ。説明文や前置きは禁止）
{
  "language": "ja",
  "candidates": [
    {"doc_id": "doc_xxx", "section_ids": ["sec_x", "sec_y"], "reason": "なぜこのセクションが必要か（1-2文）"}
  ]
}

# 候補選定の必須ルール（厳守）
1. **主題の一致が必須**: ドキュメント／セクションの主題（タイトル・サマリー・キーワードから読み取れる中心テーマ）が、質問の主題と一致している場合のみ候補とする。
2. **単語の表層一致だけで選ばない**: 例えば「禁止」「規程」「ルール」「セキュリティ」「管理」などの一般語が共通するだけでは候補にしない。質問が「セキュリティポリシーで禁止されていることは？」なら、情報セキュリティ／ISMS 系のドキュメントのみが候補。ハラスメント防止規程に「禁止される行為」セクションがあっても、ハラスメントは情報セキュリティの主題ではないので候補にしない。
3. **件数を埋めない**: 主題が一致するドキュメントが 1 件しかなければ 1 件、0 件なら空配列 \`[]\` を返す。無理に 3 件にしない。
4. **疑わしきは除外**: reason 欄に「関連がありそう」「念のため」「補足として」のような留保が必要なものは候補に入れない。
5. **会話履歴がある場合**: 直前のターンで言及された主題の継続（「それ」「詳しく」など指示語・省略表現を含む）と読めるなら、その主題でルール1〜4を再評価する。ただし、履歴に出ただけで現在の質問の主題と一致しないなら採用しない。履歴をきっかけにルール1〜4を緩めてはならない。

# その他のルール
- "language" は質問本文の言語を BCP-47 の主言語サブタグ（2〜3文字）で表す。例: 日本語=ja, 英語=en, 中国語=zh, 韓国語=ko, フランス語=fr, スペイン語=es, ドイツ語=de, ベトナム語=vi, タイ語=th。判定に迷う場合は ja。
- ドキュメント本文・キーワード・要約は日本語のままだが、質問が他言語でも意味的に関連するなら候補に含めてよい。
- 1ドキュメントあたりセクションは最大3つまで。
- ベクトル類似度上位として参考情報が与えられても、上記ルール1〜4で主題が一致しないと判断したものは採用しない。類似度は補助情報にすぎない。
- 該当なしの場合は {"language": "<検出した言語>", "candidates": []} を返す。`;

// json_schema constraint for Step 1's structured output.
const STEP1_SCHEMA = {
  type: "object",
  properties: {
    language: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          doc_id: { type: "string" },
          section_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["doc_id", "section_ids", "reason"],
      },
    },
  },
  required: ["language", "candidates"],
} as const;

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

// Per-stage token usage. Workers AI has no context-cache product, so the
// cached* fields are always zero — kept on the type for a stable wire shape.
export interface UsageSummary {
  stage: "candidates" | "answer";
  model: string;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
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

function summarizeUsage(
  stage: UsageSummary["stage"],
  model: string,
  usage: WorkersAiUsage | null,
): UsageSummary | null {
  if (!usage) return null;
  return {
    stage,
    model,
    promptTokens: usage.promptTokens,
    cachedTokens: 0,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheRatio: 0,
  };
}

// Structured single-line log so it's easy to grep server logs or pipe into
// any log aggregator without a parser. Keys match UsageSummary fields.
function logUsage(u: UsageSummary): void {
  console.log(
    `[search.usage] stage=${u.stage} model=${u.model} prompt=${u.promptTokens} output=${u.outputTokens} total=${u.totalTokens}`,
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

  const userPrompt = `${vectorBlock}# ドキュメント一覧
${indexSnippet}

${historyBlock}# ユーザーの質問
${question}`;

  // Content/parse failures degrade to "no candidates" (the fallback path then
  // replies in persona). Infrastructure errors — HTTP 4xx/5xx, missing
  // credentials — propagate so the route can surface a quota/config message.
  let parsed: Partial<Step1Result> = {};
  let usage: WorkersAiUsage | null = null;
  try {
    const res = await runJson<Partial<Step1Result>>({
      model: llmConfig.candidateModel,
      messages: [
        { role: "system", content: STEP1_SYSTEM_INSTRUCTION },
        { role: "user", content: userPrompt },
      ],
      schema: STEP1_SCHEMA,
      temperature: 0.1,
      maxTokens: 1024,
    });
    parsed = res.data ?? {};
    usage = res.usage;
  } catch (e) {
    if (!(e instanceof WorkersAiError) || e.status !== 200) throw e;
    console.warn(`[search.step1] parse/blocked: ${e.message}`);
  }
  return {
    language: normalizeLanguage(parsed.language),
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    usage: summarizeUsage("candidates", llmConfig.candidateModel, usage),
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
  const contextText = contextBlocks
    .map((b) => {
      const secs = b.sections
        .map((s) => `### ${s.title} (${s.id})\n${s.body}`)
        .join("\n\n");
      return `## ドキュメント: ${b.doc.title} [${b.doc.id}] (カテゴリ: ${b.doc.category})\n要約: ${b.doc.summary}\n\n${secs}`;
    })
    .join("\n\n---\n\n");

  const historyBlock = renderHistoryBlock(history);

  const userPrompt = `以下の参考資料のみを根拠に、簡潔かつ正確に回答してください。

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

  const gen = runTextStream({
    model: llmConfig.answerModel,
    messages: [
      { role: "system", content: PERSONA_INSTRUCTION },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 4096,
  });
  let usage: WorkersAiUsage | null = null;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      usage = value;
      break;
    }
    if (value) yield value;
  }
  return summarizeUsage("answer", llmConfig.answerModel, usage);
}

// Persona-tinted fallback when Step 1 finds nothing usable. No document
// context — token cost stays bounded. Uses the answer model since it's a
// natural-language reply, not a structured selection.
async function* step3FallbackStream(
  question: string,
  language: string,
  history?: ChatTurn[],
): AsyncGenerator<string, UsageSummary | null, void> {
  const historyBlock = renderHistoryBlock(history);
  const userPrompt = `# 回答言語
${language}（BCP-47 主言語サブタグ）

${historyBlock}# ユーザーの質問
${question}`;

  const gen = runTextStream({
    model: llmConfig.answerModel,
    messages: [
      { role: "system", content: OFFTOPIC_FALLBACK_INSTRUCTION },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: 2048,
  });
  let usage: WorkersAiUsage | null = null;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      usage = value;
      break;
    }
    if (value) yield value;
  }
  return summarizeUsage("answer", llmConfig.answerModel, usage);
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

  // 受け止めの一言はルールベースのプリセットから即決定する。LLM 待ちが
  // 消えるので Step 1 と直列にしても遅延は増えない。
  const intro = pickIntro(question);
  yield { type: "delta", text: intro };

  const step1 = await step1FindCandidates(question, index, history);
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

  // Step 3 generates the body only (no 一言, no marker). Prefix a paragraph
  // break so the body renders cleanly below the announcement.
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
