// History: past runs replayed from the journal — final cue of every node on
// a frozen canvas, each node's chat, the activity timeline, and where the run
// left off. Interrupted runs (the app died with the run open) surface their
// surviving pending gate: review the worktree's diff and ship it, even though
// the engine that parked it is long gone.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MarkerType, type Edge, type Node } from "@xyflow/react";
import type { StageSpec } from "../types";
import { buildNodes } from "../lib/graph";
import { AgentNode, GateNode, type AgentNodeData } from "../canvas/nodes";
import { replayRun, synthesizeOrphanGate, slugify, type ReplayState, type RunDetail } from "./replay";
import type { PendingGate } from "./useRun";
import { ReviewView } from "./ReviewView";

const nodeTypes = { agent: AgentNode, gate: GateNode };

interface RunMeta {
  id: string;
  stageName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
}

interface Loaded {
  stage: StageSpec;
  replay: ReplayState;
  gates: PendingGate[]; // still-completable gates (journaled or synthesized)
  worktrees: Array<{ node: string; path: string }>;
}

const STATUS_LABEL: Record<string, string> = { running: "interrupted", finished: "finished", stopped: "stopped" };

export function HistoryView({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [node, setNode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<PendingGate | null>(null);
  const [shipped, setShipped] = useState<string | null>(null);

  const loadRuns = useCallback(() => {
    invoke<RunMeta[]>("list_runs", { repoPath }).then(setRuns).catch((e) => setErr(String(e)));
  }, [repoPath]);

  useEffect(loadRuns, [loadRuns]);

  const loadRun = useCallback(
    async (runId: string) => {
      setData(null);
      setNode(null);
      setShipped(null);
      try {
        const detail = await invoke<RunDetail>("get_run", { repoPath, runId });
        const worktrees = await invoke<Array<{ node: string; path: string }>>("list_run_worktrees", { repoPath, runId }).catch(() => []);
        const replay = replayRun(detail);
        const alive = new Set(worktrees.map((w) => w.path));
        // Journaled pending gates are completable only if their worktree survives;
        // legacy runs (no gate events) get a synthesized gate from the spec.
        let gates = replay.gates
          .map((g) => (g.worktree && alive.has(g.worktree) ? g : worktrees.length > 0 ? { ...g, worktree: worktrees[0].path } : g))
          .filter((g) => g.worktree && alive.has(g.worktree!));
        if (gates.length === 0 && replay.status === "running") {
          const synth = synthesizeOrphanGate(detail.stage, replay, worktrees, detail.decisions);
          if (synth) gates = [synth];
        }
        setData({ stage: detail.stage, replay, gates, worktrees });
      } catch (e) {
        setErr(String(e));
      }
    },
    [repoPath]
  );

  useEffect(() => {
    if (sel) void loadRun(sel);
  }, [sel, loadRun]);

  const nodes: Node[] = useMemo(() => {
    if (!data) return [];
    return buildNodes(data.stage).map((n) => ({
      ...n,
      data: { ...(n.data as AgentNodeData), cue: data.replay.cues[n.id] ?? "idle", currently: data.replay.details[n.id] },
    }));
  }, [data]);

  const edges: Edge[] = useMemo(() => {
    if (!data) return [];
    return data.stage.edges.map((e, i) => {
      const ret = e.kind === "return";
      const color = ret ? "#4A4655" : "#6B6680";
      return {
        id: `h${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: ret ? "loop-out" : "out",
        targetHandle: ret ? "loop-in" : "in",
        type: "smoothstep",
        label: ret ? `↺ ${e.label ?? ""}` : e.label,
        style: { stroke: color, strokeWidth: ret ? 1.5 : 2.25, strokeDasharray: ret ? "5 5" : undefined },
        labelStyle: { fill: "#82808F", fontSize: 10 },
        labelBgStyle: { fill: "#111013" },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      } as Edge;
    });
  }, [data]);

  const selMeta = runs.find((r) => r.id === sel) ?? null;
  const feed = node && data ? data.replay.feeds[node] ?? [] : [];

  return (
    <div className="review">
      <div className="rvbar">
        <button className="tbtn" onClick={onClose}>← Back</button>
        <div className="tname">history <span>— past runs in {repoPath.split(/[\\/]/).pop()}</span></div>
        <div className="grow" />
      </div>
      <div className="histgrid">
        <div className="histlist">
          <div className="wtlabel">Runs <b>{runs.length}</b></div>
          {err && <div className="railhint">{err}</div>}
          {runs.length === 0 && !err && <div className="railhint">No past runs in this repo yet.</div>}
          {runs.map((r) => (
            <div key={r.id} className={`histrow ${sel === r.id ? "on" : ""}`} onClick={() => setSel(r.id)}>
              <div className="hr-top">
                <span className={`hr-status ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                <span className="hr-name">{r.stageName}</span>
              </div>
              <div className="hr-time">{new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            </div>
          ))}
        </div>

        <div className="histcanvas">
          {data ? (
            <>
              <ReactFlowProvider>
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_e, n) => setNode(n.id)} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}>
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1B1920" />
                </ReactFlow>
              </ReactFlowProvider>
              {(data.gates.length > 0 || shipped) && (
                <div className="dock">
                  <div className="dh">◈ {shipped ? "Recovered" : "Left off here"} {!shipped && <i>{data.gates.length}</i>}</div>
                  {shipped ? (
                    <div className="di"><b>✓</b> {shipped}</div>
                  ) : (
                    data.gates.map((g) => (
                      <div key={g.nodeId} className="di" onClick={() => setReview(g)}>
                        <b>{g.nodeId}</b>
                        {g.outward ? " · outward" : ""}
                        <span>review & complete →</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="chat-empty">{sel ? "Loading…" : "Select a run to replay it."}</div>
          )}
        </div>

        <div className="histside">
          {node ? (
            <>
              <div className="ihead">
                <div className="r1"><span className={`cue ${data?.replay.cues[node] ?? "idle"}`} /><span className="role">{node}</span></div>
                {data?.replay.details[node] && <div className="task">{data.replay.details[node]}</div>}
              </div>
              <div className="chat">
                {feed.length === 0 ? (
                  <div className="chat-empty">No recorded output for this node.</div>
                ) : (
                  feed.map((l, i) => {
                    if (l.kind === "tool") return <div key={i} className="chat-tool">{l.text}</div>;
                    if (l.kind === "ok") return <div key={i} className="chat-res ok">{l.text}</div>;
                    if (l.kind === "bad") return <div key={i} className="chat-res bad">{l.text}</div>;
                    const think = l.text.startsWith("…");
                    return <div key={i} className={think ? "chat-think" : "chat-msg"}>{think ? l.text.replace(/^…\s*/, "") : l.text}</div>;
                  })
                )}
              </div>
            </>
          ) : (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{selMeta ? selMeta.stageName : "Activity"}</span>
                  {selMeta && <span className={`hr-status ${selMeta.status}`}>{STATUS_LABEL[selMeta.status] ?? selMeta.status}</span>}
                </div>
                {selMeta && (
                  <div className="task">
                    started {new Date(selMeta.startedAt).toLocaleString()}
                    {selMeta.finishedAt ? ` · ended ${new Date(selMeta.finishedAt).toLocaleString()}` : " · never finished — the app closed mid-run"}
                  </div>
                )}
              </div>
              <div className="rscroll">
                <div className="timeline" style={{ padding: "8px 12px" }}>
                  {data && data.replay.activity.length === 0 && (
                    <div className="chat-empty">No timeline recorded for this run (it predates full-stream journaling). Node chats on the left still replay.</div>
                  )}
                  {data?.replay.activity.map((a, i) => (
                    <div key={i} className="tl" onClick={() => setNode(a.nodeId)}>
                      <span className={`cue ${a.cue}`} />
                      <span className="tl-node">{a.nodeId}</span>
                      <span className="tl-detail">{a.detail || a.cue}</span>
                      {a.at > 0 && <span className="tl-time">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
                    </div>
                  )) ?? <div className="chat-empty">Select a run.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {review && sel && data && (
        <ReviewView
          gate={review}
          workflowName={`${selMeta?.stageName ?? "run"} (recovered)`}
          orphan
          onDecide={async (approve, _memo, action) => {
            if (!approve) return; // Request changes is disabled in orphan mode
            if (review.outward && action) {
              const branch = `cuelight/${slugify(selMeta?.stageName ?? "recovered")}-${sel.slice(0, 8)}`;
              const msg = await invoke<string>("ship_orphan", {
                repoPath,
                worktree: review.worktree!,
                action,
                branch,
                message: `Cuelight: ${selMeta?.stageName ?? "run"} (recovered)`,
                runId: sel,
                nodeId: review.nodeId,
              });
              setShipped(msg);
            } else {
              // Non-outward gate: nothing to release — just journal the approval.
              await invoke<string>("ship_orphan", {
                repoPath,
                worktree: review.worktree!,
                action: "none",
                branch: "",
                message: "approved (recovered)",
                runId: sel,
                nodeId: review.nodeId,
              });
              setShipped("approved");
            }
            setData((d) => (d ? { ...d, gates: d.gates.filter((g) => g.nodeId !== review.nodeId) } : d));
            loadRuns();
          }}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}
