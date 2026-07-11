// Cuelight shell: rail (templates + draggable agent library) | interactive
// canvas | inspector (mock anatomy: tabs, vitals, context, controls).
// M1 replaces the placeholder vitals/controls with the conductor's live
// event stream; everything else here is the shipping layout.

import { useMemo, useState } from "react";
import type { CueState, StageNode, StageSpec } from "./types";
import { StageCanvas } from "./canvas/StageCanvas";

import ossContributor from "../templates/oss-contributor.stage.json";
import shipAFeature from "../templates/ship-a-feature.stage.json";
import bugHunt from "../templates/bug-hunt.stage.json";
import testCoverage from "../templates/test-coverage.stage.json";
import nightlyRefactor from "../templates/nightly-refactor.stage.json";
import docsSync from "../templates/docs-sync.stage.json";
import prBabysitter from "../templates/pr-babysitter.stage.json";

import implementer from "../agents/implementer.agent.json";
import adversarialReviewer from "../agents/adversarial-reviewer.agent.json";
import repoScout from "../agents/repo-scout.agent.json";
import issueTriager from "../agents/issue-triager.agent.json";
import lifecycleMonitor from "../agents/lifecycle-monitor.agent.json";
import securityReviewer from "../agents/security-reviewer.agent.json";
import testEngineer from "../agents/test-engineer.agent.json";
import docsWriter from "../agents/docs-writer.agent.json";
import refactorSurgeon from "../agents/refactor-surgeon.agent.json";
import ideationLead from "../agents/ideation-lead.agent.json";

const TEMPLATES = [
  ossContributor,
  shipAFeature,
  bugHunt,
  testCoverage,
  nightlyRefactor,
  docsSync,
  prBabysitter,
] as unknown as StageSpec[];

interface AgentCard {
  name: string;
  displayName?: string;
  description: string;
  harness: string;
  permissions: string;
  prompt: string;
}

const AGENTS = [
  implementer,
  adversarialReviewer,
  repoScout,
  issueTriager,
  lifecycleMonitor,
  securityReviewer,
  testEngineer,
  docsWriter,
  refactorSurgeon,
  ideationLead,
] as unknown as AgentCard[];

const AGENT_BY_NAME = new Map(AGENTS.map((a) => [a.name, a]));

