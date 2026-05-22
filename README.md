# 社内ドキュメントエージェント

社内ドキュメントを自然言語で検索・編集できる文書エージェント。v1（Markdown 検索のみ）から v2（多形式取り込み・チャット編集・GitHub バックエンド）へ移行中。設計方針・採用機能・やらないことリストは [`docs/v2-design.md`](docs/v2-design.md) を参照。

## 特徴

- **段階的コンテキスト開示**: フロントマター → セクション本文 → 回答 の 3 ステップで API トークンを節約
- **2 モデル使い分け**: 候補抽出は軽量な `gemini-2.5-flash-lite`、回答生成は高品質な `gemini-2.5-flash`
- **多形式取り込み**: PDF / Word / Excel / HTML / CSV / TXT を Markdown 化＋フロントマター自動生成（Phase 3）
- **メタデータ駆動検索**: フロントマター（キーワード・タイトル・カテゴリ・見出し）の一致で候補を抽出
- **GitHub バックエンド編集**: 編集 = branch、提案 = PR、承認 = merge。`{find, replace, reason}` 構造化編集＋人間レビュー必須（Phase 5・7）
- **チャットベース編集 UI**: Monaco DiffEditor で AI 提案を差分レビュー（Phase 6）
- **認証 / ロール**: Auth.js v5 + Google OAuth、環境変数で ON/OFF（Phase 7）
- **MCP コネクタ**: 文書検索・編集を MCP ツールとして公開し、利用者自身の Claude から利用可能
- **出典表示**: 参照したドキュメントとセクションをアコーディオン形式で常に提示

## セットアップ

```bash
npm install
cp .env.local.example .env.local
# .env.local に GEMINI_API_KEY を設定 (https://aistudio.google.com/apikey で取得)
npm run dev
```

http://localhost:3000 を開く。認証用の環境変数を設定しなければ「認証オフ」モードで全機能を試せる。

## 構成

```
documents/                   ダミー社内文書 50 件（Markdown）
├── 各種規程・基準/  (9)
├── 各種マニュアル/  (9)
├── 設備運用ルール/  (5)
├── 発令/            (5)
├── ISMS関連文書/    (5)
├── 人事考課/        (5)
├── その他業務ガイド/ (5)
├── 年末調整/        (3)
├── 会社案内/        (2)
├── 労使協定/        (2)
└── index.json          全文書のフロントマター + サマリー（build:corpus で生成）

app/
├── page.tsx                検索チャット（/）
├── documents/page.tsx      文書一覧（/documents）
├── docs/[doc_id]/page.tsx  文書ビューア（/docs/<id>）
├── edit/[docId]/page.tsx   チャット編集 UI（/edit/<id>、Phase 6）
├── upload/page.tsx         多形式アップロード（/upload、Phase 3）
├── pr/page.tsx             編集提案 PR 一覧（/pr）
└── api/                    search / edit / upload / delete / mcp / auth の各ルート

components/                  ChatWindow / DocViewer / DocumentReference /
                             EditorPanel / UploadPanel / DeleteButton /
                             SiteHeader / SiteNav

lib/
├── gemini-search.ts        3 ステップ検索ロジック
├── section-select.ts       セクション選定スコアリング
├── prompt-cache.ts         プロンプトキャッシュ観測（Phase 2 / 8）
├── document-utils.ts       index / セクション読込み（Workers では生成バンドルを参照）
├── generated/corpus.ts     ビルド時に同梱される文書バンドル（build-corpus.mjs が生成）
├── ingest-core.ts          多形式取り込みのコアロジック（Web アップロード用、Phase 3）
├── edit-llm.ts             {find, replace, reason} 構造化編集の生成（Phase 6）
├── edit-schema.ts          編集提案のバリデーション
├── github.ts               branch / commit / PR（Octokit、Phase 5）
├── commit-files.ts         複数ファイルコミットのヘルパー
├── auth-helpers.ts         ロール判定 / アクセス制御（Phase 7）
├── config-guard.ts         本番設定ガード（認証オフ等を fail-secure に拒否）
├── audit-log.ts            構造化監査ログ
├── llm-config.ts           LLM 設定の環境変数抽象化
├── llm-errors.ts           LLM エラーの整形
├── persona.ts / sample-prompts.ts   チャット UI の文言
├── rehype-merged-cells.ts  表セル結合の Markdown レンダリング
├── build-info.ts           UI フッターのビルド識別子
└── mcp/                    MCP サーバ（server / tools / edit-tool /
                            ingest-tool / oauth / http）

scripts/
├── build-corpus.mjs              documents/ → index.json + lib/generated/corpus.ts（postinstall）
├── ingest.mjs                    多形式取り込み CLI（Phase 3、ingest-core.ts の CLI 版）
├── generate-docs.mjs             初期ダミーコーパス（50 件）の生成スクリプト
├── validate-corpus.mjs           コーパス整合性チェック（corpus CI）
├── check-separation-of-duties.mjs 提案者≠承認者ゲート（SoD CI）
└── propose-edit.mjs              CLI からの編集提案 PR 作成
```

