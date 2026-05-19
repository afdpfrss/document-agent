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
    url: pr.html_url,
    author: pr.user?.login ?? null,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
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
