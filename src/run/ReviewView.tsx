// The Review view — screen 2 of the design spec, live. You arrive from a
// pending gate: the agent's case on the right, the file tree as evidence on
// the left, real diffs from the worktree in the middle. Replying in the memo
// becomes a steering instruction; Approve releases the gate.
//
// The three panes are IDE-style resizable: drag the gutters to rebalance,
// double-click a gutter to reset. Widths persist across sessions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PendingGate } from "./useRun";

interface ChangedFile {
  path: string;
  adds: number;
  dels: number;
}

// Very large diffs (lockfiles, generated code) would otherwise render tens of
// thousands of DOM rows and stall the view.
const MAX_DIFF_LINES = 4000;

// Parsed diff row: raw git headers are stripped (the file header bar already
// names the file); hunks become dividers; every code row carries old→new
// line numbers for the gutter.
interface DiffRow {
  kind: "hunk" | "ctx" | "add" | "del";
  old?: number;
  new?: number;
  text: string;
}

const DIFF_NOISE = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |copy |old mode|new mode|Binary files|\\ No newline)/;

function parseDiff(diff: string): { rows: DiffRow[]; truncated: number } {
  const all = diff.split("\n");
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  let consumed = 0;
  for (const l of all) {
    consumed++;
    if (rows.length >= MAX_DIFF_LINES) {
      consumed--;
      break;
    }
    if (DIFF_NOISE.test(l)) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) {
      o = parseInt(m[1], 10);
      n = parseInt(m[2], 10);
      rows.push({ kind: "hunk", text: m[3].trim() });
      continue;
    }
    if (l.startsWith("+")) rows.push({ kind: "add", new: n++, text: l.slice(1) });
    else if (l.startsWith("-")) rows.push({ kind: "del", old: o++, text: l.slice(1) });
    else rows.push({ kind: "ctx", old: o++, new: n++, text: l.startsWith(" ") ? l.slice(1) : l });
  }
  return { rows, truncated: all.length - consumed };
}

