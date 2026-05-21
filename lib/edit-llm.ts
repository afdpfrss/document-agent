// Gemini-side proposal generation for chat-based editing (v2 Phase 6).
//
// Uses responseSchema to force the model to emit {find, replace, reason}[]
// instead of free-form prose, so we never have to robust-parse a creative
// answer. Combined with applyEdits()'s exact-substring matching, this gives
// us a fail-loud pipeline: if the model hallucinates context, the apply
// step rejects the edit with `not_found` rather than mangling the file.

import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { llmConfig, requireApiKey } from "./llm-config";
import type { EditProposal } from "./edit-schema";

const PROPOSAL_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    edits: {
      type: SchemaType.ARRAY,
      description: "順序付き編集リスト。順に適用される。",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          find: {
            type: SchemaType.STRING,
            description:
              "原文に1箇所だけ存在する逐語の部分文字列。前後の文脈を含めて一意になるようにする。",
          },
          replace: {
            type: SchemaType.STRING,
            description: "置換後のテキスト。削除する場合は空文字。",
          },
          reason: {
            type: SchemaType.STRING,
            description: "この編集の理由（1-2文）。レビュアーが PR で読む。",
          },
        },
        required: ["find", "replace", "reason"],
      },
    },
  },
  required: ["edits"],
} as const;

export interface ProposeEditsInput {
  docTitle: string;
  docCategory: string;
  originalContent: string;
  instruction: string;
}

export async function proposeEditsViaLlm(
  input: ProposeEditsInput,
): Promise<EditProposal> {
  const client = new GoogleGenerativeAI(requireApiKey());
  const model = client.getGenerativeModel({
    model: llmConfig.answerModel,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: PROPOSAL_SCHEMA,
    },
  });

  const prompt = `あなたは社内ドキュメントの編集を支援するアシスタントです。
指示に従ってドキュメントを編集する「最小の置換操作」のリストを JSON で出力してください。

# 重要な制約
- 出力は {edits: [{find, replace, reason}, ...]} の形式のみ。
- "find" は原文に**一意に**存在する逐語部分文字列にすること。曖昧な場合は前後の文脈を含めて十分長くする。
- "find" がドキュメントに存在しないと適用は失敗する。コピペ可能な精度で書くこと。
- ドキュメント全体の再生成は禁止。常に最小限の差分を提案する。
- 削除する場合は "replace" を空文字にする。
- "reason" には変更理由を 1-2 文で書く（レビュアー向け）。
- 指示と関係ない変更は提案しない。

# 対象ドキュメント
タイトル: ${input.docTitle}
カテゴリ: ${input.docCategory}

# 編集指示
${input.instruction}

# ドキュメント本文
${input.originalContent}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(text) as EditProposal;
  if (!Array.isArray(parsed.edits)) {
    return { edits: [] };
  }
  // Defensive cleanup — the schema constrains the shape but the model can
  // still emit empty strings or extra whitespace that we want to normalise.
  parsed.edits = parsed.edits
    .filter(
      (e) =>
        e && typeof e.find === "string" && typeof e.replace === "string" && e.find.length > 0,
    )
    .map((e) => ({
      find: e.find,
      replace: e.replace,
      reason: String(e.reason ?? "").slice(0, 500),
    }));
  return parsed;
}
