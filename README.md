# Cuelight

**The live canvas for agent orchestration. The diagram is the runtime.**

Cuelight is a desktop app where multi-agent coding workflows are drawn, watched, and controlled as a living architectural diagram. Nodes are real agent sessions running on the coding harnesses you already pay for — Claude Code, Grok Build — via their official headless modes. Edit the graph and you've edited the running loop.

> A *cue light* is the pulsing light a stage manager uses to tell each performer "standby / go." Every agent on the canvas carries one: dark when idle, amber on standby, pulsing green while working, red when blocked.

**Status: pre-0.1 scaffold.** The architecture, schemas, templates, and design spec are here; the conductor and canvas are being built in the open. Follow the commit history.

---

## Why this exists

Node-based agent builders (n8n, Langflow, Agent Builder) orchestrate raw API calls. The real capability lives in coding harnesses — tools, sandboxing, repo context, MCP — but their orchestration surface is a CLI: powerful, invisible, and hostile to anyone who doesn't live in a terminal.

Cuelight is the missing layer: **mission control for headless coding agents.**

- **Watch** — a live graph of who's working on what: file-level activity, context saturation, token burn, quota state.
- **Control** — pause, steer, rewind, or kill agents; approve human gates; re-route edges on the running workflow.
- **Build** — drag agents from a library onto the canvas, wire stages into loops, launch. Design-tool ergonomics, but the artifact is alive.

## No API keys. Ever.

Cuelight shells out to CLIs authenticated on *your* machine (`claude -p`, `grok -p` — official headless modes). Your subscriptions are the fuel; Cuelight stores no keys, proxies no traffic, and phones nothing home. That's why it's local-first desktop software, permanently.

## Templates

Ships with production-grade workflow templates in [`templates/`](templates/) — pick one, point it at a repo, press run:

| Template | What it does |
|---|---|
| `ship-a-feature` | Ideate → implement → adversarial review → verify → your gate → merge. The canonical loop. |
| `oss-contributor` | Scout responsive repos → triage real issues (repro required) → fix + tests → adversarial review → your gate → PR from your fork → lifecycle agent answers maintainers. Etiquette caps built in. |
| `bug-hunt` | Parallel finders with different lenses → adversarial verification kills false positives → fixes for survivors → your gate. |
| `test-coverage` | Find untested surface → write meaningful tests → mutation-check they actually assert something → your gate. |
| `nightly-refactor` | Simplification scout runs while you sleep → equivalence-checked refactors → morning review queue. |
| `docs-sync` | Diff watcher finds docs drifting from code → writer updates them → accuracy reviewer verifies against source → your gate. |
| `pr-babysitter` | Watches your open PRs → drafts replies and rebases within hours, not weeks → you approve every send. |

Templates are plain JSON ([schema](schema/stage.schema.json)) — diffable, forkable, PR-able. Agent roles are JSON cards in [`agents/`](agents/). Both are the contribution on-ramp: improve a prompt, add a card, share a template.

## Architecture

```
┌───────────────────────────────────────────────┐
│  CANVAS   React + React Flow (Tauri webview)  │   the design tool
│  live graph · agent library · review view     │
└──────────────▲────────────────────────────────┘
               │ typed events over Tauri IPC
┌──────────────┴────────────────────────────────┐
│  CONDUCTOR   Rust (embedded in Tauri)         │   the brain
│  graph engine · scheduler · human gates       │
│  quota governor · run journal (SQLite)        │
└──────────────▲────────────────────────────────┘
               │ spawn + parse streaming-json
┌──────────────┴────────────────────────────────┐
│  ADAPTERS    one thin Rust driver per CLI     │   the muscle
│  claude -p · grok -p · (yours here)           │
│  git-worktree isolation · session lifecycle   │
└───────────────────────────────────────────────┘
```

Key invariants:

- **Edit-at-the-boundary.** Live graph edits apply at the next node boundary; running sessions are never yanked unless you kill them.
- **Worktree isolation.** Every session runs in a git worktree owned by its run; nothing touches your branch until a gate promotes it.
- **Human gates by default** for anything outward-facing (push, PR, publish). A template must explicitly opt a gate down to auto, and the UI shouts about it.
- **The journal is the truth.** Every event, diff, and cost per node per run lands in SQLite. Rewind is a first-class operation.

## Getting started (dev)

Prereqs: [Rust](https://rustup.rs), Node ≥ 20, pnpm, and at least one harness CLI (`claude` or `grok`) logged in.

```sh
git clone https://github.com/champmk/cuelight
cd cuelight
pnpm install
pnpm smoke     # verifies your harness CLIs run headless on subscription auth
pnpm tauri dev
```

`pnpm smoke` is the honest first step: it confirms `claude -p` / `grok -p` work non-interactively on your cached login before anything is built on top of that assumption.

## Design

The full UI spec — canvas and the agent-first Review view — lives in [`design/`](design/) as self-contained HTML. The Review view inverts the IDE: you arrive from an agent making its case, its per-hunk rationale is the primary document, and replying to an annotation *is* steering — your comment becomes the instruction the re-queued agent runs with.

## Contributing

Adapters (one Rust trait), agent cards, and templates are the easiest entry points — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
