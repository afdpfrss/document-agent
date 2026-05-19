// Friendly translations for Gemini / LLM error messages.
// Shared between the search route (chat) and the upload pipeline so users
// see the same wording regardless of which path tripped the quota.

function formatRetryDelay(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `約${Math.max(1, Math.ceil(seconds))}秒後`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `約${minutes}分後`;
  const hours = Math.ceil(minutes / 60);
  return `約${hours}時間後`;
}

// Turn a Gemini 429 / quota error string into something a user can act on.
// Returns null when the message is not a quota error.
export function explainQuotaError(message: string): string | null {
  if (!/429|rate|quota|RESOURCE_EXHAUSTED|exceeded/i.test(message)) return null;

  const isDay = /per[_-]?day|daily|PerDay/i.test(message);
  const isMinute = /per[_-]?minute|PerMinute|\brpm\b/i.test(message);
  const isToken = /token[_-]?count|tokens?\b/i.test(message);

  const retryMatch = message.match(/retry[_-]?delay["':\s]+(\d+(?:\.\d+)?)\s*s/i);
  const retrySeconds = retryMatch ? parseFloat(retryMatch[1]) : 0;
  const wait = formatRetryDelay(retrySeconds);

  if (isDay) {
    const kind = isToken ? "トークン" : "リクエスト";
    const tail = wait
      ? `${wait}に制限がリセットされる見込みです。`
      : "制限のリセットまで時間を空けてから（通常は翌日）お試しください。";
    return `Gemini API の1日あたりの${kind}上限（無料枠）に達しました。${tail}`;
  }

  if (isMinute) {
    const tail = wait
      ? `${wait}に再度お試しください。`
      : "1〜2分ほど待ってから再度お試しください。";
    return `Gemini API の1分あたりのリクエスト上限（無料枠）に達しました。${tail}`;
  }

  const tail = wait
    ? `${wait}に再度お試しください。`
    : "1〜2分ほど待ってから再度お試しください。それでも改善しない場合は1日あたりの上限の可能性があります。";
  return `Gemini API のレート制限（無料枠）に達しました。${tail}`;
}

// Top-level "what went wrong" message. Falls back to a generic message
// when the cause isn't recognized.
export function friendlyLlmError(message: string, fallback: string): string {
  if (/GEMINI_API_KEY/.test(message)) {
    return "サーバーの設定が完了していません。管理者にお問い合わせください。";
  }
  const quota = explainQuotaError(message);
  if (quota) return quota;
  return fallback;
}
