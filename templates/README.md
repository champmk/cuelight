# Templates

Each `.stage.json` is a complete, runnable workflow validated by [`../schema/stage.schema.json`](../schema/stage.schema.json). Instantiate one, point `target.repoPath` at a repository, and run.

Design principles every template here follows — and contributed templates should too:

1. **Kill early, kill cheap.** Every agent node has kill-gates; bad work dies before the next (more expensive) stage, not at the human's desk.
2. **Human gates own outward actions.** Anything that pushes, posts, or publishes sits behind `mode: human, outward: true`. The conductor refuses to run a stage that violates this.
3. **Caps encode etiquette.** Rate limits, PR ceilings, and batch limits live in `caps` as enforced numbers, not in prompt prose that a model might drift past.
4. **Fresh context for verification.** Reviewer nodes never share a session with the work they judge.
5. **Adversarial by default.** The reviewer's job is to refute; humans only see work that survived attack. "Uncertain" is a rejection.

| Template | Trigger style | Outward-facing |
|---|---|---|
| `ship-a-feature` | manual, loops per feature | gate-guarded merge |
| `oss-contributor` | weekly scout + continuous loop | PRs + replies, double-gated |
| `bug-hunt` | manual sweep, loops | no |
| `test-coverage` | manual, loops per tranche | no |
| `nightly-refactor` | cron (nightly), morning queue | no |
| `docs-sync` | cron (2×/week) | no |
| `pr-babysitter` | cron (30 min) | replies, gate-guarded |
