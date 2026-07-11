import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, toSplitRows, toUnifiedRows, type SplitRow } from "./diff";

const D = (...lines: string[]) => lines.join("\n") + "\n";

const pairs = (rows: SplitRow[]) => rows.filter((r): r is Extract<SplitRow, { kind: "pair" }> => r.kind === "pair");

describe("parseUnifiedDiff", () => {
  it("strips git noise and keeps hunk content with correct line numbers", () => {
    const p = parseUnifiedDiff(
      D(
        "diff --git a/f.txt b/f.txt",
        "index 0dc8cd4..9f2a11b 100644",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -10,3 +10,4 @@ fn main",
        " keep",
        "-old",
        "+new",
        "+added",
        " tail"
      )
    );
    expect(p.plain).toEqual([]);
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0].header).toBe("fn main");
    expect(p.hunks[0].lines).toEqual([
      { kind: "ctx", old: 10, new: 10, text: "keep" },
      { kind: "del", old: 11, text: "old" },
      { kind: "add", new: 11, text: "new" },
      { kind: "add", new: 12, text: "added" },
      { kind: "ctx", old: 12, new: 13, text: "tail" },
    ]);
  });

  it("treats non-diff text as plain lines, never numbered", () => {
    const p = parseUnifiedDiff("(diff unavailable: worktree is gone)\n");
    expect(p.hunks).toHaveLength(0);
    expect(p.plain).toEqual(["(diff unavailable: worktree is gone)"]);
    const uni = toUnifiedRows(p);
    expect(uni).toEqual([{ kind: "ctx", text: "(diff unavailable: worktree is gone)" }]);
  });

  it("counts truncated lines past the cap", () => {
    const body = Array.from({ length: 10 }, (_, i) => ` line${i}`);
    const p = parseUnifiedDiff(D("@@ -1,10 +1,10 @@", ...body), 5);
    expect(p.truncated).toBe(6); // 11 content lines, 5 kept
  });
});

describe("toSplitRows change-block pairing", () => {
  it("pairs a del-run with an add-run row-by-row, filling the shorter side", () => {
    const p = parseUnifiedDiff(D("@@ -1,3 +1,2 @@", "-a", "-b", "-c", "+x", "+y"));
    const rows = pairs(toSplitRows(p));
    expect(rows).toEqual([
      { kind: "pair", left: { n: 1, text: "a", changed: true }, right: { n: 1, text: "x", changed: true } },
      { kind: "pair", left: { n: 2, text: "b", changed: true }, right: { n: 2, text: "y", changed: true } },
      { kind: "pair", left: { n: 3, text: "c", changed: true }, right: undefined },
    ]);
  });

  it("keeps separate change blocks separate (del after add starts a new block)", () => {
    const p = parseUnifiedDiff(D("@@ -1,2 +1,2 @@", "-a", "+x", "-b", "+y"));
    const rows = pairs(toSplitRows(p));
    expect(rows).toEqual([
      { kind: "pair", left: { n: 1, text: "a", changed: true }, right: { n: 1, text: "x", changed: true } },
      { kind: "pair", left: { n: 2, text: "b", changed: true }, right: { n: 2, text: "y", changed: true } },
    ]);
  });

  it("renders pure additions (new file) with left fillers", () => {
    const p = parseUnifiedDiff(D("@@ -0,0 +1,2 @@", "+one", "+two"));
    const rows = pairs(toSplitRows(p));
    expect(rows).toEqual([
      { kind: "pair", left: undefined, right: { n: 1, text: "one", changed: true } },
      { kind: "pair", left: undefined, right: { n: 2, text: "two", changed: true } },
    ]);
  });

  it("mirrors context on both sides with independent numbering", () => {
    const p = parseUnifiedDiff(D("@@ -5,2 +9,2 @@", " same", " lines"));
    const rows = pairs(toSplitRows(p));
    expect(rows).toEqual([
      { kind: "pair", left: { n: 5, text: "same", changed: false }, right: { n: 9, text: "same", changed: false } },
      { kind: "pair", left: { n: 6, text: "lines", changed: false }, right: { n: 10, text: "lines", changed: false } },
    ]);
  });

  it("flushes a trailing change block at hunk end", () => {
    const p = parseUnifiedDiff(D("@@ -1,2 +1,1 @@", " keep", "-gone"));
    const rows = pairs(toSplitRows(p));
    expect(rows[1]).toEqual({ kind: "pair", left: { n: 2, text: "gone", changed: true }, right: undefined });
  });
});
