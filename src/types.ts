// TypeScript mirror of the Rust types crossing the IPC boundary
// (src-tauri/src/events.rs, conductor/stage.rs). Keep in lockstep.

export type CueState = "idle" | "standby" | "working" | "blocked" | "failed";

export interface StageSpec {
  name: string;
  version: string;
  description: string;
  target?: { repoPath?: string; upstream?: string };
  defaults?: { harness?: string; model?: string; effort?: string };
  caps?: {
    maxConcurrentSessions?: number;
    maxSessionsPerDay?: number;
    maxOpenPRs?: number;
    maxOpenPRsPerRepo?: number;
    quotaPriority?: string[];
  };
  nodes: StageNode[];
  edges: StageEdge[];
  /** Saved canvas positions, keyed by node id. Optional; auto-layout fills gaps. */
  layout?: Record<string, { x: number; y: number }>;
}

export interface StageNode {
  id: string;
  type: "agent" | "gate";
  label?: string;
  card?: string;
  harness?: string;
  model?: string;
  effort?: string;
  promptContext?: string;
  permissions?: string;
  trigger?: string;
  killGates?: { check: string; arg?: string; onFail?: string; maxRetries?: number }[];
  gate?: {
    mode: "human" | "auto";
    outward?: boolean;
    batchLimitPerDay?: number;
    checklist?: string[];
  };
}

export interface StageEdge {
  from: string;
  to: string;
  kind?: "flow" | "return";
  label?: string;
}

/** Live per-node state emitted by the conductor. */
export interface NodeState {
  nodeId: string;
  cue: CueState;
  statePill: string;
  currently?: string;
  ctxPct?: number;
  sessionTokens: number;
  attempts: number;
}

export const PILL_BY_CUE: Record<CueState, string> = {
  idle: "IDLE",
  standby: "STANDBY",
  working: "RUNNING",
  blocked: "BLOCKED",
  failed: "FAILED",
};
