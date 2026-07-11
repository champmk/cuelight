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
  startedAt?: number;
  turns: number;
}

interface EngineEventMsg {
  type: string;
  run_id: string;
  node_id?: string;
  cue?: string;
  detail?: string;
  worktree?: string | null;
  event?: Record<string, unknown> & { kind: string };
  case_text?: string;
  checklist?: string[];
  outward?: boolean;
  status?: string;
}

export interface CardPayload {
  prompt: string;
  permissions: string;
  harness: string;
  model?: string;
  effort?: string;
}

export function useRun() {
  const [runId, setRunId] = useState<string | null>(null);
  const [cues, setCues] = useState<Record<string, CueState>>({});
  const [details, setDetails] = useState<Record<string, string>>({});
  const [worktrees, setWorktrees] = useState<Record<string, string>>({});
  const [feeds, setFeeds] = useState<Record<string, FeedLine[]>>({});
  const [vitals, setVitals] = useState<Record<string, NodeVitals>>({});
  const [gates, setGates] = useState<PendingGate[]>([]);
  const [paused, setPausedState] = useState(false);
  const [finished, setFinished] = useState(false);
  const unlisten = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let live = true;
    listen<EngineEventMsg>("engine-event", ({ payload: p }) => {
      if (!live) return;
      if (p.type === "node_state" && p.node_id) {
        setCues((c) => ({ ...c, [p.node_id!]: (p.cue as CueState) ?? "idle" }));
        setDetails((d) => ({ ...d, [p.node_id!]: p.detail ?? "" }));
        if (p.worktree) setWorktrees((w) => ({ ...w, [p.node_id!]: p.worktree! }));
        if (p.cue === "working") {
          setVitals((v) => ({ ...v, [p.node_id!]: { turns: 0, startedAt: Date.now() } }));
        }
        if (p.cue !== "standby") {
          setGates((g) => g.filter((x) => x.nodeId !== p.node_id));
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
    async (stage: StageSpec, cards: Record<string, CardPayload>, repoPath: string, goal: string) => {
      setCues({});
      setDetails({});
      setFeeds({});
      setVitals({});
      setGates([]);
      setFinished(false);
      const id = await invoke<string>("start_run", { stage, cards, repoPath, goal });
      setRunId(id);
      return id;
    },
    []
  );

  const decide = useCallback(
    async (nodeId: string, approve: boolean, memo?: string) => {
      if (!runId) return;
      await invoke("gate_decision", { runId, nodeId, approve, memo: memo || null });
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

  return { runId, cues, details, worktrees, feeds, vitals, gates, paused, finished, start, decide, kill, setPaused };
}

function sessionToLine(ev: Record<string, unknown> & { kind: string }): FeedLine | null {
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
