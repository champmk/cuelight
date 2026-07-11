// The canvas — full editor surface. Drag cards, rewire or detach edges (drag
// an endpoint off its handle to delete), right-click for context menus,
// Shift-drag to box-select, Delete removes, snap-to-grid, zoom controls,
// auto-layout. App owns the state; this renders and reports.

import { useCallback, useRef, type DragEvent, type MouseEvent as RMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
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
  outward?: boolean;
  checklist?: string[];
}

export interface CtxMenu {
  kind: "node" | "edge" | "pane";
  id?: string;
  x: number;
  y: number;
}

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (c: Connection) => void;
  onEdgesSet: (updater: (edges: Edge[]) => Edge[]) => void;
  onDropItem: (payload: DropPayload, position: { x: number; y: number }) => void;
  onSelect: (nodeId: string | null) => void;
  onSelectionIds: (nodeIds: string[]) => void;
  onContextMenu: (menu: CtxMenu | null) => void;
  onAutoLayout: () => void;
  onSnapshot: () => void;
}

function Canvas(props: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const reconnectDone = useRef(true);

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

  const ctx = useCallback(
    (kind: CtxMenu["kind"]) => (ev: RMouseEvent, el?: Node | Edge) => {
      ev.preventDefault();
      props.onContextMenu({ kind, id: el?.id, x: ev.clientX, y: ev.clientY });
    },
    [props]
  );

  return (
    <ReactFlow
      nodes={props.nodes}
      edges={props.edges}
      nodeTypes={nodeTypes}
      onNodesChange={props.onNodesChange}
      onEdgesChange={props.onEdgesChange}
      onConnect={props.onConnect}
      onSelectionChange={(sel) => {
        props.onSelect(sel.nodes[0]?.id ?? null);
        props.onSelectionIds(sel.nodes.map((n) => n.id));
      }}
      onDrop={onDrop}
      onDragOver={(ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }}
      onReconnectStart={() => {
        reconnectDone.current = false;
        props.onSnapshot();
      }}
      onReconnect={(oldEdge, conn) => {
        reconnectDone.current = true;
        props.onEdgesSet((es) => reconnectEdge(oldEdge, conn, es));
      }}
      onReconnectEnd={(_ev, edge) => {
        // Dropped in empty space: the edge is detached → delete it.
        if (!reconnectDone.current) {
          props.onEdgesSet((es) => es.filter((e) => e.id !== edge.id));
        }
        reconnectDone.current = true;
      }}
      onNodeContextMenu={(ev, node) => ctx("node")(ev, node)}
      onEdgeContextMenu={(ev, edge) => ctx("edge")(ev, edge)}
      onPaneContextMenu={(ev) => ctx("pane")(ev as unknown as RMouseEvent)}
      onPaneClick={() => props.onContextMenu(null)}
      deleteKeyCode={["Delete", "Backspace"]}
      edgesReconnectable
      snapToGrid
      snapGrid={[11, 11]}
      fitView
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1B1920" />
      <Controls position="bottom-left" showInteractive={false}>
        <ControlButton onClick={props.onAutoLayout} title="Untangle — clean up the layout (keeps every connection)">
          ⌗
        </ControlButton>
      </Controls>
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

export function StageCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
