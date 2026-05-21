// Gemini-side draft generation for chat-based document creation
// (v2 design Phase 6, §4-D companion).
//
// Unlike lib/edit-llm.ts — which constrains edits of an EXISTING document to
// {find, replace} so §10's "no full regeneration" rule holds — this module
// drafts a BRAND NEW document. Full-body generation is appropriate here:
// there is no original text to corrupt, and the result still goes through a
// human review + PR before it lands (§4-D, §10: no auto-merge).
//
// responseSchema forces a {title, category, keywords, summary, markdown,
// notes} object so the caller never has to robust-parse free-form prose.

import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { llmConfig, requireApiKey } from "./llm-config";

const DRAFT_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: {
      type: SchemaType.STRING,
      description: "文書のタイトル（30字以内）。",
    },
    category: {
      type: SchemaType.STRING,
      description:
        "カテゴリ。提示されたカテゴリ候補から最も近いものを1つ選ぶ。妥当な候補が無ければ新しいカテゴリ名でよい。",
    },
    keywords: {
      type: SchemaType.ARRAY,
      description: "検索用キーワード（最大8件）。",
      items: { type: SchemaType.STRING },
    },
    summary: {
      type: SchemaType.STRING,
      description: "本文の要約（80〜200字）。",
    },
    markdown: {
      type: SchemaType.STRING,
      description:
        "文書本文の Markdown。章立ては '## 見出し' を使う。フロントマター（--- で囲む YAML）は絶対に含めない。",
    },
    notes: {
      type: SchemaType.STRING,
      description:
        "利用者へのチャット返答（1〜3文）。何を書いたか、確認したい点があれば質問する。",
    },
  },
  required: ["title", "category", "keywords", "summary", "markdown", "notes"],
} as const;

export interface DraftMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DraftDocumentInput {
  messages: DraftMessage[];
  currentDraft: string;
  knownCategories: string[];
}

export interface DraftDocumentResult {
  title: string;
  category: string;
  keywords: string[];
  summary: string;
  markdown: string;
  notes: string;
}

export async function draftDocumentViaLlm(
  input: DraftDocumentInput,
): Promise<DraftDocumentResult> {
  const client = new GoogleGenerativeAI(requireApiKey());
  const model = client.getGenerativeModel({
    model: llmConfig.answerModel,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
      responseSchema: DRAFT_SCHEMA,
    },
  });

  const transcript = input.messages
    .map((m) => `${m.role === "user" ? "利用者" : "アシスタント"}: ${m.content}`)
    .join("\n\n");

  const prompt = `あなたは社内ドキュメントの新規作成を支援するアシスタントです。
利用者との会話と現在の下書きをもとに、社内ドキュメントの「完成版の下書き」を生成してください。

# 重要な制約
- 出力は {title, category, keywords, summary, markdown, notes} の JSON のみ。
- "markdown" は文書の本文。フロントマター（--- で囲む YAML）は含めない。
- 章立てには "## 見出し" を使う。箇条書きや表（GFM）を適宜使ってよい。
- これは新規作成なので毎回「本文全体」を出力してよい。会話に修正依頼があれば、現在の下書きを土台に必要最小限の変更で更新する。
- "category" はカテゴリ候補から最も近いものを1つ選ぶ。どれにも当てはまらず新カテゴリが妥当ならその名前でよい。
- "keywords" は検索用キーワードを最大8件。
- "summary" は本文の要約（80〜200字）。
- "notes" は利用者へのチャット返答（1〜3文）。何を書いたか、確認したい点があれば質問する。
- 事実を創作しないこと。利用者が与えていない固有の数値・規程名・日付・部署名などは本文中で「[要確認]」と明記するか、"notes" で利用者に質問する。

# カテゴリ候補
${input.knownCategories.length > 0 ? input.knownCategories.map((c) => `- ${c}`).join("\n") : "（まだありません）"}

# 現在の下書き（本文）
${input.currentDraft.trim() ? input.currentDraft : "（まだありません）"}

# 会話
${transcript}

上記を踏まえ、最新の指示を反映した完成版の下書きを JSON で出力してください。`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(text) as Partial<DraftDocumentResult>;

  return {
    title: String(parsed.title ?? "").slice(0, 120),
    category: String(parsed.category ?? "").slice(0, 60),
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => String(k)).filter(Boolean).slice(0, 8)
      : [],
    summary: String(parsed.summary ?? "").slice(0, 400),
    markdown: String(parsed.markdown ?? ""),
    notes: String(parsed.notes ?? "").slice(0, 800),
  };
}
