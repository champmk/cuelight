// Cuelight shell: rail (active sessions + template library) | tabbed canvas | inspector.
//
// The core model: TEMPLATES are the library — clicking one opens an overview
// (layout preview + description) from which you either start a SESSION or edit
// the template. SESSIONS are live workspaces: each owns its own canvas copy,
// undo history, and (at most one of them) the running engine. Run events are
// routed to the session that owns the run, never to whatever tab is displayed.

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
import { HistoryView } from "./run/HistoryView";
import { replayRun, slugify, type ReplayState, type RunDetail } from "./run/replay";

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
  structuredOutput?: unknown;
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

// Available models per harness (for the per-agent model picker).
const MODELS: Record<string, { value: string; label: string }[]> = {
  grok: [
    { value: "", label: "default (grok-4.5)" },
    { value: "grok-4.5", label: "grok-4.5" },
    { value: "grok-composer-2.5-fast", label: "grok-composer-2.5-fast · fast" },
  ],
  claude: [
    { value: "", label: "default" },
    { value: "claude-opus-4-8", label: "opus" },
    { value: "claude-sonnet-5", label: "sonnet" },
    { value: "claude-haiku-4-5-20251001", label: "haiku · fast" },
  ],
  any: [{ value: "", label: "default" }],
};

// Group the raw feed into clean chat blocks: consecutive output merges into one
// message, consecutive reasoning into one thinking note; tools/results stay
// discrete. This is what makes the chat read like a chatbot, not fragments.
type ChatBlock = { type: "output" | "think" | "tool" | "ok" | "bad"; text: string };
function groupChat(feed: { kind: string; text: string }[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  for (const l of feed) {
    let type: ChatBlock["type"];
    let text = l.text;
    if (l.kind === "tool") type = "tool";
    else if (l.kind === "ok") type = "ok";
    else if (l.kind === "bad") type = "bad";
    else if (l.text.startsWith("…")) { type = "think"; text = l.text.replace(/^…\s*/, ""); }
    else type = "output";
    const last = out[out.length - 1];
    if (last && (type === "output" || type === "think") && last.type === type) {
      last.text = `${last.text} ${text}`.trim();
    } else {
      out.push({ type, text });
    }
  }
  return out;
}

type Kind = "bundled" | "user" | "scratch";
type SaveStatus = "clean" | "dirty" | "saving";

// A workspace is one open tab: either a live session (its own canvas copy of a
// template, runnable) or a template editor (edits save back to the library).
interface Workspace {
  id: string;
  mode: "session" | "editor";
  title: string;
  kind?: Kind; // editor only: bundled | user | scratch
  spec: StageSpec; // base metadata (name/version/description/caps/target)
  nodes: Node[];
  edges: Edge[];
  status: SaveStatus; // editor only
  repoPath?: string;
  goal?: string;
  /** The last run this session launched — the key into the journal for
   * Chromium-style restore after the app closes. */
  runId?: string;
}

interface Settings {
  autosave: boolean;
}

// Static miniature of a stage layout, for the template overview. Pure SVG in
// node-space coordinates — no ReactFlow instance needed just to look.
function StagePreview({ spec }: { spec: StageSpec }) {
  const nodes = useMemo(() => buildNodes(spec), [spec]);
  if (nodes.length === 0) return <div className="tprev-empty">This template has no nodes yet.</div>;
  const pos = new Map(nodes.map((n) => [n.id, n.position]));
  const W = 150, H = 54;
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const minX = Math.min(...xs) - 24;
  const minY = Math.min(...ys) - 24;
  const maxX = Math.max(...xs) + W + 24;
  const maxY = Math.max(...ys) + H + 64; // room for return-edge dips
  return (
    <svg className="tprev" viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} preserveAspectRatio="xMidYMid meet">
      {spec.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        if (e.kind === "return") {
          const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y + H;
          const dip = Math.max(y1, y2) + 44;
          return <path key={i} d={`M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`} className="tp-ret" />;
        }
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
        const mx = (x1 + x2) / 2;
        return <path key={i} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} className="tp-wire" />;
      })}
      {spec.nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        return (
          <g key={n.id}>
            <rect x={p.x} y={p.y} width={W} height={H} rx={10} className={n.type === "gate" ? "tp-gate" : "tp-agent"} />
            <circle cx={p.x + 15} cy={p.y + 17} r={4} className="tp-cue" />
            <text x={p.x + 27} y={p.y + 21} className="tp-label">{(n.label ?? n.id).slice(0, 16)}</text>
            <text x={p.x + 15} y={p.y + 41} className="tp-sub">
              {n.type === "gate" ? `${n.gate?.mode ?? "human"} gate${n.gate?.outward ? " · outward" : ""}` : n.card ?? ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function App() {
  const [userWorkflows, setUserWorkflows] = useState<StageSpec[]>([]);
  const [userAgents, setUserAgents] = useState<AgentCard[]>([]);
  const [gatePresets, setGatePresets] = useState<GatePreset[]>([]);
  const [agentEditor, setAgentEditor] = useState<null | { card?: AgentCard }>(null);
  const [gateEditor, setGateEditor] = useState<null | { preset?: GatePreset }>(null);
  const [libMenu, setLibMenu] = useState<string | null>(null);
  const [untangling, setUntangling] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ---- workspaces: the open tabs ----
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const wsRef = useRef(workspaces);
  wsRef.current = workspaces;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const wsCounter = useRef(1);
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overviewFor, setOverviewFor] = useState<null | { spec: StageSpec; kind: "bundled" | "user"; edited: boolean }>(null);
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

  const run = useRun();
  const [runModal, setRunModal] = useState(false);
  const [reviewFor, setReviewFor] = useState<null | { nodeId: string; orphan: boolean; wsId: string }>(null);
  // Per-session archived run state, replayed from the journal: what a session
  // shows when its run isn't the live one (restored after restart, or frozen
  // when another session took the engine).
  const [archived, setArchived] = useState<Record<string, ReplayState>>({});
  const [tab, setTab] = useState<"Chat" | "Diff" | "Config" | "Log">("Chat");
  const runActive = run.runId !== null && !run.finished;
  const runOwnerRef = useRef<string | null>(null);
  runOwnerRef.current = run.session;
  // The run's visuals belong to the tab that owns the run — only there.
  const runVisible = !!active && active.mode === "session" && active.id === run.session;
  // When the active session's run isn't live, its journal-replayed state is.
  const archivedView = active && !runVisible ? archived[active.id] : undefined;
  const orphanGates = archivedView?.gates ?? [];

  const updateWs = useCallback((id: string, fn: (w: Workspace) => Workspace) => {
    setWorkspaces((list) => {
      let changed = false;
      const next = list.map((w) => {
        if (w.id !== id) return w;
        const nw = fn(w);
        if (nw !== w) changed = true;
        return nw;
      });
      return changed ? next : list; // identity bail-out — no re-render on no-op updates
    });
  }, []);

  // ---- editor plumbing: per-workspace history, clipboard, selection ----
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const histories = useRef<Record<string, { past: Array<{ n: Node[]; e: Edge[] }>; future: Array<{ n: Node[]; e: Edge[] }> }>>({});
  const clipboard = useRef<Array<{ spec: StageNode; x: number; y: number }>>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  // Keep the chat pinned to the newest message as it streams.
  useEffect(() => {
    if (tab === "Chat" && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [tab, selectedId, run.activeNode, run.feeds]);

  const snapshot = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const ws = wsRef.current.find((w) => w.id === id);
    if (!ws) return;
    const h = (histories.current[id] ??= { past: [], future: [] });
    h.past.push({ n: structuredClone(ws.nodes), e: structuredClone(ws.edges) });
    if (h.past.length > 50) h.past.shift();
    h.future = [];
  }, []);

  const markDirty = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    updateWs(id, (w) => (w.mode === "editor" && w.status !== "saving" ? { ...w, status: "dirty" } : w));
  }, [updateWs]);

  const undo = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const h = histories.current[id];
    const ws = wsRef.current.find((w) => w.id === id);
    if (!h || h.past.length === 0 || !ws) return;
    const prev = h.past.pop()!;
    h.future.push({ n: structuredClone(ws.nodes), e: structuredClone(ws.edges) });
    updateWs(id, (w) => ({ ...w, nodes: prev.n, edges: prev.e, status: w.mode === "editor" ? "dirty" : w.status }));
  }, [updateWs]);

  const redo = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const h = histories.current[id];
    const ws = wsRef.current.find((w) => w.id === id);
    if (!h || h.future.length === 0 || !ws) return;
    const next = h.future.pop()!;
    h.past.push({ n: structuredClone(ws.nodes), e: structuredClone(ws.edges) });
    updateWs(id, (w) => ({ ...w, nodes: next.n, edges: next.e, status: w.mode === "editor" ? "dirty" : w.status }));
  }, [updateWs]);

  const copySelection = useCallback(() => {
    const ws = wsRef.current.find((w) => w.id === activeIdRef.current);
    if (!ws) return;
    clipboard.current = ws.nodes
      .filter((n) => selectionIds.includes(n.id))
      .map((n) => ({ spec: structuredClone((n.data as AgentNodeData).spec), x: n.position.x, y: n.position.y }));
  }, [selectionIds]);

  const paste = useCallback(() => {
    const id = activeIdRef.current;
    if (!id || clipboard.current.length === 0) return;
    snapshot();
    updateWs(id, (w) => {
      const taken = new Set(w.nodes.map((n) => n.id));
      const added = clipboard.current.map((c) => {
        const nid = uniqueNodeId(c.spec.id, taken);
        taken.add(nid);
        const spec = { ...structuredClone(c.spec), id: nid };
        return { id: nid, type: spec.type, position: { x: c.x + 33, y: c.y + 33 }, data: { spec, cue: "idle" } satisfies AgentNodeData } as Node;
      });
      return { ...w, nodes: [...w.nodes, ...added] };
    });
    markDirty();
  }, [snapshot, updateWs, markDirty]);

  const deleteById = useCallback((delId: string, isEdge: boolean) => {
    const id = activeIdRef.current;
    if (!id) return;
    snapshot();
    updateWs(id, (w) =>
      isEdge
        ? { ...w, edges: w.edges.filter((e) => e.id !== delId) }
        : { ...w, nodes: w.nodes.filter((n) => n.id !== delId), edges: w.edges.filter((e) => e.source !== delId && e.target !== delId) }
    );
    markDirty();
    setCtxMenu(null);
  }, [snapshot, updateWs, markDirty]);

  const duplicateNode = useCallback((dupId: string) => {
    const id = activeIdRef.current;
    if (!id) return;
    snapshot();
    updateWs(id, (w) => {
      const n = w.nodes.find((x) => x.id === dupId);
      if (!n) return w;
      const taken = new Set(w.nodes.map((x) => x.id));
      const spec = structuredClone((n.data as AgentNodeData).spec);
      spec.id = uniqueNodeId(spec.id, taken);
      return { ...w, nodes: [...w.nodes, { id: spec.id, type: spec.type, position: { x: n.position.x + 33, y: n.position.y + 33 }, data: { spec, cue: "idle" } satisfies AgentNodeData } as Node] };
    });
    markDirty();
    setCtxMenu(null);
  }, [snapshot, updateWs, markDirty]);

  const autoLayout = useCallback(() => {
    const id = activeIdRef.current;
    const ws = wsRef.current.find((w) => w.id === id);
    if (!id || !ws) return;
    snapshot();
    const spec = serializeStage(ws.spec, ws.nodes, ws.edges);
    const fresh = buildNodes({ ...spec, layout: undefined });
    setUntangling(true); // enable the smooth position transition
    updateWs(id, (w) => ({
      ...w,
      nodes: w.nodes.map((n) => {
        const f = fresh.find((x) => x.id === n.id);
        return f ? { ...n, position: f.position } : n;
      }),
    }));
    markDirty();
    setTimeout(() => setUntangling(false), 550);
  }, [snapshot, updateWs, markDirty]);

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

  // Push live run state into the OWNING session's node cards — even when that
  // tab isn't displayed, so switching back shows the true picture.
  useEffect(() => {
    const owner = run.session;
    if (!owner) return;
    updateWs(owner, (ws) => {
      let changed = false;
      const nodes = ws.nodes.map((n) => {
        const d = n.data as AgentNodeData;
        const cue = run.cues[n.id] ?? "idle";
        const currently = run.details[n.id];
        if (d.cue === cue && d.currently === currently) return n;
        changed = true;
        return { ...n, data: { ...d, cue, currently } };
      });
      return changed ? { ...ws, nodes } : ws;
    });
  }, [run.cues, run.details, run.session, updateWs]);

  // Escalation: inject/remove the check + resolution overlay nodes — always on
  // the session that owns the run, never the displayed canvas.
  useEffect(() => {
    run.onEscalation(
      (esc) => {
        const owner = runOwnerRef.current;
        if (!owner) return;
        updateWs(owner, (ws) => {
          const failed = ws.nodes.find((n) => n.id === esc.failedNode);
          const bx = failed?.position.x ?? 200;
          const by = failed?.position.y ?? 200;
          const checkSpec: StageNode = { id: esc.checkNode, type: "agent", card: "diagnostic", label: "Failure check", model: "grok-composer-2.5-fast", effort: "low" };
          const gateSpec: StageNode = { id: esc.gateNode, type: "gate", label: "Resolve & retry", gate: { mode: "human", outward: false, checklist: [] } };
          return {
            ...ws,
            nodes: [
              ...ws.nodes.filter((n) => n.id !== esc.checkNode && n.id !== esc.gateNode),
              { id: esc.checkNode, type: "agent", position: { x: bx + 220, y: by + 30 }, className: "esc-enter", data: { spec: checkSpec, cue: "working", ephemeral: true } as AgentNodeData },
              { id: esc.gateNode, type: "gate", position: { x: bx + 220, y: by + 170 }, className: "esc-enter", data: { spec: gateSpec, cue: "standby", ephemeral: true } as AgentNodeData },
            ],
            edges: [
              ...ws.edges.filter((e) => e.target !== esc.checkNode && e.target !== esc.gateNode),
              { id: `esc-${esc.failedNode}-check`, source: esc.failedNode, target: esc.checkNode, ...edgeStyle(false), className: "esc-edge" } as Edge,
              { id: `esc-${esc.checkNode}-gate`, source: esc.checkNode, target: esc.gateNode, ...edgeStyle(false), className: "esc-edge" } as Edge,
            ],
          };
        });
      },
      (_failedNode, _retried, checkNode, gateNode) => {
        const owner = runOwnerRef.current;
        if (!owner) return;
        updateWs(owner, (ws) => ({ ...ws, nodes: ws.nodes.map((n) => (n.id === checkNode || n.id === gateNode ? { ...n, className: "esc-leave" } : n)) }));
        setTimeout(() => {
          updateWs(owner, (ws) => ({
            ...ws,
            nodes: ws.nodes.filter((n) => n.id !== checkNode && n.id !== gateNode),
            edges: ws.edges.filter((e) => e.source !== checkNode && e.source !== gateNode && e.target !== checkNode && e.target !== gateNode),
          }));
        }, 420);
      }
    );
  }, [run.onEscalation, updateWs]);

  useEffect(() => {
    listUserTemplates().then(setUserWorkflows);
    listUserAgents().then((a) => setUserAgents(a.map((c) => ({ ...c, builtin: false }))));
    setGatePresets(listGatePresets());
  }, []);

  // Restore open sessions from the last app run: canvas snapshots come from
  // localStorage, and each session's RUN state (cues, chats, pending gates)
  // replays from the journal — so reopening the app looks like never closing.
  useEffect(() => {
    let raw: Array<{ id: string; title: string; stage: StageSpec; repoPath?: string; goal?: string; runId?: string }> = [];
    try {
      raw = JSON.parse(localStorage.getItem("cuelight-sessions") ?? "[]");
    } catch {
      return; // corrupt snapshot — start empty
    }
    if (raw.length === 0) return;
    const restored: Workspace[] = raw.map((r) => ({
      id: r.id,
      mode: "session",
      title: r.title,
      spec: r.stage,
      nodes: buildNodes(r.stage),
      edges: buildEdges(r.stage),
      status: "clean",
      repoPath: r.repoPath,
      goal: r.goal,
      runId: r.runId,
    }));
    setWorkspaces(restored);
    setActiveId(restored[0].id);

    // Hydrate each session's last run from its repo's journal.
    for (const r of raw) {
      if (!r.runId || !r.repoPath) continue;
      void (async () => {
        try {
          const detail = await invoke<RunDetail>("get_run", { repoPath: r.repoPath, runId: r.runId });
          const worktrees = await invoke<Array<{ node: string; path: string }>>("list_run_worktrees", { repoPath: r.repoPath, runId: r.runId }).catch(() => []);
          const rep = replayRun(detail);
          // A gate is only completable if its worktree survived on disk.
          const alive = new Set(worktrees.map((w) => w.path));
          rep.gates = rep.gates
            .map((g) => (g.worktree && alive.has(g.worktree) ? g : worktrees.length > 0 ? { ...g, worktree: worktrees[0].path } : g))
            .filter((g) => !!g.worktree && alive.has(g.worktree!));
          setArchived((a) => ({ ...a, [r.id]: rep }));
          updateWs(r.id, (ws) => ({
            ...ws,
            nodes: ws.nodes.map((n) => {
              const cue = rep.cues[n.id];
              const currently = rep.details[n.id];
              if (!cue && !currently) return n;
              return { ...n, data: { ...(n.data as AgentNodeData), cue: cue ?? "idle", currently } };
            }),
          }));
        } catch {
          // no journal for this repo/run — leave the session cold
        }
      })();
    }
  }, [updateWs]);

  // Persist session canvases so a restart doesn't lose your open work.
  const lastSaved = useRef("");
  useEffect(() => {
    const t = setTimeout(() => {
      const sess = wsRef.current
        .filter((w) => w.mode === "session")
        .map((w) => ({ id: w.id, title: w.title, stage: serializeStage(w.spec, w.nodes, w.edges), repoPath: w.repoPath, goal: w.goal, runId: w.runId }));
      const json = JSON.stringify(sess);
      if (json !== lastSaved.current) {
        lastSaved.current = json;
        localStorage.setItem("cuelight-sessions", json);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [workspaces]);

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

  // Announce run completion so approvals that finish a workflow are visible.
  const prevFinished = useRef(false);
  useEffect(() => {
    if (run.finished && !prevFinished.current && run.runId) {
      setToast(run.gates.length > 0 ? "Run ended — items still awaited review" : "✓ Run complete");
    }
    prevFinished.current = run.finished;
  }, [run.finished, run.runId, run.gates.length]);

  // ---- opening & closing workspaces ----
  const activate = useCallback((id: string) => {
    setActiveId(id);
    setSelectedId(null);
    setSelectionIds([]);
    setCtxMenu(null);
  }, []);

  const openSession = useCallback((spec: StageSpec) => {
    const id = `s-${Date.now().toString(36)}-${wsCounter.current++}`;
    const dupes = wsRef.current.filter((w) => w.mode === "session" && w.spec.name === spec.name).length;
    const title = dupes > 0 ? `${spec.name} · ${dupes + 1}` : spec.name;
    const snap = structuredClone(spec); // session owns its copy — template edits never leak in
    const ws: Workspace = { id, mode: "session", title, spec: snap, nodes: buildNodes(snap), edges: buildEdges(snap), status: "clean" };
    setWorkspaces((l) => [...l, ws]);
    activate(id);
    return id;
  }, [activate]);

  const openEditor = useCallback((spec: StageSpec, kind: Kind) => {
    const id = kind === "scratch" ? "edit:scratch" : `edit:${spec.name}`;
    if (wsRef.current.some((w) => w.id === id)) {
      activate(id);
      return;
    }
    const ws: Workspace = {
      id,
      mode: "editor",
      title: kind === "scratch" ? "scratch" : `${spec.name} · edit`,
      kind,
      spec,
      nodes: buildNodes(spec),
      edges: buildEdges(spec),
      status: "clean",
    };
    setWorkspaces((l) => [...l, ws]);
    activate(id);
  }, [activate]);

  const closeWs = useCallback((id: string) => {
    if (id === runOwnerRef.current && runActive) {
      setToast("This session has a live run — stop it before closing");
      return;
    }
    delete histories.current[id];
    setArchived((a) => {
      const { [id]: _drop, ...rest } = a;
      return rest;
    });
    const rest = wsRef.current.filter((w) => w.id !== id);
    setWorkspaces(rest);
    if (activeIdRef.current === id) {
      setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
      setSelectedId(null);
      setSelectionIds([]);
      setCtxMenu(null);
    }
  }, [runActive]);

  // ---- canvas callbacks (always the active workspace) ----
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const id = activeIdRef.current;
      if (!id) return;
      if (changes.some((c) => c.type === "remove")) snapshot();
      updateWs(id, (w) => ({ ...w, nodes: applyNodeChanges(changes, w.nodes) }));
      if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markDirty();
    },
    [markDirty, snapshot, updateWs]
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const id = activeIdRef.current;
      if (!id) return;
      if (changes.some((c) => c.type === "remove")) snapshot();
      updateWs(id, (w) => ({ ...w, edges: applyEdgeChanges(changes, w.edges) }));
      if (changes.some((c) => c.type !== "select")) markDirty();
    },
    [markDirty, snapshot, updateWs]
  );
  const onConnect = useCallback(
    (c: Connection) => {
      const id = activeIdRef.current;
      if (!id) return;
      snapshot();
      const ret = c.sourceHandle === "loop-out" || c.targetHandle === "loop-in";
      updateWs(id, (w) => ({ ...w, edges: addEdge({ ...c, label: ret ? "↺ loop" : undefined, ...edgeStyle(ret) }, w.edges) }));
      markDirty();
    },
    [markDirty, snapshot, updateWs]
  );
  const onEdgesSet = useCallback(
    (updater: (es: Edge[]) => Edge[]) => {
      const id = activeIdRef.current;
      if (!id) return;
      updateWs(id, (w) => ({ ...w, edges: updater(w.edges) }));
      markDirty();
    },
    [markDirty, updateWs]
  );
  const onDropItem = useCallback(
    (p: DropPayload, position: { x: number; y: number }) => {
      const id = activeIdRef.current;
      if (!id) return;
      snapshot();
      updateWs(id, (w) => {
        const taken = new Set(w.nodes.map((n) => n.id));
        const nid = uniqueNodeId(p.kind === "gate" ? `${p.gateMode}-gate` : p.name, taken);
        const spec: StageNode =
          p.kind === "gate"
            ? { id: nid, type: "gate", label: p.displayName ?? "Gate", gate: { mode: p.gateMode ?? "human", outward: p.outward ?? false, checklist: p.checklist ?? [] } }
            : { id: nid, type: "agent", card: p.name, label: p.displayName ?? p.name };
        return { ...w, nodes: [...w.nodes, { id: nid, type: spec.type, position, data: { spec, cue: "idle" } satisfies AgentNodeData }] };
      });
      markDirty();
    },
    [markDirty, snapshot, updateWs]
  );

  const updateSpec = useCallback(
    (nodeId: string, patch: Partial<StageNode>) => {
      const id = activeIdRef.current;
      if (!id) return;
      updateWs(id, (w) => ({
        ...w,
        nodes: w.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const d = n.data as AgentNodeData;
          return { ...n, data: { ...d, spec: { ...d.spec, ...patch } } };
        }),
      }));
      markDirty();
    },
    [markDirty, updateWs]
  );

  // ---- template persistence (editors only) ----
  const saveSpec = useCallback(async (spec: StageSpec): Promise<boolean> => {
    // Empty templates are fine to SAVE (you fill them in later) — the run
    // engine rejects them at launch, not the library.
    const problems = validateStage(spec).filter((p) => !p.includes("no nodes"));
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
    setUserWorkflows((ts) => [...ts.filter((t) => t.name !== spec.name), spec]);
    return true;
  }, []);

  const persistEditor = useCallback(
    async (id: string, quiet = true): Promise<boolean> => {
      const ws = wsRef.current.find((w) => w.id === id);
      if (!ws || ws.mode !== "editor") return false;
      const spec = serializeStage(ws.spec, ws.nodes, ws.edges);
      updateWs(id, (w) => ({ ...w, status: "saving" }));
      const ok = await saveSpec(spec);
      updateWs(id, (w) => (ok ? { ...w, spec, status: "clean" } : { ...w, status: "dirty" }));
      if (ok && !quiet) setToast(`Saved ${spec.name}`);
      return ok;
    },
    [saveSpec, updateWs]
  );

  // Autosave named template editors when enabled. Editing a bundled template
  // writes an override under the SAME name into ~/.cuelight/templates. Session
  // canvases NEVER autosave to the library — session edits are session-local.
  useEffect(() => {
    if (!active || active.mode !== "editor" || active.kind === "scratch" || active.status !== "dirty" || !settings.autosave) return;
    const t = setTimeout(() => {
      void persistEditor(active.id, true);
    }, 900);
    return () => clearTimeout(t);
  }, [active, settings.autosave, persistEditor]);

  const showSaveChanges = !!active && active.mode === "editor" && active.status === "dirty" && (active.kind === "scratch" || !settings.autosave);

  const onSaveChanges = useCallback(() => {
    if (!active) return;
    if (active.kind === "scratch") {
      setCreator({ forScratch: true }); // scratch has no name — name it, then save
    } else {
      void persistEditor(active.id, false);
    }
  }, [active, persistEditor]);

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
      if (wsRef.current.some((w) => w.id === `edit:${oldName}`)) closeWs(`edit:${oldName}`);
      setRenaming(null);
      setToast(`Renamed to ${newName}`);
    },
    [userWorkflows, closeWs]
  );

  // ---- inspector selection (auto-follow only applies to the run's own tab) ----
  const inspectId = selectedId ?? (runVisible ? run.activeNode : null);
  const following = selectedId === null && runVisible && run.activeNode != null;
  const selected: StageNode | null = useMemo(() => {
    const n = active?.nodes.find((n) => n.id === inspectId);
    return n ? (n.data as AgentNodeData).spec : null;
  }, [active?.nodes, inspectId]);
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

  const statusChip = !active || active.mode !== "editor"
    ? null
    : active.status === "clean" ? (active.kind === "scratch" ? "scratch" : "✓ up to date")
    : active.status === "saving" ? "saving…"
    : "• unsaved";

  const sessionWs = workspaces.filter((w) => w.mode === "session");
  const runOwnerWs = workspaces.find((w) => w.id === run.session);

  // Run: sessions run directly; from an editor, the canvas snapshots into a
  // fresh session first (the editor stays a library concern).
  const onRunClick = useCallback(() => {
    if (!active || runActive) return;
    if (active.mode === "session") {
      setRunModal(true);
    } else {
      const spec = serializeStage(active.spec, active.nodes, active.edges);
      openSession(spec);
      setRunModal(true);
    }
  }, [active, runActive, openSession]);

  return (
    <div className="shell" onClick={() => { setMenuFor(null); setLibMenu(null); }}>
      <div className="tbar">
        <div className="tname">cuelight</div>
        <div className="wstabs">
          {workspaces.map((w) => (
            <div
              key={w.id}
              className={`wstab ${w.id === activeId ? "on" : ""}`}
              title={w.mode === "session" ? `Session — ${w.spec.name}` : w.kind === "scratch" ? "Scratch canvas" : `Editing template ${w.spec.name}`}
              onClick={() => activate(w.id)}
            >
              {w.mode === "session" ? (
                <span className={`cue ${w.id === run.session ? (runActive ? (run.paused ? "standby" : "working") : run.gates.length > 0 ? "standby" : "idle") : (archived[w.id]?.gates.length ?? 0) > 0 ? "standby" : "idle"}`} />
              ) : (
                <span className="wstab-pen">✎</span>
              )}
              <span className="wstab-title">{w.title}</span>
              <span
                className="wstab-x"
                title="Close"
                onClick={(ev) => { ev.stopPropagation(); closeWs(w.id); }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        {statusChip && <span className={`statuschip ${active!.status}`}>{statusChip}</span>}
        <div className="grow" />
        {showSaveChanges && (
          <button className="tbtn primary" onClick={onSaveChanges}>
            Save changes{active?.kind !== "user" ? "…" : ""}
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
          className={`runbtn ${runActive || !active ? "" : "ready"}`}
          disabled={runActive || !active}
          onClick={onRunClick}
          title={runActive ? `Run in progress — ${runOwnerWs?.title ?? "another session"}` : !active ? "Open a template first" : active.mode === "session" ? "Launch this session" : "Snapshot this canvas into a session and run it"}
        >
          {runActive ? (run.paused ? "Run paused" : "Run live") : "▶ Run"}
        </button>
        <button className="tbtn" title="Past runs in the last-used repo" onClick={() => setHistoryOpen(true)}>History</button>
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
              Autosave template edits
            </label>
            <div className="sethint">Applies to template editors only — session canvases never write back to the library.</div>
          </div>
        )}
      </div>

      <div className="bodygrid">
        <div className="rail">
          <div>
            <div className="rlabel">Active sessions</div>
            {sessionWs.length === 0 && <div className="railhint">None yet — open a template below and start one.</div>}
            {sessionWs.map((w) => (
              <div key={w.id} className={`railitem sess ${activeId === w.id ? "on" : ""}`} onClick={() => activate(w.id)}>
                <span className={`cue ${w.id === run.session ? (runActive ? (run.paused ? "standby" : "working") : run.gates.length > 0 ? "standby" : "idle") : (archived[w.id]?.gates.length ?? 0) > 0 ? "standby" : "idle"}`} />
                <span className="railtxt">{w.title}</span>
                {w.id === run.session && run.gates.length > 0 && <span className="gatecount" title="Awaiting your review">{run.gates.length}</span>}
                {w.id !== run.session && (archived[w.id]?.gates.length ?? 0) > 0 && <span className="gatecount" title="Recovered — awaiting your review">{archived[w.id]!.gates.length}</span>}
                <button className="railx" title="Close session" onClick={(ev) => { ev.stopPropagation(); closeWs(w.id); }}>×</button>
              </div>
            ))}
          </div>
          <div>
            <div className="rlabel">
              Templates
              <button className="railadd" title="New template" onClick={(ev) => { ev.stopPropagation(); setCreator({ forScratch: false }); }}>
                ＋
              </button>
            </div>
            <div
              className={`railitem scratch ${activeId === "edit:scratch" ? "on" : ""}`}
              onClick={() => openEditor(structuredClone(SCRATCH), "scratch")}
              title="A free playground — nothing saves unless you ask"
            >
              <span className="gr">✎</span>
              scratch canvas
            </div>
            {BUNDLED.map((t) => {
              const override = userWorkflows.find((u) => u.name === t.name);
              const edited = !!override;
              return (
                <div key={t.name} className="railitem" onClick={() => setOverviewFor({ spec: override ?? t, kind: "bundled", edited })}>
                  <span className="gr">◇</span>
                  <span className="railtxt">{t.name}</span>
                  {edited && <span className="editflag" title="You've edited this template">edited</span>}
                  {edited && (
                    <>
                      <button className="kebab" title="Options" onClick={(ev) => { ev.stopPropagation(); setMenuFor(menuFor === `b:${t.name}` ? null : `b:${t.name}`); }}>⋮</button>
                      {menuFor === `b:${t.name}` && (
                        <div className="menu" onClick={(ev) => ev.stopPropagation()}>
                          <div className="mi danger" onClick={async () => {
                            setMenuFor(null);
                            await deleteUserTemplate(t.name);
                            setUserWorkflows((ts) => ts.filter((x) => x.name !== t.name));
                            // If the editor tab is open, rebuild it from the bundled original.
                            if (wsRef.current.some((w) => w.id === `edit:${t.name}`)) {
                              updateWs(`edit:${t.name}`, (w) => ({ ...w, spec: t, nodes: buildNodes(t), edges: buildEdges(t), status: "clean" }));
                              delete histories.current[`edit:${t.name}`];
                            }
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
                <div key={t.name} className="railitem" onClick={() => setOverviewFor({ spec: t, kind: "user", edited: false })}>
                  <span className="gr">◇</span>
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
                    <span className="railtxt">{t.name}</span>
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
                          if (wsRef.current.some((w) => w.id === `edit:${t.name}`)) closeWs(`edit:${t.name}`);
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

        <div className={`canvaswrap ${untangling ? "untangling" : ""}`}>
          {active ? (
            <StageCanvas
              key={active.id}
              nodes={active.nodes}
              edges={active.edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgesSet={onEdgesSet}
              onDropItem={onDropItem}
              onSelect={setSelectedId}
              onSelectionIds={setSelectionIds}
              onContextMenu={setCtxMenu}
              onAutoLayout={autoLayout}
              onSnapshot={snapshot}
            />
          ) : (
            <div className="emptycanvas">
              <div className="ec-mark">◇ → ◈ → ◇</div>
              <div className="ec-title">No open workspace</div>
              <div className="ec-sub">Pick a template on the left to see its layout and start a session, or open the scratch canvas to build from nothing.</div>
            </div>
          )}
          {ctxMenu && active && (
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
          {(run.gates.length > 0 || orphanGates.length > 0) && (
            <div className="dock">
              <div className="dh">
                ◈ Action required <i>{run.gates.length + orphanGates.length}</i>
                {run.gates.length > 0 && runOwnerWs && !runVisible && <span className="dh-where">in {runOwnerWs.title}</span>}
              </div>
              {run.gates.map((g) => (
                <div
                  key={g.nodeId}
                  className="di"
                  onClick={() => {
                    const owner = run.session;
                    if (owner && wsRef.current.some((w) => w.id === owner)) activate(owner);
                    setReviewFor({ nodeId: g.nodeId, orphan: false, wsId: owner ?? "" });
                  }}
                >
                  <b>{g.nodeId}</b>
                  {g.outward ? " · outward" : ""}
                  <span>review →</span>
                </div>
              ))}
              {active && orphanGates.map((g) => (
                <div key={`o-${g.nodeId}`} className="di" onClick={() => setReviewFor({ nodeId: g.nodeId, orphan: true, wsId: active.id })}>
                  <b>{g.nodeId}</b> · recovered
                  <span>review →</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="insp">
          {selected && active ? (() => {
            const isAgent = selected.type === "agent";
            // Live run state when this tab owns the engine; otherwise the
            // session's journal-replayed archive (restored or frozen).
            const liveCue = runVisible ? run.cues[selected.id] ?? "idle" : archivedView?.cues[selected.id] ?? "idle";
            const v = runVisible ? run.vitals[selected.id] : undefined;
            const feed = runVisible ? run.feeds[selected.id] ?? [] : archivedView?.feeds[selected.id] ?? [];
            const failReason = runVisible ? run.failReasons[selected.id] : archivedView?.failReasons[selected.id];
            const diagnosis = runVisible ? run.diagnoses[selected.id] : archivedView?.diagnoses[selected.id];
            const gatePending = runVisible ? run.gates.find((g) => g.nodeId === selected.id) : undefined;
            const orphanPending = !runVisible ? orphanGates.find((g) => g.nodeId === selected.id) : undefined;
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
                    {following && <span className="followchip" title="Auto-following the active node — click a node to pin it">following</span>}
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

                {tab === "Chat" && isAgent && (
                  <>
                    <div className="chat" ref={chatRef}>
                      {feed.length === 0 && liveCue !== "working" && (
                        <div className="chat-empty">
                          {active.mode === "session"
                            ? "No session yet. Run this workflow to watch the agent work here."
                            : "This is a template editor — agents only run inside a session."}
                        </div>
                      )}
                      {groupChat(feed).map((b, i) => {
                        if (b.type === "tool") return <div key={i} className="chat-tool">{b.text}</div>;
                        if (b.type === "ok") return <div key={i} className="chat-res ok">{b.text}</div>;
                        if (b.type === "bad") return <div key={i} className="chat-res bad">{b.text}</div>;
                        if (b.type === "think") return <div key={i} className="chat-think">{b.text}</div>;
                        return <div key={i} className="chat-msg">{b.text}</div>;
                      })}
                      {liveCue === "working" && (
                        <div className="chat-working">
                          <span className="cw-dots"><i /><i /><i /></span>
                          <span>
                            {card?.structuredOutput
                              ? "Reviewing — this step reasons privately and returns a verdict (no live stream in structured mode)."
                              : run.details[selected.id] || "Working…"}
                          </span>
                        </div>
                      )}
                    </div>
                    <ChatBar
                      disabled={!runVisible || !runActive || liveCue === "working"}
                      hint={liveCue === "working" ? "Agent is mid-turn — nudge after this turn" : runVisible && runActive ? "" : "Start a run to chat"}
                      onSend={(text) => void run.nudge(selected.id, text)}
                    />
                  </>
                )}
                {tab === "Chat" && !isAgent && (
                  <div className="tabscroll"><div className="secblock"><div className="iprose">Gates don't run a chat session — switch to Config to edit this gate, or open it from the Action-required dock when it's pending.</div></div></div>
                )}

                {tab === "Diff" && (
                  <div className="tabscroll">
                    <div className="secblock">
                      <div className="ilabel">Working diff</div>
                      <div className="iprose">
                        {gatePending || orphanPending
                          ? "This node is awaiting review — open it from the Action-required dock to see the full file-by-file diff."
                          : runVisible && run.worktrees[selected.id]
                            ? "This node has a worktree. Its diff opens in the full Review view when it reaches a gate."
                            : "No worktree yet — diffs appear once this node has run."}
                      </div>
                      {(gatePending || orphanPending) && active && (
                        <button className="mprimary" style={{ marginTop: 10 }} onClick={() => setReviewFor({ nodeId: selected.id, orphan: !gatePending, wsId: active.id })}>
                          Open review
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {tab === "Config" && (
                  <div className="tabscroll">
                    <div className="secblock config">
                      {active.mode === "session" && (
                        <div className="iprose hintline">Session-local settings — changes here affect this session only, not the template.</div>
                      )}
                      <div className="editrow">
                        <label>Label</label>
                        <input className="tinput" value={selected.label ?? ""} placeholder={selected.id} onChange={(ev) => updateSpec(selected.id, { label: ev.target.value || undefined })} />
                      </div>
                      {isAgent && (
                        <>
                          <div className="editrow2">
                            <div className="ef">
                              <label>Harness</label>
                              <Select ariaLabel="Harness" value={selected.harness ?? "any"} options={[{ value: "any", label: `auto (${rHarness})` }, { value: "grok", label: "grok" }, { value: "claude", label: "claude" }]} onChange={(val) => updateSpec(selected.id, { harness: val === "any" ? undefined : val, model: undefined })} />
                            </div>
                            <div className="ef">
                              <label>Effort</label>
                              <Select ariaLabel="Effort" value={selected.effort ?? "high"} options={[{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }]} onChange={(val) => updateSpec(selected.id, { effort: val })} />
                            </div>
                          </div>
                          <div className="editrow col">
                            <label>Model</label>
                            <Select ariaLabel="Model" value={selected.model ?? ""} options={MODELS[rHarness] ?? MODELS.any} onChange={(val) => updateSpec(selected.id, { model: val || undefined })} />
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
                  <button className="qbtn" disabled={!runVisible || !runActive} title={runVisible && runActive ? "Pause scheduling at the next boundary" : "No active run in this session"} onClick={() => void run.setPaused(!run.paused)}>
                    {run.paused ? "Resume" : "Pause"}
                  </button>
                  {(gatePending || orphanPending) && active && (
                    <button className="qbtn" onClick={() => setReviewFor({ nodeId: selected.id, orphan: !gatePending, wsId: active.id })}>Review…</button>
                  )}
                  <span className="sep" />
                  <button className="killbtn" disabled={liveCue !== "working"} title={liveCue === "working" ? "Kill this session" : "Node has no running session"} onClick={() => void run.kill(selected.id)}>
                    <span>Kill session</span>
                  </button>
                </div>
              </>
            );
          })() : active ? (
            <>
              <div className="ihead">
                <div className="r1">
                  <span className="role">{active.title}</span>
                  {active.mode === "session" ? <span className="model">session</span> : active.kind !== "scratch" ? <span className="model">v{active.spec.version}</span> : null}
                </div>
                <div className="task">{active.spec.description}</div>
              </div>
              <div className="iscroll">
                <div className="secblock">
                  <div className="ilabel">{runVisible && runActive ? "Run in progress" : active.mode === "session" ? "Session" : "Template"}</div>
                  <div className="ovgrid">
                    <div className="ov"><span className="k">Nodes</span><div className="v">{active.nodes.filter((n) => !(n.data as AgentNodeData).ephemeral).length}</div></div>
                    <div className="ov"><span className="k">Edges</span><div className="v">{active.edges.length}</div></div>
                    <div className="ov"><span className="k">Status</span><div className="v sm">{runVisible ? (run.finished ? "finished" : run.paused ? "paused" : "live") : archivedView ? (archivedView.status === "running" ? "interrupted" : archivedView.status) : "idle"}</div></div>
                    <div className="ov"><span className="k">Awaiting you</span><div className="v">{runVisible ? run.gates.length : orphanGates.length}</div></div>
                  </div>
                </div>
                {active.spec.caps && Object.entries(active.spec.caps).some(([, v]) => v != null && !Array.isArray(v)) && (
                  <div className="secblock">
                    <div className="ilabel">Caps (enforced)</div>
                    <div className="kgates">
                      {Object.entries(active.spec.caps).filter(([, v]) => v != null && !Array.isArray(v)).map(([k, v]) => (
                        <div key={k} className="kgate">{k}: {String(v)}</div>
                      ))}
                    </div>
                  </div>
                )}
                {(runVisible ? run.activity : archivedView?.activity ?? []).length > 0 ? (
                  <div className="secblock">
                    <div className="ilabel">Activity{!runVisible && archivedView ? " · replayed from the journal" : ""}</div>
                    <div className="timeline">
                      {(runVisible ? run.activity : archivedView!.activity).slice(-40).reverse().map((a, i) => (
                        <div key={i} className="tl" onClick={() => setSelectedId(a.nodeId)}>
                          <span className={`cue ${a.cue}`} />
                          <span className="tl-node">{a.nodeId}</span>
                          <span className="tl-detail">{a.detail || a.cue}</span>
                          <span className="tl-time">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="secblock">
                    <div className="ilabel">Getting started</div>
                    <div className="iprose">
                      {active.mode === "session"
                        ? "This session owns its own canvas — tweak nodes freely without touching the template, then hit Run. Live activity will appear right here."
                        : active.kind === "scratch"
                          ? "A free playground. Drag agents and gates from the library; wire left→right for flow, bottom→top for loops. Nothing persists unless you save."
                          : settings.autosave
                            ? "You're editing the template itself — changes autosave to the library and apply to future sessions (existing sessions keep their snapshot)."
                            : "You're editing the template itself — autosave is off, use Save changes."}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="ihead">
                <div className="r1"><span className="role">cuelight</span></div>
                <div className="task">The diagram is the runtime.</div>
              </div>
              <div className="iscroll">
                <div className="secblock">
                  <div className="ilabel">Getting started</div>
                  <div className="iprose">
                    Click a template in the left rail to preview its layout and start a session. Sessions open as tabs up top — each one is its own live canvas.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="bbar">
        <span className="cell">
          <b>{active ? active.title : "no workspace"}</b>
          {active ? ` · ${active.nodes.filter((n) => !(n.data as AgentNodeData).ephemeral).length} nodes · ${active.edges.length} edges` : ""}
        </span>
        {runActive && run.activeNode && (
          <span
            className="cell now"
            style={{ cursor: runVisible ? undefined : "pointer" }}
            title={runVisible ? undefined : `Run is live in ${runOwnerWs?.title ?? "another session"} — click to jump`}
            onClick={() => { if (!runVisible && run.session && wsRef.current.some((w) => w.id === run.session)) activate(run.session); }}
          >
            <span className={`cue ${run.cues[run.activeNode] ?? "idle"}`} />
            <b>{run.activeNode}</b>
            {!runVisible && runOwnerWs ? ` · in ${runOwnerWs.title}` : run.details[run.activeNode] ? ` · ${run.details[run.activeNode]}` : ""}
          </span>
        )}
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
                : `run live${runOwnerWs && !runVisible ? ` · ${runOwnerWs.title}` : ""}`
            : "no run active"}
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {historyOpen && (
        <HistoryView
          repoPath={active?.repoPath ?? active?.spec.target?.repoPath ?? localStorage.getItem("cuelight-last-repo") ?? ""}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {overviewFor && (
        <div className="modalback" onClick={() => setOverviewFor(null)}>
          <div className="modal overview" onClick={(ev) => ev.stopPropagation()}>
            <div className="mtitle">
              {overviewFor.spec.name}
              {overviewFor.edited && <span className="editflag" style={{ marginLeft: 8 }}>edited</span>}
            </div>
            <div className="ovdesc">{overviewFor.spec.description}</div>
            <div className="tprevwrap">
              <StagePreview spec={overviewFor.spec} />
            </div>
            <div className="ovmeta">
              {overviewFor.spec.nodes.length} nodes · {overviewFor.spec.edges.length} connections · v{overviewFor.spec.version}
            </div>
            <div className="mbtns">
              <button className="mghost" onClick={() => setOverviewFor(null)}>Cancel</button>
              <span className="mspacer" />
              <button className="msecondary" onClick={() => { openEditor(structuredClone(overviewFor.spec), overviewFor.kind); setOverviewFor(null); }}>
                ✎ Edit template
              </button>
              <button className="mprimary" onClick={() => { openSession(overviewFor.spec); setOverviewFor(null); }}>
                ▶ Start session
              </button>
            </div>
          </div>
        </div>
      )}

      {runModal && active && (
        <RunModal
          suggestedRepo={active.repoPath ?? active.spec.target?.repoPath ?? localStorage.getItem("cuelight-last-repo") ?? ""}
          onCancel={() => setRunModal(false)}
          onStart={async (repoPath, goal) => {
            const cards: Record<string, CardPayload> = {};
            for (const a of allAgents) {
              cards[a.name] = { prompt: a.prompt, permissions: a.permissions, harness: a.harness, effort: a.effort, structuredOutput: a.structuredOutput };
            }
            // The engine is single-run: freeze the previous owner's final
            // state into its archive so its tab keeps showing the truth.
            const prevOwner = run.session;
            if (prevOwner && prevOwner !== active.id) {
              setArchived((a) => ({
                ...a,
                [prevOwner]: {
                  cues: run.cues,
                  details: run.details,
                  feeds: run.feeds,
                  activity: run.activity,
                  failReasons: run.failReasons,
                  diagnoses: run.diagnoses,
                  gates: [],
                  lastResult: {},
                  finished: true,
                  status: run.finished ? "finished" : "stopped",
                },
              }));
              updateWs(prevOwner, (w) => ({
                ...w,
                nodes: w.nodes.filter((n) => !(n.data as AgentNodeData).ephemeral),
                edges: w.edges.filter((e) => !String(e.id).startsWith("esc-")),
              }));
            }
            const spec = serializeStage(active.spec, active.nodes, active.edges);
            const id = await run.start(spec, cards, repoPath, goal, active.id);
            // This session's archive is now stale — the live run replaces it.
            setArchived((a) => {
              const { [active.id]: _drop, ...rest } = a;
              return rest;
            });
            updateWs(active.id, (w) => ({ ...w, repoPath, goal, runId: id }));
            localStorage.setItem("cuelight-last-repo", repoPath);
            setRunModal(false);
            setToast("Run started — cue lights are live");
          }}
        />
      )}

      {reviewFor && (() => {
        const gate = reviewFor.orphan
          ? archived[reviewFor.wsId]?.gates.find((g) => g.nodeId === reviewFor.nodeId)
          : run.gates.find((g) => g.nodeId === reviewFor.nodeId);
        if (!gate) return null;
        const gateWs = workspaces.find((w) => w.id === reviewFor.wsId);
        return (
          <ReviewView
            gate={gate}
            workflowName={reviewFor.orphan ? `${gateWs?.title ?? "session"} (recovered)` : runOwnerWs?.title ?? "run"}
            orphan={reviewFor.orphan}
            onDecide={async (approve, memo, action) => {
              if (reviewFor.orphan) {
                // The engine that parked this gate is gone; shipping is a pure
                // git operation on the surviving worktree.
                if (!approve || !gateWs?.repoPath || !gate.worktree) return;
                const msg = await invoke<string>("ship_orphan", {
                  repoPath: gateWs.repoPath,
                  worktree: gate.worktree,
                  action: gate.outward && action ? action : "none",
                  branch: `cuelight/${slugify(gateWs.goal || gateWs.title)}`,
                  message: gateWs.goal || `Cuelight: ${gateWs.title}`,
                  runId: gateWs.runId ?? null,
                  nodeId: gate.nodeId,
                });
                setArchived((a) => {
                  const cur = a[gateWs.id];
                  if (!cur) return a;
                  return {
                    ...a,
                    [gateWs.id]: {
                      ...cur,
                      gates: cur.gates.filter((x) => x.nodeId !== gate.nodeId),
                      cues: { ...cur.cues, [gate.nodeId]: "idle" },
                      details: { ...cur.details, [gate.nodeId]: `approved · ${msg}` },
                      status: "finished",
                      finished: true,
                    },
                  };
                });
                updateWs(gateWs.id, (w) => ({
                  ...w,
                  nodes: w.nodes.map((n) => (n.id === gate.nodeId ? { ...n, data: { ...(n.data as AgentNodeData), cue: "idle", currently: "approved" } } : n)),
                }));
                setToast(`✓ Recovered — ${msg}`);
              } else {
                await run.decide(gate.nodeId, approve, memo, action);
                setToast(approve ? `✓ Approved${action ? ` — ${action}` : ""}` : `Changes requested — sending ${gate.nodeId} back`);
                if (run.session && wsRef.current.some((w) => w.id === run.session)) activate(run.session);
                setSelectedId(gate.nodeId);
              }
            }}
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
            // From the ＋ button: a named empty template. From scratch's Save
            // changes: the scratch canvas becomes the template's first contents.
            const base: StageSpec = { name, version: "0.1.0", description, nodes: [], edges: [] };
            const scratch = creator.forScratch ? wsRef.current.find((w) => w.id === "edit:scratch") : undefined;
            const spec = scratch ? serializeStage(base, scratch.nodes, scratch.edges) : base;
            const ok = await saveSpec(spec);
            if (ok) {
              if (scratch) updateWs("edit:scratch", (w) => ({ ...w, status: "clean" }));
              openEditor(spec, "user");
              setCreator(null);
              setToast(`Saved ${name}`);
            }
          }}
          onGenerate={async (name, description) => {
            const json = await invoke<string>("generate_template", { name, description });
            const spec = JSON.parse(json) as StageSpec;
            const ok = await saveSpec(spec);
            if (ok) {
              openEditor(spec, "user");
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

function ChatBar(props: { disabled: boolean; hint: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText("");
  };
  return (
    <div className="chatbar">
      <textarea
        className="chatbar-input"
        rows={1}
        value={text}
        placeholder={props.disabled ? props.hint || "Not available right now" : "Nudge this agent… (Enter to send)"}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        }}
      />
      <button className="chatbar-send" disabled={props.disabled || text.trim() === ""} onClick={send} title="Send nudge">↑</button>
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
        <div className="mtitle">{props.hasCanvas ? "Save canvas as a template" : "New template"}</div>
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
