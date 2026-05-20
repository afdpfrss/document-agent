// GitHub backend for v2 — branch = draft, PR = approval queue, merge = published
// (docs/v2-design.md §4-E, §5 Phase 5). All edits to documents/ go through a
// PR rather than being written to disk by the running app, so reviewers
// (CODEOWNERS) get a chance to sign off before content reaches main.
//
// This module is server-only — it talks to the GitHub API via Octokit using
// a Personal Access Token (PAT) or GitHub App token set in the environment.
// It never runs in the browser and never exposes the token to clients.
//
// Environment:
//   GITHUB_TOKEN         required — repo-scoped PAT or installation token
//   GITHUB_REPO_OWNER    default: afdpfrss
//   GITHUB_REPO_NAME     default: document-agent
//   GITHUB_BASE_BRANCH   default: main

import { Octokit } from "octokit";

export interface GithubRepoConfig {
  owner: string;
  repo: string;
  baseBranch: string;
}

export function readGithubConfig(): GithubRepoConfig {
  return {
    owner: process.env.GITHUB_REPO_OWNER ?? "afdpfrss",
    repo: process.env.GITHUB_REPO_NAME ?? "document-agent",
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
  };
}

export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

function requireToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Configure a PAT with `repo` scope (or an app installation token) before using the GitHub backend.",
    );
  }
  return token;
}

// Cached Octokit instance — Octokit is cheap to construct but reusing one
// allows its internal throttling/retry plugins (if added later) to share state.
let octokitInstance: Octokit | null = null;
export function getOctokit(): Octokit {
  if (!octokitInstance) {
    octokitInstance = new Octokit({ auth: requireToken() });
  }
  return octokitInstance;
}

// Used by tests/scripts to drop the cached client after a token rotation.
export function resetOctokitForTesting(): void {
  octokitInstance = null;
}

export interface ProposeEditInput {
  // Path inside the repo, e.g. "documents/各種規程・基準/doc_001_就業規則.md".
  path: string;
  // Replacement file content. Must be the full file body — GitHub's contents
  // API replaces, not patches.
  content: string;
  // Human-readable commit / PR title. Should be short (≤72 chars).
  message: string;
  // Optional longer PR body. Should explain what was changed and why.
  prBody?: string;
  // Optional branch name override. If omitted, generated as
  // `edit/<basename>-<unix-ts>`.
  branch?: string;
}

export interface ProposeEditResult {
  branch: string;
  prNumber: number;
  prUrl: string;
  commitSha: string;
}

// Create a fresh branch off baseBranch, replace `path` with `content`, and
// open a PR back into baseBranch. All edits funnel through this single
// function so the audit trail (branch + PR + commit) is uniform.
export async function proposeEdit(input: ProposeEditInput): Promise<ProposeEditResult> {
  const cfg = readGithubConfig();
  const oct = getOctokit();
  const { owner, repo, baseBranch } = cfg;

  const branchName = input.branch ?? defaultBranchName(input.path);

  // 1. Read the base branch's tip commit SHA so we can branch from it.
  const baseRef = await oct.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.data.object.sha;

  // 2. Create the new branch ref. Fails with 422 if the branch already exists
  //    — we surface that as a clearer error rather than letting the raw
  //    Octokit response leak through.
  try {
    await oct.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) {
      throw new Error(`Branch already exists: ${branchName}`);
    }
    throw err;
  }

  // 3. Look up the existing file's blob SHA on the new branch. createOrUpdate
  //    requires `sha` when the path already exists (PUT replaces a blob).
  //    A 404 means we're creating a new file — that's allowed too.
  let existingSha: string | undefined;
  try {
    const existing = await oct.rest.repos.getContent({
      owner,
      repo,
      path: input.path,
      ref: branchName,
    });
    if (!Array.isArray(existing.data) && existing.data.type === "file") {
      existingSha = existing.data.sha;
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }

  // 4. Commit the file change to the new branch.
  const commit = await oct.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: input.path,
    message: input.message,
    content: Buffer.from(input.content, "utf8").toString("base64"),
    branch: branchName,
    sha: existingSha,
  });

  // 5. Open the PR. We always target baseBranch — multi-target PRs are not
  //    part of the v2 design.
  const pr = await oct.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base: baseBranch,
    title: input.message,
    body: input.prBody ?? "",
  });

  return {
    branch: branchName,
    prNumber: pr.data.number,
    prUrl: pr.data.html_url,
    commitSha: commit.data.commit.sha ?? "",
  };
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  branch: string;
  headSha: string;
  body: string | null;
  url: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listOpenPullRequests(): Promise<PullRequestSummary[]> {
  const { owner, repo, baseBranch } = readGithubConfig();
  const oct = getOctokit();
  const res = await oct.rest.pulls.list({
    owner,
    repo,
    state: "open",
    base: baseBranch,
    per_page: 100,
  });
  return res.data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state as "open" | "closed",
    merged: false,
    branch: pr.head.ref,
    headSha: pr.head.sha,
    body: pr.body ?? null,
    url: pr.html_url,
    author: pr.user?.login ?? null,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  }));
}

