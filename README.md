# 社内ドキュメント検索システム

自然言語の質問に対して、50件の社内ドキュメント（MD ファイル）から段階的に関連情報を抽出し、Google Gemini Flash で回答を生成するチャットアプリ。

## 特徴

- **段階的コンテキスト開示**: フロントマター → セクション本文 → 回答 の 3 ステップで API トークンを節約
- **2 モデル使い分け**: 候補抽出は軽量な `gemini-2.5-flash-lite`、回答生成は高品質な `gemini-2.5-flash`
- **出典表示**: 参照したドキュメントとセクションをアコーディオン形式で常に提示
- **チャット UI**: Markdown レンダリング、ローディング表示、レスポンシブ

## セットアップ

```bash
npm install
cp .env.local.example .env.local
# .env.local に GEMINI_API_KEY を設定 (https://aistudio.google.com/apikey で取得)
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
└── gemini-search.ts      (3 ステップ検索ロジック)

scripts/
└── generate-docs.mjs     (50 件のダミードキュメント生成スクリプト)
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

実測値は `/api/search` の NDJSON ストリームで段階ごとに流れる `usage` イベント（`{stage, model, promptTokens, cachedTokens, outputTokens, totalTokens, cacheRatio}`）で確認できる。同じ値は `[search.usage] stage=... prompt=... cached=... ratio=...` 形式でサーバーログにも出力されるので、暗黙プロンプトキャッシュのヒット率を観測できる（v2 設計 Phase 2）。

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
# 全セクションの埋め込みを Gemini で生成（API キー必要、無料枠で 50 件分は数十秒）
node scripts/generate-embeddings.mjs
```

`embeddings.json` は `.gitignore` 済み。ファイルが無い／クエリ埋め込み呼び出しが失敗した／次元が一致しない場合、ハイブリッド層は無効化されメタデータ単独の Phase 1-2 挙動に自動フォールバックする（ユーザーに見える失敗は出さない）。pgvector 等への移行は 500 件規模を超えてから（設計 §6, §10）。

## デプロイ

Vercel: `vercel` コマンドで即デプロイ可。`GEMINI_API_KEY` を環境変数に登録すること。Next.js 16 + Node ランタイム（Fluid Compute）で動作。
