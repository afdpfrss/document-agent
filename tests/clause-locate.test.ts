import { describe, it, expect } from "vitest";
import { parseArticles, splitBlocks, locateCitation } from "../lib/clause-locate";
import { canonical, textHash } from "../lib/text-score";

const SEC3_BODY = `**第13条(機器貸与)**
1. 当社は、在宅勤務者に対し業務遂行に必要な機器を貸与する。
2. 貸与機器は、業務目的以外に使用してはならない。
3. 貸与機器の故障があった場合は、直ちにIT部に報告する。

**第14条(在宅勤務環境整備一時金)**
1. 在宅勤務を開始する者に対し、初回30,000円を一時金として支給する。`;

const SEC1_BODY = `**第1条(目的)**
本規程は、在宅勤務の実施に当たり必要な事項を定めることを目的とする。`;

const TABLE_BODY = `**第13条(機器貸与)**
1. 当社は機器を貸与する。

| 機器 | 基準 |
|---|---|
| ノートPC | 全員 |

2. 貸与機器は私用禁止。`;

const PROSE_BODY = `これは規程ではない文書の本文です。条も項もありません。

二つ目の段落です。手順や説明が続きます。`;

const LIST_BODY = `手順は次のとおり実施する。

- 一つ目の作業を行うこと
- 二つ目の作業を行うこと`;

describe("parseArticles", () => {
  it("splits a section body into 条 and numbered 項", () => {
    const arts = parseArticles(SEC3_BODY);
    expect(arts.map((a) => a.label)).toEqual([
      "第13条(機器貸与)",
      "第14条(在宅勤務環境整備一時金)",
    ]);
    expect(arts[0].paragraphs.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("treats a 条 with no numbered 項 as a single null-項 unit", () => {
    const arts = parseArticles(SEC1_BODY);
    expect(arts).toHaveLength(1);
    expect(arts[0].paragraphs).toHaveLength(1);
    expect(arts[0].paragraphs[0].number).toBeNull();
  });

  it("does not absorb a following table into a 項's text", () => {
    const arts = parseArticles(TABLE_BODY);
    expect(arts[0].paragraphs.map((p) => p.number)).toEqual([1, 2]);
    expect(arts[0].paragraphs[0].text).toBe("当社は機器を貸与する。");
  });

  it("returns [] for prose with no 条 headers", () => {
    expect(parseArticles(PROSE_BODY)).toEqual([]);
  });
});

describe("splitBlocks", () => {
  it("splits prose into blank-line separated blocks", () => {
    expect(splitBlocks(PROSE_BODY)).toHaveLength(2);
  });

  it("explodes a list into one block per item", () => {
    const blocks = splitBlocks(LIST_BODY);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe("一つ目の作業を行うこと");
  });
});

describe("canonical / textHash", () => {
  it("canonical reduces markdown and punctuation to letters and numbers", () => {
    expect(canonical("**当社は、機器を貸与する。**")).toBe(
      canonical("当社は機器を貸与する"),
    );
  });

  it("textHash is deterministic 8-char hex and distinguishes inputs", () => {
    expect(textHash("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).not.toBe(textHash("abd"));
  });
});

describe("locateCitation", () => {
  const sections = [{ title: "第3章 機器貸与と費用負担", body: SEC3_BODY }];

  it("pinpoints the 項 that best matches the question", () => {
    const loc = locateCitation("貸与機器を業務目的以外に使用できますか", sections);
    expect(loc?.article).toBe("第13条(機器貸与)");
    expect(loc?.paragraph).toBe(2);
    expect(loc?.token).toMatch(/^[0-9a-f]{8}$/);
    expect(loc?.quote.length).toBeGreaterThan(0);
  });

  it("falls back to section granularity when nothing scores", () => {
    const loc = locateCitation("XYZ", sections);
    expect(loc?.article).toBe("");
    expect(loc?.paragraph).toBeNull();
    expect(loc?.token).toBe("");
  });
});
