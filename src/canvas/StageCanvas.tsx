// The canvas — and it behaves like one: drag cards, rewire edges, delete with
// Del/Backspace, drop agents in from the library. Flow edges run left→right;
// return edges leave the bottom handle and re-enter on top, so loops read as
// loops. Layout edits persist per template in localStorage until stage-file
// persistence lands (M2).

import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { CueState, StageNode, StageSpec } from "../types";
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

const WIRE = "#6B6680";
const WIRE_RET = "#4A4655";

function edgeStyle(ret: boolean): Partial<Edge> {
  const color = ret ? WIRE_RET : WIRE;
  return {
    type: "smoothstep",
    style: { stroke: color, strokeWidth: ret ? 1.5 : 2.25, strokeDasharray: ret ? "5 5" : undefined },
    labelStyle: { fill: "#82808F", fontSize: 10, fontFamily: "var(--mono)" },
    labelBgStyle: { fill: "#111013" },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  };
}

function posKey(stageName: string) {
  return `cuelight-layout-${stageName}`;
}

function initialNodes(stage: StageSpec, cues: Record<string, CueState>): Node[] {
  const auto = layoutStage(stage);
  let saved: Record<string, { x: number; y: number }> = {};
  try {
    saved = JSON.parse(localStorage.getItem(posKey(stage.name)) ?? "{}");
  } catch {
    /* corrupted layout cache — fall back to auto layout */
  }
  return stage.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: saved[n.id] ?? { x: auto.get(n.id)?.x ?? 0, y: auto.get(n.id)?.y ?? 0 },
    data: { spec: n, cue: cues[n.id] ?? "idle" } satisfies AgentNodeData,
  }));
}

function initialEdges(stage: StageSpec): Edge[] {
  return stage.edges.map((e, i) => {
    const ret = e.kind === "return";
    return {
      id: `e${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      sourceHandle: ret ? "loop-out" : "out",
      targetHandle: ret ? "loop-in" : "in",
      label: ret ? `↺ ${e.label ?? "loop"}` : e.label,
      ...edgeStyle(ret),
    };
  });
}

interface Props {
  stage: StageSpec;
  cues: Record<string, CueState>;
  onSelect: (node: StageNode | null) => void;
}

function Canvas({ stage, cues, onSelect }: Props) {
  const [nodes, setNodes] = useState<Node[]>(() => initialNodes(stage, cues));
  const [edges, setEdges] = useState<Edge[]>(() => initialEdges(stage));
  const { screenToFlowPosition } = useReactFlow();
  const addCount = useRef(0);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  );

  const onConnect = useCallback((c: Connection) => {
    const ret = c.sourceHandle === "loop-out" || c.targetHandle === "loop-in";
    setEdges((es) =>
      addEdge({ ...c, label: ret ? "↺ loop" : undefined, ...edgeStyle(ret) }, es)
    );
  }, []);

  const persistPositions = useCallback(() => {
    setNodes((ns) => {
      const saved: Record<string, { x: number; y: number }> = {};
      for (const n of ns) saved[n.id] = { x: n.position.x, y: n.position.y };
      localStorage.setItem(posKey(stage.name), JSON.stringify(saved));
      return ns;
    });
  }, [stage.name]);

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault();
      const raw = ev.dataTransfer.getData("application/cuelight-agent");
      if (!raw) return;
      const card = JSON.parse(raw) as { name: string; displayName?: string };
      addCount.current += 1;
      const id = `${card.name}-${addCount.current}`;
      const spec: StageNode = { id, type: "agent", card: card.name, label: card.displayName ?? card.name };
      const position = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      setNodes((ns) => [
        ...ns,
        { id, type: "agent", position, data: { spec, cue: "idle" } satisfies AgentNodeData },
      ]);
    },
    [screenToFlowPosition]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={persistPositions}
      onSelectionChange={(sel) => {
        const n = sel.nodes[0];
        onSelect(n ? (n.data as AgentNodeData).spec : null);
      }}
      onDrop={onDrop}
      onDragOver={(ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }}
      deleteKeyCode={["Delete", "Backspace"]}
      edgesReconnectable
      fitView
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1B1920" />
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

// Remounts per template (key) so switching templates rebuilds the working copy.
export function StageCanvas(props: Props) {
  return (
    <ReactFlowProvider key={props.stage.name}>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
