# Design spec

`ui-spec.html` is the living design spec — self-contained, open it in a browser. Two screens:

1. **Canvas** — the live orchestration graph. State pills (RUNNING / FAILED / STANDBY / IDLE) give the 50 ms read; cue lights pulse only while an agent works; amber exclusively means "a human is needed"; blue exclusively means selection / the agent's voice.
2. **Review view** — the agent-first IDE inversion. You arrive from an agent making its case; per-hunk rationale is pinned to the diff; replying to an annotation adds to the steering queue; the gate checklist is auto-filled from pipeline kill-gates.

## Tokens (source of truth until the app's theme file exists)

| Token | Value | Use |
|---|---|---|
| `--win` | `#111013` | window ground |
| `--panel` | `#17161A` | rails, bars |
| `--ink` | `#EFEDEA` | primary text |
| `--mut` / `--dim` | `#ABA9B4` / `#82808F` | secondary / tertiary text |
| `--cue-work` | `#4CC38A` | executing (the pulse) |
| `--cue-stby` / `--accent` | `#E0A63C` | human needed, brand accent |
| `--cue-block` | `#E5534B` | failed / blocked — loud |
| `--sel` | `#7AA7D8` | selection + agent voice, never semantic status |

Type: sans (system UI stack) for all structure; mono only for paths, hashes, tokens, timers, terminal output. The cue-light pulse is the interface's only ambient animation.
