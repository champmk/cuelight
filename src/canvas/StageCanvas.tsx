// The canvas, now fully controlled by App so the inspector can edit nodes and
// Save can serialize the working copy. Drag cards, rewire handles, Delete
// removes a selection, agents and gates drop in from the library.

import { useCallback, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
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

import type { CueState } from "../types";
import { AgentNode, GateNode, type AgentNodeData } from "./nodes";

const nodeTypes = { agent: AgentNode, gate: GateNode };

const CUE_COLOR: Record<CueState, string> = {
  idle: "#45424F",
  standby: "#E0A63C",
  working: "#4CC38A",
  blocked: "#E5534B",
  failed: "#E5534B",
};

export interface DropPayload {
  kind: "agent" | "gate";
  name: string;
  displayName?: string;
  gateMode?: "human" | "auto";
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (c: Connection) => void;
  onDropItem: (payload: DropPayload, position: { x: number; y: number }) => void;
  onSelect: (nodeId: string | null) => void;
}

function Canvas(props: Props) {
  const { screenToFlowPosition } = useReactFlow();

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault();
      const raw =
        ev.dataTransfer.getData("application/cuelight-agent") ||
        ev.dataTransfer.getData("application/cuelight-gate");
      if (!raw) return;
      const payload = JSON.parse(raw) as DropPayload;
      props.onDropItem(payload, screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
    },
    [props, screenToFlowPosition]
  );

  return (
    <ReactFlow
      nodes={props.nodes}
      edges={props.edges}
      nodeTypes={nodeTypes}
      onNodesChange={props.onNodesChange}
      onEdgesChange={props.onEdgesChange}
      onConnect={props.onConnect}
      onSelectionChange={(sel) => props.onSelect(sel.nodes[0]?.id ?? null)}
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

// keyed remount per template happens in App via the `key` prop.
export function StageCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
