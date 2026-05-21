import { GoogleGenerativeAI, type UsageMetadata } from "@google/generative-ai";
import {
  buildIndexSnippet,
  loadIndex,
  type DocumentMeta,
} from "./document-utils";
import { selectSections } from "./section-select";
import { locateCitation, type CitedLocation } from "./clause-locate";
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
  // The passage this document contributed, resolved at request time.
  cited: CitedLocation;
}

// A drill-down chip click carries the previous turn's candidate documents so
// the follow-up — already a concrete question — can skip Step 1 and go
// straight to section selection within those documents.
export interface SearchFocus {
  doc_ids: string[];
  language: string;
}

// One picked document plus the section bodies Step 3 will read.
interface AnswerBlock {
  doc: DocumentMeta;
  sections: Array<{ id: string; title: string; body: string }>;
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
  // Drill-down suggestions shown as clickable chips. `doc_ids` is the carry
  // context: clicking a chip re-sends it as a focused (Step 1-skipping) query.
  | { type: "followups"; items: string[]; language: string; doc_ids: string[] }
  | { type: "usage"; usage: UsageSummary }
  | { type: "done" }
  | { type: "error"; error: string };

interface Step1Candidate {
  doc_id: string;
  reason: string;
}

interface Step1Result {
  // BCP-47 primary subtag detected from the user's question (e.g. "ja", "en", "zh", "ko").
  // Used by Step 3 to lock response language and by the no-match fallback.
  language: string;
  // Whether the question names something concrete to look up, or is still an
  // abstract topic mention. Abstract questions skip the heavy answer stage and
  // get a lightweight clarifying reply instead.
  mode: "abstract" | "concrete";
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
    mode: parsed.mode === "abstract" ? "abstract" : "concrete",
    candidates: parsed.candidates ?? [],
    usage: summarizeUsage(
      "candidates",
      llmConfig.candidateModel,
      result.response.usageMetadata,
    ),
  };
}

// Drill-down suggestions are appended by Step 3 after this marker on its own
// final line — streamed prose before it, a JSON array of follow-up questions
// after. Splitting on a marker keeps the answer streamable (a responseSchema
// would force us to buffer the whole answer first).
const FOLLOWUPS_MARKER = "[[FOLLOWUPS]]";
const MAX_FOLLOWUPS = 4;

function parseFollowups(trailer: string): string[] {
  const start = trailer.indexOf("[");
  const end = trailer.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(trailer.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 60)
      .slice(0, MAX_FOLLOWUPS);
  } catch {
    return [];
  }
}

// How many trailing chars of `buf` must be retained before emitting a delta:
// a partial FOLLOWUPS_MARKER at the end, plus any whitespace immediately
// before it. The marker sits on its own final line, so the whitespace leading
// up to it must not leak into the answer text either.
function pendingMarkerLen(buf: string): number {
  let marker = 0;
  for (let k = Math.min(buf.length, FOLLOWUPS_MARKER.length - 1); k > 0; k--) {
    if (FOLLOWUPS_MARKER.startsWith(buf.slice(buf.length - k))) {
      marker = k;
      break;
    }
  }
  let ws = 0;
  for (let i = buf.length - marker - 1; i >= 0 && /\s/.test(buf[i]); i--) ws++;
  return marker + ws;
}

// Wraps a raw model text stream: yields the answer prose (marker stripped) and
// returns the parsed follow-up list plus the usage summary. A partial marker
// at a chunk boundary is held back so it never leaks into a delta.
async function* splitFollowups(
  raw: AsyncGenerator<string, UsageSummary | null, void>,
): AsyncGenerator<string, { usage: UsageSummary | null; followups: string[] }, void> {
  let buf = "";
  let trailer = "";
  let inTrailer = false;
  let usage: UsageSummary | null = null;
  while (true) {
    const { value, done } = await raw.next();
    if (done) {
      usage = value ?? null;
      break;
    }
    if (inTrailer) {
      trailer += value;
      continue;
    }
    buf += value;
    const idx = buf.indexOf(FOLLOWUPS_MARKER);
    if (idx >= 0) {
      const before = buf.slice(0, idx).replace(/\s+$/, "");
      if (before) yield before;
      trailer = buf.slice(idx + FOLLOWUPS_MARKER.length);
      inTrailer = true;
      buf = "";
    } else {
      // Hold back a possible partial marker (and its leading whitespace) so a
      // marker split across chunks never leaks.
      const hold = pendingMarkerLen(buf);
      if (buf.length > hold) {
        yield buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
      }
    }
  }
  if (!inTrailer && buf) yield buf;
  return { usage, followups: parseFollowups(trailer) };
}

