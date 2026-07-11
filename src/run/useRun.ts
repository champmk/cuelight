// Live run state: subscribes to the conductor's engine-event stream and
// exposes the maps the canvas renders from. This hook is the seam between
// the Rust engine and everything visual.

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

export function useRun() {
  const [runId, setRunId] = useState<string | null>(null);
  // The workspace (session tab) that owns the current run. Events are only
  // ever applied to this session's canvas — never whatever happens to be
  // displayed.
  const [session, setSession] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [cues, setCues] = useState<Record<string, CueState>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [worktrees, setWorktrees] = useState<Record<string, string>>({});
  const [feeds, setFeeds] = useState<Record<string, FeedLine[]>>({});
  const [vitals, setVitals] = useState<Record<string, NodeVitals>>({});
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [activeNode, setActiveNode] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [failReasons, setFailReasons] = useState<Record<string, string>>({});
  const [diagnoses, setDiagnoses] = useState<Record<string, string>>({});
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const escHandlers = useRef<{ open?: (e: Escalation) => void; close?: (failedNode: string, retried: boolean, checkNode: string, gateNode: string) => void }>({});
  const [paused, setPausedState] = useState(false);
  const [finished, setFinished] = useState(false);
  const unlisten = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let live = true;
    listen<EngineEventMsg>("engine-event", ({ payload: p }) => {
      if (!live) return;
      // Drop events from any run other than the current one ("*" = a start is
      // in flight and the id isn't known yet). Stale events from a stopped or
      // superseded run must never touch live state.
      if (runIdRef.current !== "*" && p.run_id !== runIdRef.current) return;
      if (p.type === "node_state" && p.node_id) {
        const nodeId = p.node_id;
        const cue = (p.cue as CueState) ?? "idle";
        setCues((c) => ({ ...c, [nodeId]: cue }));
        setDetails((d) => ({ ...d, [nodeId]: p.detail ?? "" }));
        if (p.worktree) setWorktrees((w) => ({ ...w, [nodeId]: p.worktree! }));
        if (cue === "working" || cue === "standby") setActiveNode(nodeId);
        // Timeline: record notable transitions (starts, waits, failures, and
        // idle states carrying a message like "done" / "rejected — back to…").
        if (cue === "working" || cue === "standby" || cue === "failed" || (cue === "idle" && p.detail && p.detail !== "done" ? true : cue === "idle" && p.detail === "done")) {
          setActivity((a) => {
            const entry: Activity = { at: Date.now(), nodeId, cue, detail: p.detail ?? "" };
            const prev = a[a.length - 1];
            if (prev && prev.nodeId === nodeId && prev.cue === cue && prev.detail === entry.detail) return a;
            return [...a.slice(-79), entry];
          });
        }
        if (cue === "working") {
          // New session on this node: reset vitals and start its clock.
          setVitals((v) => ({ ...v, [nodeId]: { turns: 0, startedAt: Date.now() } }));
          setFailReasons((f) => {
            const { [nodeId]: _drop, ...rest } = f;
            return rest;
          });
        } else {
          // Terminal state (idle/failed/blocked): freeze the elapsed clock.
          setVitals((v) => (v[nodeId] ? { ...v, [nodeId]: { ...v[nodeId], endedAt: v[nodeId].endedAt ?? Date.now() } } : v));
        }
        if (cue === "failed" || cue === "blocked") {
          setFailReasons((f) => ({ ...f, [nodeId]: p.detail || "session failed" }));
        }
        if (p.diagnosis) {
          setDiagnoses((d) => ({ ...d, [nodeId]: p.diagnosis! }));
        }
        if (cue !== "standby") {
          setGates((g) => g.filter((x) => x.nodeId !== nodeId));
        }
      } else if (p.type === "escalation_opened" && p.failed_node && p.check_node && p.gate_node) {
        const esc: Escalation = { failedNode: p.failed_node, checkNode: p.check_node, gateNode: p.gate_node, reason: p.reason ?? "" };
        setEscalations((xs) => [...xs.filter((x) => x.failedNode !== esc.failedNode), esc]);
        escHandlers.current.open?.(esc);
      } else if (p.type === "escalation_closed" && p.failed_node) {
        setEscalations((xs) => xs.filter((x) => x.failedNode !== p.failed_node));
        escHandlers.current.close?.(p.failed_node, p.retried ?? false, p.check_node ?? "", p.gate_node ?? "");
        if (p.retried) {
          setFailReasons((f) => { const { [p.failed_node!]: _d, ...rest } = f; return rest; });
        }
      } else if (p.type === "session" && p.node_id && p.event) {
        const ev = p.event;
        const nodeId = p.node_id;
        setFeeds((f) => {
          const line = sessionToLine(ev);
          if (!line) return f;
          const cur = f[nodeId] ?? [];
          return { ...f, [nodeId]: [...cur.slice(-199), line] };
        });
        if (ev.kind === "tool_call") {
          setDetails((d) => ({ ...d, [nodeId]: `${ev.tool}: ${String(ev.target ?? "")}` }));
          setVitals((v) => ({ ...v, [nodeId]: { ...(v[nodeId] ?? { turns: 0 }), turns: (v[nodeId]?.turns ?? 0) + 1 } }));
        }
        if (ev.kind === "text") {
          const t = String(ev.text ?? "").replace(/^…\s*/, "").trim();
          if (t) {
            setDetails((d) => ({ ...d, [nodeId]: t.length > 60 ? t.slice(0, 60) + "…" : t }));
            setVitals((v) => ({ ...v, [nodeId]: { ...(v[nodeId] ?? { turns: 0 }), turns: (v[nodeId]?.turns ?? 0) + 1 } }));
          }
        }
        if (ev.kind === "usage") {
          setVitals((v) => ({
            ...v,
            [nodeId]: {
              ...(v[nodeId] ?? { turns: 0 }),
              contextUsed: ev.context_used as number | undefined,
              contextLimit: ev.context_limit as number | undefined,
              outputTokens: ev.output_tokens as number | undefined,
              inputTokens: ev.input_tokens as number | undefined,
            },
          }));
        }
      } else if (p.type === "gate_pending" && p.node_id) {
        const nodeId = p.node_id;
        setGates((g) => [
          ...g.filter((x) => x.nodeId !== nodeId),
          {
            nodeId,
            worktree: p.worktree ?? undefined,
            caseText: p.case_text ?? "",
            checklist: p.checklist ?? [],
            outward: p.outward ?? false,
          },
        ]);
      } else if (p.type === "run_finished") {
        setFinished(true);
      }
    }).then((u) => {
      unlisten.current = u;
    });
    return () => {
      live = false;
      unlisten.current?.();
    };
  }, []);

  const start = useCallback(
    async (stage: StageSpec, cards: Record<string, CardPayload>, repoPath: string, goal: string, sessionId: string) => {
      runIdRef.current = "*"; // accept the new run's first events while the id is in flight
      setSession(sessionId);
      setCues({});
      setDetails({});
      setFeeds({});
      setVitals({});
      setGates([]);
      setActivity([]);
      setFailReasons({});
      setDiagnoses({});
      setEscalations([]);
      setFinished(false);
      const id = await invoke<string>("start_run", { stage, cards, repoPath, goal });
      runIdRef.current = id;
      setRunId(id);
      return id;
    },
    []
  );

  const decide = useCallback(
    async (nodeId: string, approve: boolean, memo?: string, action?: string, branch?: string) => {
      if (!runId) return;
      await invoke("gate_decision", { runId, nodeId, approve, memo: memo || null, action: action || null, branch: branch || null });
      setGates((g) => g.filter((x) => x.nodeId !== nodeId));
    },
    [runId]
  );

  const kill = useCallback(
    async (nodeId: string) => {
      if (!runId) return;
      await invoke("kill_node", { runId, nodeId });
    },
    [runId]
  );

  const setPaused = useCallback(async (p: boolean) => {
    await invoke("set_paused", { paused: p });
    setPausedState(p);
  }, []);

  const stop = useCallback(async () => {
    await invoke("stop_run");
    setPausedState(false);
    setGates([]);
    setFinished(true);
  }, []);

  const nudge = useCallback(async (nodeId: string, text: string) => {
    await invoke("nudge_node", { nodeId, text });
  }, []);

  const onEscalation = useCallback(
    (open: (e: Escalation) => void, close: (failedNode: string, retried: boolean, checkNode: string, gateNode: string) => void) => {
      escHandlers.current = { open, close };
    },
    []
  );

  return { runId, session, cues, details, worktrees, feeds, vitals, gates, activeNode, activity, failReasons, diagnoses, escalations, paused, finished, start, decide, kill, setPaused, stop, nudge, onEscalation };
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
