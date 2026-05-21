// Friendly translations for Cloudflare Workers AI error messages.
// Shared between the search route (chat) and the upload pipeline so users see
// the same wording regardless of which path tripped a limit.

// Turn a Workers AI rate-limit / capacity error into something a user can act
// on. Returns null when the message is not a rate-limit error.
export function explainQuotaError(message: string): string | null {
  if (
    !/HTTP 429|rate.?limit|too many requests|capacity|RESOURCE_EXHAUSTED|exceeded|neuron/i.test(
      message,
    )
  ) {
    return null;
  }
  return "Cloudflare Workers AI のレート制限（無料枠）に達しました。1〜2分ほど待ってから再度お試しください。繰り返し出る場合は1日あたりの上限（Neurons）に達している可能性があるため、時間を空けてからお試しください。";
}

// Top-level "what went wrong" message. Falls back to a generic message when
// the cause isn't recognized.
export function friendlyLlmError(message: string, fallback: string): string {
  if (
    /not configured|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_AI_API_TOKEN/i.test(
      message,
    )
  ) {
    return "サーバーの設定が完了していません。管理者にお問い合わせください。";
  }
  if (/HTTP 401|HTTP 403|unauthorized|forbidden|authentication/i.test(message)) {
    return "AI サービスの認証に失敗しました。管理者に API トークンの設定をご確認ください。";
  }
  const quota = explainQuotaError(message);
  if (quota) return quota;
  return fallback;
}
