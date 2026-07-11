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
  const [action, setAction] = useState("branch");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [panes, setPanes] = useState(loadPanes);
  const dragRef = useRef<null | { which: "tree" | "rail"; startX: number; start: number }>(null);

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

  // Parse + classify diff lines once per diff, and cap the row count so a
  // giant generated-file diff can't stall the DOM.
  const diffLines = useMemo(() => {
    const all = diff.split("\n");
    const lines = all.slice(0, MAX_DIFF_LINES).map((l) => ({
      text: l,
      cls: l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "d" : l.startsWith("@@") ? "h" : "",
    }));
    return { lines, truncated: all.length - Math.min(all.length, MAX_DIFF_LINES) };
  }, [diff]);

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
        {gate.outward && <span className="outchip">OUTWARD — approving releases an external action</span>}
        {orphan && <span className="outchip orphan">RECOVERED — this run's engine is gone; the work below survives and can still ship</span>}
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
            {diffLines.lines.map((l, i) => (
              <div key={i} className={`cl ${l.cls}`}>
                <span className="tx">{l.text || " "}</span>
              </div>
            ))}
            {diffLines.truncated > 0 && (
              <div className="cl trunc"><span className="tx">… {diffLines.truncated} more lines not shown (large diff)</span></div>
            )}
          </div>
        </div>

        <div className="gutter" title="Drag to resize · double-click to reset" onPointerDown={startDrag("rail")} onDoubleClick={() => resetPane("rail")} />

        <div className="rrail">
          <div className="rscroll">
            <div className="rsec">
              <div className="rh">Agent's case</div>
              <Markdown text={gate.caseText || "(the upstream agent returned no summary)"} />
            </div>
            {gate.checklist.length > 0 && (
              <div className="rsec">
                <div className="rh">Gate checklist</div>
                {gate.checklist.map((c, i) => (
                  <div key={i} className="chk">
                    <i>◻</i> {c}
                  </div>
                ))}
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
            {gate.outward && (
              <div className="rsec">
                <div className="rh">On approve — what happens to the work</div>
                <div className="shipopts">
                  {SHIP_ACTIONS.map((a) => (
                    <label key={a.value} className={`shipopt ${action === a.value ? "on" : ""}`}>
                      <input type="radio" name="ship" checked={action === a.value} onChange={() => setAction(a.value)} />
                      <span className="so-label">{a.label}</span>
                      <span className="so-hint">{a.hint}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {err && <div className="mwarn" style={{ padding: "0 14px" }}>{err}</div>}
          </div>
          <div className="ractions">
            <button className="rv-approve" disabled={busy} onClick={() => decide(true)}>
              {busy ? "…" : gate.outward ? `Approve — ${SHIP_ACTIONS.find((a) => a.value === action)?.label ?? "release"}` : "Approve & continue"}
            </button>
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
