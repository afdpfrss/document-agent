# セキュリティ / 本番運用ガイド

document-agent を本番環境（社内公開・商用提供）で運用する際のセキュリティモデルと、
公開前に必ず確認すべき事項をまとめる。設計全体の背景は `docs/v2-design.md`、
未対応の大規模課題は `docs/commercialization-todo.md` を参照。

## 1. セキュリティモデル

- **認証**: Auth.js v5 + Google OIDC。`AUTH_GOOGLE_ID` と `AUTH_GOOGLE_SECRET` が
  両方設定されている時のみ有効。未設定だと「認証オフ」モードになり、全ユーザーが
  「編集」ロールで全機能にアクセスできる（ローカル開発専用）。
- **認可**: 2 ロール（`一般` / `編集`）。`編集` は `EDITOR_EMAILS` の allowlist で付与。
  MCP コネクタは `mcp:read` / `mcp:edit` / `mcp:merge` の 3 スコープ（`EDITOR_EMAILS` /
  `MERGER_EMAILS` で付与）。
- **データの所在**: 文書本体は GitHub リポジトリ上の Markdown。DB は持たない。
  検索・編集提案の処理で文書本文が Google Gemini API に送信される（§5 参照）。
- **編集フロー**: AI 編集は必ず `{find, replace, reason}` 構造化 + 人間レビュー。
  反映は GitHub PR のマージのみ（自動マージなし）。

## 2. 本番設定ガード

`lib/config-guard.ts` が本番環境（`NODE_ENV=production`）で危険な設定を検出し、
危険な操作をフェイルセキュアに拒否する。

| 危険な設定 | 本番での挙動 |
|---|---|
| 認証オフ（`AUTH_GOOGLE_*` 未設定）| `/api/search`・`/api/edit/*`・`/api/mcp` が 503 |
| MCP allowlist 未設定 | `/api/mcp` が 503 |
| `MCP_DEMO_MODE=true` | `isDemoMode()` が強制的に false（デモ印が付かず SoD が通常適用）|

サーバ起動時には `instrumentation.ts` が検出した問題を `[config-guard]` 警告ログに出力する。

### エスケープハッチ `ALLOW_INSECURE_DEPLOY`

`ALLOW_INSECURE_DEPLOY=true` を設定すると上記のフェイルセキュアな拒否が無効化され、
警告ログのみになる。**意図的に認証なしで動かす内部ステージング限定**。本番では
絶対に設定しないこと。

## 3. デモモード

`MCP_DEMO_MODE=true` はプレゼン用に職務分掌（提案者≠承認者）チェックを無効化し、
同一アカウントでの作成〜承認〜マージを可能にする。詳細は
`.github/branch-protection.md`。本番コネクタでは未設定にすること（本番ガードにより
本番では強制的に無効化されるが、設定自体を残さないのが望ましい）。

## 4. 監査ログ

`lib/audit-log.ts` がセキュリティ関連イベントを `[audit]` 接頭辞付きの構造化 JSON で
標準出力に記録する（`search` / `pr.created` / `auth.denied` / `mcp.auth.ok` /
`mcp.auth.denied`）。ログドレイン（Cloudflare Workers Logs / Logpush 等）で集約・保全すること。
**検索クエリ本文・文書本文は記録しない**（監査ログが機密データの二次コピーに
ならないようにするため）。

## 5. 外部サービスへ送信されるデータ

検索（回答生成）・編集提案の生成で、対象文書の本文とユーザーの質問・編集指示が
Google Gemini API に送信される。**機密文書（人事考課・ISMS 等）を本番運用する
場合は、Gemini 無料枠（データ学習の対象になりうる）ではなく有料枠、または国内 DC の
LLM（さくらの AI Engine 等）への切替を検討すること**（`docs/v2-design.md` §7）。
顧客に提供する場合は、この外部送信をプライバシーポリシー・利用規約に明記する。

## 6. 本番公開前チェックリスト

- [ ] `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `AUTH_SECRET` を設定（認証 ON）
- [ ] `EDITOR_EMAILS` / `MERGER_EMAILS` を実在のアカウントで設定
- [ ] MCP コネクタを使う場合 `MCP_ALLOWED_EMAIL_DOMAINS` または `MCP_ALLOWED_EMAILS` を設定
- [ ] `MCP_DEMO_MODE` が未設定であることを確認
- [ ] `ALLOW_INSECURE_DEPLOY` が未設定であることを確認
- [ ] `GITHUB_TOKEN` は最小権限（対象リポジトリの `repo` スコープ）で発行
- [ ] サービスアカウントが CODEOWNERS のどのチームにも属していないことを確認
- [ ] `.github/CODEOWNERS` をプレースホルダーから実在のチームに置換
- [ ] ブランチ保護を `.github/branch-protection.md` の手順どおり設定
- [ ] 機密文書を扱う場合、LLM ベンダー / データ越境方針を確定（§5）
- [ ] `[config-guard]` 起動警告ログが出ていないことを確認
- [ ] 監査ログ（`[audit]`）の集約先を設定

## 7. 脆弱性の報告

セキュリティ上の問題を見つけた場合は、公開 issue ではなくリポジトリ管理者へ
非公開で連絡すること。
