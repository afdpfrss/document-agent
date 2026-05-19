// Structured edit-proposal schema (v2 design Phase 6, §4-D, §10).
//
// All AI-generated edits MUST be expressed as {find, replace, reason} so a
// human reviewer can read the intent, see exactly what bytes will change,
// and reject anything that looks wrong before it ever becomes a PR. Full
// regeneration of the document by the model is explicitly disallowed in
// docs/v2-design.md §10 ("やらないこと").

export interface FindReplaceEdit {
  // Verbatim substring of the original document. Must match exactly once.
  // If it matches zero or multiple times the edit is rejected — the model
  // should retry with more surrounding context to make the match unique.
  find: string;
  // Replacement text. May be empty (deletion).
  replace: string;
  // Short human-readable justification surfaced in the review UI and used
  // as part of the PR body so reviewers see why each change was suggested.
  reason: string;
}

export interface EditProposal {
  edits: FindReplaceEdit[];
}

export type EditApplyStatus =
  | { kind: "ok"; index: number }
  | { kind: "not_found"; index: number; find: string }
  | { kind: "ambiguous"; index: number; find: string; matches: number };

export interface EditApplyResult {
  content: string;
  statuses: EditApplyStatus[];
}

// Apply edits sequentially. Each edit's `find` is searched in the CURRENT
// (post-previous-edit) content, so later edits can target text introduced
// by earlier ones — and conflicting edits are caught when the second
// edit's `find` no longer exists.
//
// Sequential application matches what a human editor would do; trying to
// be clever and apply edits in parallel against the original makes it
// impossible to express dependent changes.
export function applyEdits(original: string, edits: FindReplaceEdit[]): EditApplyResult {
  let content = original;
  const statuses: EditApplyStatus[] = [];
  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i];
    if (find.length === 0) {
      statuses.push({ kind: "not_found", index: i, find });
      continue;
    }
    const matches = countOccurrences(content, find);
    if (matches === 0) {
      statuses.push({ kind: "not_found", index: i, find });
      continue;
    }
    if (matches > 1) {
      statuses.push({ kind: "ambiguous", index: i, find, matches });
      continue;
    }
    content = content.replace(find, replace);
    statuses.push({ kind: "ok", index: i });
  }
  return { content, statuses };
}

// Non-overlapping occurrence count. We don't use String.matchAll(regex)
// because `find` is literal text and may legitimately contain regex
// metacharacters that we DON'T want interpreted.
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const next = haystack.indexOf(needle, idx);
    if (next < 0) return count;
    count++;
    idx = next + needle.length;
  }
}
