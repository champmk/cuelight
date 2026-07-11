// Read-only viewer for a past run: loads its frozen stage + journaled events,
// reconstructs the final cue of every node, the activity timeline, and each
// node's chat, and renders them on a non-interactive canvas.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MarkerType, type Edge, type Node } from "@xyflow/react";
import type { CueState, StageSpec } from "../types";
import { buildNodes } from "../lib/graph";
import { AgentNode, GateNode, type AgentNodeData } from "../canvas/nodes";

const nodeTypes = { agent: AgentNode, gate: GateNode };

interface RunMeta {
  id: string;
  stageName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
}

interface Reconstructed {
  stage: StageSpec;
  cues: Record<string, CueState>;
  feeds: Record<string, { kind: string; text: string }[]>;
  activity: { nodeId: string; cue: string; detail: string }[];
}

function reconstruct(stage: StageSpec, events: Record<string, unknown>[]): Reconstructed {
  const cues: Record<string, CueState> = {};
  const feeds: Record<string, { kind: string; text: string }[]> = {};
  const activity: { nodeId: string; cue: string; detail: string }[] = [];
  for (const e of events) {
    const type = e.type as string;
    const nodeId = e.node_id as string | undefined;
    if (type === "node_state" && nodeId) {
      cues[nodeId] = (e.cue as CueState) ?? "idle";
      const detail = (e.detail as string) ?? "";
      const cue = (e.cue as string) ?? "idle";
      if (["working", "standby", "failed"].includes(cue) || detail) activity.push({ nodeId, cue, detail });
    } else if (type === "session" && nodeId && e.event) {
      const ev = e.event as Record<string, unknown> & { kind: string };
      const line = sessionLine(ev);
      if (line) (feeds[nodeId] ??= []).push(line);
    }
  }
  return { stage, cues, feeds, activity };
}

function sessionLine(ev: Record<string, unknown> & { kind: string }): { kind: string; text: string } | null {
  switch (ev.kind) {
    case "text": {
      const t = String(ev.text ?? "").trim();
      return t ? { kind: "say", text: t } : null;
    }
    case "tool_call":
      return { kind: "tool", text: `${ev.tool} ${String(ev.target ?? "")}`.trim() };
    case "tool_result":
      return { kind: ev.ok === false ? "bad" : "ok", text: String(ev.summary ?? ev.tool ?? "") };
    case "done":
      return { kind: ev.ok ? "ok" : "bad", text: ev.ok ? "session complete" : "session failed" };
    case "failed":
      return { kind: "bad", text: String(ev.error ?? "failed") };
    default:
      return null;
  }
}

const CUE_COLOR: Record<CueState, string> = { idle: "#45424F", standby: "#E0A63C", working: "#4CC38A", blocked: "#E5534B", failed: "#E5534B" };

export function HistoryView({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<Reconstructed | null>(null);
  const [node, setNode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<RunMeta[]>("list_runs", { repoPath }).then(setRuns).catch((e) => setErr(String(e)));
  }, [repoPath]);

  useEffect(() => {
    if (!sel) return;
    setData(null);
    setNode(null);
    invoke<{ stage: StageSpec; events: Record<string, unknown>[] }>("get_run", { repoPath, runId: sel })
      .then((r) => setData(reconstruct(r.stage, r.events)))
      .catch((e) => setErr(String(e)));
  }, [sel, repoPath]);

  const nodes: Node[] = useMemo(() => {
    if (!data) return [];
    return buildNodes(data.stage).map((n) => ({
      ...n,
      data: { ...(n.data as AgentNodeData), cue: data.cues[n.id] ?? "idle" },
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

  const feed = node && data ? data.feeds[node] ?? [] : [];

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
                <span className={`hr-status ${r.status}`}>{r.status}</span>
                <span className="hr-name">{r.stageName}</span>
              </div>
              <div className="hr-time">{new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            </div>
          ))}
        </div>

        <div className="histcanvas">
          {data ? (
            <ReactFlowProvider>
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodeClick={(_e, n) => setNode(n.id)} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable proOptions={{ hideAttribution: true }}>
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1B1920" />
              </ReactFlow>
            </ReactFlowProvider>
          ) : (
            <div className="chat-empty">{sel ? "Loading…" : "Select a run to replay it."}</div>
          )}
        </div>

        <div className="histside">
          {node ? (
            <>
              <div className="ihead"><div className="r1"><span className={`cue ${data?.cues[node] ?? "idle"}`} /><span className="role">{node}</span></div></div>
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
              <div className="ihead"><div className="r1"><span className="role">Activity</span></div></div>
              <div className="rscroll">
                <div className="timeline" style={{ padding: "8px 12px" }}>
                  {data?.activity.map((a, i) => (
                    <div key={i} className="tl" onClick={() => setNode(a.nodeId)}>
                      <span className="cue" style={{ background: CUE_COLOR[(a.cue as CueState) ?? "idle"] }} />
                      <span className="tl-node">{a.nodeId}</span>
                      <span className="tl-detail">{a.detail || a.cue}</span>
                    </div>
                  )) ?? <div className="chat-empty">Select a run.</div>}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