export async function getPullRequest(prNumber: number): Promise<PullRequestSummary> {
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  const res = await oct.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const pr = res.data;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state as "open" | "closed",
    merged: Boolean(pr.merged),
    branch: pr.head.ref,
    headSha: pr.head.sha,
    body: pr.body ?? null,
    url: pr.html_url,
    author: pr.user?.login ?? null,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
}

// --- PR review aids (ポカヨケ設計 柱2 — review_edit MCP ツールの裏側) -------

export interface PullRequestFileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PullRequestDiff {
  diff: string;
  files: PullRequestFileChange[];
}

// Unified diff (mediaType: diff) + a structured per-file change list. Lets the
// review_edit tool put the actual diff in front of the reviewer.
export async function getPullRequestDiff(
  prNumber: number,
): Promise<PullRequestDiff> {
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  const diffRes = await oct.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  // With mediaType.format "diff" the response body is the raw diff string,
  // even though Octokit's static types still describe the PR object.
  const diff = diffRes.data as unknown as string;
  const filesRes = await oct.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return {
    diff,
    files: filesRes.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}

export type CheckState = "success" | "pending" | "failure";

export interface PullRequestCheck {
  context: string;
  state: CheckState;
}

function normalizeCheckRun(
  status: string,
  conclusion: string | null,
): CheckState {
  if (status !== "completed") return "pending";
  if (
    conclusion === "success" ||
    conclusion === "neutral" ||
    conclusion === "skipped"
  ) {
    return "success";
  }
  return "failure";
}

function normalizeStatusState(state: string): CheckState {
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  return "failure";
}

// Merges GitHub's two CI surfaces — check runs (Actions) and legacy commit
// statuses (the separation-of-duties workflow posts one) — into one normalized
// list so review_edit / merge_edit can reason about a single gate state.
export async function getPullRequestChecks(
  prNumber: number,
): Promise<PullRequestCheck[]> {
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  const pr = await getPullRequest(prNumber);
  const ref = pr.headSha;

  const out: PullRequestCheck[] = [];

  const checkRuns = await oct.rest.checks.listForRef({
    owner,
    repo,
    ref,
    per_page: 100,
  });
  for (const run of checkRuns.data.check_runs) {
    out.push({
      context: run.name,
      state: normalizeCheckRun(run.status, run.conclusion),
    });
  }

  const combined = await oct.rest.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref,
  });
  for (const s of combined.data.statuses) {
    out.push({ context: s.context, state: normalizeStatusState(s.state) });
  }

  return out;
}

export interface PullRequestReview {
  login: string | null;
  state: string;
}

export interface PullRequestReviewInfo {
  reviews: PullRequestReview[];
  mergeable: boolean | null;
  mergeableState: string;
}

export async function getPullRequestReviews(
  prNumber: number,
): Promise<PullRequestReviewInfo> {
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  const reviewsRes = await oct.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const prRes = await oct.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return {
    reviews: reviewsRes.data.map((r) => ({
      login: r.user?.login ?? null,
      state: r.state,
    })),
    mergeable: prRes.data.mergeable ?? null,
    mergeableState: prRes.data.mergeable_state ?? "unknown",
  };
}

// Adds labels to a PR. issues.addLabels auto-creates labels that don't exist
// yet. Used to stamp PRs with the proposer / demo markers (ポカヨケ設計 柱3）。
export async function addPullRequestLabels(
  prNumber: number,
  labels: string[],
): Promise<void> {
  if (labels.length === 0) return;
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  await oct.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels,
  });
}

// --- merge (ポカヨケ設計 柱D — merge_edit MCP ツールの裏側) ----------------

export type MergeBlockReason = "ci" | "review" | "stale" | "conflict" | "other";

export interface MergeResult {
  ok: boolean;
  merged?: boolean;
  mergeCommitSha?: string;
  blockedBy?: MergeBlockReason;
  message: string;
}

// Best-effort classification of GitHub's "not mergeable" (405) message into a
// reason. The message text is not a stable API, so callers should also surface
// the concrete check/review state for an accurate diagnosis.
function classifyBlock(message: string): MergeBlockReason {
  const m = message.toLowerCase();
  if (m.includes("status check") || m.includes("required check")) return "ci";
  if (m.includes("review") || m.includes("approv")) return "review";
  if (m.includes("up to date") || m.includes("out of date") || m.includes("behind")) {
    return "stale";
  }
  if (m.includes("conflict")) return "conflict";
  return "other";
}

