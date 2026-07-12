// Shared pane-resizing: ONE implementation for every draggable gutter in the
// app (shell, review, history). Widths clamp to per-pane bounds, persist per
// storage key, and double-click resets — identical mechanics everywhere.

import { useCallback, useRef, useState } from "react";

export interface PaneDef {
  def: number;
  min: number;
  max: number;
  /** true when the pane sits on the RIGHT of its gutter (drag left = grow). */
  invert?: boolean;
}

function clamp(d: PaneDef, v: number): number {
  return Math.min(d.max, Math.max(d.min, v));
}

export function usePanes<K extends string>(storageKey: string, defs: Record<K, PaneDef>) {
  const [sizes, setSizes] = useState<Record<K, number>>(() => {
    const out = {} as Record<K, number>;
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      // corrupt — defaults
    }
    for (const k of Object.keys(defs) as K[]) {
      const v = Number(saved[k]);
      out[k] = Number.isFinite(v) && v > 0 ? clamp(defs[k], v) : defs[k].def;
    }
    return out;
  });
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const dragRef = useRef<null | { k: K; startX: number; start: number }>(null);

  const persist = useCallback(() => {
    localStorage.setItem(storageKey, JSON.stringify(sizesRef.current));
  }, [storageKey]);

  const startDrag = useCallback(
    (k: K) => (ev: React.PointerEvent) => {
      ev.preventDefault();
      dragRef.current = { k, startX: ev.clientX, start: sizesRef.current[k] };
      const move = (e: PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const delta = (e.clientX - d.startX) * (defs[d.k].invert ? -1 : 1);
        const next = clamp(defs[d.k], d.start + delta);
        setSizes((s) => (s[d.k] === next ? s : { ...s, [d.k]: next }));
      };
      const up = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("col-resizing");
        persist();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.classList.add("col-resizing");
    },
    [defs, persist]
  );

  const reset = useCallback(
    (k: K) => {
      setSizes((s) => ({ ...s, [k]: defs[k].def }));
      // persist after state applies
      setTimeout(persist, 0);
    },
    [defs, persist]
  );

  return { sizes, startDrag, reset };
}
