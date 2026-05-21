// Centralised LLM configuration.
//
// The whole agent runs on Cloudflare Workers AI (docs/v2-design.md §6, §7).
// Model IDs and credentials are env-driven, so a future provider swap
// (さくらの AI Engine など) only has to touch lib/workers-ai.ts plus these
// defaults — call sites stay untouched.

export const llmConfig = {
  // Cloudflare Workers AI model IDs (the `@cf/...` namespace).
  // candidate = lightweight selection model, answer = high-quality model.
  candidateModel:
    process.env.LLM_CANDIDATE_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast",
  answerModel:
    process.env.LLM_ANSWER_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  embeddingModel: process.env.LLM_EMBEDDING_MODEL ?? "@cf/baai/bge-m3",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_AI_API_TOKEN,
} as const;

// True when Workers AI credentials are present. Call sites use this to fail
// soft (vector search) or return a 503 (chat / edit routes).
export function isLlmConfigured(): boolean {
  return Boolean(llmConfig.accountId && llmConfig.apiToken);
}

export function requireLlmCredentials(): {
  accountId: string;
  apiToken: string;
} {
  if (!llmConfig.accountId || !llmConfig.apiToken) {
    throw new Error(
      "Workers AI is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN in .env.local before running the search.",
    );
  }
  return { accountId: llmConfig.accountId, apiToken: llmConfig.apiToken };
}
