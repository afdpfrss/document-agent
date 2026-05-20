<!-- このテンプレートは全 PR に表示される。propose_edit / propose_related_edit
     が作成する PR は構造化された本文で上書きされるため、このチェックリストは
     主に手動 PR のレビュアー向け。 -->

社内ドキュメントの編集 PR です。**マージ前に差分の人間レビューが必須**です
（v2 設計 §10：自動マージ禁止・AI 提案は人間レビュー必須）。

機械で判定できる項目（frontmatter 整合性・section_id・index.json 整合性・型）は
corpus-ci が自動検証します。レビュアーは機械では検証できない**意味の正しさ**に集中してください。

## レビュアー確認チェックリスト（CODEOWNERS）

- [ ] 差分（diff）をすべて目視で確認した
- [ ] 変更内容が各編集の `reason`（理由）と一致している
- [ ] 事実関係・数値・固有名詞・日付が正しい
- [ ] 自分はこの編集の提案者ではない（提案者≠承認者）
- [ ] CI（corpus-ci の validate / typecheck、separation-of-duties）がすべて green
