// Rehype plugin: collapse marker cells in GFM tables into rowspan/colspan.
//
// Storage stays as plain GFM (easy to diff, easy to edit). The merge geometry
// is encoded by per-cell text markers:
//   "←"  → this cell is merged with the cell to its left
//   "↑"  → this cell is merged with the cell above
// For an N×M merge, the top-left "anchor" carries the value; cells on the
// top row (other than anchor) use ←, cells in the left column use ↑, and
// interior cells use either (← is preferred because it cascades through the
// already-resolved row above).
//
// Whitespace inside the cell text is trimmed before matching, so users can
// write `| ← |` naturally. Only an exact match counts as a marker — a cell
// containing `← see other table` stays as a regular cell.
//
// ----------------------------------------------------------------------------
// Limitation: a cell whose content is *exactly* ← or ↑ cannot be displayed
// as literal text — it will be absorbed as a merge marker. We accept this:
//
//   - GFM cannot express merges in any standard way. Tools that have tried
//     converge on similar inline-marker conventions, all with the same
//     tradeoff:
//       * remark-extended-table / rehype-extended-table → ">" and "^",
//         backslash-escape (`\>`, `\^`) for literals.
//         https://github.com/wataru-chocola/remark-extended-table
//       * Python-Markdown cell_row_span → "||" / "_..._" markers, NBSP entity
//         as escape. https://github.com/Neepawa/cell_row_span
//       * markdown-it-multimd-table → "||" / "^^".
//         https://github.com/redbug312/markdown-it-multimd-table
//       * Obsidian community proposal → "|<" / ">|" anchored to the pipe.
//   - We chose ← / ↑ (non-ASCII arrows) over the ecosystem default of > / ^
//     specifically because real spreadsheets almost never contain a cell of
//     just "←" or "↑" — collision probability is dramatically lower than
//     with ASCII markers. Adding a backslash-escape mechanism is feasible
//     (mirrors remark-extended-table) but pushes complexity onto editors,
//     and we judged the tradeoff not worth it for this use case.
//   - Workarounds for the rare cell that genuinely needs to show ← / ↑ as
//     content:
//       * Pair with any other character: "← 戻る", "(←)", "「←」"
//       * Use a different glyph: ⇐ ⟵ ⬅ ◀ / ⇑ ⟰ ⬆ ▲
//       * Prefix a zero-width space (U+200B) — visually identical, defeats
//         the exact-match check.
//   - HTML entities (`&larr;`, `&#8592;`) do NOT escape: the parser decodes
//     them before this plugin runs.
// ----------------------------------------------------------------------------

import type { Element, ElementContent, Root } from "hast";

const MERGE_LEFT = "←";
const MERGE_UP = "↑";

function cellText(cell: Element): string {
  let out = "";
  for (const child of cell.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += cellText(child);
  }
  return out.trim();
}

function collectRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of table.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "thead" || child.tagName === "tbody") {
      for (const tr of child.children) {
        if (tr.type === "element" && tr.tagName === "tr") rows.push(tr);
      }
    } else if (child.tagName === "tr") {
      rows.push(child);
    }
  }
  return rows;
}

function rowCells(row: Element): Element[] {
  return row.children.filter(
    (c): c is Element =>
      c.type === "element" && (c.tagName === "td" || c.tagName === "th"),
  );
}

function isMarker(t: string): boolean {
  return t === MERGE_LEFT || t === MERGE_UP;
}

function processTable(table: Element): void {
  const rows = collectRows(table);
  if (rows.length === 0) return;
  const cells = rows.map(rowCells);
  const skip: boolean[][] = cells.map((r) => r.map(() => false));

  // Walk anchor-out: at each non-marker cell, extend colspan rightward over
  // ← cells, then rowspan downward over ↑ cells. Interior cells of the
  // resulting rectangle (any marker variant) are absorbed.
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      if (skip[r][c]) continue;
      const anchor = cells[r][c];
      const text = cellText(anchor);
      if (isMarker(text)) {
        // Stray marker without an anchor before it — leave as-is so it's
        // visible in the rendered output (data is suspect).
        continue;
      }
      let colspan = 1;
      for (let cc = c + 1; cc < cells[r].length; cc++) {
        if (skip[r][cc]) break;
        if (cellText(cells[r][cc]) !== MERGE_LEFT) break;
        skip[r][cc] = true;
        colspan++;
      }
      let rowspan = 1;
      for (let rr = r + 1; rr < cells.length; rr++) {
        if (cells[rr][c] === undefined) break;
        if (skip[rr][c]) break;
        if (cellText(cells[rr][c]) !== MERGE_UP) break;
        // Confirm the interior cells (c+1..c+colspan-1) are also markers
        // before committing — otherwise the rectangle isn't really merged.
        let interiorOk = true;
        for (let cc = c + 1; cc < c + colspan; cc++) {
          if (cells[rr][cc] === undefined) {
            interiorOk = false;
            break;
          }
          if (!isMarker(cellText(cells[rr][cc]))) {
            interiorOk = false;
            break;
          }
        }
        if (!interiorOk) break;
        skip[rr][c] = true;
        for (let cc = c + 1; cc < c + colspan; cc++) skip[rr][cc] = true;
        rowspan++;
      }
      if (rowspan > 1 || colspan > 1) {
        anchor.properties = { ...(anchor.properties ?? {}) };
        if (rowspan > 1) anchor.properties.rowSpan = rowspan;
        if (colspan > 1) anchor.properties.colSpan = colspan;
      }
    }
  }

  // Drop skipped cells. Iterate rows again so the row children list is
  // rebuilt without the absorbed marker cells.
  for (let r = 0; r < rows.length; r++) {
    const keep = new Set<Element>();
    for (let c = 0; c < cells[r].length; c++) {
      if (!skip[r][c]) keep.add(cells[r][c]);
    }
    rows[r].children = rows[r].children.filter(
      (child): child is ElementContent =>
        child.type !== "element" ||
        (child.tagName !== "td" && child.tagName !== "th") ||
        keep.has(child),
    );
  }
}

// Plugin entry. Walks every <table> in the tree and applies merge logic.
export function rehypeMergedCells() {
  return (tree: Root) => {
    walk(tree);
  };
}

function walk(node: Root | Element): void {
  if (node.type === "element" && node.tagName === "table") {
    processTable(node);
  }
  for (const child of node.children) {
    if (child.type === "element") walk(child);
  }
}