async function* step3StreamAnswer(
  question: string,
  language: string,
  contextBlocks: AnswerBlock[],
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
- 参考資料に答えがない場合は、回答言語で「該当する記載がありません」に相当する旨を 1〜2 文で示し、隣接領域に関する記載があれば触れる程度に留める。
- 本文の最後に、ユーザーが続けて知りたくなりそうな論点を 1 文で軽く案内してよい（「〜についてもお調べできます」程度。箇条書きにはしない）。
- そのうえで、最終行に必ず次の 1 行だけを出力する（この行は表示されず、システムが処理する）:
  ${FOLLOWUPS_MARKER} ["質問1","質問2"]
  これは今回の回答で深く触れていないが参考資料に関連記載のある隣接トピックを、ユーザーが次に押すと自然な「短い具体的な質問文」として 2〜4 個、回答言語で書いたもの。隣接トピックが乏しければ 0〜1 個でもよい。`;

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

// Abstract path: the question names a topic area but not a concrete thing to
// look up, so we deliberately do NOT read section bodies. Using only the
// candidate documents' frontmatter + section titles, we reply at the level of
// "which area, what aspects" and offer drill-down chips that turn the next
// turn into a concrete question. Far lighter than step3StreamAnswer.
async function* step3StreamAbstract(
  question: string,
  language: string,
  docs: DocumentMeta[],
  history?: ChatTurn[],
): AsyncGenerator<string, UsageSummary | null, void> {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: llmConfig.answerModel,
    generationConfig: { temperature: 0.3 },
  });

  const docList = docs
    .map((d) => {
      const secs = d.sections.map((s) => s.title).join(" / ");
      return `## ${d.title} [${d.id}] (カテゴリ: ${d.category})\n要約: ${d.summary}\n見出し: ${secs}`;
    })
    .join("\n\n");

  const historyBlock = renderHistoryBlock(history);

  const prompt = `${PERSONA_INSTRUCTION}

ユーザーの質問はまだ抽象的で、何を知りたいかが絞れていません。いきなり詳細を答えず、関連しそうな社内ドキュメントの「どの観点を知りたいか」をユーザーから引き出してください。本文はまだ読んでいません。

# 回答言語
ユーザーの質問の言語: ${language}（BCP-47 主言語サブタグ）。出力するすべての自然言語をこの言語で記述すること。

${historyBlock}# ユーザーの質問
${question}

# 関連しそうなドキュメント（本文は未取得・タイトルと見出しのみ）
${docList}

# 応答ルール（厳守）
- 挨拶・自己紹介・前置きは不要。いきなり本文を書き始める。
- 2〜4 文で、どの領域の話かを示し、上の見出しのうち何を詳しく知りたいか尋ねる。会話的に、温度のある業務口調で。
- 具体的な手続き・数値・期限・条文は書かない（まだ本文を読んでいないため）。推測で補わない。
- 見出しの長い列挙や箇条書きはしない。
- 最終行に必ず次の 1 行だけを出力する（この行は表示されず、システムが処理する）:
  ${FOLLOWUPS_MARKER} ["質問1","質問2","質問3"]
  これは、ユーザーが次に押すと自然な「短い具体的な質問文」を 2〜4 個。上の見出しに対応させ、回答言語で書く。`;

  const result = await withRetry(() => model.generateContentStream(prompt));
  for await (const chunk of result.stream) {
    const t = chunk.text();
    if (t) yield t;
  }
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

// Concrete path: read the relevant section bodies and stream the answer body,
// then emit citation cards and drill-down chips.
async function* runConcreteAnswer(
  question: string,
  language: string,
  blocks: AnswerBlock[],
  history: ChatTurn[] | undefined,
): AsyncGenerator<SearchEvent> {
  const sources: SearchSource[] = blocks.flatMap((b) => {
    const cited = locateCitation(question, b.sections);
    return cited
      ? [{ doc_id: b.doc.id, title: b.doc.title, category: b.doc.category, cited }]
      : [];
  });

  // Step 3 generates the body only (no 一言, no marker). Strip leading
  // whitespace from the first chunk so the answer starts cleanly.
  let bodyStarted = false;
  let followups: string[] = [];
  const gen = splitFollowups(step3StreamAnswer(question, language, blocks, history));
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      if (value.usage) {
        logUsage(value.usage);
        yield { type: "usage", usage: value.usage };
      }
      followups = value.followups;
      break;
    }
    if (!bodyStarted) {
      bodyStarted = true;
      yield { type: "delta", text: value.replace(/^\s+/, "") };
    } else {
      yield { type: "delta", text: value };
    }
  }
  yield { type: "sources", sources };
  if (followups.length > 0) {
    yield {
      type: "followups",
      items: followups,
      language,
      doc_ids: blocks.map((b) => b.doc.id),
    };
  }
  yield { type: "done" };
}

