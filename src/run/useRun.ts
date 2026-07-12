// Live run state: subscribes to the conductor's engine-event stream and
// exposes the maps the canvas renders from. This hook is the seam between
// the Rust engine and everything visual.
//
// Multi-run: state is a map keyed by run id. Every live run accumulates
// simultaneously — events route to their run's slice regardless of which
// tab is displayed. `view(runId)` selects one run's state for rendering.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CueState, StageSpec } from "../types";

export interface FeedLine {
  kind: string;
  text: string;
  ok?: boolean;
}

export interface PendingGate {
  nodeId: string;
  worktree?: string;
  caseText: string;
  checklist: string[];
  outward: boolean;
}

/** Token usage aggregated per harness — grok and claude are separate
 * subscriptions with separate costs, so they are never summed together. */
export interface HarnessUsage {
  out: number;
  inp: number;
}

const USAGE_KEY = "cuelight-usage-today";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadGlobalUsage(): Record<string, HarnessUsage> {
  try {
    const g = JSON.parse(localStorage.getItem(USAGE_KEY) ?? "null");
    if (g && g.date === todayStr()) return g.byHarness ?? {};
  } catch {
    // fall through
  }
  return {};
}

export interface NodeVitals {
  contextUsed?: number;
  contextLimit?: number;
  outputTokens?: number;
  inputTokens?: number;
  startedAt?: number;
  endedAt?: number;
  turns: number;
}

interface EngineEventMsg {
  type: string;
  run_id: string;
  node_id?: string;
  cue?: string;
  detail?: string;
  worktree?: string | null;
  diagnosis?: string;
  event?: Record<string, unknown> & { kind: string };
  case_text?: string;
  checklist?: string[];
  outward?: boolean;
  status?: string;
  // escalation
  failed_node?: string;
  check_node?: string;
  gate_node?: string;
  reason?: string;
  retried?: boolean;
}

export interface Escalation {
  failedNode: string;
  checkNode: string;
  gateNode: string;
  reason: string;
}

export interface Activity {
  at: number;
  nodeId: string;
  cue: CueState;
  detail: string;
}

export interface CardPayload {
  prompt: string;
  permissions: string;
  harness: string;
  model?: string;
  effort?: string;
  structuredOutput?: unknown;
}

/** One run's complete render state. */
export interface RunView {
  runId: string;
  /** The workspace (session tab) that owns this run. */
  session: string;
  cues: Record<string, CueState>;
  details: Record<string, string>;
  worktrees: Record<string, string>;
  feeds: Record<string, FeedLine[]>;
  vitals: Record<string, NodeVitals>;
  gates: PendingGate[];
  activeNode: string | null;
  activity: Activity[];
  failReasons: Record<string, string>;
  diagnoses: Record<string, string>;
  escalations: Escalation[];
  paused: boolean;
  finished: boolean;
  usage: Record<string, HarnessUsage>;
  inflight: Record<string, HarnessUsage>;
}

const EMPTY_VIEW: RunView = {
  runId: "",
  session: "",
  cues: {},
  details: {},
  worktrees: {},
  feeds: {},
  vitals: {},
  gates: [],
  activeNode: null,
  activity: [],
  failReasons: {},
  diagnoses: {},
  escalations: [],
  paused: false,
  finished: false,
  usage: {},
  inflight: {},
};

function freshView(runId: string, session: string): RunView {
  return { ...EMPTY_VIEW, runId, session };
}

/** Mutable per-run token accounting, kept in refs so React strict-mode
 *  double-invoked updaters can't double-count into localStorage. */
interface UsageAcc {
  nodeHarness: Record<string, string>;
  nodeLatest: Record<string, HarnessUsage>;
  committed: Record<string, HarnessUsage>;
}

