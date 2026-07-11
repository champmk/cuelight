// Layered (Sugiyama) layout for stage graphs. Three passes:
//   1. Rank — columns by longest path over flow edges (Kahn's algorithm).
//   2. Untangle — barycenter crossing minimization: repeatedly reorder each
//      column by the median position of its neighbours, sweeping down then up.
//      This ONLY moves nodes; it never changes an edge, so the graph stays
//      topologically identical — just readable.
//   3. Place — vertical coordinates from the final order, columns centred.
// Return edges are excluded from ranking and from the barycenter (they close
// loops and should route around the graph, not fight the layout).

import type { StageSpec } from "../types";

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

const COL_W = 250;
const ROW_H = 150;
const SWEEPS = 8;

export function layoutStage(stage: StageSpec): Map<string, Positioned> {
  const flow = stage.edges.filter((e) => (e.kind ?? "flow") === "flow");

  // --- 1. Rank ---
  const indeg = new Map<string, number>(stage.nodes.map((n) => [n.id, 0]));
  for (const e of flow) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const rank = new Map<string, number>();
  let frontier = stage.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  frontier.forEach((id) => rank.set(id, 0));
  const remaining = new Map(indeg);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of flow.filter((e) => e.from === id)) {
        const d = (remaining.get(e.to) ?? 1) - 1;
        remaining.set(e.to, d);
        rank.set(e.to, Math.max(rank.get(e.to) ?? 0, (rank.get(id) ?? 0) + 1));
        if (d === 0) next.push(e.to);
      }
    }
    frontier = next;
  }
  for (const n of stage.nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  // Columns, preserving spec order as the initial ordering.
  const cols: string[][] = [];
  for (const n of stage.nodes) {
    const c = rank.get(n.id) ?? 0;
    (cols[c] ??= []).push(n.id);
  }

  // --- 2. Untangle (barycenter) ---
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of flow) {
    (succs.get(e.from) ?? succs.set(e.from, []).get(e.from)!).push(e.to);
    (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
  }
  const indexMap = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const col of cols) col?.forEach((id, i) => m.set(id, i));
    return m;
  };
  // Barycenter of a node = mean index of its neighbours in the adjacent column;
  // if it has none, keep its current index so it stays put (stable).
  const reorder = (neigh: Map<string, string[]>, idx: Map<string, number>) => (col: string[]) => {
    const keyed = col.map((id, i) => {
      const ns = (neigh.get(id) ?? []).map((n) => idx.get(n)).filter((x): x is number => x !== undefined);
      return { id, k: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i };
    });
    keyed.sort((a, b) => a.k - b.k); // stable: ties keep prior order
    return keyed.map((w) => w.id);
  };
  for (let s = 0; s < SWEEPS; s++) {
    let idx = indexMap();
    for (let c = 1; c < cols.length; c++) if (cols[c]) cols[c] = reorder(preds, idx)(cols[c]); // down: order by predecessors
    idx = indexMap();
    for (let c = cols.length - 2; c >= 0; c--) if (cols[c]) cols[c] = reorder(succs, idx)(cols[c]); // up: order by successors
  }

  // --- 3. Place (centre each column against the tallest) ---
  const maxRows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
  const out = new Map<string, Positioned>();
  cols.forEach((col, c) => {
    if (!col) return;
    const offset = (maxRows - col.length) / 2;
    col.forEach((id, i) => out.set(id, { id, x: 40 + c * COL_W, y: 60 + (i + offset) * ROW_H }));
  });
  return out;
}