// Minimal, safe markdown for the agent's case. Fenced ``` blocks render as
// isolated code panels; prose keeps paragraphs, **bold**, and inline `code`.
// No HTML injection — everything is plain text nodes.
function Markdown({ text }: { text: string }) {
  const segments = useMemo(() => {
    const out: Array<{ kind: "prose" | "code"; text: string; lang?: string }> = [];
    const fence = /```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = fence.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: "prose", text: text.slice(last, m.index) });
      out.push({ kind: "code", text: m[2].replace(/\s+$/, ""), lang: m[1] || undefined });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: "prose", text: text.slice(last) });
    return out;
  }, [text]);

  const inline = (s: string, key: number) => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
      return <span key={`${key}-${i}`}>{p}</span>;
    });
  };

  return (
    <div className="md">
      {segments.map((seg, s) => {
        if (seg.kind === "code") {
          return (
            <div key={s} className="md-codeblock">
              {seg.lang && <div className="md-codelang">{seg.lang}</div>}
              <pre>{seg.text}</pre>
            </div>
          );
        }
        const paras = seg.text.split(/\n{2,}/).filter((p) => p.trim() !== "");
        return paras.map((p, i) => (
          <p key={`${s}-${i}`}>{p.split("\n").flatMap((line, j) => [...(j > 0 ? [<br key={`br${i}-${j}`} />] : []), ...inline(line, i)])}</p>
        ));
      })}
    </div>
  );
}

interface Props {
  gate: PendingGate;
  workflowName: string;
  /** The run's engine is gone (app restarted mid-run). Approving ships the
   * surviving worktree directly; requesting changes needs a live agent and
   * is disabled. */
  orphan?: boolean;
  onDecide: (approve: boolean, memo?: string, action?: string, branch?: string) => Promise<void>;
  onClose: () => void;
}

const SHIP_ACTIONS: { value: string; label: string; hint: string }[] = [
  { value: "branch", label: "Commit to a new branch", hint: "local branch only — you push/PR it yourself" },
  { value: "push", label: "Commit + push branch", hint: "pushes the branch to origin; no PR" },
  { value: "pr", label: "Commit + push + open PR", hint: "pushes and opens a PR via gh (needs a remote)" },
  { value: "merge", label: "Merge into current branch", hint: "applies onto your checked-out branch, local only" },
];

const PANE_DEFAULTS = { tree: 240, rail: 330 };
const PANE_MIN = { tree: 160, rail: 260 };
const PANE_MAX = { tree: 460, rail: 600 };

function loadPanes(): { tree: number; rail: number } {
  try {
    const p = JSON.parse(localStorage.getItem("cuelight-review-panes") ?? "{}");
    return {
      tree: Math.min(PANE_MAX.tree, Math.max(PANE_MIN.tree, Number(p.tree) || PANE_DEFAULTS.tree)),
      rail: Math.min(PANE_MAX.rail, Math.max(PANE_MIN.rail, Number(p.rail) || PANE_DEFAULTS.rail)),
    };
  } catch {
    return { ...PANE_DEFAULTS };
  }
}

export function ReviewView({ gate, workflowName, orphan, onDecide, onClose }: Props) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [memo, setMemo] = useState("");
  const [action, setAction] = useState(() => {
    const saved = localStorage.getItem("cuelight-ship-action");
    return saved && SHIP_ACTIONS.some((a) => a.value === saved) ? saved : "branch";
  });
  const [shipMenu, setShipMenu] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [panes, setPanes] = useState(loadPanes);
  const dragRef = useRef<null | { which: "tree" | "rail"; startX: number; start: number }>(null);

  // A structured verdict (reviewer JSON) renders as a clean card, not raw text.
  const verdict = useMemo(() => {
    const t = gate.caseText.trim();
    if (!t.startsWith("{")) return null;
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [gate.caseText]);

  useEffect(() => {
    if (!gate.worktree) return;
    invoke<ChangedFile[]>("git_changed_files", { worktree: gate.worktree })
      .then((f) => {
        setFiles(f);
        if (f.length > 0) setActive(f[0].path);
      })
      .catch((e) => setErr(String(e)));
  }, [gate.worktree]);

  useEffect(() => {
    if (!gate.worktree || !active) return;
    invoke<string>("git_file_diff", { worktree: gate.worktree, path: active })
      .then(setDiff)
      .catch((e) => setDiff(`(diff unavailable: ${e})`));
  }, [gate.worktree, active]);

  // Parse + classify once per diff (capped so a giant generated-file diff
  // can't stall the DOM).
  const parsed = useMemo(() => parseDiff(diff), [diff]);

  const startDrag = useCallback((which: "tree" | "rail") => (ev: React.PointerEvent) => {
    ev.preventDefault();
    dragRef.current = { which, startX: ev.clientX, start: which === "tree" ? panes.tree : panes.rail };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = d.which === "tree" ? e.clientX - d.startX : d.startX - e.clientX;
      const next = Math.min(PANE_MAX[d.which], Math.max(PANE_MIN[d.which], d.start + delta));
      setPanes((p) => (p[d.which] === next ? p : { ...p, [d.which]: next }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setPanes((p) => {
        localStorage.setItem("cuelight-review-panes", JSON.stringify(p));
        return p;
      });
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("col-resizing");
  }, [panes.tree, panes.rail]);

  const resetPane = useCallback((which: "tree" | "rail") => {
    setPanes((p) => {
      const next = { ...p, [which]: PANE_DEFAULTS[which] };
      localStorage.setItem("cuelight-review-panes", JSON.stringify(next));
      return next;
    });
  }, []);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await onDecide(approve, memo.trim() || undefined, approve && gate.outward ? action : undefined);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="review">
      <div className="rvbar">
        <button className="tbtn" onClick={onClose}>← Canvas</button>
        <div className="tname">
          review <span>— {gate.nodeId} · {workflowName}</span>
        </div>
        {gate.outward && (
          <span className="rvbadge outward" title="Approving this gate releases an external action (commit, push, PR, or merge)">
            <i /> outward release
          </span>
        )}
        {orphan && (
          <span className="rvbadge recovered" title="This run's engine is gone (the app closed mid-run). The work survives in its worktree and can still ship; iterating needs a fresh run.">
            <i /> engine recovered
          </span>
        )}
        <div className="grow" />
      </div>

      <div className="rvgrid" style={{ gridTemplateColumns: `${panes.tree}px 5px minmax(0, 1fr) 5px ${panes.rail}px` }}>
        <div className="tree">
          <div className="wtlabel">
            Worktree
            <b>{files.length} changed</b>
          </div>
          {files.length === 0 && <div className="railhint">no file changes in this worktree</div>}
          {files.map((f) => (
            <div key={f.path} className={`titem chg ${active === f.path ? "on" : ""}`} onClick={() => setActive(f.path)}>
              <span className="fname">{f.path.split("/").pop()}</span>
              <span className="stat">
                <span className="a">+{f.adds}</span>
                <span className="m">−{f.dels}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="gutter" title="Drag to resize · double-click to reset" onPointerDown={startDrag("tree")} onDoubleClick={() => resetPane("tree")} />

        <div className="diffpane">
          <div className="fhead">
            <span className="path">{active ?? "no file selected"}</span>
            <div className="grow" />
          </div>
          <div className="code">
            {parsed.rows.map((r, i) =>
              r.kind === "hunk" ? (
                <div key={i} className="cl hunk">
                  <span className="ln" />
                  <span className="ln" />
                  <span className="tx">⋯{r.text ? `  ${r.text}` : ""}</span>
                </div>
              ) : (
                <div key={i} className={`cl ${r.kind}`}>
                  <span className="ln">{r.old ?? ""}</span>
                  <span className="ln">{r.new ?? ""}</span>
                  <span className="tx">{r.text || " "}</span>
                </div>
              )
            )}
            {parsed.truncated > 0 && (
              <div className="cl trunc"><span className="ln" /><span className="ln" /><span className="tx">… {parsed.truncated} more lines not shown (large diff)</span></div>
            )}
          </div>
        </div>

        <div className="gutter" title="Drag to resize · double-click to reset" onPointerDown={startDrag("rail")} onDoubleClick={() => resetPane("rail")} />

        <div className="rrail">
          <div className="rscroll">
            <div className="rsec">
              <div className="rh">{verdict ? "Execution verdict" : "Agent's case"}</div>
              {verdict ? (
                <div className="verdict">
                  {Object.entries(verdict).map(([k, v]) => {
                    const isVerdict = k.toLowerCase() === "verdict";
                    const text = Array.isArray(v)
                      ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" · ")
                      : typeof v === "object" && v !== null
                        ? JSON.stringify(v)
                        : String(v);
                    return (
                      <div key={k} className="vrow">
                        <span className="vk">{k}</span>
                        <span className={`vv ${isVerdict ? (text.toLowerCase() === "pass" ? "pass" : "reject") : ""}`}>
                          {text.length > 400 ? text.slice(0, 400) + "…" : text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Markdown text={gate.caseText || "(the upstream agent returned no summary)"} />
              )}
            </div>
            {gate.checklist.length > 0 && (
              <div className="rsec">
                <div className="rh">Gate checklist — tick as you verify</div>
                <div className="chkbox">
                  {gate.checklist.map((c, i) => {
                    const on = checked.has(i);
                    return (
                      <div
                        key={i}
                        className={`chk ${on ? "on" : ""}`}
                        onClick={() => setChecked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                      >
                        <i>{on ? "✓" : ""}</i> {c}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {!orphan && (
              <div className="rsec">
                <div className="rh">Steering memo</div>
                <textarea
                  className="memo"
                  rows={3}
                  placeholder="Optional: tell the agent what to change. Sent with Request changes; re-runs it in the same worktree."
                  value={memo}
                  onChange={(ev) => setMemo(ev.target.value)}
                />
              </div>
            )}
            {err && <div className="mwarn" style={{ padding: "0 14px" }}>{err}</div>}
          </div>
          <div className="ractions">
            {/* Split button: approve executes the selected ship action; the
                chevron picks a different one (remembered across reviews). */}
            <div className="splitbtn">
              <button className="rv-approve" disabled={busy} onClick={() => decide(true)}>
                {busy ? "…" : gate.outward ? `Approve — ${SHIP_ACTIONS.find((a) => a.value === action)?.label ?? "release"}` : "Approve & continue"}
              </button>
              {gate.outward && (
                <button className="rv-chev" disabled={busy} title="Choose what approving does with the work" onClick={() => setShipMenu((o) => !o)}>
                  ▾
                </button>
              )}
              {shipMenu && (
                <div className="shipmenu" onClick={(ev) => ev.stopPropagation()}>
                  {SHIP_ACTIONS.map((a) => (
                    <div
                      key={a.value}
                      className={`smi ${action === a.value ? "sel" : ""}`}
                      onClick={() => {
                        setAction(a.value);
                        localStorage.setItem("cuelight-ship-action", a.value);
                        setShipMenu(false);
                      }}
                    >
                      <span className="smi-check">{action === a.value ? "✓" : ""}</span>
                      <span className="smi-label">{a.label}</span>
                      <span className="smi-hint">{a.hint}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              className="rv-changes"
              disabled={busy || orphan || memo.trim() === ""}
              title={orphan ? "Needs a live agent — this run's engine is gone. Start a new run to iterate." : undefined}
              onClick={() => decide(false)}
            >
              {orphan ? "Request changes — needs a live run" : memo.trim() ? "Request changes" : "Request changes — add a memo"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
