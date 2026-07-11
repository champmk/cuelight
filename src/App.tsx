// Cuelight shell: rail (templates + library) | controlled canvas | inspector.
// Templates: bundled (read-only, save-as-copy) + user templates persisted via
// the Rust side to ~/.cuelight/templates (localStorage fallback in browser).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";

import type { StageNode, StageSpec } from "./types";
import { StageCanvas, type DropPayload } from "./canvas/StageCanvas";
import type { AgentNodeData } from "./canvas/nodes";
import { buildEdges, buildNodes, edgeStyle, serializeStage, uniqueNodeId, validateStage } from "./lib/graph";
import { deleteUserTemplate, listUserTemplates, saveUserTemplate } from "./lib/store";

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

const BUNDLED = [
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

type ModalState =
  | { kind: "closed" }
  | { kind: "new" }
  | { kind: "save-as"; from: StageSpec };

export default function App() {
  const [userTemplates, setUserTemplates] = useState<StageSpec[]>([]);
  const [current, setCurrent] = useState<StageSpec>(BUNDLED[0]);
  const [nodes, setNodes] = useState<Node[]>(() => buildNodes(BUNDLED[0]));
  const [edges, setEdges] = useState<Edge[]>(() => buildEdges(BUNDLED[0]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    listUserTemplates().then(setUserTemplates);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const isBundled = BUNDLED.some((t) => t.name === current.name);

  const openTemplate = useCallback((t: StageSpec) => {
    setCurrent(t);
    setNodes(buildNodes(t));
    setEdges(buildEdges(t));
    setSelectedId(null);
    setDirty(false);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type !== "select")) setDirty(true);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const ret = c.sourceHandle === "loop-out" || c.targetHandle === "loop-in";
    setEdges((es) => addEdge({ ...c, label: ret ? "↺ loop" : undefined, ...edgeStyle(ret) }, es));
    setDirty(true);
  }, []);

  const onDropItem = useCallback((p: DropPayload, position: { x: number; y: number }) => {
    setNodes((ns) => {
      const taken = new Set(ns.map((n) => n.id));
      const id = uniqueNodeId(p.kind === "gate" ? `${p.gateMode}-gate` : p.name, taken);
      const spec: StageNode =
        p.kind === "gate"
          ? {
              id,
              type: "gate",
              label: p.displayName ?? "Gate",
              gate: { mode: p.gateMode ?? "human", outward: false, checklist: [] },
            }
          : { id, type: "agent", card: p.name, label: p.displayName ?? p.name };
      return [...ns, { id, type: spec.type, position, data: { spec, cue: "idle" } satisfies AgentNodeData }];
    });
    setDirty(true);
  }, []);

  const updateSpec = useCallback((id: string, patch: Partial<StageNode>) => {
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const d = n.data as AgentNodeData;
        return { ...n, data: { ...d, spec: { ...d.spec, ...patch } } };
      })
    );
    setDirty(true);
  }, []);

  const doSave = useCallback(
    async (spec: StageSpec) => {
      const problems = validateStage(spec);
      if (problems.length > 0) {
        setToast(`Not saved — ${problems[0]}`);
        return false;
      }
      try {
        await saveUserTemplate(spec);
      } catch (e) {
        setToast(`Not saved — ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      setUserTemplates((ts) => [...ts.filter((t) => t.name !== spec.name), spec]);
      setCurrent(spec);
      setDirty(false);
      setToast(`Saved ${spec.name}.stage.json`);
      return true;
    },
    []
  );

  const onSaveClick = useCallback(() => {
    if (isBundled) {
      setModal({ kind: "save-as", from: current });
    } else {
      void doSave(serializeStage(current, nodes, edges));
    }
  }, [isBundled, current, nodes, edges, doSave]);

  const selected: StageNode | null = useMemo(() => {
    const n = nodes.find((n) => n.id === selectedId);
    return n ? (n.data as AgentNodeData).spec : null;
  }, [nodes, selectedId]);

  const card = selected?.card ? AGENT_BY_NAME.get(selected.card) : undefined;

  return (
    <div className="shell">
      <div className="tbar">
        <div className="tname">
          cuelight <span>— {current.name}{dirty ? " •" : ""}</span>
        </div>
        <div className="grow" />
        <div className="gitgroup">
          <span>
            nodes <b>{nodes.length}</b>
          </span>
          <span>
            edges <b>{edges.length}</b>
          </span>
          {isBundled && <span>bundled · read-only</span>}
        </div>
        <button className="tbtn" onClick={onSaveClick}>
          {isBundled ? "Save as copy…" : "Save template"}
        </button>
        <span className="runbtn off">▶ Run — M1</span>
      </div>

      <div className="bodygrid">
        <div className="rail">
          <div>
            <div className="rlabel">
              Templates
              <button className="railadd" onClick={() => setModal({ kind: "new" })} title="Create a new template">
                ＋
              </button>
            </div>
            {BUNDLED.map((t) => (
              <div
                key={t.name}
                className={`railitem ${current.name === t.name ? "on" : ""}`}
                onClick={() => openTemplate(t)}
              >
                <span className={`cue ${current.name === t.name ? "standby" : ""}`} />
                {t.name}
              </div>
            ))}
            {userTemplates.length > 0 && <div className="rlabel sub">Yours</div>}
            {userTemplates.map((t) => (
              <div
                key={t.name}
                className={`railitem ${current.name === t.name ? "on" : ""}`}
                onClick={() => openTemplate(t)}
              >
                <span className={`cue ${current.name === t.name ? "standby" : ""}`} />
                {t.name}
                <button
                  className="raildel"
                  title="Delete this template"
                  onClick={async (ev) => {
                    ev.stopPropagation();
                    await deleteUserTemplate(t.name);
                    setUserTemplates((ts) => ts.filter((x) => x.name !== t.name));
                    if (current.name === t.name) openTemplate(BUNDLED[0]);
                    setToast(`Deleted ${t.name}`);
                  }}
                >
                  ×
                </button>
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
                    JSON.stringify({ kind: "agent", name: a.name, displayName: a.displayName } satisfies DropPayload)
                  );
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">⠿</span>
                {a.displayName ?? a.name}
                <span className="hbadge">{a.harness}</span>
              </div>
            ))}
            <div className="rlabel sub">Gates</div>
            {(
              [
                { mode: "human", label: "Human gate", hint: "you approve" },
                { mode: "auto", label: "Auto gate", hint: "conditions only" },
              ] as const
            ).map((g) => (
              <div
                key={g.mode}
                className="railitem grab"
                title={`${g.hint} — drag onto the canvas`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(
                    "application/cuelight-gate",
                    JSON.stringify({ kind: "gate", name: g.mode, displayName: g.label, gateMode: g.mode } satisfies DropPayload)
                  );
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">◈</span>
                {g.label}
                <span className="hbadge">{g.mode}</span>
              </div>
            ))}
            <div className="railhint">drag anything onto the canvas</div>
          </div>
        </div>

        <div className="canvaswrap">
          <StageCanvas
            key={current.name}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDropItem={onDropItem}
            onSelect={setSelectedId}
          />
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
                  <span className="cue idle" />
                  <span className="role">{selected.label ?? selected.id}</span>
                  <span className="selchip">SELECTED</span>
                  <span className="model">{selected.harness ?? card?.harness ?? "any"}</span>
                </div>
                <div className="task">
                  {selected.type === "agent"
                    ? card?.description ?? `card: ${selected.card}`
                    : `${selected.gate?.mode} gate${selected.gate?.outward ? " — outward: releases pushes/PRs/replies" : ""}`}
                </div>
              </div>

              <div className="iscroll">
                <div className="ilabel">Edit node</div>
                <div className="editrow">
                  <label>Label</label>
                  <input
                    className="tinput"
                    value={selected.label ?? ""}
                    placeholder={selected.id}
                    onChange={(ev) => updateSpec(selected.id, { label: ev.target.value || undefined })}
                  />
                </div>
                {selected.type === "agent" && (
                  <div className="editrow col">
                    <label>Stage context (appended to the card prompt)</label>
                    <textarea
                      className="tinput area"
                      rows={4}
                      value={selected.promptContext ?? ""}
                      placeholder="What this node should know about THIS workflow…"
                      onChange={(ev) => updateSpec(selected.id, { promptContext: ev.target.value || undefined })}
                    />
                  </div>
                )}
                {selected.type === "gate" && selected.gate && (
                  <>
                    <div className="editrow">
                      <label>Mode</label>
                      <select
                        className="tinput"
                        value={selected.gate.mode}
                        disabled={selected.gate.outward}
                        onChange={(ev) =>
                          updateSpec(selected.id, {
                            gate: { ...selected.gate!, mode: ev.target.value as "human" | "auto" },
                          })
                        }
                      >
                        <option value="human">human</option>
                        <option value="auto">auto</option>
                      </select>
                    </div>
                    <div className="editrow">
                      <label title="Outward gates release pushes/PRs/replies and must be human">
                        Outward-facing
                      </label>
                      <input
                        type="checkbox"
                        checked={selected.gate.outward ?? false}
                        onChange={(ev) =>
                          updateSpec(selected.id, {
                            gate: {
                              ...selected.gate!,
                              outward: ev.target.checked,
                              mode: ev.target.checked ? "human" : selected.gate!.mode,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="editrow col">
                      <label>Checklist (one item per line)</label>
                      <textarea
                        className="tinput area"
                        rows={4}
                        value={(selected.gate.checklist ?? []).join("\n")}
                        onChange={(ev) =>
                          updateSpec(selected.id, {
                            gate: {
                              ...selected.gate!,
                              checklist: ev.target.value.split("\n").filter((l) => l.trim() !== ""),
                            },
                          })
                        }
                      />
                    </div>
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
                  <span className="role">{current.name}</span>
                  <span className="model">v{current.version}</span>
                </div>
                <div className="task">{current.description}</div>
              </div>
              <div className="iscroll">
                <div className="ilabel">Build a workflow</div>
                <div className="iprose">
                  Drag agents and gates in from the library, wire them left→right for flow and
                  bottom→top for loops, then Save. Bundled templates save as a copy under Yours;
                  your templates write to ~/.cuelight/templates as .stage.json.
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="bbar">
        <span className="cell">
          <b>{current.name}</b> · {nodes.length} nodes · {edges.length} edges
          {dirty ? " · unsaved" : ""}
        </span>
        <div className="grow" />
        <span className="cell">no run active — conductor lands in M1</span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {modal.kind !== "closed" && (
        <TemplateModal
          initialName={modal.kind === "save-as" ? `${modal.from.name}-custom` : ""}
          initialDesc={modal.kind === "save-as" ? modal.from.description : ""}
          title={modal.kind === "save-as" ? "Save as your template" : "New template"}
          taken={[...BUNDLED, ...userTemplates].map((t) => t.name)}
          allowOverwriteOwn={userTemplates.map((t) => t.name)}
          onCancel={() => setModal({ kind: "closed" })}
          onSubmit={async (name, description) => {
            if (modal.kind === "new") {
              const blank: StageSpec = { name, version: "0.1.0", description, nodes: [], edges: [] };
              const ok = await saveUserTemplate(blank)
                .then(() => true)
                .catch((e) => {
                  setToast(`Not saved — ${e instanceof Error ? e.message : String(e)}`);
                  return false;
                });
              if (!ok) return;
              setUserTemplates((ts) => [...ts.filter((t) => t.name !== name), blank]);
              openTemplate(blank);
              setToast(`Created ${name} — drag agents in, then Save`);
            } else {
              const spec = serializeStage({ ...modal.from, name, description }, nodes, edges);
              await doSave(spec);
            }
            setModal({ kind: "closed" });
          }}
        />
      )}
    </div>
  );
}

function TemplateModal(props: {
  title: string;
  initialName: string;
  initialDesc: string;
  taken: string[];
  allowOverwriteOwn: string[];
  onCancel: () => void;
  onSubmit: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(props.initialName);
  const [desc, setDesc] = useState(props.initialDesc);
  const valid = /^[a-z][a-z0-9-]*$/.test(name);
  const collides = props.taken.includes(name) && !props.allowOverwriteOwn.includes(name);

  return (
    <div className="modalback" onClick={props.onCancel}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="mtitle">{props.title}</div>
        <label className="mlabel">Name (kebab-case)</label>
        <input
          className="tinput"
          autoFocus
          value={name}
          placeholder="my-workflow"
          onChange={(ev) => setName(ev.target.value)}
        />
        {!valid && name !== "" && <div className="mwarn">lowercase letters, digits, dashes; starts with a letter</div>}
        {collides && <div className="mwarn">that name belongs to a bundled template</div>}
        <label className="mlabel">Description</label>
        <textarea
          className="tinput area"
          rows={3}
          value={desc}
          placeholder="What this workflow does, in one or two sentences"
          onChange={(ev) => setDesc(ev.target.value)}
        />
        <div className="mbtns">
          <button className="qbtn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="mprimary"
            disabled={!valid || collides || desc.trim() === ""}
            onClick={() => props.onSubmit(name, desc.trim())}
          >
            {props.title === "New template" ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
