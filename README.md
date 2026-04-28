# common-ground

Assets and p5.js sketch for the Common Ground exhibit.

The sketch draws an infinite, deterministic patchwork of square tiles cropped
from every image in `assets/`. Each tile's source image and crop position are a
pure function of its world cell `(i, j)` and a global seed, so the same seed
always reproduces the same patchwork.

## Setup

```
npm install
npm run preprocess
npm start
```

Then open <http://localhost:3000>.

### What `preprocess` does

`scripts/preprocess.mjs` walks `assets/`, **deletes** any HEIC/HEIF files
(including ones disguised with non-HEIC extensions, since browsers cannot
decode them), and for every remaining `.jpg`/`.jpeg`/`.png`:

- records its native dimensions;
- writes a low-resolution thumbnail to `assets/previews/thumb/`  (max 256 px);
- writes a medium-resolution preview to `assets/previews/medium/` (max 1024 px).

It then writes `assets/manifest.json` containing the per-image metadata and the
global `tileSize`, defined as the smallest `min(width, height)` across all
images. Re-running the script is cheap: previews are skipped when they are
newer than their source.

Re-run `npm run preprocess` whenever you add or remove files in `assets/`.

## Controls

| Key      | Action                                           |
|----------|--------------------------------------------------|
| Arrows   | Pan the camera (constant speed in world units)   |
| Q        | Zoom in (capped at native 1:1, i.e. `zoom = 1`)  |
| A        | Zoom out (capped at 40x out, i.e. `zoom = 0.025`) |
| F        | Toggle browser fullscreen                        |
| R        | Re-randomize the seed                            |
| 0        | Reset camera to origin and zoom out              |

`zoom = 1.0` means **one source-image pixel maps to one screen pixel** -- the
true native pixel resolution of the original photo, regardless of how many
tiles fit on the screen.

## Architecture

- **Determinism.** `tileFor(i, j, seed)` returns `{ imageIdx, cropX, cropY }`
  via a 32-bit integer hash. No per-tile state is ever stored, so panning over
  a region that was previously visible reproduces the same tiles bit-for-bit
  and there is nothing to "destroy" when tiles leave the viewport.
- **Multi-resolution cache.** Thumbnails for every image are preloaded at
  startup (a few MB total). Medium previews load on demand the first time a
  tile is large enough on screen to need them. Full-resolution originals load
  only when zoomed close to native, and are kept in a bounded LRU cache.
- **Render loop.** Each frame computes the visible tile range from the camera
  and zoom, picks the best loaded resolution tier per tile, and blits the
  appropriate sub-rectangle via p5's 9-argument `image()` call.
