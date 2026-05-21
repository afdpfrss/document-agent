import { describe, it, expect } from "vitest";
import { parseArticles, locateClause } from "../lib/clause-locate";

const SEC3_BODY = `**第13条(機器貸与)**
1. 当社は、在宅勤務者に対し業務遂行に必要な機器を貸与する。
2. 貸与機器は、業務目的以外に使用してはならない。
3. 貸与機器の故障があった場合は、直ちにIT部に報告する。

**第14条(在宅勤務環境整備一時金)**
1. 在宅勤務を開始する者に対し、初回30,000円を一時金として支給する。`;

const SEC1_BODY = `**第1条(目的)**
本規程は、在宅勤務の実施に当たり必要な事項を定めることを目的とする。`;

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

  it("returns [] for prose with no 条 headers", () => {
    expect(parseArticles("これは普通の文章です。\n見出しも条もありません。")).toEqual([]);
  });
});

describe("locateClause", () => {
  const sections = [
    { id: "sec_3", title: "第3章 機器貸与と費用負担", body: SEC3_BODY },
  ];

  it("pinpoints the 項 that best matches the question", () => {
    const loc = locateClause("貸与機器を業務目的以外に使用できますか", sections);
    expect(loc?.section_id).toBe("sec_3");
    expect(loc?.article).toBe("第13条(機器貸与)");
    expect(loc?.paragraph).toBe(2);
    expect(loc?.snippet.length).toBeGreaterThan(0);
  });

  it("falls back to section granularity when nothing scores", () => {
    const loc = locateClause("XYZ", sections);
    expect(loc?.section_id).toBe("sec_3");
    expect(loc?.article).toBe("");
    expect(loc?.paragraph).toBeNull();
    expect(loc?.snippet).toBe("");
  });
});
