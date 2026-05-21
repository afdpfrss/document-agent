import { describe, it, expect } from "vitest";
import type { Element, ElementContent, Root } from "hast";
import { rehypeMergedCells } from "@/lib/rehype-merged-cells";

function cell(...children: ElementContent[]): Element {
  return { type: "element", tagName: "td", properties: {}, children };
}

function text(value: string): ElementContent {
  return { type: "text", value };
}

// remark-rehype (run with allowDangerousHtml by react-markdown) emits inline
// HTML such as "<br>" as a `raw` node — outside hast's typed union.
function raw(value: string): ElementContent {
  return { type: "raw", value } as unknown as ElementContent;
}

function table(rows: Element[][]): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "table",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "tbody",
            properties: {},
            children: rows.map((cells) => ({
              type: "element",
              tagName: "tr",
              properties: {},
              children: cells,
            })),
          },
        ],
      },
    ],
  };
}

function rowCells(tree: Root, row = 0): Element[] {
  const tbody = (tree.children[0] as Element).children[0] as Element;
  const tr = tbody.children[row] as Element;
  return tr.children.filter((c): c is Element => c.type === "element");
}

function shape(el: Element): string[] {
  return el.children.map((c) =>
    c.type === "element" ? c.tagName : `text:${(c as { value: string }).value}`,
  );
}

describe("rehypeMergedCells — in-cell <br> rendering", () => {
  it("expands literal <br> text into <br> elements", () => {
    const tree = table([[cell(text("AWS<br>Java<br>C言語"))]]);
    rehypeMergedCells()(tree);
    expect(shape(rowCells(tree)[0])).toEqual([
      "text:AWS",
      "br",
      "text:Java",
      "br",
      "text:C言語",
    ]);
  });

  it("accepts <br/> and <br /> spellings", () => {
    const tree = table([[cell(text("a<br/>b<br />c"))]]);
    rehypeMergedCells()(tree);
    expect(shape(rowCells(tree)[0])).toEqual([
      "text:a",
      "br",
      "text:b",
      "br",
      "text:c",
    ]);
  });

  it("renders <br> inside a merged anchor cell", () => {
    const tree = table([[cell(text("AWS<br>Java")), cell(text("←"))]]);
    rehypeMergedCells()(tree);
    const cells = rowCells(tree);
    expect(cells).toHaveLength(1); // ← absorbed into the anchor
    expect(cells[0].properties?.colSpan).toBe(2);
    expect(shape(cells[0])).toEqual(["text:AWS", "br", "text:Java"]);
  });

  it("leaves cells without <br> untouched", () => {
    const tree = table([[cell(text("plain"))]]);
    rehypeMergedCells()(tree);
    expect(shape(rowCells(tree)[0])).toEqual(["text:plain"]);
  });

  it("converts <br> arriving as hast raw nodes (the react-markdown path)", () => {
    const tree = table([
      [cell(text("AWS"), raw("<br>"), text("Java"), raw("<br>"), text("C言語"))],
    ]);
    rehypeMergedCells()(tree);
    expect(shape(rowCells(tree)[0])).toEqual([
      "text:AWS",
      "br",
      "text:Java",
      "br",
      "text:C言語",
    ]);
  });
});

describe("rehypeMergedCells — merge geometry", () => {
  it("collapses ← markers into colSpan", () => {
    const tree = table([[cell(text("資格")), cell(text("←")), cell(text("←"))]]);
    rehypeMergedCells()(tree);
    const cells = rowCells(tree);
    expect(cells).toHaveLength(1);
    expect(cells[0].properties?.colSpan).toBe(3);
  });

  it("collapses ↑ markers into rowSpan", () => {
    const tree = table([
      [cell(text("値"))],
      [cell(text("↑"))],
    ]);
    rehypeMergedCells()(tree);
    expect(rowCells(tree, 0)[0].properties?.rowSpan).toBe(2);
    expect(rowCells(tree, 1)).toHaveLength(0);
  });
});
