// Cuelight shell: rail | canvas | inspector | status bar.
// M2 wires this to the conductor's live event stream over Tauri IPC; today it
// loads the bundled templates so the canvas, cards, and cue vocabulary are
// real and reviewable.

import { useMemo, useState } from "react";
import type { CueState, StageSpec } from "./types";
import { StageCanvas } from "./canvas/StageCanvas";

import ossContributor from "../templates/oss-contributor.stage.json";
import shipAFeature from "../templates/ship-a-feature.stage.json";
import bugHunt from "../templates/bug-hunt.stage.json";
import testCoverage from "../templates/test-coverage.stage.json";
import nightlyRefactor from "../templates/nightly-refactor.stage.json";
import docsSync from "../templates/docs-sync.stage.json";
import prBabysitter from "../templates/pr-babysitter.stage.json";

const TEMPLATES = [
  ossContributor,
  shipAFeature,
  bugHunt,
  testCoverage,
  nightlyRefactor,
  docsSync,
  prBabysitter,
] as unknown as StageSpec[];

export default function App() {
  const [stageIdx, setStageIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const stage = TEMPLATES[stageIdx];

  // Until the conductor streams real state, every node is idle. The cue map
  // is the single seam the live event stream plugs into.
  const cues = useMemo(() => {
    const m: Record<string, CueState> = {};
    for (const n of stage.nodes) m[n.id] = "idle";
    return m;
  }, [stage]);

  const selectedNode = stage.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="shell">
      <div className="tbar">
        <div className="tname">
          cuelight <span>— {stage.name}</span>
        </div>
        <div className="grow" />
        <span className="hbadge">pre-0.1 · no run active</span>
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
                <span className="hbadge">{t.nodes.length}n</span>
              </div>
            ))}
          </div>
        </div>

        <div className="canvaswrap">
          <StageCanvas stage={stage} cues={cues} currently={{}} onSelect={setSelected} />
        </div>

        <div className="insp">
          {selectedNode ? (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className={`cue ${cues[selectedNode.id]}`} />
                  <span className="role">{selectedNode.label ?? selectedNode.id}</span>
                </div>
                <div className="task">
                  {selectedNode.type === "agent"
                    ? `card: ${selectedNode.card} · permissions: ${selectedNode.permissions ?? "card default"}`
                    : `${selectedNode.gate?.mode} gate${selectedNode.gate?.outward ? " · outward-facing" : ""}`}
                </div>
              </div>
              {selectedNode.promptContext && (
                <>
                  <div className="ilabel">Stage context</div>
                  <div className="iprose">{selectedNode.promptContext}</div>
                </>
              )}
              {selectedNode.killGates && selectedNode.killGates.length > 0 && (
                <>
                  <div className="ilabel">Kill gates</div>
                  <div className="kgates">
                    {selectedNode.killGates.map((k, i) => (
                      <div key={i} className="kgate">
                        {k.check}
                        {k.arg ? ` (${k.arg})` : ""}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {selectedNode.gate?.checklist && (
                <>
                  <div className="ilabel">Gate checklist</div>
                  <div className="kgates">
                    {selectedNode.gate.checklist.map((c, i) => (
                      <div key={i} className="kgate">
                        {c}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{stage.name}</span>
                </div>
                <div className="task">{stage.description}</div>
              </div>
              <div className="ilabel">Select a node</div>
              <div className="iprose">
                Click any agent or gate to inspect its card, kill gates, and checklist.
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
          caps: {stage.caps?.maxOpenPRs != null ? `PRs ${stage.caps.maxOpenPRs} · ` : ""}
          {stage.caps?.maxConcurrentSessions ?? "∞"} concurrent
        </span>
        <div className="grow" />
        <span className="cell">conductor: not connected (M2)</span>
      </div>
    </div>
  );
}