## 検索フロー

1. **Step 1 — 候補抽出** (`gemini-2.5-flash-lite`)
   全ドキュメントのフロントマター（id, title, category, keywords, summary, sections）のみを渡し、関連ドキュメント TOP-3 と読むべきセクション ID を JSON で返させる。
2. **Step 2 — セクション本文取得**
   特定されたセクションだけを MD ファイルから抽出（最大 3000 文字/セクション）。
3. **Step 3 — 回答生成** (`gemini-2.5-flash`)
   フロントマター + サマリー + 指定セクション本文を渡し、Markdown 形式で出典付きの回答を生成。

## トークン削減のイメージ

全 50 件のドキュメント本文を毎回渡すと約 8 万トークン以上消費する一方、本方式は概ね 1 万〜1.5 万トークンに収まる（質問依存）。

実測値は `/api/search` の NDJSON ストリームで段階ごとに流れる `usage` イベント（`{stage, model, promptTokens, cachedTokens, outputTokens, totalTokens, cacheRatio}`）で確認できる。同じ値は `[search.usage] stage=... prompt=... cached=... ratio=...` 形式でサーバーログにも出力される（v2 設計 Phase 2 = 暗黙キャッシュ観測 / Phase 8 = 明示キャッシュ）。

Phase 8 では Step 1 の固定部分（system instruction + ドキュメント一覧）を `GoogleAICacheManager` で明示的キャッシュ化し、リクエストごとに送るのは可変部分（質問本文）だけになる。キャッシュは process 内に in-memory で保持、index の内容ハッシュが変わると自動で作り直し、最小トークン数未満なら自動で disabled（暗黙キャッシュは引き続き効く）。挙動は `[prompt-cache] created step1 cache name=...` ログと `cacheRatio` の急増で観測可能。

## ダミーコーパスの生成

開発用の 50 件のダミー文書は `scripts/generate-docs.mjs` で生成したもの。コーパス自体を作り直す場合のみ実行する:

```bash
node scripts/generate-docs.mjs   # documents/ のダミー文書を再生成
npm run build:corpus             # index.json + lib/generated/corpus.ts を再生成
```

**新しい文書を追加する通常の手段は `generate-docs.mjs` ではなく取り込みパイプライン**（下記「多形式ドキュメントの取り込み」）。`npm run ingest` で任意ファイルを Markdown 化し、フロントマターと `documents/index.json` まで自動更新する。

## 多形式ドキュメントの取り込み（v2 設計 Phase 3）

PDF / Word(.docx) / Excel(.xlsx) / HTML / CSV / TXT / Markdown を 1 コマンドで MD 化＋フロントマター自動生成＋ `documents/index.json` 反映できる。

```bash
# LLM でメタデータ（title/category/keywords/summary）を自動生成して取り込み
npm run ingest -- path/to/source.pdf

# まず dry-run で出力を確認、書き込みなし
npm run ingest -- path/to/source.docx --dry-run

# LLM を使わず手動で category 指定（API キー不要・最小メタデータ）
npm run ingest -- path/to/source.xlsx --no-llm --category その他業務ガイド
```

