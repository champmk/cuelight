// Shared graph plumbing: spec ⇄ React Flow conversion and edge styling.
// The canvas is a working copy; serializeStage turns it back into a valid
// .stage.json (including saved node positions in `layout`).

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { StageEdge, StageNode, StageSpec } from "../types";
import { layoutStage } from "./layout";
import type { AgentNodeData } from "../canvas/nodes";

const WIRE = "#6B6680";
const WIRE_RET = "#4A4655";

export function edgeStyle(ret: boolean): Partial<Edge> {
  const color = ret ? WIRE_RET : WIRE;
  return {
    type: "smoothstep",
    style: { stroke: color, strokeWidth: ret ? 1.5 : 2.25, strokeDasharray: ret ? "5 5" : undefined },
    labelStyle: { fill: "#82808F", fontSize: 10, fontFamily: "var(--mono)" },
    labelBgStyle: { fill: "#111013" },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  };
}

export function buildNodes(stage: StageSpec): Node[] {
  const auto = layoutStage(stage);
  return stage.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: stage.layout?.[n.id] ?? { x: auto.get(n.id)?.x ?? 0, y: auto.get(n.id)?.y ?? 0 },
    data: { spec: n, cue: "idle" } satisfies AgentNodeData,
  }));
}

export function buildEdges(stage: StageSpec): Edge[] {
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
    } as Edge;
  });
}

export function serializeStage(
  base: Pick<StageSpec, "name" | "version" | "description" | "defaults" | "caps" | "target">,
  nodes: Node[],
  edges: Edge[]
): StageSpec {
  const specNodes: StageNode[] = nodes.map((n) => (n.data as AgentNodeData).spec);
  const specEdges: StageEdge[] = edges.map((e) => {
    const ret = e.sourceHandle === "loop-out" || e.targetHandle === "loop-in";
    const label = typeof e.label === "string" ? e.label.replace(/^↺\s*/, "") : undefined;
    return {
      from: e.source,
      to: e.target,
      ...(ret ? { kind: "return" as const } : {}),
      ...(label && label !== "loop" ? { label } : {}),
    };
  });
  const layout: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  return { ...base, nodes: specNodes, edges: specEdges, layout };
}

/** Validation before save — mirrors the conductor's hard checks. */
export function validateStage(spec: StageSpec): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) {
    problems.push("Name must be kebab-case: lowercase letters, digits, dashes (e.g. my-workflow).");
  }
  if (spec.nodes.length === 0) problems.push("Template has no nodes — drag agents in from the library.");
  const ids = new Set(spec.nodes.map((n) => n.id));
  for (const e of spec.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`Edge ${e.from}→${e.to} references a missing node.`);
  }
  for (const n of spec.nodes) {
    if (n.type === "agent" && !n.card) problems.push(`Agent node "${n.id}" has no card.`);
    if (n.type === "gate" && n.gate?.outward && n.gate.mode !== "human") {
      problems.push(`Gate "${n.id}" is outward-facing — it must be a human gate.`);
    }
  }
  return problems;
}

export function uniqueNodeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
