# 社内ドキュメント検索システム

自然言語の質問に対して、50件の社内ドキュメント（MD ファイル）から段階的に関連情報を抽出し、Cloudflare Workers AI で回答を生成するチャットアプリ。

## 特徴

- **段階的コンテキスト開示**: フロントマター → セクション本文 → 回答 の 3 ステップで API トークンを節約
- **軽量モデルに統一**: 候補抽出・回答生成とも Workers AI の `llama-3.1-8b-instruct-fast`（無料枠 Neurons を抑えるため。品質を上げたいときは `LLM_ANSWER_MODEL` で上位モデルへ）
- **出典表示**: 参照したドキュメントとセクションをアコーディオン形式で常に提示
- **チャット UI**: Markdown レンダリング、ローディング表示、レスポンシブ

## セットアップ

```bash
npm install
cp .env.local.example .env.local
# .env.local に CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_AI_API_TOKEN を設定
npm run dev
```

http://localhost:3000 を開く。

## 構成

```
documents/
├── 各種規程・基準/        (8 docs)
├── 各種マニュアル/        (8 docs)
├── 設備運用ルール/        (5 docs)
├── 発令/                 (4 docs)
├── 年末調整/             (3 docs)
├── ISMS関連文書/          (5 docs)
├── 人事考課/             (5 docs)
├── 労使協定/             (2 docs)
├── 会社案内/             (2 docs)
├── その他業務ガイド/      (4 docs)
└── index.json            (全ドキュメントのフロントマター + サマリー)

app/
├── api/search/route.ts   (POST /api/search)
├── layout.tsx
└── page.tsx

components/
├── ChatWindow.tsx        (チャット本体)
├── DocumentReference.tsx (参考ドキュメント表示)
└── LoadingIndicator.tsx

lib/
├── document-utils.ts     (index 読込み / セクション抽出)
├── search.ts             (3 ステップ検索ロジック)
└── workers-ai.ts         (Cloudflare Workers AI REST クライアント)

scripts/
└── generate-docs.mjs     (50 件のダミードキュメント生成スクリプト)
```

## 検索フロー

1. **Step 1 — 候補抽出** (`@cf/meta/llama-3.1-8b-instruct-fast`)
   全ドキュメントのフロントマター（id, title, category, keywords, summary, sections）のみを渡し、関連ドキュメント TOP-3 と読むべきセクション ID を JSON で返させる。
2. **Step 2 — セクション本文取得**
   特定されたセクションだけを MD ファイルから抽出（最大 3000 文字/セクション）。
3. **Step 3 — 回答生成** (`@cf/meta/llama-3.1-8b-instruct-fast`)
   フロントマター + サマリー + 指定セクション本文を渡し、Markdown 形式で出典付きの回答を生成。

## トークン削減のイメージ

全 50 件のドキュメント本文を毎回渡すと約 8 万トークン以上消費する一方、本方式は概ね 1 万〜1.5 万トークンに収まる（質問依存）。

実測値は `/api/search` の NDJSON ストリームで段階ごとに流れる `usage` イベント（`{stage, model, promptTokens, outputTokens, totalTokens, ...}`）で確認できる。同じ値は `[search.usage] stage=... model=... prompt=... output=... total=...` 形式でサーバーログにも出力される。

Workers AI にはコンテキストキャッシュ製品がないため、`usage` イベントの `cachedTokens` / `cacheRatio` は常に 0（ワイヤ形式の互換のために型は残している）。Gemini 時代の明示キャッシュ（旧 `lib/prompt-cache.ts`）は廃止された。

## ドキュメントの再生成

```bash
node scripts/generate-docs.mjs
```

新規ドキュメントを追加する場合は `scripts/generate-docs.mjs` の `docs` 配列に追加するか、`documents/<カテゴリ>/` 配下に MD を置いて `documents/index.json` を手動で更新する。

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

出力先は `documents/<category>/<id>_<title>.md`、id は既存最大の `doc_NNN` + 1。`## ` 見出しごとに `sec_N` のセクションマーカーが自動付与され、既存の段階的検索ロジックと互換になる。

## ハイブリッド検索（v2 設計 Phase 4）

`documents/embeddings.json` を生成しておくと、Step 1 候補抽出にベクトル類似度上位 10 セクションがプロンプト経由でヒントとして注入され、キーワード一致では拾えない意味的近傍を救えるようになる（メタデータ駆動はそのまま維持）。

```bash
# 全セクションの埋め込みを Workers AI (@cf/baai/bge-m3) で生成
# （CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_API_TOKEN が必要）
node scripts/generate-embeddings.mjs
```

`embeddings.json` は `.gitignore` 済み。ファイルが無い／クエリ埋め込み呼び出しが失敗した／次元が一致しない場合、ハイブリッド層は無効化されメタデータ単独の Phase 1-2 挙動に自動フォールバックする（ユーザーに見える失敗は出さない）。pgvector 等への移行は 500 件規模を超えてから（設計 §6, §10）。

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

`/edit/<doc_id>` を開くと Monaco DiffEditor 付きのエディタが立ち上がる。右側のチャットに「~~を修正して」と指示すると、Workers AI が `{find, replace, reason}[]` を構造化出力（json_schema）で返し、各提案が「適用可 / 原文に見つからない / 複数箇所に一致」のステータスカードで並ぶ。

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

## デプロイ

Cloudflare Workers（OpenNext）へ `npm run cf:deploy` でデプロイ。`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_API_TOKEN` ほかのシークレットは `wrangler secret put <NAME>` または Cloudflare ダッシュボードで登録する。