// Abstract path: we are not reading bodies — stream a clarifying reply, then
// drill-down chips that carry the candidate doc ids so a chip click skips
// Step 1.
async function* runAbstractReply(
  question: string,
  language: string,
  docs: DocumentMeta[],
  history: ChatTurn[] | undefined,
): AsyncGenerator<SearchEvent> {
  let bodyStarted = false;
  let followups: string[] = [];
  const gen = splitFollowups(step3StreamAbstract(question, language, docs, history));
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      if (value.usage) {
        logUsage(value.usage);
        yield { type: "usage", usage: value.usage };
      }
      followups = value.followups;
      break;
    }
    if (!bodyStarted) {
      bodyStarted = true;
      yield { type: "delta", text: value.replace(/^\s+/, "") };
    } else {
      yield { type: "delta", text: value };
    }
  }
  // No section bodies were read, so there are no citation cards to show — the
  // chips are the path forward.
  yield { type: "sources", sources: [] };
  if (followups.length > 0) {
    yield {
      type: "followups",
      items: followups,
      language,
      doc_ids: docs.map((d) => d.id),
    };
  }
  yield { type: "done" };
}

// Resolve doc ids to DocumentMeta, dropping unknowns and duplicates. Capped at
// 3 to match the candidate ceiling.
function resolveDocs(ids: string[], index: DocumentMeta[]): DocumentMeta[] {
  const out: DocumentMeta[] = [];
  for (const id of ids) {
    const doc = index.find((d) => d.id === id);
    if (doc && !out.some((d) => d.id === doc.id)) out.push(doc);
  }
  return out.slice(0, 3);
}

// Step 2: for each picked document, score its sections against the question
// (lib/section-select.ts) and keep the bodies Step 3 will read.
async function buildConcreteBlocks(
  question: string,
  docs: DocumentMeta[],
): Promise<AnswerBlock[]> {
  const blocks: AnswerBlock[] = [];
  for (const doc of docs) {
    const sections = await selectSections(question, doc.id, 3);
    if (sections.length > 0) blocks.push({ doc, sections });
  }
  return blocks;
}

export async function* searchDocumentsStream(
  question: string,
  history?: ChatTurn[],
  focus?: SearchFocus,
): AsyncGenerator<SearchEvent> {
  const index = await loadIndex();

  // Carry path: a drill-down chip click sends the previous turn's candidate
  // doc ids. The follow-up is already a concrete question, so Step 1 is
  // skipped — go straight to section selection within those documents. If the
  // focus docs are stale or yield no sections, fall through to a full search.
  if (focus && focus.doc_ids.length > 0) {
    const focusDocs = resolveDocs(focus.doc_ids, index);
    if (focusDocs.length > 0) {
      const blocks = await buildConcreteBlocks(question, focusDocs);
      if (blocks.length > 0) {
        yield* runConcreteAnswer(
          question,
          normalizeLanguage(focus.language),
          blocks,
          history,
        );
        return;
      }
    }
  }

  const step1 = await step1FindCandidates(question, index, history);
  const { language, candidates, mode } = step1;
  if (step1.usage) {
    logUsage(step1.usage);
    yield { type: "usage", usage: step1.usage };
  }

  const candidateDocs = resolveDocs(
    candidates.slice(0, 3).map((c) => c.doc_id),
    index,
  );

  if (candidateDocs.length === 0) {
    // Off-topic / no usable docs: respond with a persona-style fallback reply.
    yield* runFallback(question, language, history);
    return;
  }

  // Abstract question: respond at the topic level without reading bodies.
  if (mode === "abstract") {
    yield* runAbstractReply(question, language, candidateDocs, history);
    return;
  }

  // Concrete question: read the relevant section bodies and answer.
  const blocks = await buildConcreteBlocks(question, candidateDocs);
  if (blocks.length === 0) {
    yield* runFallback(question, language, history);
    return;
  }
  yield* runConcreteAnswer(question, language, blocks, history);
}
