# v2 設計サマリ（実装引き継ぎ用）

このドキュメントは v2（ハイブリッド型ドキュメントエージェント）の設計意図と実装方針を、新しい実装セッションが**このファイルと AGENTS.md だけ読めば着手できる**形にまとめたものです。

---

## 1. 出発点

### 現状（旧アイディア = `legacy/v1-original` ブランチ）
- 50 件の社内 Markdown ドキュメント検索システム
- Google Gemini Flash / Flash-Lite による段階的検索（3 ステップ）
  1. フロントマター → 候補抽出（Flash-Lite）
  2. セクション本文取得（ファイル I/O）
  3. 回答生成（Flash）
- ベクトル DB なし、シンプルな Next.js 1 サービス構成
- 詳細：`README.md` 参照

### ゴール（v2）
旧アイディアの **段階的開示の優位性を維持** したまま、市販 SaaS（InfoCraft 等）相当の汎用性・拡張性・編集機能を取り込んだ「**いいとこ取りのドキュメントエージェント**」を構築する。

---

## 2. 設計の基本方針

| 原則 | 内容 |
|---|---|
| **メタデータ駆動が主、ベクトルが補助** | 段階的開示の構造を壊さない。ベクトル検索は Step1 の候補プール拡張用途 |
| **構造化編集指示 `{find, replace}`** | AI 生成の編集は必ず構造化、人間が diff レビュー前提 |
| **GitHub をバックエンドに据える** | branch = ドラフト、PR = 承認待ち、merge = 反映。CODEOWNERS でカテゴリ別承認者 |
| **小さく入れて積み重ねる** | フェーズ分けで段階導入。各フェーズ単独で価値が出る単位 |
| **LLM 抽象化を最小限残す** | モデル名・API キーを環境変数化、Sakura 等への切替余地を確保 |

---

## 3. アーキテクチャ全体像