// Triggers a PR merge. Safe to expose via merge_edit BECAUSE GitHub branch
// protection rejects any merge that isn't fully gated (CI green + CODEOWNERS
// approval + base up-to-date + SoD pass). A 405/409 is translated into a
// structured blockedBy reason rather than a raw Octokit throw — this is what
// keeps merge_edit from ever forcing an ungated merge.
export async function mergePullRequest(prNumber: number): Promise<MergeResult> {
  const { owner, repo } = readGithubConfig();
  const oct = getOctokit();
  try {
    const res = await oct.rest.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
    });
    return {
      ok: true,
      merged: res.data.merged,
      mergeCommitSha: res.data.sha,
      message: res.data.message ?? "merged",
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const raw = err instanceof Error ? err.message : String(err);
    if (status === 405) {
      // Not mergeable — branch protection / required reviews / required checks.
      return { ok: false, blockedBy: classifyBlock(raw), message: raw };
    }
    if (status === 409) {
      // Head changed since the SHA we read, or an unresolved merge conflict.
      return { ok: false, blockedBy: "conflict", message: raw };
    }
    throw err;
  }
}

export interface ProposeEditMultiInput {
  files: { path: string; content: string }[];
  // Repo-root-relative paths to delete in the same commit. Encoded as tree
  // entries with `sha: null`, per the Git Data API contract.
  deletions?: string[];
  message: string;
  prBody?: string;
  branch?: string;
}

// Multi-file variant of proposeEdit. Uses the Git Data API
// (blob → tree → commit → ref) so all files land in a single commit instead
// of N successive PUTs. Failure after createRef triggers a deleteRef
// rollback so we don't leave orphan branches behind.
export async function proposeEditMulti(
  input: ProposeEditMultiInput,
): Promise<ProposeEditResult> {
  const deletions = input.deletions ?? [];
  if (input.files.length === 0 && deletions.length === 0) {
    throw new Error("proposeEditMulti: files[] and deletions[] are both empty");
  }

  const cfg = readGithubConfig();
  const oct = getOctokit();
  const { owner, repo, baseBranch } = cfg;

  const branchName =
    input.branch ??
    defaultBranchName(input.files[0]?.path ?? deletions[0] ?? "delete");

  // 1. base commit + tree
  const baseRef = await oct.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = baseRef.data.object.sha;
  const baseCommit = await oct.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseSha,
  });
  const baseTreeSha = baseCommit.data.tree.sha;

  // 2. blob per file (parallel — these are independent network round trips)
  const blobs = await Promise.all(
    input.files.map(async (f) => {
      const blob = await oct.rest.git.createBlob({
        owner,
        repo,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      return { path: f.path, sha: blob.data.sha };
    }),
  );

  // 3. one tree off the base tree. Deletions are encoded as entries with
  //    `sha: null` (Git Data API contract). Octokit's type signature for
  //    `tree[].sha` is `string | undefined`, but the REST API documents
  //    `null` as the explicit "remove this path" signal, so we cast.
  const tree = await oct.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: [
      ...blobs.map((b) => ({
        path: b.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: b.sha,
      })),
      ...deletions.map((p) => ({
        path: p,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null as unknown as string,
      })),
    ],
  });

  // 4. one commit
  const commit = await oct.rest.git.createCommit({
    owner,
    repo,
    message: input.message,
    tree: tree.data.sha,
    parents: [baseSha],
  });

  // 5. branch ref. From here on, failures must roll back the ref so we
  // don't leave orphan branches behind.
  try {
    await oct.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: commit.data.sha,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) {
      throw new Error(`Branch already exists: ${branchName}`);
    }
    throw err;
  }

  try {
    const pr = await oct.rest.pulls.create({
      owner,
      repo,
      head: branchName,
      base: baseBranch,
      title: input.message,
      body: input.prBody ?? "",
    });
    return {
      branch: branchName,
      prNumber: pr.data.number,
      prUrl: pr.data.html_url,
      commitSha: commit.data.sha,
    };
  } catch (err) {
    // Roll back the branch — leaving it behind makes the next attempt 422.
    try {
      await oct.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
      });
    } catch {
      // best-effort; the original error is more important
    }
    throw err;
  }
}

// Generates a branch name that is unique-per-second and filesystem-safe.
// Format: edit/<doc-id-or-basename>-<unix-ts>. We intentionally include the
// file basename rather than the full path so the branch name stays short
// enough for GitHub's UI.
export function defaultBranchName(filePath: string): string {
  const base = filePath
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 40);
  return `edit/${base}-${Math.floor(Date.now() / 1000)}`;
}
