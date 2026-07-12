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
import { CheckCircle2, History as HistoryIcon, PauseCircle, Square } from "lucide-react";
import { replayRun, synthesizeOrphanGate, slugify, type ReplayState, type RunDetail } from "./replay";
import type { PendingGate } from "./useRun";
import { ReviewView } from "./ReviewView";
import { usePanes } from "../ui/panes";

const nodeTypes = { agent: AgentNode, gate: GateNode };

interface RunMeta {
  id: string;
  stageName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  nodes?: number;
  gates?: number;
}

function duration(meta: RunMeta): string | null {
  if (!meta.finishedAt) return null;
  const ms = Date.parse(meta.finishedAt) - Date.parse(meta.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function StatusPill({ status }: { status: string }) {
  const Ic = status === "finished" ? CheckCircle2 : status === "running" ? PauseCircle : Square;
  return (
    <span className={`hr-status ${status}`}>
      <Ic size={10} strokeWidth={2.25} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
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
  const panes = usePanes("cuelight-hist-panes", {
    list: { def: 260, min: 200, max: 420 },
    side: { def: 320, min: 260, max: 560, invert: true },
  });

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
        // Legacy runs journaled no node states — infer "completed" for nodes
        // whose sessions finished, so the canvas isn't a wall of idle.
        if (replay.activity.length === 0) {
          for (const id of Object.keys(replay.lastResult)) {
            if (!replay.details[id]) replay.details[id] = "completed";
          }
        }
        // Light the parked gate amber on the frozen canvas — the replay should
        // SHOW where the run left off, not just list it in the dock.
        for (const g of gates) {
          replay.cues[g.nodeId] = "standby";
          replay.details[g.nodeId] = "awaiting your review";
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
      // Marker color stays literal (it keys the SVG marker id; CSS retargets
      // it per theme); strokes/labels follow the theme via variables.
      const markerColor = ret ? "#8A7347" : "#7D879E";
      return {
        id: `h${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: ret ? "loop-out" : "out",
        targetHandle: ret ? "loop-in" : "in",
        type: "smoothstep",
        label: ret ? `↺ ${e.label ?? ""}` : e.label,
        style: { stroke: ret ? "var(--wire-ret)" : "var(--wire)", strokeWidth: ret ? 1.5 : 2.25, strokeDasharray: ret ? "5 5" : undefined },
        labelStyle: { fill: "var(--dim)", fontSize: 10 },
        labelBgStyle: { fill: "var(--win)" },
        markerEnd: { type: MarkerType.ArrowClosed, color: markerColor },
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
      <div className="histgrid" style={{ gridTemplateColumns: `${panes.sizes.list}px 5px minmax(0, 1fr) 5px ${panes.sizes.side}px` }}>
        <div className="histlist">
          <div className="wtlabel">Runs <b>{runs.length}</b></div>
          {err && <div className="railhint">{err}</div>}
          {runs.length === 0 && !err && <div className="railhint">No past runs in this repo yet.</div>}
          {runs.map((r) => {
            const dur = duration(r);
            return (
              <div key={r.id} className={`histrow ${sel === r.id ? "on" : ""}`} onClick={() => setSel(r.id)}>
                <div className="hr-top">
                  <StatusPill status={r.status} />
                  <span className="hr-when">{new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="hr-sub">
                  {r.stageName}
                  {r.nodes ? ` · ${r.nodes} nodes` : ""}
                  {dur ? ` · ${dur}` : r.status === "running" ? " · never finished" : ""}
                </div>
              </div>
            );
          })}
        </div>

        <div className="gutter" title="Drag to resize · double-click to reset" onPointerDown={panes.startDrag("list")} onDoubleClick={() => panes.reset("list")} />

        <div className="histcanvas">
          {data ? (
            <>
              <ReactFlowProvider>
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_e, n) => setNode(n.id)} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}>
                  <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#242A38" />
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

        <div className="gutter" title="Drag to resize · double-click to reset" onPointerDown={panes.startDrag("side")} onDoubleClick={() => panes.reset("side")} />

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
                  {selMeta && <StatusPill status={selMeta.status} />}
                </div>
                {selMeta && (
                  <div className="task">
                    started {new Date(selMeta.startedAt).toLocaleString()}
                    {selMeta.finishedAt ? ` · ended ${new Date(selMeta.finishedAt).toLocaleString()}` : " · never finished — the app closed mid-run"}
                  </div>
                )}
              </div>
              <div className="rscroll">
                {data && data.replay.activity.length === 0 ? (
                  <div className="legacyempty">
                    <HistoryIcon size={26} strokeWidth={1.5} className="le-ico" />
                    <div className="le-head">Legacy run archive</div>
                    <div className="le-sub">
                      This run predates full-stream journaling, so there's no node-by-node timeline. Each node's chat output still replays.
                    </div>
                    {(() => {
                      const first = data.stage.nodes.find((n) => (data.replay.feeds[n.id] ?? []).length > 0);
                      return first ? (
                        <button className="le-link" onClick={() => setNode(first.id)}>View node output →</button>
                      ) : null;
                    })()}
                  </div>
                ) : (
                  <div className="timeline" style={{ padding: "8px 12px" }}>
                    {data?.replay.activity.map((a, i) => (
                      <div key={i} className="tl" onClick={() => setNode(a.nodeId)}>
                        <span className={`cue ${a.cue}`} />
                        <span className="tl-node">{a.nodeId}</span>
                        <span className="tl-detail">{a.detail || a.cue}</span>
                        {a.at > 0 && <span className="tl-time">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
                      </div>
                    )) ?? <div className="chat-empty">Select a run.</div>}
                  </div>
                )}
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
