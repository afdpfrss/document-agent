# ブランチ保護 運用ランブック

ポカヨケ設計（編集→レビュー→承認→マージでヒューマンエラーを構造的に防ぐ）の
**運用側の設定手順**。コードだけでは完結せず、GitHub 上の設定が揃って初めて
ガードが効く。

## 0. 前提 — 有効化の順序（重要）

必須チェック（`validate` / `typecheck` / `poka-yoke / separation-of-duties`）が
**存在して green になる前にブランチ保護を有効化すると `main` が凍結**する。
必ず次の順で行う:

1. `corpus-ci.yml` と `separation-of-duties.yml` をマージ済みにする。
2. `edit-authors.json` に実メンバーを登録（§3）。
3. GitHub チームを作成（§1）。
4. 一度ダミー PR を出し、3つのチェックがすべて緑になることを確認。
5. 最後にブランチ保護を有効化（§2）。

## 1. GitHub チーム

org `afdpfrss` に以下のチームを作成する。slug は `.github/CODEOWNERS` の
記載と完全一致させること。各チームは **2 名以上**（提案者が1名のとき別の人が
承認できるように。1名だと SoD でそのカテゴリの PR がマージ不能になる）。

| team slug | 担当カテゴリ |
|---|---|
| `security-team` | ISMS関連文書 |
| `hr-team` | 人事考課 / 年末調整 / 労使協定 / 発令 |
| `legal-team` | 各種規程・基準 |
| `ops-team` | 各種マニュアル / その他業務ガイド |
| `facilities-team` | 設備運用ルール |
| `comms-team` | 会社案内 |
| `eng` | コード・設定・ガバナンスファイル全般 |

## 2. `main` のブランチ保護ルール

Settings → Branches → Add branch ruleset（または classic branch protection）、
対象 `main`:

- **Require a pull request before merging**
  - Require approvals: **1**
  - **Require review from Code Owners**
  - **Dismiss stale pull request approvals when new commits are pushed**
- **Require status checks to pass before merging**
  - **Require branches to be up to date before merging**（古い PR のマージを阻止）
  - 必須チェックに追加: `validate`、`typecheck`、`poka-yoke / separation-of-duties`
    - 前2つは `corpus-ci.yml` のジョブ。最後の1つは SoD ワークフローが
      head SHA に post する **commit status**（ジョブ名ではなくこの context 名）。
- **Require conversation resolution before merging**（推奨）
- **Do not allow bypassing the above settings**（管理者も red を越えられない）
- **Restrict who can push** — `main` への直 push を禁止。全変更は PR 経由。
- リポジトリ設定で **"Allow auto-merge" は無効**のまま（v2 設計 §10：自動マージ禁止）。

## 3. サービスアカウント（`GITHUB_TOKEN`）の制約

`propose_edit` / `merge_edit` が使う `GITHUB_TOKEN` のアカウントは:

- **どの CODEOWNERS チームにも入れない** — 入れると自己承認できてしまう。
- ブランチ保護の **bypass リストに入れない**。
- `merge_edit` は `pulls.merge` を呼ぶだけ。全ゲート（CI・CODEOWNERS 承認・
  base 最新・SoD）が満たされて初めて GitHub がマージを許可する。トークンに
  特権は不要で、むしろ与えてはいけない。

## 4. `edit-authors.json` の保守

`.github/edit-authors.json` は SoD チェックの email↔GitHub ログイン対応表。

- 編集を**提案または承認しうる全メンバー**を登録する。
- 未登録の提案者・承認者は「検証不能」として SoD が **fail closed**（red）。
- このファイルは CODEOWNERS で `@afdpfrss/eng` にルーティングされ、改ざんに
  はエンジニアレビューが必要。

形式:

```json
{
  "authors": [
    { "email": "alice@example.co.jp", "github_login": "alice-gh", "teams": ["hr-team"] }
  ]
}
```

`email` は MCP の認証メール（OAuth）、`github_login` は GitHub アカウント名。

## 5. デモモード

プレゼン用に同一アカウントで作成〜承認〜マージを実演する場合、MCP コネクタの
環境変数 `MCP_DEMO_MODE=true` を設定する。

- デモ PR も対象は `main`。タイトルに `[DEMO]` 接頭辞、`demo` ラベルが付く。
- SoD チェックは `demo` ラベルを見て **非適用**（success）になる。
- **緩和されるのは SoD のみ**。`validate` / `typecheck` と CODEOWNERS 承認は
  通常どおり必須 — デモ編集も壊れた文書ではなく、承認は GitHub 差分 UI を通る。
- デモ担当アカウントは対象カテゴリの CODEOWNERS かつ `MERGER_EMAILS` 登録に
  しておくこと。
- **本番コネクタでは `MCP_DEMO_MODE` を有効化しない**。有効なまま放置すると
  全 PR が `demo` ラベル付きになり SoD が事実上無効化される。`[DEMO]` 接頭辞・
  `demo` ラベルが歯止め（デモ PR が常に可視）。

## 6. 単独運用モード（零細企業向け）

文書の作成・承認・マージを **1 人で担う零細企業**では、提案者≠承認者（SoD）を
満たせる人員がいない。この場合 MCP コネクタの環境変数
`MCP_SOLO_APPROVER_MODE=true` を設定する。

- `propose_edit` / `propose_related_edit` / `ingest_documents` が作る PR に
  `solo-approver` ラベルと本文マーカー `<!-- poka-yoke:solo-approver -->` が付く。
- separation-of-duties チェックはこの印を見て **SoD を非適用**（success）にし、
  作成者本人の承認でマージできるようにする。
- **緩和されるのは SoD のみ**。`validate` / `typecheck` と CODEOWNERS 承認は
  通常どおり必須 — 作成者は対象カテゴリの CODEOWNERS かつ `MERGER_EMAILS`
  登録にしておくこと。
- **デモモード（§5）との違い**:
  - `[DEMO]` 接頭辞・`demo` ラベルは付かない。デモではなく正規の編集 PR のため。
  - 本番でも有効。本番ガード（`productionGuardActive`）で打ち消さない —
    零細企業の正規の運用形態だから。デモモードは本番で強制無効化される。
  - 代わりに `lib/config-guard.ts` が起動時に「SoD が無効化されている」ことを
    `[config-guard]` 警告ログで可視化する。設定の存在自体が歯止め。
- **複数人で文書を運用できるようになったら未設定に戻すこと**。SoD は
  ヒューマンエラーを構造的に防ぐ柱（柱3）なので、承認できる人員が揃ったら
  有効化するのが望ましい。

## 7. MCP コネクタ側の環境変数

| 変数 | 用途 |
|---|---|
| `EDITOR_EMAILS` | `mcp:edit` を付与（propose_edit / propose_related_edit） |
| `MERGER_EMAILS` | `mcp:merge` を付与（merge_edit） |
| `MCP_DEMO_MODE` | `true` でデモモード（§5）。本番は未設定 |
| `MCP_SOLO_APPROVER_MODE` | `true` で単独運用モード（§6）。零細企業向けに SoD を非適用にする |
