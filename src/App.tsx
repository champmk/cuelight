// Cuelight shell: rail (workflows + library) | controlled canvas | inspector.
// Save model: bundled workflows are read-only (edits surface "Save changes" →
// save-as-copy); your workflows autosave (toggle in settings); the scratch
// canvas is a free playground whose "Save changes" runs the create flow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { invoke } from "@tauri-apps/api/core";

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

const SCRATCH: StageSpec = {
  name: "scratch",
  version: "0.0.0",
  description: "Scratch canvas — experiment freely; Save changes turns it into a workflow.",
  nodes: [],
  edges: [],
};

type Kind = "bundled" | "user" | "scratch";
type SaveStatus = "clean" | "dirty" | "saving";

interface Settings {
  autosave: boolean;
}

export default function App() {
  const [userWorkflows, setUserWorkflows] = useState<StageSpec[]>([]);
  const [kind, setKind] = useState<Kind>("bundled");
  const [current, setCurrent] = useState<StageSpec>(BUNDLED[0]);
  const [nodes, setNodes] = useState<Node[]>(() => buildNodes(BUNDLED[0]));
  const [edges, setEdges] = useState<Edge[]>(() => buildEdges(BUNDLED[0]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [creator, setCreator] = useState<null | { forScratch: boolean }>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      return { autosave: true, ...JSON.parse(localStorage.getItem("cuelight-settings") ?? "{}") };
    } catch {
      return { autosave: true };
    }
  });
  const canvasKey = useRef(0);

  useEffect(() => {
    listUserTemplates().then(setUserWorkflows);
  }, []);
  useEffect(() => {
    localStorage.setItem("cuelight-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const open = useCallback((spec: StageSpec, k: Kind) => {
    canvasKey.current += 1;
    setKind(k);
    setCurrent(spec);
    setNodes(buildNodes(spec));
    setEdges(buildEdges(spec));
    setSelectedId(null);
    setStatus("clean");
    setMenuFor(null);
  }, []);

  const markDirty = useCallback(() => setStatus((s) => (s === "saving" ? s : "dirty")), []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markDirty();
    },
    [markDirty]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type !== "select")) markDirty();
    },
    [markDirty]
  );
  const onConnect = useCallback(
    (c: Connection) => {
      const ret = c.sourceHandle === "loop-out" || c.targetHandle === "loop-in";
      setEdges((es) => addEdge({ ...c, label: ret ? "↺ loop" : undefined, ...edgeStyle(ret) }, es));
      markDirty();
    },
    [markDirty]
  );
  const onDropItem = useCallback(
    (p: DropPayload, position: { x: number; y: number }) => {
      setNodes((ns) => {
        const taken = new Set(ns.map((n) => n.id));
        const id = uniqueNodeId(p.kind === "gate" ? `${p.gateMode}-gate` : p.name, taken);
        const spec: StageNode =
          p.kind === "gate"
            ? { id, type: "gate", label: p.displayName ?? "Gate", gate: { mode: p.gateMode ?? "human", outward: false, checklist: [] } }
            : { id, type: "agent", card: p.name, label: p.displayName ?? p.name };
        return [...ns, { id, type: spec.type, position, data: { spec, cue: "idle" } satisfies AgentNodeData }];
      });
      markDirty();
    },
    [markDirty]
  );

  const updateSpec = useCallback(
    (id: string, patch: Partial<StageNode>) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n;
          const d = n.data as AgentNodeData;
          return { ...n, data: { ...d, spec: { ...d.spec, ...patch } } };
        })
      );
      markDirty();
    },
    [markDirty]
  );

  const persist = useCallback(
    async (spec: StageSpec, quiet = false): Promise<boolean> => {
      const problems = validateStage(spec);
      if (problems.length > 0) {
        setToast(`Not saved — ${problems[0]}`);
        setStatus("dirty");
        return false;
      }
      setStatus("saving");
      try {
        await saveUserTemplate(spec);
      } catch (e) {
        setToast(`Not saved — ${e instanceof Error ? e.message : String(e)}`);
        setStatus("dirty");
        return false;
      }
      setUserWorkflows((ts) => [...ts.filter((t) => t.name !== spec.name), spec]);
      setCurrent(spec);
      setStatus("clean");
      if (!quiet) setToast(`Saved ${spec.name}`);
      return true;
    },
    []
  );

  // Autosave: your workflows only, when enabled, debounced at the boundary.
  useEffect(() => {
    if (status !== "dirty" || kind !== "user" || !settings.autosave) return;
    const t = setTimeout(() => {
      void persist(serializeStage(current, nodes, edges), true);
    }, 900);
    return () => clearTimeout(t);
  }, [status, kind, settings.autosave, current, nodes, edges, persist]);

  const showSaveChanges =
    status === "dirty" && (kind === "scratch" || kind === "bundled" || !settings.autosave);

  const onSaveChanges = useCallback(() => {
    if (kind === "user") {
      void persist(serializeStage(current, nodes, edges));
    } else {
      setCreator({ forScratch: true }); // scratch or bundled: name it first, then save
    }
  }, [kind, current, nodes, edges, persist]);

  const renameWorkflow = useCallback(
    async (oldName: string, newName: string) => {
      if (oldName === newName) return setRenaming(null);
      if (!/^[a-z][a-z0-9-]*$/.test(newName) || BUNDLED.some((b) => b.name === newName) || userWorkflows.some((u) => u.name === newName)) {
        setToast("Rename failed — invalid or taken name");
        return setRenaming(null);
      }
      const spec = userWorkflows.find((t) => t.name === oldName);
      if (!spec) return setRenaming(null);
      const renamed = { ...spec, name: newName };
      try {
        await saveUserTemplate(renamed);
        await deleteUserTemplate(oldName);
      } catch (e) {
        setToast(`Rename failed — ${e instanceof Error ? e.message : String(e)}`);
        return setRenaming(null);
      }
      setUserWorkflows((ts) => [...ts.filter((t) => t.name !== oldName), renamed]);
      if (current.name === oldName) setCurrent(renamed);
      setRenaming(null);
      setToast(`Renamed to ${newName}`);
    },
    [userWorkflows, current.name]
  );

  const selected: StageNode | null = useMemo(() => {
    const n = nodes.find((n) => n.id === selectedId);
    return n ? (n.data as AgentNodeData).spec : null;
  }, [nodes, selectedId]);
  const card = selected?.card ? AGENT_BY_NAME.get(selected.card) : undefined;

  const statusChip =
    status === "clean" ? (kind === "scratch" ? "scratch" : "✓ up to date")
    : status === "saving" ? "saving…"
    : "• unsaved";

  return (
    <div className="shell" onClick={() => setMenuFor(null)}>
      <div className="tbar">
        <div className="tname">
          cuelight <span>— {kind === "scratch" ? "scratch canvas" : current.name}</span>
        </div>
        <span className={`statuschip ${status}`}>{statusChip}</span>
        <div className="grow" />
        {showSaveChanges && (
          <button className="tbtn primary" onClick={onSaveChanges}>
            Save changes{kind !== "user" ? "…" : ""}
          </button>
        )}
        <span className="runbtn off">▶ Run — M1</span>
        <button className="tbtn icon" title="Settings" onClick={(ev) => { ev.stopPropagation(); setSettingsOpen((o) => !o); }}>
          ⚙
        </button>
        {settingsOpen && (
          <div className="settings" onClick={(ev) => ev.stopPropagation()}>
            <div className="mtitle">Settings</div>
            <label className="setrow">
              <input
                type="checkbox"
                checked={settings.autosave}
                onChange={(ev) => setSettings((s) => ({ ...s, autosave: ev.target.checked }))}
              />
              Autosave canvas changes to your workflows
            </label>
            <div className="sethint">When off, a Save changes button appears instead.</div>
          </div>
        )}
      </div>

      <div className="bodygrid">
        <div className="rail">
          <div>
            <div className="rlabel">
              Workflows
              <button className="railadd" title="New workflow" onClick={(ev) => { ev.stopPropagation(); setCreator({ forScratch: false }); }}>
                ＋
              </button>
            </div>
            <div
              className={`railitem scratch ${kind === "scratch" ? "on" : ""}`}
              onClick={() => open(SCRATCH, "scratch")}
              title="A free playground — nothing saves unless you ask"
            >
              <span className="gr">✎</span>
              scratch canvas
            </div>
            {BUNDLED.map((t) => (
              <div key={t.name} className={`railitem ${kind === "bundled" && current.name === t.name ? "on" : ""}`} onClick={() => open(t, "bundled")}>
                <span className={`cue ${kind === "bundled" && current.name === t.name ? "standby" : ""}`} />
                {t.name}
              </div>
            ))}
            {userWorkflows.length > 0 && <div className="rlabel sub">Yours</div>}
            {userWorkflows
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => (
                <div key={t.name} className={`railitem ${kind === "user" && current.name === t.name ? "on" : ""}`} onClick={() => open(t, "user")}>
                  <span className={`cue ${kind === "user" && current.name === t.name ? "standby" : ""}`} />
                  {renaming === t.name ? (
                    <input
                      className="tinput rename"
                      autoFocus
                      defaultValue={t.name}
                      onClick={(ev) => ev.stopPropagation()}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") void renameWorkflow(t.name, (ev.target as HTMLInputElement).value);
                        if (ev.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(ev) => void renameWorkflow(t.name, ev.target.value)}
                    />
                  ) : (
                    t.name
                  )}
                  <button
                    className="kebab"
                    title="Options"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setMenuFor(menuFor === t.name ? null : t.name);
                    }}
                  >
                    ⋮
                  </button>
                  {menuFor === t.name && (
                    <div className="menu" onClick={(ev) => ev.stopPropagation()}>
                      <div
                        className="mi"
                        onClick={() => {
                          setMenuFor(null);
                          setRenaming(t.name);
                        }}
                      >
                        Edit name
                      </div>
                      <div
                        className="mi danger"
                        onClick={async () => {
                          setMenuFor(null);
                          await deleteUserTemplate(t.name);
                          setUserWorkflows((ts) => ts.filter((x) => x.name !== t.name));
                          if (kind === "user" && current.name === t.name) open(BUNDLED[0], "bundled");
                          setToast(`Deleted ${t.name}`);
                        }}
                      >
                        Delete
                      </div>
                    </div>
                  )}
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
                  ev.dataTransfer.setData("application/cuelight-agent", JSON.stringify({ kind: "agent", name: a.name, displayName: a.displayName } satisfies DropPayload));
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">⠿</span>
                {a.displayName ?? a.name}
                <span className="hbadge">{a.harness}</span>
              </div>
            ))}
            <div className="rlabel sub">Gates</div>
            {([
              { mode: "human", label: "Human gate", hint: "you approve" },
              { mode: "auto", label: "Auto gate", hint: "conditions only" },
            ] as const).map((g) => (
              <div
                key={g.mode}
                className="railitem grab"
                title={`${g.hint} — drag onto the canvas`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("application/cuelight-gate", JSON.stringify({ kind: "gate", name: g.mode, displayName: g.label, gateMode: g.mode } satisfies DropPayload));
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">◈</span>
                {g.label}
                <span className="hbadge">{g.mode}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="canvaswrap">
          <StageCanvas
            key={canvasKey.current}
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
                  <input className="tinput" value={selected.label ?? ""} placeholder={selected.id} onChange={(ev) => updateSpec(selected.id, { label: ev.target.value || undefined })} />
                </div>
                {selected.type === "agent" && (
                  <div className="editrow col">
                    <label>Stage context (appended to the card prompt)</label>
                    <textarea className="tinput area" rows={4} value={selected.promptContext ?? ""} placeholder="What this node should know about THIS workflow…" onChange={(ev) => updateSpec(selected.id, { promptContext: ev.target.value || undefined })} />
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
                        onChange={(ev) => updateSpec(selected.id, { gate: { ...selected.gate!, mode: ev.target.value as "human" | "auto" } })}
                      >
                        <option value="human">human</option>
                        <option value="auto">auto</option>
                      </select>
                    </div>
                    <div className="editrow">
                      <label title="Outward gates release pushes/PRs/replies and must be human">Outward-facing</label>
                      <input
                        type="checkbox"
                        checked={selected.gate.outward ?? false}
                        onChange={(ev) => updateSpec(selected.id, { gate: { ...selected.gate!, outward: ev.target.checked, mode: ev.target.checked ? "human" : selected.gate!.mode } })}
                      />
                    </div>
                    <div className="editrow col">
                      <label>Checklist (one item per line)</label>
                      <textarea
                        className="tinput area"
                        rows={4}
                        value={(selected.gate.checklist ?? []).join("\n")}
                        onChange={(ev) => updateSpec(selected.id, { gate: { ...selected.gate!, checklist: ev.target.value.split("\n").filter((l) => l.trim() !== "") } })}
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
                <button className="qbtn" disabled title="Needs an active run (M1)">Pause</button>
                <button className="qbtn" disabled title="Needs an active run (M1)">Steer…</button>
                <span className="sep" />
                <button className="killbtn" disabled title="Needs an active run (M1)"><span>Hold to kill</span></button>
              </div>
            </>
          ) : (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{kind === "scratch" ? "scratch canvas" : current.name}</span>
                  {kind !== "scratch" && <span className="model">v{current.version}</span>}
                </div>
                <div className="task">{current.description}</div>
              </div>
              <div className="iscroll">
                <div className="ilabel">Build a workflow</div>
                <div className="iprose">
                  Drag agents and gates in from the library; wire left→right for flow, bottom→top for loops.
                  {kind === "bundled" && " This workflow is bundled (read-only) — edits become your copy when you save."}
                  {kind === "scratch" && " Nothing here persists unless you hit Save changes."}
                  {kind === "user" && (settings.autosave ? " Autosave is on — edits persist at the boundary." : " Autosave is off — use Save changes.")}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="bbar">
        <span className="cell">
          <b>{kind === "scratch" ? "scratch" : current.name}</b> · {nodes.length} nodes · {edges.length} edges
        </span>
        <div className="grow" />
        <span className="cell">no run active — conductor lands in M1</span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {creator && (
        <CreateWorkflowModal
          taken={[...BUNDLED.map((t) => t.name), ...userWorkflows.map((t) => t.name)]}
          hasCanvas={creator.forScratch}
          onCancel={() => setCreator(null)}
          onBlank={async (name, description) => {
            // From the ＋ button: a named empty workflow. From Save changes:
            // the current canvas becomes the workflow's first contents.
            const base: StageSpec = { name, version: "0.1.0", description, nodes: [], edges: [] };
            const spec = creator.forScratch ? serializeStage(base, nodes, edges) : base;
            const ok = await persist(spec);
            if (ok) {
              open(spec, "user");
              setCreator(null);
            }
          }}
          onGenerate={async (name, description) => {
            const json = await invoke<string>("generate_template", { name, description });
            const spec = JSON.parse(json) as StageSpec;
            const ok = await persist(spec);
            if (ok) {
              open(spec, "user");
              setCreator(null);
              setToast(`Generated ${name} — review the graph before trusting it`);
            }
          }}
        />
      )}
    </div>
  );
}

function CreateWorkflowModal(props: {
  taken: string[];
  hasCanvas: boolean;
  onCancel: () => void;
  onBlank: (name: string, description: string) => Promise<void>;
  onGenerate: (name: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState<null | "blank" | "generate">(null);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9-]*$/.test(name);
  const collides = props.taken.includes(name);
  const ready = valid && !collides && desc.trim() !== "";

  const run = async (which: "blank" | "generate") => {
    setBusy(which);
    setErr(null);
    try {
      if (which === "blank") await props.onBlank(name, desc.trim());
      else await props.onGenerate(name, desc.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="modalback" onClick={() => busy || props.onCancel()}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="mtitle">{props.hasCanvas ? "Save canvas as a workflow" : "New workflow"}</div>
        <label className="mlabel">Name (kebab-case)</label>
        <input className="tinput" autoFocus value={name} placeholder="my-workflow" onChange={(ev) => setName(ev.target.value)} disabled={!!busy} />
        {!valid && name !== "" && <div className="mwarn">lowercase letters, digits, dashes; starts with a letter</div>}
        {collides && <div className="mwarn">that name is taken</div>}
        <label className="mlabel">{props.hasCanvas ? "Description" : "Description — also the brief if you generate"}</label>
        <textarea
          className="tinput area"
          rows={4}
          value={desc}
          placeholder={props.hasCanvas ? "What this workflow does" : "e.g. Every night, find flaky tests in my repo, fix the top one with a proven repro, and queue it for my morning review"}
          onChange={(ev) => setDesc(ev.target.value)}
          disabled={!!busy}
        />
        {err && <div className="mwarn">{err}</div>}
        <div className="mbtns">
          <button className="qbtn" onClick={props.onCancel} disabled={!!busy}>
            Cancel
          </button>
          <button className="qbtn" disabled={!ready || !!busy} onClick={() => run("blank")}>
            {busy === "blank" ? "Saving…" : props.hasCanvas ? "Save canvas" : "Blank canvas"}
          </button>
          {!props.hasCanvas && (
            <button className="mprimary" disabled={!ready || !!busy} onClick={() => run("generate")}>
              {busy === "generate" ? "Generating… (runs a Grok session)" : "✦ Generate from description"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
