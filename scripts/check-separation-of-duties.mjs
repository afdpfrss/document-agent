#!/usr/bin/env node
// 提案者≠承認者の検証 — ポカヨケ設計 柱3。
//
// GitHub Actions（.github/workflows/separation-of-duties.yml）から実行される。
// PR 本文に propose_edit / propose_related_edit が埋め込んだ提案者マーカーを
// 読み、APPROVED レビューの承認者と突き合わせ、commit status
// `poka-yoke / separation-of-duties` を PR の head SHA に post する。
// ブランチ保護でこの status を必須チェックにすると、提案者の自己承認だけでは
// マージできなくなる。
//
// 共有トークン問題: propose_edit の PR は単一サービスアカウント名義で作られる
// ため GitHub 標準の自己承認禁止が効かない。このスクリプトが代替の歯止め。
//
// 必要な env: GITHUB_TOKEN, PR_NUMBER, REPO(owner/repo), HEAD_SHA
//
// 依存なし（node:* と グローバル fetch のみ）。CI で npm ci 不要。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORS_PATH = path.join(ROOT, ".github", "edit-authors.json");
const STATUS_CONTEXT = "poka-yoke / separation-of-duties";
const PROPOSER_MARKER_RE = /<!--\s*poka-yoke:proposer=(\S+?)\s*-->/;
const DEMO_LABEL = "demo";
const API = "https://api.github.com";

const TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.REPO;
const HEAD_SHA = process.env.HEAD_SHA;

async function gh(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${urlPath} -> ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// commit status の description は 140 文字上限。
function clip(s, max = 140) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function postStatus(state, description) {
  await gh("POST", `/repos/${REPO}/statuses/${HEAD_SHA}`, {
    state,
    context: STATUS_CONTEXT,
    description: clip(description),
  });
  console.log(`[SoD] ${state}: ${description}`);
}

async function main() {
  if (!TOKEN || !PR_NUMBER || !REPO || !HEAD_SHA) {
    console.error("必須 env (GITHUB_TOKEN/PR_NUMBER/REPO/HEAD_SHA) が未設定です");
    process.exit(1);
  }

  const pr = await gh("GET", `/repos/${REPO}/pulls/${PR_NUMBER}`);
  const labels = (pr.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name,
  );

  // デモモード: demo ラベル付き PR は SoD 非適用（プレゼン用、main 上で
  // 同一アカウントの作成〜承認を許す）。緩和されるのは SoD のみで、
  // corpus CI と CODEOWNERS 承認は通常どおり必須。
  if (labels.includes(DEMO_LABEL)) {
    await postStatus("success", "demo mode — SoD 非適用");
    return;
  }

  const markerMatch = PROPOSER_MARKER_RE.exec(pr.body ?? "");
  const proposer = markerMatch ? markerMatch[1].trim().toLowerCase() : null;

  // 提案者マーカーなし = MCP 提案ではない手動 PR。手動 PR は実ユーザー名義で
  // 作られるため GitHub 標準の自己承認禁止が効く → SoD は非適用。
  if (!proposer) {
    await postStatus("success", "MCP 提案ではない — GitHub 標準ルールが適用");
    return;
  }

  // 認証オフで作成された編集は提案者を検証できない → fail closed。
  if (proposer === "unverified") {
    await postStatus(
      "failure",
      "認証オフで作成された編集 — 提案者を検証できません",
    );
    return;
  }

  // email → GitHub ログイン対応表を読む（base ブランチの版が checkout 済み）。
  let authors = [];
  try {
    const raw = await fs.readFile(AUTHORS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    authors = Array.isArray(parsed.authors) ? parsed.authors : [];
  } catch (e) {
    await postStatus("failure", `edit-authors.json を読めません: ${e.message}`);
    return;
  }
  const emailByLogin = new Map();
  const knownEmails = new Set();
  for (const a of authors) {
    if (a && typeof a.email === "string" && typeof a.github_login === "string") {
      const email = a.email.trim().toLowerCase();
      emailByLogin.set(a.github_login.trim().toLowerCase(), email);
      knownEmails.add(email);
    }
  }

  // 提案者が対応表に未登録 → 承認者との照合不能 → fail closed。
  if (!knownEmails.has(proposer)) {
    await postStatus(
      "failure",
      `提案者 ${proposer} が edit-authors.json に未登録です`,
    );
    return;
  }

  // APPROVED レビューの承認者を集める。各ユーザーの最新レビュー状態で判定し、
  // COMMENTED は承認状態を変えないので無視する。
  const reviews = await gh(
    "GET",
    `/repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100`,
  );
  const latestByUser = new Map();
  for (const r of reviews) {
    const login = r.user?.login?.toLowerCase();
    if (!login) continue;
    if (r.state === "COMMENTED") continue;
    latestByUser.set(login, r.state);
  }
  const approverLogins = [...latestByUser.entries()]
    .filter(([, state]) => state === "APPROVED")
    .map(([login]) => login);

  if (approverLogins.length === 0) {
    await postStatus("success", "承認待ち — SoD 違反なし");
    return;
  }

  // 対応表で email を確定でき、かつ提案者と異なる承認者が1人でもいれば OK。
  const hasValidNonProposer = approverLogins.some((login) => {
    const email = emailByLogin.get(login);
    return email && email !== proposer;
  });
  if (hasValidNonProposer) {
    await postStatus("success", "提案者以外の承認を確認しました");
    return;
  }

  // 承認者はいるが、提案者以外と確定できる者がいない。
  const selfApproved = approverLogins.some(
    (login) => emailByLogin.get(login) === proposer,
  );
  if (selfApproved) {
    await postStatus(
      "failure",
      "提案者本人が承認しています — 別のレビュアーの承認が必要です",
    );
  } else {
    await postStatus(
      "failure",
      "承認者が edit-authors.json に未登録で提案者との照合ができません",
    );
  }
}

main().catch(async (err) => {
  console.error(err);
  // 検証自体が異常終了したら fail closed（status を出せるなら failure に）。
  try {
    if (TOKEN && REPO && HEAD_SHA) {
      await postStatus("failure", `SoD チェックが異常終了: ${err.message}`);
    }
  } catch {
    // status も出せなければ exit code で workflow を赤くする。
  }
  process.exit(1);
});
