// Journal replay: rebuild a run's visible state from its journaled events —
// the same reduction useRun performs live, applied after the fact. Used by
// the History view and by session restore at app start ("Chromium restore").
//
// Two payload shapes coexist in journals:
//  - engine shape (current): type-tagged EngineEvent JSON — node_state,
//    session, gate_pending, escalation_*, run_finished.
//  - legacy flat (runs before full-stream journaling): a bare SessionEvent
//    with kind/node_id at the top level and no `type` field.

import type { CueState, StageSpec } from "../types";
import { sessionToLine, type Activity, type FeedLine, type PendingGate } from "./useRun";

export interface ReplayState {
  cues: Record<string, CueState>;
  details: Record<string, string>;
  feeds: Record<string, FeedLine[]>;
  activity: Activity[];
  failReasons: Record<string, string>;
  diagnoses: Record<string, string>;
  gates: PendingGate[];
  /** Last Done result per node — the payload a downstream gate would have seen. */
  lastResult: Record<string, string>;
  finished: boolean;
  /** running = interrupted (engine died with the run open) */
  status: string;
}

export interface RunDetail {
  stage: StageSpec;
  events: Array<Record<string, unknown>>;
  decisions: Array<{ nodeId: string; decision: string }>;
  status: string;
  startedAt: string;
}

export function replayRun(detail: RunDetail): ReplayState {
  const cues: Record<string, CueState> = {};
  const details: Record<string, string> = {};
  const feeds: Record<string, FeedLine[]> = {};
  const activity: Activity[] = [];
  const failReasons: Record<string, string> = {};
  const diagnoses: Record<string, string> = {};
  const lastResult: Record<string, string> = {};
  let gates: PendingGate[] = [];
  let finished = false;

  const at = (e: Record<string, unknown>) => {
    const t = Date.parse(String(e.at ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };

  const pushFeed = (nodeId: string, line: FeedLine | null) => {
    if (!line) return;
    (feeds[nodeId] ??= []).push(line);
    if (feeds[nodeId].length > 400) feeds[nodeId].shift();
  };

  const applySession = (nodeId: string, ev: Record<string, unknown> & { kind: string }, when: number) => {
    pushFeed(nodeId, sessionToLine(ev));
    if (ev.kind === "tool_call") {
      details[nodeId] = `${ev.tool}: ${String(ev.target ?? "")}`;
    } else if (ev.kind === "text") {
      const t = String(ev.text ?? "").replace(/^…\s*/, "").trim();
      if (t) details[nodeId] = t.length > 60 ? t.slice(0, 60) + "…" : t;
    } else if (ev.kind === "done") {
      lastResult[nodeId] = String(ev.result_text ?? "");
    }
    void when;
  };

  for (const e of detail.events) {
    const type = e.type as string | undefined;
    if (type === "node_state") {
      const nodeId = String(e.node_id ?? "");
      if (!nodeId) continue;
      const cue = (e.cue as CueState) ?? "idle";
      const det = String(e.detail ?? "");
      cues[nodeId] = cue;
      details[nodeId] = det;
      if (cue === "working" || cue === "standby" || cue === "failed" || det) {
        const prev = activity[activity.length - 1];
        if (!(prev && prev.nodeId === nodeId && prev.cue === cue && prev.detail === det)) {
          activity.push({ at: at(e), nodeId, cue, detail: det });
          if (activity.length > 120) activity.shift();
        }
      }
      if (cue === "failed" || cue === "blocked") failReasons[nodeId] = det || "session failed";
      else if (cue === "working") delete failReasons[nodeId];
      if (typeof e.diagnosis === "string" && e.diagnosis) diagnoses[nodeId] = e.diagnosis;
      // A gate leaves "standby" only when it's been decided (or the run ended it).
      if (cue !== "standby") gates = gates.filter((g) => g.nodeId !== nodeId);
    } else if (type === "gate_pending") {
      const nodeId = String(e.node_id ?? "");
      if (!nodeId) continue;
      gates = [
        ...gates.filter((g) => g.nodeId !== nodeId),
        {
          nodeId,
          worktree: (e.worktree as string | null) ?? undefined,
          caseText: String(e.case_text ?? ""),
          checklist: (e.checklist as string[]) ?? [],
          outward: Boolean(e.outward),
        },
      ];
    } else if (type === "session" && e.node_id && e.event) {
      applySession(String(e.node_id), e.event as Record<string, unknown> & { kind: string }, at(e));
    } else if (type === "run_finished") {
      finished = true;
    } else if (!type && typeof e.kind === "string" && e.node_id) {
      // Legacy flat SessionEvent row.
      applySession(String(e.node_id), e as Record<string, unknown> & { kind: string }, at(e));
    }
  }

  // Gates that were actually decided (journaled decisions survive restarts).
  const decided = new Set(detail.decisions.map((d) => d.nodeId));
  gates = gates.filter((g) => !decided.has(g.nodeId));

  if (detail.status !== "running") finished = true;
  else {
    // The engine died mid-run: a node frozen at "working" is really dead.
    for (const [id, c] of Object.entries(cues)) {
      if (c === "working") {
        cues[id] = "failed";
        details[id] = "interrupted — the app closed mid-session";
        failReasons[id] = "interrupted — the app closed mid-session";
      }
    }
  }

  return { cues, details, feeds, activity, failReasons, diagnoses, gates, lastResult, finished, status: detail.status };
}

/// For legacy runs (journaled before gate_pending existed): synthesize the
/// pending human gate from the stage spec + surviving worktree, so the
/// operator can still review and ship the orphaned work.
export function synthesizeOrphanGate(
  stage: StageSpec,
  replay: ReplayState,
  worktrees: Array<{ node: string; path: string }>,
  decisions: Array<{ nodeId: string }>
): PendingGate | null {
  if (replay.status !== "running" || worktrees.length === 0) return null;
  const decided = new Set(decisions.map((d) => d.nodeId));
  // Prefer the outward human gate (the ship gate), else any human gate.
  const gateNode =
    stage.nodes.find((n) => n.type === "gate" && n.gate?.mode === "human" && n.gate.outward && !decided.has(n.id)) ??
    stage.nodes.find((n) => n.type === "gate" && n.gate?.mode === "human" && !decided.has(n.id));
  if (!gateNode) return null;
  // The gate's case is the last thing its upstream agent said.
  const upstream = stage.edges.find((e) => e.to === gateNode.id && e.kind !== "return")?.from;
  const caseText =
    (upstream && replay.lastResult[upstream]) ||
    Object.values(replay.lastResult).pop() ||
    "(recovered run — the agent's final summary was not journaled)";
  return {
    nodeId: gateNode.id,
    worktree: worktrees[0].path,
    caseText,
    checklist: gateNode.gate?.checklist ?? [],
    outward: gateNode.gate?.outward ?? false,
  };
}

export function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "recovered"
  );
}
