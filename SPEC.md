# SPEC: Add "hi" to README

## Goal

Add the literal text `hi` to the project root README so it appears when someone opens or views `README.md`.

## User-visible behavior

1. **When** a reader opens the repository root `README.md` (GitHub, local editor, or clone), **they see** the existing Cuelight documentation unchanged in substance, plus the word `hi` present as a standalone line at the end of the file.
2. **When** someone searches the file for `hi` (e.g. editor find, `rg -n "^hi$" README.md`), **they find** exactly one dedicated line that is the string `hi` (not an accidental substring inside another word).
3. **When** the file is viewed on GitHub’s rendered markdown, **they see** `hi` as plain text after the License section (no new heading, badge, or callout required).

## Chosen approach

**Append a single line `hi` at the end of `README.md`**, after the License section (after the existing `[Apache-2.0](LICENSE)` line), with a blank line before it for normal markdown spacing.

**Runner-up:** Insert `hi` under the title as a one-word greeting. **Tiebreaker:** End-of-file preserves the hero/tagline and status block at the top; the task only requires presence of the text, not a product-facing greeting.

## NON-goals

- Do **not** edit `design/README.md`, `templates/README.md`, or any other nested README.
- Do **not** rewrite, restructure, rebrand, or “improve” the root README beyond adding `hi`.
- Do **not** add sections, headings, emojis, images, badges, or links related to this change.
- Do **not** change `CONTRIBUTING.md`, `LICENSE`, `PLAN.md`, agents, templates, schemas, app code, or CI.
- Do **not** add tests, scripts, or tooling solely to assert README content unless already required by the repo (none today).
- Do **not** rename the file, move it, or change encoding/line-ending style beyond what the edit requires.
- Do **not** commit, push, open a PR, or update package metadata as part of this change (unless a later stage asks).
- Do **not** internationalize or add variants (`hello`, `Hi`, `HI`); the exact lowercase token is `hi`.

## Seams

| Area | Action |
|------|--------|
| **Touch** | `README.md` (repository root only) |
| **Must not touch** | Everything else: `src/`, `src-tauri/`, `agents/`, `templates/`, `schema/`, `design/`, `package.json`, `CONTRIBUTING.md`, nested READMEs, etc. |
| **Interface changes** | None. No APIs, types, IPC, or build config. Documentation text only. |

Current root README ends with:

```markdown
## License

[Apache-2.0](LICENSE)
```

After the change it should end with:

```markdown
## License

[Apache-2.0](LICENSE)

hi
```

## Acceptance checks

Implementer can verify with:

1. **Content check (PowerShell, from repo root):**
   ```powershell
   Select-String -Path README.md -Pattern '^hi$'
   ```
   Expected: one match, last content line of the file (or immediately after a trailing blank line is fine if editor adds one; preferred: final non-empty line is `hi`).

2. **Ripgrep equivalent (if available):**
   ```sh
   rg -n '^hi$' README.md
   ```
   Expected: exactly one line match.

3. **No collateral edits:**
   ```powershell
   git status --short
   ```
   Expected: only `README.md` modified (or staged), nothing else.

4. **Diff sanity:**
   ```powershell
   git diff README.md
   ```
   Expected: only addition of a blank line + `hi` (or just `hi` if a trailing newline already existed). No deletions or rewrites of existing paragraphs.

5. **Smoke (optional, not required for this doc-only change):** existing `pnpm smoke` / app builds need not pass for README text; do not block on them.

## Open questions

None. Placement (end of root README) and exact string (`hi`) are fixed by this spec.
