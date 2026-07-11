# Contributing to Cuelight

Three on-ramps, easiest first.

## 1. Templates (`templates/*.stage.json`)

A template is a stage graph: agent nodes, gates, edges, caps. Validate against `schema/stage.schema.json`. Good templates encode judgment, not just plumbing — kill-gates that stop bad work early, human gates before anything outward-facing, quota priorities. Look at `oss-contributor.stage.json` for the fully-loaded example.

## 2. Agent cards (`agents/*.agent.json`)

A card is a role: prompt, harness, permission mode, effort. Keep prompts specific and testable ("must produce a failing test before any fix" beats "be careful"). Cards must declare the least permission mode that works.

## 3. Adapters (`src-tauri/src/adapters/`)

One Rust trait (`HarnessAdapter`) per CLI. An adapter must:
- launch a headless session with a prompt + working dir,
- translate the CLI's streaming output into `NormalizedEvent`s,
- detect auth state without ever handling credentials itself,
- pass the recorded-fixture contract tests (`cargo test -p adapters`).

Never add an adapter that requires API keys as its only auth path — subscription/local auth is the project's core invariant.

## Ground rules

- No telemetry, no network calls except the harness CLIs themselves.
- No secrets in code, templates, or fixtures.
- Human gates stay default-on for outward-facing actions; PRs that flip that default get closed.
- `pnpm check` (typecheck + lint) and `cargo check` must pass.

## Conduct

Be the kind of contributor the `oss-contributor` template is designed to be: issue-first, repro-first, respectful of maintainer time.
