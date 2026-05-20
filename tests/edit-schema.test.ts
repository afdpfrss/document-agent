import { describe, it, expect } from "vitest";
import { applyEdits } from "@/lib/edit-schema";

describe("applyEdits", () => {
  it("applies a single edit", () => {
    const r = applyEdits("hello world", [
      { find: "world", replace: "there", reason: "x" },
    ]);
    expect(r.content).toBe("hello there");
    expect(r.statuses).toEqual([{ kind: "ok", index: 0 }]);
  });

  it("applies edits sequentially — a later edit can target earlier output", () => {
    const r = applyEdits("a", [
      { find: "a", replace: "b", reason: "" },
      { find: "b", replace: "c", reason: "" },
    ]);
    expect(r.content).toBe("c");
    expect(r.statuses.every((s) => s.kind === "ok")).toBe(true);
  });

  it("reports not_found when the text is absent", () => {
    const r = applyEdits("abc", [{ find: "xyz", replace: "q", reason: "" }]);
    expect(r.content).toBe("abc");
    expect(r.statuses[0]).toEqual({ kind: "not_found", index: 0, find: "xyz" });
  });

  it("reports ambiguous when the text matches more than once", () => {
    const r = applyEdits("a a a", [{ find: "a", replace: "b", reason: "" }]);
    expect(r.content).toBe("a a a");
    expect(r.statuses[0]).toEqual({
      kind: "ambiguous",
      index: 0,
      find: "a",
      matches: 3,
    });
  });

  it("rejects an empty find string as not_found", () => {
    const r = applyEdits("abc", [{ find: "", replace: "x", reason: "" }]);
    expect(r.statuses[0].kind).toBe("not_found");
    expect(r.content).toBe("abc");
  });

  it("supports deletion via an empty replace", () => {
    const r = applyEdits("hello world", [
      { find: " world", replace: "", reason: "" },
    ]);
    expect(r.content).toBe("hello");
  });

  it("inserts replace text literally — $& / $1 are not backreferences", () => {
    const r = applyEdits("price: X", [
      { find: "X", replace: "$& $1 $$", reason: "" },
    ]);
    expect(r.content).toBe("price: $& $1 $$");
  });

  it("matches find text literally — regex metacharacters are not interpreted", () => {
    const literal = applyEdits("a.b.c", [
      { find: "a.b", replace: "Z", reason: "" },
    ]);
    expect(literal.content).toBe("Z.c");
    // If "a.b" were treated as a regex it would also match "axb".
    const regexWould = applyEdits("axb", [
      { find: "a.b", replace: "Z", reason: "" },
    ]);
    expect(regexWould.statuses[0].kind).toBe("not_found");
  });

  it("a failed edit does not block later edits", () => {
    const r = applyEdits("keep this", [
      { find: "missing", replace: "x", reason: "" },
      { find: "this", replace: "that", reason: "" },
    ]);
    expect(r.content).toBe("keep that");
    expect(r.statuses[0].kind).toBe("not_found");
    expect(r.statuses[1].kind).toBe("ok");
  });
});
