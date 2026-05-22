// Centralised LLM configuration.
// Lets us swap models or providers (Gemini → Sakura AI Engine, etc.) via env
// vars without touching call sites. See docs/v2-design.md §6, §7.

export const llmConfig = {
  candidateModel: process.env.LLM_CANDIDATE_MODEL ?? "gemini-2.5-flash-lite",
  answerModel: process.env.LLM_ANSWER_MODEL ?? "gemini-2.5-flash",
  apiKey: process.env.GEMINI_API_KEY,
} as const;

export function requireApiKey(): string {
  if (!llmConfig.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Set it in .env.local before running the search.",
    );
  }
  return llmConfig.apiKey;
}
