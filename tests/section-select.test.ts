import { describe, it, expect } from "vitest";
import { sectionScore } from "../lib/section-select";

describe("sectionScore", () => {
  it("returns 0 when the query and section share no bigrams", () => {
    expect(sectionScore("休暇", "経費精算の申請手順")).toBe(0);
  });

  it("scores a topically overlapping section above an unrelated one", () => {
    const relevant = sectionScore(
      "有給休暇の付与日数",
      "年次有給休暇は勤続年数に応じて付与日数が決まる",
    );
    const unrelated = sectionScore("有給休暇の付与日数", "オフィスの施錠と防犯");
    expect(relevant).toBeGreaterThan(unrelated);
    expect(relevant).toBeGreaterThan(0);
  });

  it("returns 0 for an empty or single-character query", () => {
    expect(sectionScore("", "なんらかの本文")).toBe(0);
    expect(sectionScore("あ", "なんらかの本文")).toBe(0);
  });

  it("never exceeds 1", () => {
    expect(sectionScore("休暇", "休暇休暇休暇")).toBeLessThanOrEqual(1);
  });
});
