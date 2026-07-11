# Cuelight

**The live canvas for agent orchestration. The diagram IS the runtime.**

A desktop app where multi-agent workflows are drawn, watched, and controlled as a living architectural diagram. Nodes are agents running on the coding harnesses you already pay for (Claude Code, Grok Build, Codex CLI — subscription auth, zero API keys). Edit the graph and you've edited the running loop. Open source, built by Champ Mukiza.

*A cue light is the pulsing light a stage manager uses to tell each performer "standby / go." That's the product: every agent on the canvas carries its cue light — dark when idle, amber on standby, pulsing green while working, red when blocked.*

---

## 1. The gap

Node-based agent builders exist — n8n, Langflow, Flowise, Dify, OpenAI Agent Builder. **All of them orchestrate raw API calls.** None of them sit on top of coding harnesses. Meanwhile the harnesses (Claude Code, Grok Build, Codex CLI) are where the actual capability lives — tools, sandboxing, skills, MCP, repo context — but their orchestration surface is a CLI: powerful, invisible, and hostile to non-technical users.

Cuelight is the missing layer: **mission control for headless coding agents.**

- Watching: live graph of who's working on what, file-level activity, token spend, quota state.
- Controlling: pause/resume/kill agents, approve gates, re-route edges — on the running workflow.
- Building: drag agents from a library onto the canvas, wire stages into loops, launch.

Design-tool ergonomics (Figma/Canva), but the artifact is alive. Architectural diagrams today are documentation that rots; a Cuelight diagram is the deployment.

## 2. Why subscription-only (no API keys) is the moat, not the constraint

1. **Cost story**: users bring the Claude Max / SuperGrok / ChatGPT plans they already pay for. Cuelight itself costs nothing to run. No metered-billing anxiety, which is the #1 reason non-technical people won't touch agent APIs.
2. **Capability story**: `claude -p` / `grok -p` / `codex exec` headless sessions come with the full harness — file tools, git, MCP, skills, AGENTS.md. Rebuilding that on raw APIs is years of work n8n-style tools will not do.
3. **Trust story**: no keys stored, no proxying, no telemetry of prompts. The app shells out to CLIs authenticated on *your* machine. Clean pitch for an open-source repo.

Consequence: Cuelight is local-first desktop software, permanently. A hosted version would force API keys and kill all three stories.

## 3. Core concepts

| Concept | What it is |
|---|---|
| **Stage** | A workflow: a directed graph (usually cyclic) of agents and gates. Saved as a versioned JSON spec — git-friendly, shareable. |
| **Agent card** | A role definition: name, harness, model, system prompt, tools/permissions, effort. E.g. "L5 Implementer (Grok 4.5)", "Security Reviewer (Claude)", "Research Scout". Cards live in a local library; JSON files, so shareable/forkable. |
| **Cue light** | The live status on every node: idle / standby / working (pulsing) / blocked / failed. The heartbeat of the UI. |
| **Gate** | An edge condition: auto (tests pass, reviewer approves) or human (user must click). Human gates are how non-technical users stay in command. |
| **Run** | One traversal of the stage. Full transcript, diffs, and costs recorded per node per run. |
| **Loop** | A stage whose graph cycles (ideate → build → review → ship → back). First-class, not a hack. |

Terminology stays plain everywhere else — agents, workflows, runs. The theater metaphor lives in the name and the light, not in a themed UI that gets cute.

## 4. Architecture

Three layers, strict boundaries:

```
┌──────────────────────────────────────────────┐
│  CANVAS  (Tauri webview: React + React Flow)  │  the design tool
│  live graph · agent library · run inspector   │
└──────────────▲───────────────────────────────┘
               │ typed events over Tauri IPC / WebSocket
┌──────────────┴───────────────────────────────┐
│  CONDUCTOR  (Rust daemon, embedded in Tauri)  │  the brain
│  graph engine · scheduler · gates · quota     │
│  governor · run journal (SQLite)              │
└──────────────▲───────────────────────────────┘
               │ spawn + parse streaming-json
┌──────────────┴───────────────────────────────┐
│  HARNESS ADAPTERS  (one per CLI)              │  the muscle
│  claude -p · grok -p · codex exec             │
│  worktree isolation · session lifecycle       │
└──────────────────────────────────────────────┘
```