出力先は `documents/<category>/<id>_<title>.md`、id は既存最大の `doc_NNN` + 1。`## ` 見出しごとに `sec_N` のセクションマーカーが自動付与され、既存の段階的検索ロジックと互換になる。Web UI からの取り込みは `/upload` ページ（`lib/ingest-core.ts`）。

## GitHub バックエンド: 編集提案フロー（v2 設計 Phase 5）

全てのドキュメント編集を「branch を切る → 変更を commit → PR を立てる」のフローに通すことで、`.github/CODEOWNERS` で振り分けたレビュアーがマージ前に承認できる構造になっている（設計 §4-E）。

```bash
# 編集後のフル本文を <new.md> に用意して PR を作る
npm run propose-edit -- doc_001 ./new.md --message "就業規則の文言修正"
# → Branch: edit/doc_001-1700000000
# → PR #42: https://github.com/afdpfrss/document-agent/pull/42
```

必要な環境変数:

| 変数 | 既定値 | 用途 |
|---|---|---|
| `GITHUB_TOKEN` | （必須） | `repo` スコープの PAT または GitHub App のインストールトークン |
| `GITHUB_REPO_OWNER` | `afdpfrss` | 対象 owner |
| `GITHUB_REPO_NAME` | `document-agent` | 対象 repo |
| `GITHUB_BASE_BRANCH` | `main` | PR のターゲット |

`.github/CODEOWNERS` は社内チームのプレースホルダー入りでコミット済み。本番運用時は実在のチームに置き換え、GitHub のブランチ保護で "Require review from Code Owners" を有効化する。

## チャットベース編集 UI（v2 設計 Phase 6 PoC）

`/edit/<doc_id>` を開くと Monaco DiffEditor 付きのエディタが立ち上がる。右側のチャットに「~~を修正して」と指示すると、Gemini が `{find, replace, reason}[]` を構造化出力で返し、各提案が「適用可 / 原文に見つからない / 複数箇所に一致」のステータスカードで並ぶ。

- 「差分に適用」で適用可な提案だけが差分に反映される（あいまい・未一致は無視）
- 右側エディタ（差分の modified 側）は手動でも編集可能 — AI 提案を起点に人間が最終調整
- 「PR を立てる」で Phase 5 の `proposeEdit()` 経由で GitHub に PR が立つ

API:
- `GET /api/edit/[docId]` — 現在のファイル本文を返す
- `POST /api/edit/[docId]/propose` — `{instruction, originalContent}` → `{edits[], applied: {content, statuses}}`
- `POST /api/edit/[docId]/submit` — `{newContent, message?, prBody?}` → PR 作成結果

設計 §10 で「全文再生成型編集を採用しない」「自動マージ禁止（人間レビュー必須）」と明示されており、本実装はその制約に沿っている。

## 認証 / ロール（v2 設計 Phase 7、env で ON/OFF 可能）

Auth.js v5 + Google OAuth。`AUTH_GOOGLE_ID` と `AUTH_GOOGLE_SECRET` が両方セットされている時のみ有効になり、それ以外は**認証オフ**で全機能が誰でも使える（ローカル/開発用）。ヘッダ右に `認証オフ` バッジが表示される。

### 認証オフ（既定）
- ミドルウェアは何もせず素通し
- `requireUser` / `requireRole` / `gateForRole` は内部の `AUTH_DISABLED_USER`（ロール `編集`）を返す
- `/edit/*` も `/api/edit/*` も誰でも触れる
- env 不要、`npm run dev` だけで全機能を試せる

### 認証オン
`.env.local` に下記を入れた瞬間にコード変更なしで Phase 7 挙動が復帰する:

```env
AUTH_SECRET=（openssl rand -base64 32 など）
AUTH_GOOGLE_ID=（Google Cloud Console > OAuth クライアント ID）
AUTH_GOOGLE_SECRET=
EDITOR_EMAILS=alice@example.com,bob@example.com
```

