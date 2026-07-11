// Layered layout for stage graphs: topological columns over flow edges,
// return edges excluded from ranking (they close loops). Good enough for
// template-sized graphs; users can drag nodes afterward and positions persist
// in the stage file (M2).

import type { StageSpec } from "../types";

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

const COL_W = 250;
const ROW_H = 150;

export function layoutStage(stage: StageSpec): Map<string, Positioned> {
  const flowEdges = stage.edges.filter((e) => (e.kind ?? "flow") === "flow");
  const indeg = new Map<string, number>(stage.nodes.map((n) => [n.id, 0]));
  for (const e of flowEdges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);

  // Kahn's algorithm → rank per node.
  const rank = new Map<string, number>();
  let frontier = stage.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  frontier.forEach((id) => rank.set(id, 0));
  const remaining = new Map(indeg);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of flowEdges.filter((e) => e.from === id)) {
        const d = (remaining.get(e.to) ?? 1) - 1;
        remaining.set(e.to, d);
        const r = Math.max(rank.get(e.to) ?? 0, (rank.get(id) ?? 0) + 1);
        rank.set(e.to, r);
        if (d === 0) next.push(e.to);
      }
    }
    frontier = next;
  }
  // Nodes untouched by flow edges (pure schedule/manual islands) go to col 0.
  for (const n of stage.nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  const byCol = new Map<number, string[]>();
  for (const n of stage.nodes) {
    const c = rank.get(n.id) ?? 0;
    byCol.set(c, [...(byCol.get(c) ?? []), n.id]);
  }

  const out = new Map<string, Positioned>();
  for (const [col, ids] of byCol) {
    ids.forEach((id, i) => {
      out.set(id, { id, x: 40 + col * COL_W, y: 60 + i * ROW_H });
    });
  }
  return out;
}
