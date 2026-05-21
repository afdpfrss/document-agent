// Workers AI proposal generation for chat-based editing (v2 Phase 6).
//
// Uses a json_schema response format to force the model to emit
// {find, replace, reason}[] instead of free-form prose, so we never have to
// robust-parse a creative answer. Combined with applyEdits()'s exact-substring
// matching, this gives a fail-loud pipeline: if the model hallucinates
// context, the apply step rejects the edit with `not_found` rather than
// mangling the file.

import { llmConfig } from "./llm-config";
import { runJson } from "./workers-ai";
import type { EditProposal } from "./edit-schema";

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      description: "順序付き編集リスト。順に適用される。",
      items: {
        type: "object",
        properties: {
          find: {
            type: "string",
            description:
              "原文に1箇所だけ存在する逐語の部分文字列。前後の文脈を含めて一意になるようにする。",
          },
          replace: {
            type: "string",
            description: "置換後のテキスト。削除する場合は空文字。",
          },
          reason: {
            type: "string",
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
  const prompt = `指示に従ってドキュメントを編集する「最小の置換操作」のリストを JSON で出力してください。

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

  const res = await runJson<EditProposal>({
    model: llmConfig.answerModel,
    messages: [
      {
        role: "system",
        content: "あなたは社内ドキュメントの編集を支援するアシスタントです。",
      },
      { role: "user", content: prompt },
    ],
    schema: PROPOSAL_SCHEMA,
    temperature: 0.2,
    maxTokens: 4096,
  });

  const parsed = res.data;
  if (!parsed || !Array.isArray(parsed.edits)) {
    return { edits: [] };
  }
  // Defensive cleanup — the schema constrains the shape but the model can
  // still emit empty strings or extra whitespace that we want to normalise.
  return {
    edits: parsed.edits
      .filter(
        (e) =>
          e &&
          typeof e.find === "string" &&
          typeof e.replace === "string" &&
          e.find.length > 0,
      )
      .map((e) => ({
        find: e.find,
        replace: e.replace,
        reason: String(e.reason ?? "").slice(0, 500),
      })),
  };
}
