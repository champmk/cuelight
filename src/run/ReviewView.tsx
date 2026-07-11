// The Review view — screen 2 of the design spec, live. You arrive from a
// pending gate: the agent's case on the right, the file tree as evidence on
// the left, real diffs from the worktree in the middle. Replying in the memo
// becomes a steering instruction; Approve releases the gate.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PendingGate } from "./useRun";

interface ChangedFile {
  path: string;
  adds: number;
  dels: number;
}

// Minimal, safe markdown for the agent's case: paragraphs, **bold**, `code`.
// No HTML injection — everything is plain text nodes.
function Markdown({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim() !== "");
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
      {paras.map((p, i) => (
        <p key={i}>{p.split("\n").flatMap((line, j) => [...(j > 0 ? [<br key={`br${i}-${j}`} />] : []), ...inline(line, i)])}</p>
      ))}
    </div>
  );
}

interface Props {
  gate: PendingGate;
  workflowName: string;
  onDecide: (approve: boolean, memo?: string) => Promise<void>;
  onClose: () => void;
}

export function ReviewView({ gate, workflowName, onDecide, onClose }: Props) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await onDecide(approve, memo.trim() || undefined);
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
        <div className="grow" />
      </div>

      <div className="rvgrid">
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

        <div className="diffpane">
          <div className="fhead">
            <span className="path">{active ?? "no file selected"}</span>
            <div className="grow" />
          </div>
          <div className="code">
            {diff.split("\n").map((l, i) => {
              const cls = l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "d" : l.startsWith("@@") ? "h" : "";
              return (
                <div key={i} className={`cl ${cls}`}>
                  <span className="tx">{l || " "}</span>
                </div>
              );
            })}
          </div>
        </div>

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
            {err && <div className="mwarn" style={{ padding: "0 14px" }}>{err}</div>}
          </div>
          <div className="ractions">
            <button className="rv-approve" disabled={busy} onClick={() => decide(true)}>
              {busy ? "…" : `Approve${gate.outward ? " & release" : " & continue"}`}
            </button>
            <button className="rv-changes" disabled={busy || memo.trim() === ""} onClick={() => decide(false)}>
              {memo.trim() ? "Request changes" : "Request changes — add a memo"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
