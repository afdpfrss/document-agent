// Common write facade for batched file commits. Lets the upload pipeline
// (and any future bulk editor) hand the same { path, content }[] to either
// the GitHub backend (PR per submit) or local disk (dev only).
//
// Mode selection:
//   - explicit `opts.mode`
//   - else `isGithubConfigured() ? "github" : "local"`
//
// Local mode is dev-only — we refuse to run when NODE_ENV === "production"
// so a missing GITHUB_TOKEN in prod can't silently bypass the PR audit
// trail (docs/v2-design.md §4-E, §10).

import fs from "node:fs/promises";
import path from "node:path";
import {
  isGithubConfigured,
  proposeEdit,
  proposeEditMulti,
  defaultBranchName,
} from "./github";

export type CommitMode = "github" | "local";

export interface CommitFile {
  // Repo-root-relative POSIX path, e.g. "documents/foo/doc_001_bar.md".
  path: string;
  content: string;
}

export interface CommitOptions {
  message: string;
  prBody?: string;
  branch?: string;
  mode?: CommitMode;
  // Repo-root-relative paths to remove in the same commit as `files`. Used by
  // the delete pipeline so a doc removal lands atomically with the updated
  // index.json.
  deletions?: string[];
}

export type CommitResult =
  | {
      mode: "github";
      branch: string;
      prNumber: number;
      prUrl: string;
      commitSha: string;
    }
  | { mode: "local"; written: string[] };

function resolveMode(explicit?: CommitMode): CommitMode {
  if (explicit) return explicit;
  return isGithubConfigured() ? "github" : "local";
}

export async function commitFiles(
  files: CommitFile[],
  opts: CommitOptions,
): Promise<CommitResult> {
  const deletions = opts.deletions ?? [];
  if (files.length === 0 && deletions.length === 0) {
    throw new Error("commitFiles: no files to commit");
  }
  const mode = resolveMode(opts.mode);

  if (mode === "local") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "commitFiles: local mode is disabled in production. Configure GITHUB_TOKEN to use the PR backend.",
      );
    }
    const written: string[] = [];
    const root = process.cwd();
    for (const f of files) {
      const abs = path.join(root, f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content, "utf8");
      written.push(f.path);
    }
    for (const p of deletions) {
      const abs = path.join(root, p);
      // force: true → no-op if already gone (idempotent on retries).
      await fs.rm(abs, { force: true });
      written.push(`-${p}`);
    }
    return { mode: "local", written };
  }

  // github mode — single-file proposeEdit() only when there are no deletions
  // and exactly one write; otherwise we need the multi-file tree path.
  const branchSeed =
    files[0]?.path ?? deletions[0] ?? "delete";
  const branch =
    opts.branch ??
    defaultBranchName(branchSeed.replace(/^.*\//, "") || "delete");

  if (files.length === 1 && deletions.length === 0) {
    const single = await proposeEdit({
      path: files[0].path,
      content: files[0].content,
      message: opts.message,
      prBody: opts.prBody,
      branch,
    });
    return {
      mode: "github",
      branch: single.branch,
      prNumber: single.prNumber,
      prUrl: single.prUrl,
      commitSha: single.commitSha,
    };
  }

  const multi = await proposeEditMulti({
    files,
    deletions,
    message: opts.message,
    prBody: opts.prBody,
    branch,
  });
  return {
    mode: "github",
    branch: multi.branch,
    prNumber: multi.prNumber,
    prUrl: multi.prUrl,
    commitSha: multi.commitSha,
  };
}
