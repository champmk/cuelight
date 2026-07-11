// The canvas: renders a StageSpec as a live graph. Solid directional wires
// for flow, dashed labeled loops for return edges; green wire = data flowing.

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { CueState, StageSpec } from "../types";
import { layoutStage } from "../lib/layout";
import { AgentNode, GateNode, type AgentNodeData } from "./nodes";

const nodeTypes = { agent: AgentNode, gate: GateNode };

const CUE_COLOR: Record<CueState, string> = {
  idle: "#45424F",
  standby: "#E0A63C",
  working: "#4CC38A",
  blocked: "#E5534B",
  failed: "#E5534B",
};

interface Props {
  stage: StageSpec;
  cues: Record<string, CueState>;
  currently: Record<string, string | undefined>;
  onSelect: (nodeId: string | null) => void;
}

export function StageCanvas({ stage, cues, currently, onSelect }: Props) {
  const nodes: Node[] = useMemo(() => {
    const pos = layoutStage(stage);
    return stage.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: pos.get(n.id)?.x ?? 0, y: pos.get(n.id)?.y ?? 0 },
      data: {
        spec: n,
        cue: cues[n.id] ?? "idle",
        currently: currently[n.id],
        telemetry: n.trigger ?? undefined,
      } satisfies AgentNodeData,
    }));
  }, [stage, cues, currently]);

  const edges: Edge[] = useMemo(
    () =>
      stage.edges.map((e, i) => {
        const ret = e.kind === "return";
        const hot = cues[e.from] === "working";
        const color = ret ? "#4A4655" : hot ? "#57A87B" : "#6B6680";
        return {
          id: `e${i}-${e.from}-${e.to}`,
          source: e.from,
          target: e.to,
          label: ret ? `↺ ${e.label ?? "loop"}` : e.label,
          animated: hot,
          style: { stroke: color, strokeWidth: ret ? 1.5 : 2.25, strokeDasharray: ret ? "5 5" : undefined },
          labelStyle: { fill: "#82808F", fontSize: 10, fontFamily: "var(--mono)" },
          labelBgStyle: { fill: "#111013" },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [stage, cues]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onSelectionChange={(sel) => onSelect(sel.nodes[0]?.id ?? null)}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#17161B" />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => CUE_COLOR[(n.data as AgentNodeData).cue] ?? "#555161"}
        maskColor="rgba(12,11,14,0.6)"
        style={{ background: "rgba(23,22,26,0.92)", width: 104, height: 72 }}
      />
    </ReactFlow>
  );
}
