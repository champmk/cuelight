// Custom React Flow nodes implementing the design-spec card anatomy:
// header (cue + role + state pill) / static meta / telemetry strip.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CueState, StageNode } from "../types";
import { PILL_BY_CUE } from "../types";

export interface AgentNodeData extends Record<string, unknown> {
  spec: StageNode;
  cue: CueState;
  currently?: string;
  telemetry?: string;
}

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const pill = PILL_BY_CUE[d.cue];
  const cls = [
    "ncard",
    d.cue === "working" ? "live" : "",
    d.cue === "failed" || d.cue === "blocked" ? "err" : "",
    d.cue === "idle" ? "idle" : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} />
      <div className="nhd">
        <span className={`cue ${d.cue}`} />
        <span className="role">{d.spec.label ?? d.spec.card}</span>
        <span className={`pill ${pill}`}>{pill}</span>
      </div>
      <div className="nmeta">
        {d.spec.card}
        {d.spec.trigger?.startsWith("schedule:") ? " · scheduled" : ""}
        {d.spec.permissions ? ` · ${d.spec.permissions}` : ""}
      </div>
      <div className="ntel">
        {d.currently ? <b>{d.currently}</b> : d.telemetry ?? "—"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function GateNode({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const waiting = d.cue === "standby";
  return (
    <div className={`gcard ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="g1">◈ {d.spec.label ?? "Gate"}</div>
      <div className="g2">
        {d.spec.gate?.mode === "human"
          ? waiting
            ? "awaiting your review"
            : "human gate"
          : "auto gate"}
        {d.spec.gate?.outward ? " · outward" : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
