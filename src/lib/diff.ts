// Unified-diff parsing and projection. One parser, two views:
//  - toUnifiedRows: the classic single-column stream.
//  - toSplitRows: side-by-side with proper change-block pairing — a run of
//    deletions followed by a run of additions inside a hunk is ONE block,
//    paired row-by-row (del[i] ↔ add[i]); the longer side's remainder pairs
//    against filler cells. This is the GitHub/VS Code alignment model.
//
// Raw git noise (diff --git, index, ---/+++, mode lines) is stripped here —
// the review view's file header bar already names the file. Non-diff text
// (e.g. an error message) surfaces as `plain` lines instead of being
// mislabeled with line numbers.

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  old?: number;
  new?: number;
  text: string;
}

export interface DiffHunk {
  header: string; // the function/context hint after @@ … @@, may be ""
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  /** Lines that belong to no hunk — error strings, plain text. */
  plain: string[];
  /** Lines dropped past the cap (giant generated diffs). */
  truncated: number;
}

const DIFF_NOISE = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |copy |old mode|new mode|Binary files|\\ No newline)/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export const MAX_DIFF_LINES = 4000;

export function parseUnifiedDiff(diff: string, maxLines: number = MAX_DIFF_LINES): ParsedDiff {
  const all = diff.split("\n");
  if (all[all.length - 1] === "") all.pop(); // trailing newline, not a line
  const hunks: DiffHunk[] = [];
  const plain: string[] = [];
  let cur: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  let kept = 0;
  let truncated = 0;

  for (const l of all) {
    if (kept >= maxLines) {
      truncated++;
      continue;
    }
    if (DIFF_NOISE.test(l)) continue;
    const m = HUNK_HEAD.exec(l);
    if (m) {
      o = parseInt(m[1], 10);
      n = parseInt(m[2], 10);
      cur = { header: m[3].trim(), lines: [] };
      hunks.push(cur);
      kept++;
      continue;
    }
    if (!cur) {
      if (l !== "") {
        plain.push(l);
        kept++;
      }
      continue;
    }
    if (l.startsWith("+")) cur.lines.push({ kind: "add", new: n++, text: l.slice(1) });
    else if (l.startsWith("-")) cur.lines.push({ kind: "del", old: o++, text: l.slice(1) });
    else cur.lines.push({ kind: "ctx", old: o++, new: n++, text: l.startsWith(" ") ? l.slice(1) : l });
    kept++;
  }
  return { hunks, plain, truncated };
}

// ---- unified projection ----

export type UnifiedRow =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; old?: number; new?: number; text: string };

export function toUnifiedRows(p: ParsedDiff): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  for (const l of p.plain) out.push({ kind: "ctx", text: l }); // no line numbers — it's not diff content
  for (const h of p.hunks) {
    out.push({ kind: "hunk", text: h.header });
    out.push(...h.lines);
  }
  return out;
}

// ---- split (side-by-side) projection ----

export interface SplitSide {
  n?: number;
  text: string;
  changed: boolean;
}

export type SplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "pair"; left?: SplitSide; right?: SplitSide };

export function toSplitRows(p: ParsedDiff): SplitRow[] {
  const out: SplitRow[] = [];
  for (const l of p.plain) {
    out.push({ kind: "pair", left: { text: l, changed: false }, right: { text: l, changed: false } });
  }
  for (const h of p.hunks) {
    out.push({ kind: "hunk", text: h.header });
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      for (let i = 0; i < m; i++) {
        out.push({
          kind: "pair",
          left: dels[i] ? { n: dels[i].old, text: dels[i].text, changed: true } : undefined,
          right: adds[i] ? { n: adds[i].new, text: adds[i].text, changed: true } : undefined,
        });
      }
      dels = [];
      adds = [];
    };
    for (const l of h.lines) {
      if (l.kind === "del") {
        // A deletion after additions started means the previous change block
        // ended — flush it so blocks never smear together.
        if (adds.length > 0) flush();
        dels.push(l);
      } else if (l.kind === "add") {
        adds.push(l);
      } else {
        flush();
        out.push({
          kind: "pair",
          left: { n: l.old, text: l.text, changed: false },
          right: { n: l.new, text: l.text, changed: false },
        });
      }
    }
    flush();
  }
  return out;
}