**Harness adapters.** Each adapter knows: how to launch a headless session with a prompt + working dir, how to parse the CLI's streaming-JSON into Cuelight's normalized event schema (`agent_started`, `tool_call {file}`, `text`, `awaiting_input`, `done {result, cost}`, `rate_limited`), how to detect auth state, and the CLI's quirks (Grok Build needs one-time browser OAuth; Codex uses ChatGPT login; Claude uses claude.ai login). Adapters are the plugin surface — a contributor can add opencode or Gemini CLI by implementing one trait.

**Conductor.** Owns the graph. Schedules nodes when their in-edges satisfy gates, spawns adapter sessions in isolated git worktrees, journals every event to SQLite, enforces the quota governor (below), and applies **live edits**: graph mutations while a run is in flight take effect at the next node boundary — running sessions are never yanked mid-flight unless explicitly killed. This "edit-at-the-boundary" rule is what makes diagram-is-runtime safe.

**Canvas.** React Flow graph bound to conductor state. Node = agent card + cue light + one-line "currently: editing src/auth.ts". Click a node → inspector drawer: live transcript, diff, cost. Sidebar = agent library (search, drag onto canvas) + "forge an agent" (a Cuelight workflow that uses a connected harness to draft a new agent card from a description — dogfooding from day one). Human gates surface as approval buttons on the edge itself.

## 5. Quota governor

Subscription plans are shared, opaque, rate-limited pools. The governor:
- watches for `rate_limited` events per harness, backs off, and reschedules;
- lets a stage declare priorities so scarce quota is spent in order (e.g. "reply to external reviewers before starting new work");
- shows a per-harness quota health strip on the canvas — throttled agents show an amber cue light with "waiting on Grok quota";
- pauses cleanly at node boundaries when a pool is exhausted; runs resume when quota returns.

## 6. Security model

- Every agent session runs in a **git worktree** owned by the run; nothing touches the user's branch until a gate promotes it.
- Agent cards declare permission mode (plan-only / edit / edit+exec) mapped to each harness's native permission flags.
- Outward-facing actions (push, PR, publish) are **always human gates by default**; a stage must explicitly opt a gate down to auto, and the UI shouts about it.
- No secrets in stage specs. Adapters read auth from the CLIs' own credential stores only.

## 7. v1 scope (ruthless)

The full Figma-grade editor is v2. v1 is **watch, launch, control**:

1. Two adapters: Claude Code + Grok Build (Codex fast-follows).
2. Load a stage spec → render live graph → run it → cue lights, node inspector, transcripts, costs.
3. Pause / resume / kill per node and per run. Human gates open the **Review view** — the agent-first IDE inversion: file tree + diffs as evidence, the agent's per-hunk rationale as the primary document, replies to annotations become steering instructions, gate checklist auto-filled from pipeline kill-gates, Approve → PR. (Mocked as Screen 2 in the design artifact.)
4. Agent library: browse, edit JSON cards, drag onto a stage *between* runs (live structural editing of an in-flight run is v2; live prompt/param tweaks at node boundary are v1).
5. Quota governor v0 (backoff + priorities + health strip).
6. Two shipped stage templates (below).

Explicitly **not** v1: agent marketplace, forge-an-agent UI (card JSON is hand-editable meanwhile), collaborative multi-user canvas, hosted anything, non-coding-harness nodes.

## 8. Flagship stage templates (shipped in-repo)

**Template A — "Ship a feature" loop.** Ideate → implement → adversarial review → verify/production gate → back. Four stages, one human gate before merge. The demo-video template: legible to non-technical viewers in 10 seconds.

**Template B — "OSS contributor" pipeline.** The full plan from the Grok-agents project, as a Cuelight stage:
- *Scout* (weekly): score candidate repos — external-PR merge rate, median days-to-first-maintainer-response, triaged-issue density, young + marquee org ("find the next pyrefly"). Depth beats breadth: 1–3 targets.
- *Triage*: maintainer-filed issues only; must check no claimed/linked/landed fix exists; must reproduce (failing test) or die.
- *Fix* (Grok 4.5): patch + tests in a worktree; repo's own CI green locally or die.
- *Review* (adversarial, fresh session, refute-biased): survivors only.
- *Human gate*: 2–3 candidates/day max hit Champ's queue; approve → PR opens from his fork, matching the repo's PR template, single clean commit.
- *Lifecycle* (the edge nobody automates): watch review comments, draft replies/rebases within 24–48 h for human approval. A third of comparable contributors' losses are stale-PR deaths.
- Etiquette caps baked into the spec: ≤1 open PR per repo until first merge there, ≤4 open PRs global, ~2 PRs/week per target, ≥50% merge rate per repo or the scout re-targets.

