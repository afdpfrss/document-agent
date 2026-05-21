import { describe, it, expect } from "vitest";
import {
  parseArticles,
  splitParagraphs,
  uniquePrefix,
} from "../lib/clause-locate";

const SEC3_BODY = `**第13条(機器貸与)**
1. 当社は、在宅勤務者に対し業務遂行に必要な機器を貸与する。
2. 貸与機器は、業務目的以外に使用してはならない。
3. 貸与機器の故障があった場合は、直ちにIT部に報告する。

**第14条(在宅勤務環境整備一時金)**
1. 在宅勤務を開始する者に対し、初回30,000円を一時金として支給する。`;

const SEC1_BODY = `**第1条(目的)**
本規程は、在宅勤務の実施に当たり必要な事項を定めることを目的とする。`;

const PROSE_BODY = `これは規程ではない文書の本文です。条も項もありません。

二つ目の段落です。手順や説明が続きます。`;

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
    expect(parseArticles(PROSE_BODY)).toEqual([]);
  });
});

describe("splitParagraphs", () => {
  it("splits prose into blank-line separated blocks", () => {
    const blocks = splitParagraphs(PROSE_BODY);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("規程ではない文書");
    expect(blocks[1]).toContain("二つ目の段落");
  });
});

describe("uniquePrefix", () => {
  it("returns the whole text when it is short", () => {
    expect(uniquePrefix("みじかい文", "前後 みじかい文 など")).toBe("みじかい文");
  });

  it("returns a prefix that occurs exactly once in the document", () => {
    const passage =
      "これは引用される具体的な一文であり、ユニークな内容を十分な長さで含んでいます。";
    const full = `無関係な前段の文章。${passage} 別の無関係な後段の文章。`;
    const snip = uniquePrefix(passage, full);
    expect(passage.startsWith(snip)).toBe(true);
    expect(full.split(snip).length - 1).toBe(1);
  });
});