export function useRun() {
  const [runs, setRuns] = useState<Record<string, RunView>>({});
  const [globalUsage, setGlobalUsage] = useState<Record<string, HarnessUsage>>(loadGlobalUsage);
  const usageAcc = useRef<Record<string, UsageAcc>>({});
  /** run id → owning workspace, readable outside React's update queue. */
  const sessionOf = useRef<Record<string, string>>({});
  const escHandlers = useRef<{
    open?: (session: string, e: Escalation) => void;
    close?: (session: string, failedNode: string, retried: boolean, checkNode: string, gateNode: string) => void;
  }>({});
  const unlisten = useRef<UnlistenFn | null>(null);

  const mut = useCallback((runId: string, fn: (r: RunView) => RunView) => {
    setRuns((rs) => {
      const cur = rs[runId];
      if (!cur) return rs;
      const next = fn(cur);
      return next === cur ? rs : { ...rs, [runId]: next };
    });
  }, []);

  useEffect(() => {
    let live = true;

    const withUsage = (rid: string, r: RunView): RunView => {
      const acc = usageAcc.current[rid];
      if (!acc) return r;
      const totals = structuredClone(acc.committed);
      const inf: Record<string, HarnessUsage> = {};
      for (const [nid, u] of Object.entries(acc.nodeLatest)) {
        const h = acc.nodeHarness[nid] ?? "grok";
        (totals[h] ??= { out: 0, inp: 0 });
        totals[h].out += u.out;
        totals[h].inp += u.inp;
        (inf[h] ??= { out: 0, inp: 0 });
        inf[h].out += u.out;
        inf[h].inp += u.inp;
      }
      return { ...r, usage: totals, inflight: inf };
    };

    const commitNode = (rid: string, nid: string) => {
      const acc = usageAcc.current[rid];
      const u = acc?.nodeLatest[nid];
      if (!acc || !u) return;
      const h = acc.nodeHarness[nid] ?? "grok";
      const c = (acc.committed[h] ??= { out: 0, inp: 0 });
      c.out += u.out;
      c.inp += u.inp;
      delete acc.nodeLatest[nid];
      // Fold into the persistent per-day counter (all workflows, additive).
      let store: { date: string; byHarness: Record<string, HarnessUsage> };
      try {
        const g = JSON.parse(localStorage.getItem(USAGE_KEY) ?? "null");
        store = g && g.date === todayStr() ? g : { date: todayStr(), byHarness: {} };
      } catch {
        store = { date: todayStr(), byHarness: {} };
      }
      const gh = (store.byHarness[h] ??= { out: 0, inp: 0 });
      gh.out += u.out;
      gh.inp += u.inp;
      localStorage.setItem(USAGE_KEY, JSON.stringify(store));
      setGlobalUsage({ ...store.byHarness });
    };

    listen<EngineEventMsg>("engine-event", ({ payload: p }) => {
      if (!live) return;
      const rid = p.run_id;
      // Only runs this app instance started exist in the map; anything else
      // (a dev-reload stray, a foreign run) is dropped.
      if (p.type === "node_state" && p.node_id) {
        const nodeId = p.node_id;
        const cue = (p.cue as CueState) ?? "idle";
        mut(rid, (r) => {
          let next: RunView = {
            ...r,
            cues: { ...r.cues, [nodeId]: cue },
            details: { ...r.details, [nodeId]: p.detail ?? "" },
          };
          if (p.worktree) next.worktrees = { ...next.worktrees, [nodeId]: p.worktree };
          if (cue === "working" || cue === "standby") next.activeNode = nodeId;
          // Timeline: record notable transitions (starts, waits, failures,
          // and idle states carrying a message like "done" / "rejected…").
          if (cue === "working" || cue === "standby" || cue === "failed" || cue === "idle") {
            const entry: Activity = { at: Date.now(), nodeId, cue, detail: p.detail ?? "" };
            const prev = r.activity[r.activity.length - 1];
            if (!(prev && prev.nodeId === nodeId && prev.cue === cue && prev.detail === entry.detail)) {
              next.activity = [...r.activity.slice(-79), entry];
            }
          }
          if (cue === "working") {
            // New session on this node: reset vitals and start its clock.
            next.vitals = { ...next.vitals, [nodeId]: { turns: 0, startedAt: Date.now() } };
            const { [nodeId]: _drop, ...rest } = next.failReasons;
            next.failReasons = rest;
          } else if (next.vitals[nodeId]) {
            // Terminal state (idle/failed/blocked): freeze the elapsed clock.
            next.vitals = { ...next.vitals, [nodeId]: { ...next.vitals[nodeId], endedAt: next.vitals[nodeId].endedAt ?? Date.now() } };
          }
          if (cue === "failed" || cue === "blocked") {
            next.failReasons = { ...next.failReasons, [nodeId]: p.detail || "session failed" };
          }
          if (p.diagnosis) {
            next.diagnoses = { ...next.diagnoses, [nodeId]: p.diagnosis };
          }
          if (cue !== "standby") {
            next.gates = next.gates.filter((x) => x.nodeId !== nodeId);
          }
          return next;
        });
      } else if (p.type === "escalation_opened" && p.failed_node && p.check_node && p.gate_node) {
        const esc: Escalation = { failedNode: p.failed_node, checkNode: p.check_node, gateNode: p.gate_node, reason: p.reason ?? "" };
        const owner = sessionOf.current[rid];
        if (owner) escHandlers.current.open?.(owner, esc);
        mut(rid, (r) => ({ ...r, escalations: [...r.escalations.filter((x) => x.failedNode !== esc.failedNode), esc] }));
      } else if (p.type === "escalation_closed" && p.failed_node) {
        const failedNode = p.failed_node;
        const owner = sessionOf.current[rid];
        if (owner) escHandlers.current.close?.(owner, failedNode, p.retried ?? false, p.check_node ?? "", p.gate_node ?? "");
        mut(rid, (r) => {
          let next = { ...r, escalations: r.escalations.filter((x) => x.failedNode !== failedNode) };
          if (p.retried) {
            const { [failedNode]: _d, ...rest } = next.failReasons;
            next.failReasons = rest;
          }
          return next;
        });
      } else if (p.type === "session" && p.node_id && p.event) {
        const ev = p.event;
        const nodeId = p.node_id;
        if (ev.kind === "started") {
          const acc = usageAcc.current[rid];
          if (acc) acc.nodeHarness[nodeId] = String(ev.harness ?? "grok");
        }
        if (ev.kind === "usage") {
          const acc = usageAcc.current[rid];
          if (acc) acc.nodeLatest[nodeId] = { out: Number(ev.output_tokens ?? 0), inp: Number(ev.input_tokens ?? 0) };
        }
        if (ev.kind === "done" || ev.kind === "failed") {
          commitNode(rid, nodeId);
        }
        mut(rid, (r) => {
          let next = { ...r };
          const line = sessionToLine(ev);
          if (line) {
            const cur = r.feeds[nodeId] ?? [];
            next.feeds = { ...r.feeds, [nodeId]: [...cur.slice(-199), line] };
          }
          if (ev.kind === "tool_call") {
            next.details = { ...next.details, [nodeId]: `${ev.tool}: ${String(ev.target ?? "")}` };
            next.vitals = { ...next.vitals, [nodeId]: { ...(next.vitals[nodeId] ?? { turns: 0 }), turns: (next.vitals[nodeId]?.turns ?? 0) + 1 } };
          }
          if (ev.kind === "text") {
            const t = String(ev.text ?? "").replace(/^…\s*/, "").trim();
            if (t) {
              next.details = { ...next.details, [nodeId]: t.length > 60 ? t.slice(0, 60) + "…" : t };
              next.vitals = { ...next.vitals, [nodeId]: { ...(next.vitals[nodeId] ?? { turns: 0 }), turns: (next.vitals[nodeId]?.turns ?? 0) + 1 } };
            }
          }
          if (ev.kind === "usage") {
            next.vitals = {
              ...next.vitals,
              [nodeId]: {
                ...(next.vitals[nodeId] ?? { turns: 0 }),
                contextUsed: ev.context_used as number | undefined,
                contextLimit: ev.context_limit as number | undefined,
                outputTokens: ev.output_tokens as number | undefined,
                inputTokens: ev.input_tokens as number | undefined,
              },
            };
          }
          return withUsage(rid, next);
        });
      } else if (p.type === "gate_pending" && p.node_id) {
        const nodeId = p.node_id;
        mut(rid, (r) => ({
          ...r,
          gates: [
            ...r.gates.filter((x) => x.nodeId !== nodeId),
            {
              nodeId,
              worktree: p.worktree ?? undefined,
              caseText: p.case_text ?? "",
              checklist: p.checklist ?? [],
              outward: p.outward ?? false,
            },
          ],
        }));
      } else if (p.type === "run_finished") {
        mut(rid, (r) => ({ ...r, finished: true, paused: false }));
      }
    }).then((u) => {
      unlisten.current = u;
    });
    return () => {
      live = false;
      unlisten.current?.();
    };
  }, [mut]);

  const start = useCallback(
    async (stage: StageSpec, cards: Record<string, CardPayload>, repoPath: string, goal: string, sessionId: string) => {
      // The client mints the run id: no event race waiting for the engine to
      // return one, and the engine dedups a double-fired launch on it.
      const id = crypto.randomUUID();
      usageAcc.current[id] = { nodeHarness: {}, nodeLatest: {}, committed: {} };
      sessionOf.current[id] = sessionId;
      setRuns((rs) => ({ ...rs, [id]: freshView(id, sessionId) }));
      try {
        await invoke("start_run", { runId: id, stage, cards, repoPath, goal });
      } catch (e) {
        setRuns((rs) => {
          const { [id]: _drop, ...rest } = rs;
          return rest;
        });
        delete usageAcc.current[id];
        delete sessionOf.current[id];
        throw e;
      }
      return id;
    },
    []
  );

  const decide = useCallback(
    async (runId: string, nodeId: string, approve: boolean, memo?: string, action?: string, branch?: string) => {
      if (!runId) return;
      await invoke("gate_decision", { runId, nodeId, approve, memo: memo || null, action: action || null, branch: branch || null });
      mut(runId, (r) => ({ ...r, gates: r.gates.filter((x) => x.nodeId !== nodeId) }));
    },
    [mut]
  );

  const kill = useCallback(async (runId: string, nodeId: string) => {
    if (!runId) return;
    await invoke("kill_node", { runId, nodeId });
  }, []);

  const setPaused = useCallback(
    async (runId: string, p: boolean) => {
      if (!runId) return;
      await invoke("set_paused", { runId, paused: p });
      mut(runId, (r) => ({ ...r, paused: p }));
    },
    [mut]
  );

  const stop = useCallback(
    async (runId: string) => {
      if (!runId) return;
      await invoke("stop_run", { runId });
      mut(runId, (r) => ({ ...r, paused: false, gates: [], finished: true }));
    },
    [mut]
  );

  const nudge = useCallback(async (runId: string, nodeId: string, text: string) => {
    if (!runId) return;
    await invoke("nudge_node", { runId, nodeId, text });
  }, []);

  /** Drop a run's state (its workspace closed). */
  const forget = useCallback((runId: string | undefined) => {
    if (!runId) return;
    delete usageAcc.current[runId];
    delete sessionOf.current[runId];
    setRuns((rs) => {
      if (!rs[runId]) return rs;
      const { [runId]: _drop, ...rest } = rs;
      return rest;
    });
  }, []);

  const view = useCallback((runId: string | null | undefined): RunView => (runId ? runs[runId] ?? EMPTY_VIEW : EMPTY_VIEW), [runs]);

  const onEscalation = useCallback(
    (
      open: (session: string, e: Escalation) => void,
      close: (session: string, failedNode: string, retried: boolean, checkNode: string, gateNode: string) => void
    ) => {
      escHandlers.current = { open, close };
    },
    []
  );

  return { runs, view, globalUsage, start, decide, kill, setPaused, stop, nudge, forget, onEscalation };
}

export function sessionToLine(ev: Record<string, unknown> & { kind: string }): FeedLine | null {
  switch (ev.kind) {
    case "started":
      return { kind: "say", text: `session started (${ev.harness}${ev.model ? ` · ${ev.model}` : ""})` };
    case "text": {
      const t = String(ev.text ?? "").trim();
      return t ? { kind: "say", text: t.length > 220 ? t.slice(0, 220) + "…" : t } : null;
    }
    case "tool_call":
      return { kind: "tool", text: `${ev.tool} ${String(ev.target ?? "")}`.trim() };
    case "tool_result":
      return { kind: ev.ok === false ? "bad" : "ok", text: String(ev.summary ?? ev.tool ?? "") };
    case "rate_limited":
      return { kind: "bad", text: `rate limited${ev.retry_after_secs ? ` — retry in ${ev.retry_after_secs}s` : ""}` };
    case "done":
      return { kind: ev.ok ? "ok" : "bad", text: ev.ok ? "session complete" : "session ended with failure" };
    case "failed":
      return { kind: "bad", text: String(ev.error ?? "failed") };
    default:
      return null;
  }
}