ロール:

| ロール | 権限 |
|---|---|
| `一般` | 検索 (`/`、`/api/search`) のみ |
| `編集` | 上記 + 編集 UI (`/edit/*`)・PR 作成 (`/api/edit/*`) |

`編集` 割当は `EDITOR_EMAILS` の allowlist（カンマ区切り、trim + lowercase）。allowlist に含まれないログインユーザーは自動的に `一般`。

ロール情報は JWT に埋め込まれて毎リクエストで参照可。DB は使わない（設計 §10 "DB で文書本体を管理しない" 原則）。将来 viewer/proposer/approver/admin の 4 段階（設計 §4-D）に拡張する場合は `auth.ts` の `roleFor()` を入れ替えるだけ。

## MCP コネクタ（v2 設計 §4-F）

文書検索・編集を MCP（Model Context Protocol）ツールとして公開するリモート MCP サーバ。利用者は自分の Claude にカスタムコネクタとして登録し、自分の契約・トークンで社内文書を検索・編集できる。**回答生成 LLM はこのサーバでは呼ばず、クエリ時の推論コストは利用者側の Claude が負担する**。

- **エンドポイント**: `/api/mcp`（OAuth メタデータは `/.well-known/oauth-*`）
- **公開ツール**:
  - 読み取り — `search_documents` / `get_sections` / `list_categories`
  - 編集（`mcp:edit` スコープ）— `propose_edit` / `find_text_occurrences` / `propose_related_edit` / `ingest_documents`
  - PR 操作（`mcp:merge` スコープ）— `review_edit` / `merge_edit`
- **認証**: OAuth 2.1（PKCE、ステートレス JWT）。`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` 設定時に有効化。`MCP_ALLOWED_EMAIL_DOMAINS` / `MCP_ALLOWED_EMAILS` で組織内に限定する
- **デモモード**: `MCP_DEMO_MODE=true` で `propose_edit` 系が作る PR に `[DEMO]` 接頭辞が付き、提案者≠承認者（SoD）チェックが非適用になる。同一アカウントで作成〜承認〜マージを実演できる（corpus CI と CODEOWNERS 承認は通常どおり必須）
- **単独運用モード**: `MCP_SOLO_APPROVER_MODE=true` で `propose_edit` 系が作る PR に `solo-approver` ラベル・マーカーが付き、提案者≠承認者（SoD）チェックが非適用になる。文書の作成・承認・マージを 1 人で担う零細企業向け。デモモードと違い `[DEMO]` 接頭辞は付かず本番でも有効（corpus CI と CODEOWNERS 承認は通常どおり必須）

設定項目は `.env.local.example` の「MCP コネクタ」節を参照。認証を有効化するまで公開デプロイしないこと（`lib/config-guard.ts` が本番では fail-secure に拒否する）。逐語マッチに失敗した編集が 1 件でもあれば PR は作られず、反映は人間レビューを経た PR でのみ行われる（自動マージなし）。

## デプロイ

Cloudflare Workers（[OpenNext](https://opennext.js.org/cloudflare) アダプタ）にデプロイする。設定は `wrangler.jsonc` と `open-next.config.ts`。

```bash
npm run cf:preview   # ローカルで Workers ランタイムをプレビュー
npm run cf:deploy    # ビルドして Cloudflare へデプロイ
```

シークレット（`GEMINI_API_KEY` / `AUTH_SECRET` / `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `GITHUB_TOKEN` / `MCP_ALLOWED_*` など）は `wrangler.jsonc` には書かず、`wrangler secret put <NAME>` または Cloudflare ダッシュボードで設定する。ローカルの `cf:preview` 用は `.dev.vars` に置く。

> Cloudflare Workers ランタイムにはプロジェクトのファイルシステムが無いため、文書コーパスはビルド時に `lib/generated/corpus.ts` へ同梱される（`scripts/build-corpus.mjs`）。`next dev` / `next start` の Node 実行では `documents/` を直接読む。