Evidence base (2026-07-10 study of a successful 19-year-old contributor): steady issue-driven work at one responsive Meta repo → 14/23 merged; burst of 13 agent fan-out PRs at an unresponsive repo → 0 merged. Cuelight's templates encode the winning shape.

## 9. Tech stack (choices vs next-best, per evidence rule)

| Choice | Over | Why |
|---|---|---|
| **Tauri 2** (Rust core) | Electron | ~10× smaller binaries, native webview, Rust backend doubles as the conductor (process supervision, async I/O via tokio) — one language for daemon + IPC. Electron's only edge is Node ecosystem, which we don't need since harnesses are subprocesses, not npm libs. |
| **React Flow (xyflow)** | Custom canvas / D3 | The de-facto node-graph library (powers n8n, Langflow UIs); custom nodes/edges, performant at hundreds of nodes; MIT. Custom canvas is a 6-month tax for no differentiation — our differentiation is liveness, not rendering. |
| **SQLite** (run journal) | Postgres / files | Local-first, zero-ops, queryable history, one file per project. Postgres is server-shaped; loose files can't answer "cost per node last 30 runs". |
| **JSON stage specs in git** | DB-only workflows | Shareable, diffable, PR-able — required for an open-source template ecosystem. |
| **Rust adapter trait + subprocess streaming-json** | SDK bindings | CLIs are the stable public contract for subscription auth; SDKs would drag us back to API keys. |

## 10. Design language

Per the standing rule: **must not look AI-generated.** No card-spam dashboards, no gradient-blob landing pages. References: Linear's density, Figma's canvas calm, mission-control restraint. Dark-first (it's a monitoring tool), typographic hierarchy over chrome, the cue-light pulse as the single signature animation — everything else still. A visual-critique loop runs before any UI ships.

## 11. Open source strategy

- **License**: Apache-2.0 (patent grant matters for a tool companies might adopt; MIT is the fallback if contributor friction appears).
- Per the GitHub-presence playbook: energy goes to the **flagship README** (hero GIF of a live run — cue lights pulsing while a real feature ships), a docs site, and template gallery. No profile decoration.
- Public repo from first commit; incremental commits per milestone (standing rule).
- Community surface: agent cards and stage templates are the contribution on-ramp — JSON PRs, low barrier.
- Naming hygiene: `cuelight` on npm/PyPI reserved at v0.1; grab `cuelight.dev`.

## 12. Milestones

- **M0 — Spike (weekend)**: smoke-test both harnesses headless on subscription auth (`claude -p`, `grok -p` post-OAuth, streaming-json parse). Kill-risk retired first.
- **M1 — Conductor core**: graph engine, worktrees, journal, one adapter (Claude), CLI-only runs of Template A.
- **M2 — Canvas alpha**: live graph, cue lights, inspector, pause/kill, human gates.
- **M3 — Grok adapter + quota governor**: two-harness stages; Template B (OSS pipeline) live with Champ as the gate.
- **M4 — Library + polish + 0.1 release**: agent library UX, both templates shipped, README hero GIF, docs site, public launch.
- **M5 — v2 track**: live structural editing mid-run, forge-an-agent, Codex + community adapters.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Harness CLIs change streaming-json shape | Adapters version-pin + contract tests replaying recorded session fixtures. |
| ToS drift on subscription automation | Headless modes are documented, official features today; BYO-auth keeps us a client, not a reseller. Re-verify at each release. |
| Grok Build beta gating changes | Adapter degrades gracefully; Claude-only stages still work; community grok-cli as fallback adapter. |
| Scope creep toward Figma | v1 scope section is the contract; anything not listed is v2 by default. |
| Anthropic/xAI ship their own canvas | Speed + neutrality (multi-harness) is the defense; a first-party tool will never orchestrate competitors' harnesses. |

## 14. Success criteria

- v0.1: a non-technical viewer can watch Template A ship a real change end-to-end and correctly narrate what's happening from the canvas alone.
- Template B: first externally merged PR shepherded through Cuelight, with the full run journal as the receipt.
- Repo: README that makes "the diagram is the runtime" obvious in one GIF, ≥1 community-contributed adapter or template within 90 days of launch.
