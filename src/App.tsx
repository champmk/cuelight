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
import { StageCanvas, type CtxMenu, type DropPayload } from "./canvas/StageCanvas";
import { Select } from "./ui/Select";
import type { AgentNodeData } from "./canvas/nodes";
import { buildEdges, buildNodes, edgeStyle, serializeStage, uniqueNodeId, validateStage } from "./lib/graph";
import {
  deleteUserTemplate,
  listUserTemplates,
  saveUserTemplate,
  listUserAgents,
  saveUserAgent,
  deleteUserAgent,
  listGatePresets,
  saveGatePreset,
  deleteGatePreset,
  type AgentCardFile,
  type GatePreset,
} from "./lib/store";
import { useRun, type CardPayload } from "./run/useRun";
import { ReviewView } from "./run/ReviewView";

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
  effort?: string;
  prompt: string;
  builtin?: boolean;
}

const BUILTIN_AGENTS = ([
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
] as unknown as AgentCard[]).map((a) => ({ ...a, builtin: true }));

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
  const [userAgents, setUserAgents] = useState<AgentCard[]>([]);
  const [gatePresets, setGatePresets] = useState<GatePreset[]>([]);
  const [agentEditor, setAgentEditor] = useState<null | { card?: AgentCard }>(null);
  const [gateEditor, setGateEditor] = useState<null | { preset?: GatePreset }>(null);
  const [libMenu, setLibMenu] = useState<string | null>(null);
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

  const run = useRun();
  const [runModal, setRunModal] = useState(false);
  const [reviewFor, setReviewFor] = useState<string | null>(null);
  const [tab, setTab] = useState<"Chat" | "Diff" | "Config" | "Log">("Chat");
  const runActive = run.runId !== null && !run.finished;

  // ---- editor plumbing: history, clipboard, selection, context menu ----
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const past = useRef<Array<{ n: Node[]; e: Edge[] }>>([]);
  const future = useRef<Array<{ n: Node[]; e: Edge[] }>>([]);
  const clipboard = useRef<Array<{ spec: StageNode; x: number; y: number }>>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const chatRef = useRef<HTMLDivElement>(null);

  // Keep the chat pinned to the newest message as it streams.
  useEffect(() => {
    if (tab === "Chat" && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [tab, selectedId, run.feeds]);

  const snapshot = useCallback(() => {
    past.current.push({ n: structuredClone(nodesRef.current), e: structuredClone(edgesRef.current) });
    if (past.current.length > 50) past.current.shift();
    future.current = [];
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ n: structuredClone(nodesRef.current), e: structuredClone(edgesRef.current) });
    setNodes(prev.n);
    setEdges(prev.e);
    setStatus("dirty");
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ n: structuredClone(nodesRef.current), e: structuredClone(edgesRef.current) });
    setNodes(next.n);
    setEdges(next.e);
    setStatus("dirty");
  }, []);

  const copySelection = useCallback(() => {
    clipboard.current = nodesRef.current
      .filter((n) => selectionIds.includes(n.id))
      .map((n) => ({ spec: structuredClone((n.data as AgentNodeData).spec), x: n.position.x, y: n.position.y }));
  }, [selectionIds]);

  const paste = useCallback(() => {
    if (clipboard.current.length === 0) return;
    snapshot();
    setNodes((ns) => {
      const taken = new Set(ns.map((n) => n.id));
      const added = clipboard.current.map((c) => {
        const id = uniqueNodeId(c.spec.id, taken);
        taken.add(id);
        const spec = { ...structuredClone(c.spec), id };
        return { id, type: spec.type, position: { x: c.x + 33, y: c.y + 33 }, data: { spec, cue: "idle" } satisfies AgentNodeData } as Node;
      });
      return [...ns, ...added];
    });
    setStatus("dirty");
  }, [snapshot]);

  const deleteById = useCallback((id: string, isEdge: boolean) => {
    snapshot();
    if (isEdge) setEdges((es) => es.filter((e) => e.id !== id));
    else {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    }
    setStatus("dirty");
    setCtxMenu(null);
  }, [snapshot]);

  const duplicateNode = useCallback((id: string) => {
    const n = nodesRef.current.find((n) => n.id === id);
    if (!n) return;
    snapshot();
    setNodes((ns) => {
      const taken = new Set(ns.map((x) => x.id));
      const spec = structuredClone((n.data as AgentNodeData).spec);
      spec.id = uniqueNodeId(spec.id, taken);
      return [...ns, { id: spec.id, type: spec.type, position: { x: n.position.x + 33, y: n.position.y + 33 }, data: { spec, cue: "idle" } satisfies AgentNodeData } as Node];
    });
    setStatus("dirty");
    setCtxMenu(null);
  }, [snapshot]);

  const autoLayout = useCallback(() => {
    snapshot();
    const spec = serializeStage(current, nodesRef.current, edgesRef.current);
    const fresh = buildNodes({ ...spec, layout: undefined });
    setNodes((ns) =>
      ns.map((n) => {
        const f = fresh.find((x) => x.id === n.id);
        return f ? { ...n, position: f.position } : n;
      })
    );
    setStatus("dirty");
  }, [current, snapshot]);

  // Keyboard: undo/redo/copy/paste (skip when typing in inputs).
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return;
      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && ev.shiftKey)) { ev.preventDefault(); redo(); }
      else if (k === "c") { copySelection(); }
      else if (k === "v") { ev.preventDefault(); paste(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [undo, redo, copySelection, paste]);

  // Push live run state into the node cards (cue lights + "currently" line).
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) => {
        const d = n.data as AgentNodeData;
        const cue = run.cues[n.id] ?? "idle";
        const currently = run.details[n.id];
        if (d.cue === cue && d.currently === currently) return n;
        return { ...n, data: { ...d, cue, currently } };
      })
    );
  }, [run.cues, run.details]);

  // Escalation: inject/remove the check + resolution overlay nodes.
  useEffect(() => {
    run.onEscalation(
      (esc) => {
        const failed = nodesRef.current.find((n) => n.id === esc.failedNode);
        const bx = failed?.position.x ?? 200;
        const by = failed?.position.y ?? 200;
        const checkSpec: StageNode = { id: esc.checkNode, type: "agent", card: "diagnostic", label: "Failure check" };
        const gateSpec: StageNode = { id: esc.gateNode, type: "gate", label: "Resolve & retry", gate: { mode: "human", outward: false, checklist: [] } };
        setNodes((ns) => [
          ...ns.filter((n) => n.id !== esc.checkNode && n.id !== esc.gateNode),
          { id: esc.checkNode, type: "agent", position: { x: bx + 220, y: by + 30 }, className: "esc-enter", data: { spec: checkSpec, cue: "working", ephemeral: true } as AgentNodeData },
          { id: esc.gateNode, type: "gate", position: { x: bx + 220, y: by + 170 }, className: "esc-enter", data: { spec: gateSpec, cue: "standby", ephemeral: true } as AgentNodeData },
        ]);
        setEdges((es) => [
          ...es.filter((e) => e.target !== esc.checkNode && e.target !== esc.gateNode),
          { id: `esc-${esc.failedNode}-check`, source: esc.failedNode, target: esc.checkNode, ...edgeStyle(false), className: "esc-edge" } as Edge,
          { id: `esc-${esc.checkNode}-gate`, source: esc.checkNode, target: esc.gateNode, ...edgeStyle(false), className: "esc-edge" } as Edge,
        ]);
      },
      (_failedNode, _retried, checkNode, gateNode) => {
        setNodes((ns) => ns.map((n) => (n.id === checkNode || n.id === gateNode ? { ...n, className: "esc-leave" } : n)));
        setTimeout(() => {
          setNodes((ns) => ns.filter((n) => n.id !== checkNode && n.id !== gateNode));
          setEdges((es) => es.filter((e) => e.source !== checkNode && e.source !== gateNode && e.target !== checkNode && e.target !== gateNode));
        }, 420);
      }
    );
  }, [run.onEscalation]);

  useEffect(() => {
    listUserTemplates().then(setUserWorkflows);
    listUserAgents().then((a) => setUserAgents(a.map((c) => ({ ...c, builtin: false }))));
    setGatePresets(listGatePresets());
  }, []);

  const allAgents = useMemo(() => [...BUILTIN_AGENTS, ...userAgents], [userAgents]);
  const AGENT_BY_NAME = useMemo(() => new Map(allAgents.map((a) => [a.name, a])), [allAgents]);
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
      if (changes.some((c) => c.type === "remove")) snapshot();
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markDirty();
    },
    [markDirty, snapshot]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some((c) => c.type === "remove")) snapshot();
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type !== "select")) markDirty();
    },
    [markDirty, snapshot]
  );
  const onConnect = useCallback(
    (c: Connection) => {
      snapshot();
      const ret = c.sourceHandle === "loop-out" || c.targetHandle === "loop-in";
      setEdges((es) => addEdge({ ...c, label: ret ? "↺ loop" : undefined, ...edgeStyle(ret) }, es));
      markDirty();
    },
    [markDirty, snapshot]
  );
  const onDropItem = useCallback(
    (p: DropPayload, position: { x: number; y: number }) => {
      snapshot();
      setNodes((ns) => {
        const taken = new Set(ns.map((n) => n.id));
        const id = uniqueNodeId(p.kind === "gate" ? `${p.gateMode}-gate` : p.name, taken);
        const spec: StageNode =
          p.kind === "gate"
            ? { id, type: "gate", label: p.displayName ?? "Gate", gate: { mode: p.gateMode ?? "human", outward: p.outward ?? false, checklist: p.checklist ?? [] } }
            : { id, type: "agent", card: p.name, label: p.displayName ?? p.name };
        return [...ns, { id, type: spec.type, position, data: { spec, cue: "idle" } satisfies AgentNodeData }];
      });
      markDirty();
    },
    [markDirty, snapshot]
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

  // Autosave any named workflow (bundled or yours) when enabled. Editing a
  // bundled template writes an override under the SAME name into
  // ~/.cuelight/templates — you update the workflow in place, not a copy.
  // Only the scratch canvas (which has no name yet) needs an explicit save.
  useEffect(() => {
    if (status !== "dirty" || kind === "scratch" || !settings.autosave) return;
    const t = setTimeout(() => {
      void persist(serializeStage(current, nodes, edges), true);
    }, 900);
    return () => clearTimeout(t);
  }, [status, kind, settings.autosave, current, nodes, edges, persist]);

  const showSaveChanges = status === "dirty" && (kind === "scratch" || !settings.autosave);

  const onSaveChanges = useCallback(() => {
    if (kind === "scratch") {
      setCreator({ forScratch: true }); // scratch has no name — name it, then save
    } else {
      void persist(serializeStage(current, nodes, edges)); // update in place (override)
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

  // Resolve the model + effort actually in effect for the selected node.
  const rHarness =
    selected?.harness && selected.harness !== "any"
      ? selected.harness
      : card?.harness && card.harness !== "any"
        ? card.harness
        : "grok";
  const modelLabel = selected?.model ?? (rHarness === "grok" ? "grok-4.5" : rHarness === "claude" ? "claude" : rHarness);
  const effortLabel = selected?.effort ?? "high";

  const statusChip =
    status === "clean" ? (kind === "scratch" ? "scratch" : "✓ up to date")
    : status === "saving" ? "saving…"
    : "• unsaved";

  return (
    <div className="shell" onClick={() => { setMenuFor(null); setLibMenu(null); }}>
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
        {runActive && (
          <>
            <button className="tbtn" onClick={() => void run.setPaused(!run.paused)}>
              {run.paused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button className="tbtn stop" onClick={() => void run.stop()} title="Stop the run — cancels all sessions and gates">
              ■ Stop
            </button>
          </>
        )}
        <button
          className={`runbtn ${runActive ? "" : "ready"}`}
          disabled={runActive}
          onClick={() => setRunModal(true)}
          title={runActive ? "Run in progress" : "Launch this workflow"}
        >
          {runActive ? (run.paused ? "Run paused" : "Run live") : "▶ Run"}
        </button>
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
            {BUNDLED.map((t) => {
              const override = userWorkflows.find((u) => u.name === t.name);
              const edited = !!override;
              return (
                <div key={t.name} className={`railitem ${kind === "bundled" && current.name === t.name ? "on" : ""}`} onClick={() => open(override ?? t, "bundled")}>
                  <span className={`cue ${kind === "bundled" && current.name === t.name ? "standby" : ""}`} />
                  {t.name}
                  {edited && <span className="editflag" title="You've edited this workflow">edited</span>}
                  {edited && (
                    <>
                      <button className="kebab" title="Options" onClick={(ev) => { ev.stopPropagation(); setMenuFor(menuFor === `b:${t.name}` ? null : `b:${t.name}`); }}>⋮</button>
                      {menuFor === `b:${t.name}` && (
                        <div className="menu" onClick={(ev) => ev.stopPropagation()}>
                          <div className="mi danger" onClick={async () => {
                            setMenuFor(null);
                            await deleteUserTemplate(t.name);
                            setUserWorkflows((ts) => ts.filter((x) => x.name !== t.name));
                            if (current.name === t.name) open(t, "bundled");
                            setToast(`Reverted ${t.name} to default`);
                          }}>Revert to default</div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
            {userWorkflows.some((t) => !BUNDLED.some((b) => b.name === t.name)) && <div className="rlabel sub">Yours</div>}
            {userWorkflows
              .filter((t) => !BUNDLED.some((b) => b.name === t.name))
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
            <div className="rlabel">
              Agent library
              <button className="railadd" title="New agent" onClick={(ev) => { ev.stopPropagation(); setAgentEditor({}); }}>＋</button>
            </div>
            {allAgents.map((a) => (
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
                <button
                  className="kebab"
                  title="Options"
                  onClick={(ev) => { ev.stopPropagation(); setLibMenu(libMenu === `a:${a.name}` ? null : `a:${a.name}`); }}
                >⋮</button>
                {libMenu === `a:${a.name}` && (
                  <div className="menu" onClick={(ev) => ev.stopPropagation()}>
                    <div className="mi" onClick={() => { setLibMenu(null); setAgentEditor({ card: a }); }}>
                      {a.builtin ? "Duplicate & edit" : "Edit"}
                    </div>
                    {!a.builtin && (
                      <div className="mi danger" onClick={async () => { setLibMenu(null); await deleteUserAgent(a.name); setUserAgents((xs) => xs.filter((x) => x.name !== a.name)); setToast(`Deleted ${a.name}`); }}>
                        Delete
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="rlabel sub">
              Gates
              <button className="railadd" title="New gate preset" onClick={(ev) => { ev.stopPropagation(); setGateEditor({}); }}>＋</button>
            </div>
            {([
              { name: "human", label: "Human gate", mode: "human" as const, outward: false, checklist: [] as string[], builtin: true },
              { name: "auto", label: "Auto gate", mode: "auto" as const, outward: false, checklist: [] as string[], builtin: true },
              ...gatePresets.map((g) => ({ ...g, builtin: false })),
            ]).map((g) => (
              <div
                key={g.name}
                className="railitem grab"
                title={`${g.mode} gate${g.outward ? " · outward" : ""} — drag onto the canvas`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("application/cuelight-gate", JSON.stringify({ kind: "gate", name: g.name, displayName: g.label, gateMode: g.mode, outward: g.outward, checklist: g.checklist } satisfies DropPayload));
                  ev.dataTransfer.effectAllowed = "copy";
                }}
              >
                <span className="gr">◈</span>
                {g.label}
                {g.builtin ? (
                  <span className="hbadge">{g.mode}</span>
                ) : (
                  <button
                    className="kebab"
                    title="Options"
                    onClick={(ev) => { ev.stopPropagation(); setLibMenu(libMenu === `g:${g.name}` ? null : `g:${g.name}`); }}
                  >⋮</button>
                )}
                {libMenu === `g:${g.name}` && (
                  <div className="menu" onClick={(ev) => ev.stopPropagation()}>
                    <div className="mi" onClick={() => { setLibMenu(null); setGateEditor({ preset: g }); }}>Edit</div>
                    <div className="mi danger" onClick={() => { setLibMenu(null); deleteGatePreset(g.name); setGatePresets(listGatePresets()); setToast(`Deleted ${g.label}`); }}>Delete</div>
                  </div>
                )}
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
            onEdgesSet={(updater) => { setEdges(updater); markDirty(); }}
            onDropItem={onDropItem}
            onSelect={setSelectedId}
            onSelectionIds={setSelectionIds}
            onContextMenu={setCtxMenu}
            onAutoLayout={autoLayout}
            onSnapshot={snapshot}
          />
          {ctxMenu && (
            <div className="ctxmenu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={() => setCtxMenu(null)}>
              {ctxMenu.kind === "node" && ctxMenu.id && (
                <>
                  <div className="mi" onClick={() => duplicateNode(ctxMenu.id!)}>Duplicate</div>
                  <div className="mi" onClick={() => { copySelection(); setCtxMenu(null); }}>Copy</div>
                  <div className="mi danger" onClick={() => deleteById(ctxMenu.id!, false)}>Delete node</div>
                </>
              )}
              {ctxMenu.kind === "edge" && ctxMenu.id && (
                <div className="mi danger" onClick={() => deleteById(ctxMenu.id!, true)}>Delete connection</div>
              )}
              {ctxMenu.kind === "pane" && (
                <>
                  <div className={`mi ${clipboard.current.length ? "" : "off"}`} onClick={() => { if (clipboard.current.length) paste(); }}>
                    Paste{clipboard.current.length ? ` (${clipboard.current.length})` : ""}
                  </div>
                  <div className="mi" onClick={() => { autoLayout(); setCtxMenu(null); }}>Auto-layout</div>
                </>
              )}
            </div>
          )}
          {run.gates.length > 0 && (
            <div className="dock">
              <div className="dh">
                ◈ Action required <i>{run.gates.length}</i>
              </div>
              {run.gates.map((g) => (
                <div key={g.nodeId} className="di" onClick={() => setReviewFor(g.nodeId)}>
                  <b>{g.nodeId}</b>
                  {g.outward ? " · outward" : ""}
                  <span>review →</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="insp">
          {selected ? (() => {
            const isAgent = selected.type === "agent";
            const liveCue = run.cues[selected.id] ?? "idle";
            const v = run.vitals[selected.id];
            const feed = run.feeds[selected.id] ?? [];
            const failReason = run.failReasons[selected.id];
            const diagnosis = run.diagnoses[selected.id];
            const gatePending = run.gates.find((g) => g.nodeId === selected.id);
            const end = v?.endedAt ?? Date.now();
            const elapsedSec = v?.startedAt ? Math.round((end - v.startedAt) / 1000) : null;
            const elapsedStr = elapsedSec != null ? `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}` : "—";
            const ctxPct = v?.contextUsed && v?.contextLimit ? Math.round((v.contextUsed / v.contextLimit) * 100) : null;
            const burn = v?.outputTokens && elapsedSec && elapsedSec > 0 ? Math.round(v.outputTokens / (elapsedSec / 60)) : null;
            const fmtK = (n?: number) => (n != null ? (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`) : "—");
            const isExec = (k: string) => k === "tool" || k === "ok" || k === "bad";

            return (
              <>
                <div className="ihead">
                  <div className="r1">
                    <span className={`cue ${liveCue}`} />
                    <span className="role">{selected.label ?? selected.id}</span>
                    {isAgent && <span className="model">{modelLabel} · {effortLabel}</span>}
                  </div>
                  <div className="task">
                    {isAgent
                      ? card?.description ?? `card: ${selected.card ?? "diagnostic"}`
                      : `${selected.gate?.mode ?? "human"} gate${selected.gate?.outward ? " · outward-facing" : ""}`}
                  </div>
                </div>

                {isAgent && (
                  <div className="vitals">
                    <div className="vit">
                      <span className="k">Context</span>
                      <div className="v">{fmtK(v?.contextUsed)} <small>/ {fmtK(v?.contextLimit)}{ctxPct != null ? ` · ${ctxPct}%` : ""}</small></div>
                      <div className="ctxbar"><span style={{ width: `${Math.min(100, ctxPct ?? 0)}%` }} /></div>
                    </div>
                    <div className="vit"><span className="k">Burn rate</span><div className="v">{burn != null ? fmtK(burn) : "—"} <small>tok/min</small></div></div>
                    <div className="vit"><span className="k">Tokens</span><div className="v">{fmtK(v?.outputTokens)} <small>output</small></div></div>
                    <div className="vit"><span className="k">Elapsed · turns</span><div className="v">{elapsedStr} <small>· {v?.turns ?? 0}</small></div></div>
                  </div>
                )}

                <div className="itabs">
                  {(["Chat", "Diff", "Config", "Log"] as const).map((t) => (
                    <span key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</span>
                  ))}
                </div>

                {failReason && (
                  <div className="failcard">
                    <div className="fc-top"><span className="fc-dot" /> Step failed</div>
                    <div className="fc-reason">{failReason}</div>
                    {diagnosis && (
                      <div className="fc-diag">
                        <div className="fc-diag-label">Diagnosis · grok-composer-fast</div>
                        <div className="fc-diag-body">{diagnosis}</div>
                      </div>
                    )}
                  </div>
                )}

                {tab === "Chat" && (
                  <div className="chat" ref={chatRef}>
                    {feed.length === 0 ? (
                      <div className="chat-empty">{liveCue === "working" ? "The agent is starting…" : "No session yet. Run this workflow to see the agent work here."}</div>
                    ) : (
                      feed.map((l, i) => {
                        if (l.kind === "tool") return <div key={i} className="chat-tool">{l.text}</div>;
                        if (l.kind === "ok") return <div key={i} className="chat-res ok">{l.text}</div>;
                        if (l.kind === "bad") return <div key={i} className="chat-res bad">{l.text}</div>;
                        const thinking = l.text.startsWith("…");
                        return <div key={i} className={thinking ? "chat-think" : "chat-msg"}>{thinking ? l.text.replace(/^…\s*/, "") : l.text}</div>;
                      })
                    )}
                  </div>
                )}

                {tab === "Diff" && (
                  <div className="tabscroll">
                    <div className="secblock">
                      <div className="ilabel">Working diff</div>
                      <div className="iprose">
                        {gatePending
                          ? "This node is awaiting review — open it from the Action-required dock to see the full file-by-file diff."
                          : run.worktrees[selected.id]
                            ? "This node has a worktree. Its diff opens in the full Review view when it reaches a gate."
                            : "No worktree yet — diffs appear once this node has run."}
                      </div>
                      {gatePending && <button className="mprimary" style={{ marginTop: 10 }} onClick={() => setReviewFor(selected.id)}>Open review</button>}
                    </div>
                  </div>
                )}

                {tab === "Config" && (
                  <div className="tabscroll">
                    <div className="secblock config">
                      <div className="editrow">
                        <label>Label</label>
                        <input className="tinput" value={selected.label ?? ""} placeholder={selected.id} onChange={(ev) => updateSpec(selected.id, { label: ev.target.value || undefined })} />
                      </div>
                      {isAgent && (
                        <>
                          <div className="editrow2">
                            <div className="ef">
                              <label>Harness</label>
                              <Select ariaLabel="Harness" value={selected.harness ?? "any"} options={[{ value: "any", label: `auto (${rHarness})` }, { value: "grok", label: "grok" }, { value: "claude", label: "claude" }]} onChange={(val) => updateSpec(selected.id, { harness: val === "any" ? undefined : val })} />
                            </div>
                            <div className="ef">
                              <label>Effort</label>
                              <Select ariaLabel="Effort" value={selected.effort ?? "high"} options={[{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }]} onChange={(val) => updateSpec(selected.id, { effort: val })} />
                            </div>
                          </div>
                          <div className="editrow col">
                            <label>Stage context</label>
                            <textarea className="tinput area" rows={4} value={selected.promptContext ?? ""} placeholder="What this node should know about THIS workflow…" onChange={(ev) => updateSpec(selected.id, { promptContext: ev.target.value || undefined })} />
                          </div>
                        </>
                      )}
                      {!isAgent && selected.gate && (
                        <>
                          <div className="editrow2">
                            <div className="ef">
                              <label>Mode</label>
                              <Select ariaLabel="Gate mode" value={selected.gate.mode} disabled={selected.gate.outward} options={[{ value: "human", label: "human" }, { value: "auto", label: "auto" }]} onChange={(val) => updateSpec(selected.id, { gate: { ...selected.gate!, mode: val as "human" | "auto" } })} />
                            </div>
                            <div className="ef check">
                              <label title="Outward gates release pushes/PRs/replies and must be human">Outward</label>
                              <input type="checkbox" checked={selected.gate.outward ?? false} onChange={(ev) => updateSpec(selected.id, { gate: { ...selected.gate!, outward: ev.target.checked, mode: ev.target.checked ? "human" : selected.gate!.mode } })} />
                            </div>
                          </div>
                          <div className="editrow col">
                            <label>Checklist (one per line)</label>
                            <textarea className="tinput area" rows={4} value={(selected.gate.checklist ?? []).join("\n")} onChange={(ev) => updateSpec(selected.id, { gate: { ...selected.gate!, checklist: ev.target.value.split("\n").filter((l) => l.trim() !== "") } })} />
                          </div>
                        </>
                      )}
                    </div>
                    {selected.killGates && selected.killGates.length > 0 && (
                      <div className="secblock">
                        <div className="ilabel">Kill gates</div>
                        <div className="kgates">
                          {selected.killGates.map((k, i) => <div key={i} className="kgate">{k.check}{k.arg ? ` (${k.arg})` : ""}</div>)}
                        </div>
                      </div>
                    )}
                    {card && (
                      <div className="secblock">
                        <div className="ilabel">Card prompt · {card.permissions}</div>
                        <div className="iprose prompt">{card.prompt}</div>
                      </div>
                    )}
                  </div>
                )}

                {tab === "Log" && (
                  <div className="tabscroll">
                    <div className="log">
                      {feed.filter((l) => isExec(l.kind)).length === 0 ? (
                        <div className="log-empty">No tool executions yet. Commands, edits, and their results appear here as the agent works.</div>
                      ) : (
                        feed.filter((l) => isExec(l.kind)).map((l, i) => (
                          <div key={i} className={`log-line ${l.kind}`}>{l.text}</div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                <div className="ibtns">
                  <button className="qbtn" disabled={!runActive} title={runActive ? "Pause scheduling at the next boundary" : "No active run"} onClick={() => void run.setPaused(!run.paused)}>
                    {run.paused ? "Resume" : "Pause"}
                  </button>
                  {gatePending && <button className="qbtn" onClick={() => setReviewFor(selected.id)}>Review…</button>}
                  <span className="sep" />
                  <button className="killbtn" disabled={liveCue !== "working"} title={liveCue === "working" ? "Kill this session" : "Node has no running session"} onClick={() => void run.kill(selected.id)}>
                    <span>Kill session</span>
                  </button>
                </div>
              </>
            );
          })() : (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{kind === "scratch" ? "scratch canvas" : current.name}</span>
                  {kind !== "scratch" && <span className="model">v{current.version}</span>}
                </div>
                <div className="task">{current.description}</div>
              </div>
              <div className="iscroll">
                <div className="secblock">
                  <div className="ilabel">{run.runId && !run.finished ? "Run in progress" : "Workflow"}</div>
                  <div className="ovgrid">
                    <div className="ov"><span className="k">Nodes</span><div className="v">{nodes.filter((n) => !(n.data as AgentNodeData).ephemeral).length}</div></div>
                    <div className="ov"><span className="k">Edges</span><div className="v">{edges.length}</div></div>
                    <div className="ov"><span className="k">Status</span><div className="v sm">{run.runId ? (run.finished ? "finished" : run.paused ? "paused" : "live") : "idle"}</div></div>
                    <div className="ov"><span className="k">Awaiting you</span><div className="v">{run.gates.length}</div></div>
                  </div>
                </div>
                {current.caps && Object.entries(current.caps).some(([, v]) => v != null && !Array.isArray(v)) && (
                  <div className="secblock">
                    <div className="ilabel">Caps (enforced)</div>
                    <div className="kgates">
                      {Object.entries(current.caps).filter(([, v]) => v != null && !Array.isArray(v)).map(([k, v]) => (
                        <div key={k} className="kgate">{k}: {String(v)}</div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="secblock">
                  <div className="ilabel">Getting started</div>
                  <div className="iprose">
                    Select a node to inspect its chat, diff, config, and log. Drag agents and gates from the library; wire left→right for flow, bottom→top for loops.
                    {kind === "scratch" ? " Nothing here persists unless you save." : settings.autosave ? " Autosave keeps this workflow updated." : " Autosave is off — use Save changes."}
                  </div>
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
        {run.gates.length > 0 && (
          <span className="cell" style={{ color: "var(--cue-stby)" }}>
            ◈ {run.gates.length} awaiting review
          </span>
        )}
        <span className="cell">
          {run.runId
            ? run.finished
              ? "run finished — journal saved"
              : run.paused
                ? "run paused at boundary"
                : "run live"
            : "no run active"}
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {runModal && (
        <RunModal
          suggestedRepo={current.target?.repoPath ?? localStorage.getItem("cuelight-last-repo") ?? ""}
          onCancel={() => setRunModal(false)}
          onStart={async (repoPath, goal) => {
            const cards: Record<string, CardPayload> = {};
            for (const a of allAgents) {
              cards[a.name] = { prompt: a.prompt, permissions: a.permissions, harness: a.harness, effort: a.effort };
            }
            const spec = serializeStage(current, nodes, edges);
            await run.start(spec, cards, repoPath, goal);
            localStorage.setItem("cuelight-last-repo", repoPath);
            setRunModal(false);
            setToast("Run started — cue lights are live");
          }}
        />
      )}

      {reviewFor && (() => {
        const gate = run.gates.find((g) => g.nodeId === reviewFor);
        if (!gate) return null;
        return (
          <ReviewView
            gate={gate}
            workflowName={kind === "scratch" ? "scratch" : current.name}
            onDecide={(approve, memo) => run.decide(gate.nodeId, approve, memo)}
            onClose={() => setReviewFor(null)}
          />
        );
      })()}

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

      {agentEditor && (
        <AgentEditor
          card={agentEditor.card}
          takenNames={allAgents.map((a) => a.name)}
          onCancel={() => setAgentEditor(null)}
          onSave={async (card) => {
            try {
              await saveUserAgent(card as AgentCardFile);
            } catch (e) {
              setToast(`Not saved — ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
            setUserAgents((xs) => [...xs.filter((x) => x.name !== card.name), { ...card, builtin: false }]);
            setAgentEditor(null);
            setToast(`Saved agent ${card.name}`);
          }}
        />
      )}

      {gateEditor && (
        <GateEditor
          preset={gateEditor.preset}
          takenNames={gatePresets.map((g) => g.name)}
          onCancel={() => setGateEditor(null)}
          onSave={(preset) => {
            saveGatePreset(preset);
            setGatePresets(listGatePresets());
            setGateEditor(null);
            setToast(`Saved gate ${preset.label}`);
          }}
        />
      )}
    </div>
  );
}

function AgentEditor(props: {
  card?: AgentCard;
  takenNames: string[];
  onCancel: () => void;
  onSave: (card: AgentCard) => void;
}) {
  const src = props.card;
  const editingCustom = src && !src.builtin;
  const [name, setName] = useState(editingCustom ? src!.name : src ? `${src.name}-custom` : "");
  const [displayName, setDisplayName] = useState(src?.displayName ?? "");
  const [description, setDescription] = useState(src?.description ?? "");
  const [harness, setHarness] = useState(src?.harness ?? "any");
  const [permissions, setPermissions] = useState(src?.permissions ?? "edit");
  const [effort, setEffort] = useState(src?.effort ?? "high");
  const [prompt, setPrompt] = useState(src?.prompt ?? "");

  const valid = /^[a-z][a-z0-9-]*$/.test(name);
  const collides = props.takenNames.includes(name) && name !== (editingCustom ? src!.name : "__none__");
  const ready = valid && !collides && description.trim() !== "" && prompt.trim() !== "";

  return (
    <div className="modalback" onClick={props.onCancel}>
      <div className="modal wide" onClick={(ev) => ev.stopPropagation()}>
        <div className="mtitle">{editingCustom ? "Edit agent" : src ? "Duplicate agent" : "New agent"}</div>
        <div className="editrow2">
          <div className="ef">
            <label>Name (kebab-case)</label>
            <input className="tinput" autoFocus value={name} placeholder="my-agent" onChange={(e) => setName(e.target.value)} disabled={editingCustom} />
          </div>
          <div className="ef">
            <label>Display name</label>
            <input className="tinput" value={displayName} placeholder="My Agent" onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </div>
        {!valid && name !== "" && <div className="mwarn">lowercase letters, digits, dashes</div>}
        {collides && <div className="mwarn">that name is taken</div>}
        <label className="mlabel">Description (shown in the library)</label>
        <input className="tinput" value={description} placeholder="What this agent does, in one line" onChange={(e) => setDescription(e.target.value)} />
        <div className="editrow2">
          <div className="ef">
            <label>Harness</label>
            <Select value={harness} options={[{ value: "any", label: "auto" }, { value: "grok", label: "grok" }, { value: "claude", label: "claude" }]} onChange={setHarness} />
          </div>
          <div className="ef">
            <label>Permissions</label>
            <Select value={permissions} options={[{ value: "plan", label: "plan (read-only)" }, { value: "edit", label: "edit files" }, { value: "edit+exec", label: "edit + run" }]} onChange={setPermissions} />
          </div>
          <div className="ef">
            <label>Effort</label>
            <Select value={effort} options={[{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }]} onChange={setEffort} />
          </div>
        </div>
        <label className="mlabel">Prompt (the agent's role and rules)</label>
        <textarea className="tinput area tall" rows={8} value={prompt} placeholder="You are a… Your job is to… Rules: …" onChange={(e) => setPrompt(e.target.value)} />
        <div className="mbtns">
          <button className="mghost" onClick={props.onCancel}>Cancel</button>
          <span className="mspacer" />
          <button className="mprimary" disabled={!ready} onClick={() => props.onSave({ name, displayName: displayName || undefined, description: description.trim(), harness, permissions, effort, prompt: prompt.trim() })}>
            Save agent
          </button>
        </div>
      </div>
    </div>
  );
}

function GateEditor(props: {
  preset?: GatePreset;
  takenNames: string[];
  onCancel: () => void;
  onSave: (preset: GatePreset) => void;
}) {
  const src = props.preset;
  const [label, setLabel] = useState(src?.label ?? "");
  const [mode, setMode] = useState<"human" | "auto">(src?.mode ?? "human");
  const [outward, setOutward] = useState(src?.outward ?? false);
  const [checklist, setChecklist] = useState((src?.checklist ?? []).join("\n"));

  const name = src?.name ?? label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const valid = /^[a-z][a-z0-9-]*$/.test(name);
  const collides = !src && props.takenNames.includes(name);
  const ready = label.trim() !== "" && valid && !collides;

  return (
    <div className="modalback" onClick={props.onCancel}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="mtitle">{src ? "Edit gate preset" : "New gate preset"}</div>
        <label className="mlabel">Label</label>
        <input className="tinput" autoFocus value={label} placeholder="Merge gate" onChange={(e) => setLabel(e.target.value)} />
        {collides && <div className="mwarn">a preset with that name exists</div>}
        <div className="editrow2">
          <div className="ef">
            <label>Mode</label>
            <Select value={mode} disabled={outward} options={[{ value: "human", label: "human" }, { value: "auto", label: "auto" }]} onChange={(v) => setMode(v as "human" | "auto")} />
          </div>
          <div className="ef check">
            <label title="Outward gates release pushes/PRs/replies and must be human">Outward-facing</label>
            <input type="checkbox" checked={outward} onChange={(e) => { setOutward(e.target.checked); if (e.target.checked) setMode("human"); }} />
          </div>
        </div>
        <label className="mlabel">Default checklist (one per line)</label>
        <textarea className="tinput area" rows={4} value={checklist} placeholder={"Tests green\nScope matches the issue"} onChange={(e) => setChecklist(e.target.value)} />
        <div className="mbtns">
          <button className="mghost" onClick={props.onCancel}>Cancel</button>
          <span className="mspacer" />
          <button className="mprimary" disabled={!ready} onClick={() => props.onSave({ name, label: label.trim(), mode, outward, checklist: checklist.split("\n").map((l) => l.trim()).filter(Boolean) })}>
            Save preset
          </button>
        </div>
      </div>
    </div>
  );
}

function RunModal(props: {
  suggestedRepo: string;
  onCancel: () => void;
  onStart: (repoPath: string, goal: string) => Promise<void>;
}) {
  const [repo, setRepo] = useState(props.suggestedRepo);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="modalback" onClick={() => busy || props.onCancel()}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <div className="mtitle">Launch run</div>
        <label className="mlabel">Target repository (local path, must be a git repo)</label>
        <input className="tinput" autoFocus value={repo} placeholder="C:\\path\\to\\repo" onChange={(ev) => setRepo(ev.target.value)} disabled={busy} />
        <label className="mlabel">Goal (handed to the entry nodes)</label>
        <textarea
          className="tinput area"
          rows={3}
          value={goal}
          placeholder="e.g. Fix issue #42 — the CLI crashes on empty input"
          onChange={(ev) => setGoal(ev.target.value)}
          disabled={busy}
        />
        {err && <div className="mwarn">{err}</div>}
        <div className="mbtns">
          <button className="qbtn" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="mprimary"
            disabled={repo.trim() === "" || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await props.onStart(repo.trim(), goal.trim());
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          >
            {busy ? "Starting…" : "▶ Start run"}
          </button>
        </div>
      </div>
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
        <label className="mlabel">Description</label>
        <textarea
          className="tinput area"
          rows={4}
          value={desc}
          placeholder={props.hasCanvas ? "What this workflow does" : "Describe the workflow — also used as the brief if you generate. e.g. Every night, find flaky tests, fix the top one with a proven repro, queue it for my morning review."}
          onChange={(ev) => setDesc(ev.target.value)}
          disabled={!!busy}
        />
        {err && <div className="mwarn">{err}</div>}
        <div className="mbtns">
          <button className="mghost" onClick={props.onCancel} disabled={!!busy}>
            Cancel
          </button>
          <span className="mspacer" />
          <button className="msecondary" disabled={!ready || !!busy} onClick={() => run("blank")}>
            {busy === "blank" ? "Saving…" : props.hasCanvas ? "Save" : "Blank"}
          </button>
          {!props.hasCanvas && (
            <button className="mprimary" disabled={!ready || !!busy} onClick={() => run("generate")}>
              {busy === "generate" ? "Generating…" : "✦ Generate"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