```
┌─────────────────────────────────────────────────────────┐
│ ① 取り込みパイプライン                                       │
│   PDF/Word/Excel/HTML/CSV → Markdown 変換                │
│              ↓                                          │
│   LLM で自動フロントマター生成                              │
│   (title, category, keywords, summary, sections)        │
│              ↓                                          │
│   セクション分割 + index.json 自動更新                      │
│   オプション: Embedding を併せて embeddings.json に保存     │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ ② ハイブリッド検索（Step1 の候補プール構成）                  │
│   メタデータ絞込 ∪ ベクトル類似度 top-k → LLM で TOP-3 確定   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ ③ 段階的開示（旧アイディアの核を維持）                        │
│   Step 1: 候補抽出（軽量モデル, プロンプトキャッシュ）        │
│   Step 2: セクション本文取得                                │
│   Step 3: 回答生成 or 編集指示生成（高品質モデル）            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ ④ 提供レイヤー                                              │
│   - 既存の Next.js UI（読み取り）                          │
│   - リモート MCP サーバ（/api/mcp、推論は利用者の Claude）   │
│   - チャットベース編集 UI（Monaco DiffEditor）              │
│   - 埋め込み配布スクリプト（将来）                          │
│   - 分析ダッシュボード（将来）                              │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ ⑤ 永続化レイヤー                                            │
│   GitHub Repository (afdpfrss/document-agent)            │
│   branch = ドラフト / PR = 承認待ち / merge = 公開反映       │
│   CODEOWNERS でカテゴリ別承認者                             │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 採用機能一覧

### A. 検索・基盤アーキテクチャ

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| **ハイブリッド検索** | メタデータ駆動 + ベクトル検索の併用。Step1 の候補プール構成を拡張 | 導入決定 |

### B. InfoCraft 相当の汎用化機能

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| 多形式取り込み | PDF / Word / Excel / HTML / CSV → MD 変換 | 導入意向 |
| フロントマター自動生成 | LLM で title/category/keywords/summary/sections 自動付与 | 導入意向 |
| 多言語対応 | 質問言語を検出 → 同言語で回答（プロンプト中心）| 導入意向 |
| 埋め込み配布スクリプト | 1 行 `<script>` で他サイト組込み | 将来想定 |
| 会話ログ + 分析ダッシュボード | チャット履歴 DB + 集計画面 | 将来想定 |

### C. パフォーマンス・コスト最適化

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| プロンプトキャッシュ | （v4 で見送り）Workers AI にコンテキストキャッシュ製品はない | 見送り |
| 無料生成 AI 埋め込み | Groq + Llama / Ollama。**オンプレ要件 or 取り込み軽処理用途** に限定検討 | 条件付き |

### D. チャットベース文書編集機能

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| 権限管理 | viewer / proposer / approver / admin の 4 ロール + カテゴリ別 | 導入意向 |
| AI 編集指示生成 | `{find, replace, reason}[]` 構造化出力（Workers AI json_schema 活用）| 導入意向 |
| 差分提示 + 手動編集 UI | Monaco DiffEditor、画面上で差分自体を編集可能 | 導入意向 |
| 承認フロー | ドラフト → 承認 → 反映 + 監査ログ（commit log で代用）| 導入意向 |

### E. バージョン管理基盤

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| GitHub バックエンド | 編集 = branch、提案 = PR、承認 = merge。CODEOWNERS でカテゴリ別承認者。Octokit 経由で UI から間接操作。Vercel webhook で自動再デプロイ | 採用方針 |

### F. MCP コネクタ（リモート MCP サーバ）

| 項目 | 主要要素 | 確定度 |
|---|---|---|
| MCP コネクタ | 文書検索を MCP ツールとして公開。利用者が自分の Claude に登録 | 導入決定 |

提供レイヤー（§3 ④）に「リモート MCP サーバ」を追加する。開発者側が Gemini を呼んで回答生成する従来構成に対し、**検索 API のみをホスティングし、クエリ時の推論（候補の最終選定・回答生成）は利用者側の Claude が負担する**構成。開発者は LLM 推論コストを負わず、利用者は自分の契約・トークンで社内文書を検索・質問できる。

- **エンドポイント**: `app/api/mcp/route.ts`（Next.js ルートハンドラ）。公式 SDK `@modelcontextprotocol/sdk` + Streamable HTTP トランスポートで実装。
- **ツール**: `search_documents`（候補プール）/ `get_sections`（セクション本文）/ `list_categories`（カテゴリ一覧）/ `propose_edit`（構造化編集 `{find, replace, reason}[]` を逐語適用し branch + PR を作成）。`propose_edit` は MCP の input_schema で編集構造を強制（Gemini の responseSchema の代替）し、`mcp:edit` スコープを要求。逐語マッチに失敗した編集が 1 件でもあれば PR を作らず診断を返す。反映は GitHub の PR レビューで（自動マージなし、§10 整合）。
- **段階的開示の維持**: サーバはクエリ時に回答生成 LLM を呼ばない。各ツールが返す情報量を絞る（フロントマター → セクション本文）ことで §3 の段階的開示構造をツール境界上で保つ。
- **ベクトル検索**: クエリ埋め込みは Workers AI（`@cf/baai/bge-m3`）を使用。認証情報（`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_API_TOKEN`）未設定時はメタデータ駆動のみへ自動フォールバック（`lib/hybrid-search.ts` の挙動）。
- **疎結合**: ツール実装（`lib/mcp/`）は既存の `lib/` モジュール（`document-utils` / `hybrid-search` / `edit-schema` / `github`）を import するだけにとどめ、既存の Gemini チャットパイプラインと共存させる。
- **認証（OAuth 2.1）**: `/api/mcp` は OAuth 2.1 のリソースサーバとして保護されると同時に、最小限の認可サーバも兼ねる。クライアント（claude.ai のカスタムコネクタ等）は動的クライアント登録 → authorization code + PKCE(S256) フローでトークンを取得する。実ユーザー認証は既存 `auth.ts`（NextAuth + Google OIDC）に委譲し、社内ユーザーのみを allowlist（`MCP_ALLOWED_EMAIL_DOMAINS` / `MCP_ALLOWED_EMAILS`）で許可する。アクセストークン・リフレッシュトークン・認可コード・client_id はすべて `AUTH_SECRET` で署名した HS256 JWT で表現し、DB を使わない（§10 整合。認可コードの単回使用のみプロセス内メモリでベストエフォート保証）。エンドポイント: `/.well-known/oauth-protected-resource`・`/.well-known/oauth-authorization-server`・`/api/mcp/oauth/{register,authorize,token}`。アプリ全体の認証が OFF の開発時はトークン不要（Phase 1 と同じ挙動）。認証が有効になるまで公開デプロイしない。

---

## 5. 実装フェーズと優先順位

| 順 | 項目 | 所要目安 | 理由 |
|---|---|---|---|
| 1 | 多言語対応 | 1 日 | プロンプト変更のみ、即効性 |
| 2 | プロンプトキャッシュ（暗黙的の観測ログ）| 1 日 | ヒット率測定から始める |
| 3 | 多形式取り込み + フロントマター自動生成 | 3〜5 日 | 取り込みパイプラインがハイブリッド検索の前提 |
| 4 | ハイブリッド検索（軽量版）| 2〜3 日 | `embeddings.json` + JS でコサイン類似度（pgvector 不要）|
| 5 | GitHub バックエンド化 | 3〜5 日 | 編集機能の前提 |
| 6 | チャットベース編集 Phase 1（PoC）| 1 週間 | 認証なし・ローカルで体験検証 |
| 7 | 権限管理 + 承認フロー | 1 週間 | Auth.js + GitHub PR フロー |
| 8 | 明示的プロンプトキャッシュ | 1〜2 日 | アクセス増えてから |
| 9 | 埋め込み配布 / 分析ダッシュボード | 1〜2 週間 | 外販 / 運用拡張時 |

各フェーズは**単独で価値が出る単位**に切ること。途中で止めても旧アイディアより改善された状態を維持する。

---

## 6. 技術スタック決定事項

| 領域 | 採用 | 理由 |
|---|---|---|
| **Framework** | Next.js 16（既存維持）| Cloudflare Workers（OpenNext）デプロイ前提、breaking changes は AGENTS.md 参照 |
| **LLM（候補抽出／回答生成）** | Cloudflare Workers AI: Llama 3.1 8B + Llama 3.3 70B | 無料枠あり、binding 不要の REST、Workers 本番と同一基盤（v4 で Gemini から切替） |
| **LLM（本番フェーズ判断）** | Workers AI 継続 or さくらの AI Engine | コンプラ要件次第。**LLM 設定は環境変数で抽象化** |
| **Embedding** | Workers AI `@cf/baai/bge-m3`（多言語）| 後にさくらの multilingual-e5-large 検討 |
| **ベクトル保存（初期）** | `documents/embeddings.json` + JS でコサイン計算 | 50〜数百件規模では pgvector 不要 |
| **ベクトル保存（拡張）** | pgvector（Supabase）| 500 件超で移行 |
| **差分エディタ** | `@monaco-editor/react`（DiffEditor）| VS Code 同等、左右編集可 |
| **編集指示生成** | Workers AI の `response_format: json_schema` で `{find, replace, reason}[]` 強制 | 型安全な構造化出力 |
| **永続化** | GitHub（Octokit）| PR 承認 = 編集承認、CODEOWNERS = カテゴリ別承認者 |
| **認証（Phase 2 以降）** | Auth.js（NextAuth）+ Google OIDC | 社内利用想定 |
| **同時編集制御** | 楽観ロック（branch 名 + version）| Git の merge 機構を活用 |

---

## 7. LLM 戦略（開発 → 本番）

### 開発フェーズ（現在）
- **Cloudflare Workers AI（無料枠）で稼働**：候補抽出・回答生成・編集提案・埋め込みのすべて。ダミーデータ前提。
- **REST API 経由**：`AI` binding ではなく REST を使い、`next dev`・Workers 本番・Node スクリプトで同一コードを動かす（`lib/workers-ai.ts`）。
- **抽象化レイヤを薄く張る**：
  ```ts
  // lib/llm-config.ts
  export const llmConfig = {
    candidateModel: process.env.LLM_CANDIDATE_MODEL ?? '@cf/meta/llama-3.1-8b-instruct-fast',
    answerModel: process.env.LLM_ANSWER_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    embeddingModel: process.env.LLM_EMBEDDING_MODEL ?? '@cf/baai/bge-m3',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_AI_API_TOKEN,
  } as const;
  ```
- これでモデル切替・プロバイダ移行時にコード変更を最小化（プロバイダ実体の差し替えは `lib/workers-ai.ts` に閉じる）

### 本番フェーズ（移行判断）
以下のいずれかが該当した場合は**さくらの AI Engine（国内 DC）も候補**：
- 機密ドキュメント（人事考課・ISMS 等）を本番運用
- 顧客から国内処理証明を求められる
- 規制業界（金融・自治体・医療）向け展開

該当しない場合は **Workers AI のまま**本番移行（モデル ID と認証情報は環境変数で差し替え可能）。

---

## 8. ブランチ・リリース運用

```
main                       ← 現状は旧アイディア。将来 v2 をマージして公開版に
legacy/v1-original         ← 旧アイディア保存ブランチ（main と同一コミット）
claude/summarize-infocraft-X2M5v  ← v2 設計議論・本ドキュメント追加
```

### v2 実装の進め方（推奨）
1. v2 実装は **`idea/v2-hybrid` などの専用ブランチ**を切る（または既存 `claude/summarize-infocraft-X2M5v` 継続）
2. フェーズごとに小さい PR を main に向けて作成
3. **main を v2 で完全置換するタイミング**は Phase 5（GitHub バックエンド化）完了後を目安に
4. 旧アイディアは `legacy/v1-original` で恒久保存

---

## 9. 実装着手前のチェックリスト

新しい実装セッションで作業を始めるときの確認事項：

- [ ] このドキュメント全体を読む
- [ ] `AGENTS.md` の Next.js v16 注意書きを読む
- [ ] `README.md` で旧アイディアの構成を理解
- [ ] `documents/index.json` のフロントマター構造を把握
- [ ] `lib/search.ts` の段階的検索ロジックを把握（v2 でも基本構造は流用）
- [ ] 着手するフェーズを §5 から 1 つ選び、単独で価値が出る形に分割する
- [ ] LLM 設定の環境変数化を最初に済ませる（後から面倒）

---

## 10. やらないことリスト（重要）

設計の振れを防ぐため、明示的に**現時点で採用しない**選択肢：

- ❌ ベクトル DB を最初から導入（pgvector / Pinecone 等）→ 件数増加時に移行
- ❌ 全文再生成型の AI 編集（必ず `{find, replace}` 構造化）
- ❌ 自動マージ（AI 提案 → 人間レビュー必須）
- ❌ プロプライエタリ LLM API への依存（v4 で Cloudflare Workers AI に全面切替。下記補足を参照）
- ❌ DB（Postgres 等）で文書本体を管理（GitHub バックエンドが第一選択）

> **v4 補足（LLM プロバイダ切替）**: 当初この §10 は「無料 OSS LLM への置換」を見送るとしていたが、v4 で方針転換し、LLM 層を Google Gemini から Cloudflare Workers AI（Llama 3.x / bge-m3）へ全面切替した。理由は、Workers 本番基盤と同一プロバイダで運用が単純化し、無料枠で開発が完結すること。段階的開示・構造化編集・人間レビュー必須・GitHub バックエンドといった他の原則は変更なし。モデル ID とプロバイダ実体は環境変数 + `lib/workers-ai.ts` に隔離し、さくらの AI Engine 等への将来切替余地は維持している。

---

## 11. 参考：旧アイディアと InfoCraft の比較

旧アイディアが InfoCraft に勝っている点（v2 でも引き継ぐべき優位性）：

1. **段階的開示によるトークン効率**（8 万 → 1.5 万 tokens）
2. **フロントマター駆動でハルシネーション抑制**
3. **軽量/高性能モデルの使い分け**（Flash-Lite + Flash）
4. **セクション単位の精密な引用**
5. **ベクトル DB 不要の運用シンプルさ**
6. **更新が爆速（再 Embedding 不要）**
7. **JSON 出力でデバッグ可能性が高い**

これらを **「メタデータ駆動を主、ベクトル補助」** の原則で守りながら、InfoCraft の汎用性（多形式・多言語・編集機能）を足すのが v2 の本質。
