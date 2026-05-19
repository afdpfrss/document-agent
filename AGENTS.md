<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project context

This repository is transitioning from **v1 (legacy)** to **v2 (hybrid document agent)**.

- **v1 (旧アイディア)**: Markdown-only 社内ドキュメント検索。詳細は `README.md`。保存ブランチ: `legacy/v1-original`
- **v2 (現アイディア)**: v1 の段階的開示を維持しつつ、多形式取り込み・ハイブリッド検索・チャットベース編集・GitHub バックエンドを追加する設計

**実装前に必ず `docs/v2-design.md` を読むこと**。設計方針・採用機能・実装フェーズ・やらないことリストが整理されている。

## 開発時の最重要原則（詳細は docs/v2-design.md §2, §10）

- メタデータ駆動が主、ベクトルは補助（段階的開示の構造を壊さない）
- AI 編集は必ず `{find, replace, reason}` 構造化 + 人間レビュー必須
- LLM はモデル名・API キーを環境変数化（さくら等への将来切替余地を残す）
- 開発フェーズはダミーデータ前提、Gemini 無料枠を使う
- ベクトル DB / DB 永続化 / 全文再生成型編集は採用しない（理由は §10）