export default function App() {
  const [stageIdx, setStageIdx] = useState(0);
  const [selected, setSelected] = useState<StageNode | null>(null);
  const stage = TEMPLATES[stageIdx];

  const cues = useMemo(() => {
    const m: Record<string, CueState> = {};
    for (const n of stage.nodes) m[n.id] = "idle";
    return m;
  }, [stage]);

  const card = selected?.card ? AGENT_BY_NAME.get(selected.card) : undefined;

  return (
    <div className="shell">
      <div className="tbar">
        <div className="tname">
          cuelight <span>— {stage.name}</span>
        </div>
        <div className="grow" />
        <div className="gitgroup">
          <span>
            nodes <b>{stage.nodes.length}</b>
          </span>
          <span>
            caps <b>{stage.caps?.maxConcurrentSessions ?? "∞"} conc</b>
          </span>
        </div>
        <span className="runbtn off">▶ Run — M1</span>
      </div>

      <div className="bodygrid">
        <div className="rail">
          <div>
            <div className="rlabel">Templates</div>
            {TEMPLATES.map((t, i) => (
              <div
                key={t.name}
                className={`railitem ${i === stageIdx ? "on" : ""}`}
                onClick={() => {
                  setStageIdx(i);
                  setSelected(null);
                }}
              >
                <span className={`cue ${i === stageIdx ? "standby" : ""}`} />
                {t.name}
              </div>
            ))}
          </div>
          <div>
            <div className="rlabel">Agent library</div>
            {AGENTS.map((a) => (
              <div
                key={a.name}
                className="railitem grab"
                title={`${a.description}\n\nDrag onto the canvas to add.`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(
                    "application/cuelight-agent",
                    JSON.stringify({ name: a.name, displayName: a.displayName })
                  );
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">⠿</span>
                {a.displayName ?? a.name}
                <span className="hbadge">{a.harness}</span>
              </div>
            ))}
            <div className="railhint">drag a card onto the canvas</div>
          </div>
        </div>

        <div className="canvaswrap">
          <StageCanvas stage={stage} cues={cues} onSelect={setSelected} />
        </div>

        <div className="insp">
          <div className="itabs">
            <span className="on">Session</span>
            <span>Diff</span>
            <span>Terminal</span>
            <span>History</span>
          </div>

          {selected ? (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className={`cue ${cues[selected.id] ?? "idle"}`} />
                  <span className="role">{selected.label ?? selected.id}</span>
                  <span className="selchip">SELECTED</span>
                  <span className="model">
                    {selected.harness ?? card?.harness ?? "any"}
                  </span>
                </div>
                <div className="task">
                  {selected.type === "agent"
                    ? card?.description ?? `card: ${selected.card}`
                    : `${selected.gate?.mode} gate${selected.gate?.outward ? " — outward-facing: releases pushes/PRs/replies" : ""}`}
                </div>
              </div>

              <div className="vitals">
                <div className="vit">
                  <span className="k">Context window</span>
                  <div className="v">
                    — <small>no run</small>
                  </div>
                </div>
                <div className="vit">
                  <span className="k">Burn rate</span>
                  <div className="v">
                    — <small>tok/min</small>
                  </div>
                </div>
                <div className="vit">
                  <span className="k">Session tokens</span>
                  <div className="v">
                    — <small>day quota</small>
                  </div>
                </div>
                <div className="vit">
                  <span className="k">Elapsed · turns</span>
                  <div className="v">
                    — <small>· —</small>
                  </div>
                </div>
              </div>

              <div className="iscroll">
                {selected.promptContext && (
                  <>
                    <div className="ilabel">Stage context</div>
                    <div className="iprose">{selected.promptContext}</div>
                  </>
                )}
                {selected.killGates && selected.killGates.length > 0 && (
                  <>
                    <div className="ilabel">Kill gates</div>
                    <div className="kgates">
                      {selected.killGates.map((k, i) => (
                        <div key={i} className="kgate">
                          {k.check}
                          {k.arg ? ` (${k.arg})` : ""}
                          {k.onFail === "retry" ? ` · retry ×${k.maxRetries ?? 1}` : ""}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {selected.gate?.checklist && (
                  <>
                    <div className="ilabel">Gate checklist</div>
                    <div className="kgates">
                      {selected.gate.checklist.map((c, i) => (
                        <div key={i} className="kgate">
                          {c}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {card && (
                  <>
                    <div className="ilabel">Card prompt · {card.permissions}</div>
                    <div className="iprose prompt">{card.prompt}</div>
                  </>
                )}
              </div>

              <div className="ibtns">
                <button className="qbtn" disabled title="Needs an active run (M1)">
                  Pause
                </button>
                <button className="qbtn" disabled title="Needs an active run (M1)">
                  Steer…
                </button>
                <button className="qbtn" disabled title="Needs an active run (M1)">
                  ⟲ Rewind
                </button>
                <span className="sep" />
                <button className="killbtn" disabled title="Needs an active run (M1)">
                  <span>Hold to kill</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{stage.name}</span>
                  <span className="model">v{stage.version}</span>
                </div>
                <div className="task">{stage.description}</div>
              </div>
              <div className="iscroll">
                <div className="ilabel">How to read this canvas</div>
                <div className="iprose">
                  Solid wires run left→right; dashed ↺ wires close the loop. Drag cards to
                  rearrange, drag between handles to rewire, Delete removes a selection, and
                  agents drag in from the library. Select any node to inspect it here.
                </div>
                {stage.caps && (
                  <>
                    <div className="ilabel">Caps (enforced by conductor)</div>
                    <div className="kgates">
                      {Object.entries(stage.caps)
                        .filter(([, v]) => v != null && !Array.isArray(v))
                        .map(([k, v]) => (
                          <div key={k} className="kgate">
                            {k}: {String(v)}
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="bbar">
        <span className="cell">
          <b>{stage.name}</b> · {stage.nodes.length} nodes · {stage.edges.length} edges
        </span>
        <span className="cell">
          <span className="lbl">Grok</span>
          <span className="qtrack">
            <span className="qfill" style={{ width: 0 }} />
          </span>
          —
        </span>
        <span className="cell">
          <span className="lbl">Claude</span>
          <span className="qtrack">
            <span className="qfill" style={{ width: 0 }} />
          </span>
          —
        </span>
        <div className="grow" />
        <span className="cell">no run active — conductor lands in M1</span>
      </div>
    </div>
  );
}
