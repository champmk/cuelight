# media

Brand assets and the [Remotion](https://remotion.dev) source for Cuelight's ad film, README loop GIF, and banners. This package is independent of the app — nothing in `src/` or `src-tauri/` depends on it.

Everything is built from the design tokens in [`design/ui-spec.html`](../design/ui-spec.html), so the film and the app read as the same object: same stage black, same amber cue, same node cards.

## Committed assets (`brand/`)

| File | Use |
|---|---|
| `logo.svg` | The mark — a node card with its cue light. Pure shapes, no font deps. |
| `banner.png` | README hero (1920×560). |
| `social-preview.png` | GitHub social preview (1280×640) — upload via repo Settings → Social preview. |
| `cuelight-loop.gif` | README loop (880px, 8s seamless). |

## Regenerating

Prereqs: Node ≥ 20, pnpm, ffmpeg on PATH.

```sh
cd media
pnpm install
pnpm studio           # preview / edit compositions live
pnpm render:ad        # full film → out/cuelight-ad.mp4 (1920×1080, 54s)
pnpm render:loop      # loop master → out/loop.mp4
pnpm gif              # loop.mp4 → brand/cuelight-loop.gif (palette-optimized)
pnpm render:banner    # → brand/banner.png
pnpm render:social    # → brand/social-preview.png
```

The full ad (`out/cuelight-ad.mp4`) is not committed — it's attached to GitHub Releases.

Fonts are vendored in `public/fonts/`: Fraunces (OFL) for display, Cascadia Code (OFL) for telemetry — the same mono family the app UI uses.
