# Tintwork

An original, browser-based layered image editor built on the HTML Canvas 2D API.
No frameworks, no build step, no server-side processing: images never leave your browser.

Tintwork takes general inspiration from what desktop photo editors can do (layers, tools,
adjustments, filters, history) but has its own name, UI, icons and code. It does not use
any third-party branding, assets or proprietary code.

![Workspace](screenshots/04-layer-blend-brush.png)

## What's new in v0.3

- **Adjustment layers** (Layer ▸ New adjustment layer, or the ✦ button in the Layers panel): brightness/contrast, hue/saturation, exposure, levels, curves, invert and grayscale. They work non-destructively: each one re-renders the layers below it, and nothing is baked in. To change the settings, double-click the layer thumbnail or press ✎. Every adjustment layer has a mask. If a selection is active when you create one, the mask is made from that selection. Merge down bakes the adjustment into pixels.
- **Curves** with an interactive point editor (Adjust ▸ Curves…, Ctrl+M, or as an adjustment layer):
  - Composite RGB plus R, G and B tabs, drawn over a histogram, with a monotone smooth curve.
  - Click to add a point and drag it. Drag a point off the graph, double-click it or press Delete to remove it. Arrow keys nudge a point. Reset restores the curve and an In/Out readout shows the values.
- **Editable text layers**: to change the text, font, size, bold/italic, color or alignment, click the layer with the Text tool, double-click its thumbnail or press ✎. Changing the alignment keeps the text block in place. Painting, filters and transforms first ask to rasterize the layer, and Layer ▸ Rasterize does it manually.
- **Healing brush** (R; Alt+click sets the source) and **spot healing** (J): these match the texture from the source to the color and tone around the target.
- **Ellipse selection** (O; Shift/Alt/Shift+Alt add, subtract and intersect; Ctrl draws from the center).
- **Move selected pixels**: with a selection active, the Move tool lifts and moves just those pixels, and Alt+drag duplicates them. Arrow keys nudge.
- **Autosave and crash recovery**: about 1.5 s after each change, and when the page is hidden, the document is saved to IndexedDB (layers, masks, adjustment and text settings). After a crash or reload you get a "Recover unsaved work?" prompt. File ▸ Recover autosave… restores it manually.
- **Mobile / iPhone**: a touch layout with bottom sheets for tools, layers, history and adjustments.
  - Pinch to zoom, two-finger pan, and on-screen Shift/Alt/Ctrl modifier chips.
  - Sharing an export uses the Web Share API.
  - The app is an installable PWA with an offline service worker. iOS Safari is the main target.

## Features (v0.2)

**Files**
- Open an image via file picker (Ctrl+O), drag and drop, or paste from the clipboard
- New blank canvas with presets and white / background-color / transparent fill (Ctrl+N)
- Place an image as a new layer (Ctrl+Shift+O, or drop onto an open document; hold Shift while dropping to open instead)
- Export PNG, JPEG or WebP with a quality setting (Ctrl+Shift+E); JPEG is flattened onto white
- Save / load a project file (`*.tintwork.json`: JSON with one PNG data URL per layer, plus name, visibility, opacity, blend mode, offset and the layer mask with its enabled state). v0.1 projects still open.

**Layers**
- Add, delete, duplicate, rename (double-click), reorder (drag in the list or ▲/▼), merge down, flatten
- Visibility, opacity and 16 blend modes (Canvas `globalCompositeOperation`: multiply, screen, overlay, soft light, difference, hue, color, luminosity and more)
- Live thumbnails
- **Layer masks** (new in v0.2): add a mask that reveals everything or one made from the selection. Paint on it with the brush, eraser or fill: black hides, white reveals and grays are partial. The eraser always hides. Gaussian blur and invert also work on a mask. Click the mask thumbnail to edit the mask and the layer thumbnail to edit pixels (or press `\`). Shift+click the mask thumbnail to enable or disable it; a red X marks a disabled mask. Commands to apply (bake into alpha), invert and delete masks are in Layer ▸ mask commands. Masks follow transforms, crop, resize, duplicate and merge, and they are kept in undo history and project files.

**Tools** (left toolbar)
| Tool | Key | Notes |
|---|---|---|
| Move | V | Drag the active layer, or the selected pixels when there is a selection (Alt duplicates); arrow keys nudge (Shift = 10 px) |
| Rectangle select | M | Drag a rectangle |
| Lasso | L | Freehand outline |
| Polygonal lasso | P | Click points; close with double-click, Enter or a click on the start point; Backspace removes a point; Esc cancels |
| Magic wand | W | Selects by color with tolerance, contiguous or global, active layer or all layers; reuses the fill tool's flood-fill code |
| Crop | C | Drag, then Enter to apply / Esc to cancel |
| Brush | B | Size, hardness, opacity; Shift+click draws a straight line; Alt+click picks a color |
| Eraser | E | Size, hardness, opacity |
| Clone stamp | S | Alt+click sets the source, then paint to copy pixels. Size, hardness and opacity settings; aligned or non-aligned; a crosshair shows the source point |
| Fill | G | Tolerance, contiguous or global |
| Ellipse select | O | Drag an ellipse; Ctrl draws from the center |
| Healing brush / Spot healing | R / J | Alt+click sets the healing source; spot healing samples around the spot automatically |
| Text | T | Click to place, or click an existing text layer to edit it; font, size, bold/italic, color, alignment, live preview |
| Color picker | I | Sample the merged image or the current layer |
| Hand / Zoom | H / Z | Also: hold Space to pan, mouse wheel to zoom at the cursor, middle-drag to pan |

**Selections** (new in v0.2): selections are 8-bit masks, so they can have soft edges.
- Every selection tool has New, Add, Subtract and Intersect modes. Pick one in the options bar, or hold Shift to add, Alt to subtract, or Shift+Alt to intersect.
- The Select menu has All (Ctrl+A), Deselect (Ctrl+D), Invert (Ctrl+Shift+I), Feather… (Shift+F6, a Gaussian blur of the mask), Select layer pixels (from alpha) and Crop to selection.
- Animated marching ants trace the actual mask outline.
- The selection limits brush, eraser and clone strokes, Fill, Clear, Fill with color, Copy, and every adjustment and filter. Soft (feathered) selections blend partially.

**Image / transform**: rotate 90° CW / CCW / 180°, flip horizontal / vertical (whole image or a single layer), image size (resample with proportional lock), canvas size (9-point anchor), crop to selection.

**Adjustments** (live preview, then OK to apply or Cancel to revert; applied to the selection when there is one)
- Brightness / contrast, Hue / saturation / lightness, Exposure (EV, offset, gamma)
- Levels with a histogram (input black / white, midtone gamma, output range), Auto levels
- Invert, Grayscale, Sepia tone

**Filters**: Gaussian blur (3-pass box approximation with premultiplied alpha), Sharpen (unsharp mask with threshold), Add noise (mono or color), Vignette (darken or lighten edges, size, feather).

**Background processing** (new in v0.2): adjustments, filters and feathering run in a module Web Worker (`src/worker.js`) using transferable buffers.
- Previews are coalesced, so only the latest slider value is processed. The status bar shows "Processing…" while a job is running.
- If module workers are unavailable, the same code runs on the main thread instead.
- In the test, a 25 px blur of a 4000×3000 image blocks the page for about 1.6 s when run inline. Through the worker, the longest UI stall was about 0.1 s.

**History & UX**
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) and a clickable history panel (jump to any step); up to 60 steps. Unchanged layer bitmaps are shared between steps to save memory.
- Live histogram panel, marching-ants selection, brush outline cursor, zoom 2%–6400% with pixel-crisp rendering when zoomed in
- Keyboard shortcuts for almost everything (press `?` in the app for the list)
- Dark UI: menu bar, tool options bar, left toolbar, right panels (color, histogram, layers, history), status bar

## Run it

Requires Node 18+ (only to serve static files and run the tests).

```bash
cd photo-editor
npm install          # installs the static server and Playwright (dev only)
npm start            # serves on http://localhost:5173
```

To try it on a phone on the same network, run `npm run serve` (`scripts/serve.mjs`, port 8080, with no-cache headers suitable for the service worker). Add it to the home screen to install it.

Any static file server works, e.g. `python3 -m http.server 5173`. It needs to be served over
http(s) rather than opened as a `file://` URL because it uses ES modules.

### Tests and screenshots

```bash
npx playwright install chromium webkit   # one time
npm test                 # desktop smoke test, then mobile tests
npm run test:desktop     # scripts/smoke-test.mjs (Chromium)
npm run test:mobile      # scripts/mobile-test.mjs (WebKit iPhone 14 + Chromium Pixel 7, touch input)
```

The smoke test starts a temporary server, opens a generated test photo in headless Chromium, applies
hue/saturation and brightness/contrast, adds a Screen-blended layer with brush strokes, adds text, applies a vignette,
converts a selection to grayscale, runs levels and sharpen, undoes and redoes, rotates, exports PNG/JPEG/WebP, saves and reloads a project,
drops a file, and crops. The v0.2 part checks pixels for:
- Lasso, add, subtract and intersect modes, the polygonal lasso and the magic wand.
- Invert, select all and deselect.
- Feathering, and an adjustment through a feathered selection.
- Selection undo.
- Layer masks: paint, erase, reveal, disable, project round-trip, apply, delete and mask from selection.
- Worker availability and UI responsiveness on a 4000×3000 image.
- The clone stamp.

v0.3 adds pixel checks for:
- Every adjustment-layer type, including mask and selection-limited masks, re-editing, cancel, undo and project round-trip, and the cache.
- Curves editor point add, drag, remove and reset.
- Text-layer re-edit, alignment and rasterize.
- Healing.
- Ellipse modes, moving and duplicating selected pixels, and cancel.
- Autosave write, reload, recover and discard.

The mobile test covers on both devices:
- Touch drawing, pinch zoom, the modifier chips and the sheets.
- Adding a curves layer and dragging its curve by touch.
- Text by tap, an ellipse plus a one-finger move, and autosave recovery after a reload.
- The offline service worker.

Screenshots are written to `screenshots/`:

| File | Shows |
|---|---|
| `01-welcome.png` | Empty workspace |
| `02-opened.png` | Test image opened |
| `03-hue-saturation-preview.png` | Adjustment dialog with live preview |
| `04-layer-blend-brush.png` | New layer in Screen mode at 85% with brush strokes, history panel |
| `05-selection-grayscale.png` | Grayscale applied only inside a rectangle selection |
| `06-history-levels-sharpen.png` | Text layer, vignette, levels, sharpen, full history |
| `07-crop-preview.png` | Crop tool overlay with rule-of-thirds guides |
| `08-after-crop.png` | Result after crop |
| `09-filter-menu.png` | Filter menu |
| `10-lasso-selection.png` | Lasso plus added rectangle with a subtracted hole (marching ants) |
| `11-magic-wand.png` | Magic wand selection of one color region |
| `12-feather-adjust.png` | Invert applied through a 20 px feathered selection |
| `13-layer-mask.png` | Layer mask painted with brush and eraser, mask thumbnail targeted |
| `14-worker-large.png` | 4000×3000 image blurring in the worker with the UI live ("Processing…") |
| `15-clone-stamp.png` | Clone stamp stroke with the source crosshair |
| `20-heal-before.png`, `21-heal-after.png` | Healing brush / spot healing before and after |
| `2x-adjust-invert-masked.png` | Invert adjustment layer limited by its mask |
| `2x-curves-editor.png` | Curves editor with points over the histogram |
| `2x-adjust-layers-panel.png` | Layers panel with adjustment layers |
| `2x-text-edit.png`, `2x-text-layers.png` | Re-editing a text layer; text layers with alignment |
| `2x-ellipse-select.png`, `2x-move-selection.png` | Ellipse selection; selected pixels moved |
| `2x-autosave-recover.png`, `2x-autosave-recovered.png` | Recovery prompt after reload; recovered document |
| `m-iphone-*.png`, `m-pixel-*.png` | Mobile: welcome, opened, pinch-zoomed, selection modifiers, tools/layers/history/adjust/menu sheets, adjust dialog, export, landscape, curves, text, recover |

## Project layout

```
index.html            app shell
src/main.js           state, rendering, tools, layers, history, dialogs, file I/O
src/pixels.js         pixel operations (adjustments, blur, sharpen, noise, vignette, flood fill, histogram, runOp dispatcher)
src/selection.js      mask-based selections (combine modes, invert, outline path, clipping canvas)
src/worker.js         Web Worker that runs pixel operations off the main thread
src/ops.js            promise client for the worker with a main-thread fallback
src/curves-editor.js  interactive curves point editor (canvas)
src/autosave.js       IndexedDB autosave / recovery
src/icons.js          original SVG icons
src/styles.css        dark theme
scripts/smoke-test.mjs  Playwright end-to-end test and screenshot generator
scripts/mobile-test.mjs Playwright mobile (WebKit iPhone / Chromium Pixel) touch tests
scripts/serve.mjs     tiny static server for phones on the LAN
sw.js, manifest.webmanifest  PWA offline shell
test-assets/          generated test image (export outputs are git-ignored)
```

`window.tintwork` exposes the state and commands for scripting and testing from the devtools console.

## Known limitations

- Adjustment layers apply with Normal blending at their opacity, and their blend mode is ignored. Merge down bakes them in with Normal blending.
- On documents over 2.5 MP, adjustment layers are computed in the worker, so the previous result shows briefly after each edit.
- Recovery restores the document but not its undo history.
- Text layers use system fonts only and have no per-character styling, paragraph boxes or text on a path. Transforms and filters rasterize a text layer.
- Floating selections can be moved and duplicated, but there is no free transform (scale or rotate) for them. There is no color-range selection.
- Masks are pixel-only (there are no vector masks or clipping masks). Of the adjustments, only Gaussian blur and invert apply to a mask.
- The clone stamp samples the active layer only, as it was when the stroke started. There is no "sample all layers" option for clone or heal.
- Filters (blur, sharpen, noise, vignette) are still destructive; there are no smart filters.
- History stores full layer snapshots (shared when unchanged), so very large images with many steps use a lot of memory.
- Reading and writing pixels (`getImageData`/`putImageData`) still happens on the main thread, which costs roughly 0.1 s per step on a 12 MP image. Brush strokes, the magic wand and selection outlines are computed on the main thread too.
- Masks and selections are full document-size 8-bit arrays, so very large documents use more memory.
- 8-bit sRGB only; no RAW, 16-bit, color management or CMYK.
- Brush has no pressure sensitivity, spacing or texture settings yet.
- Single document at a time; only one autosave slot.

## Roadmap

1. ~~Layer masks~~ (done in v0.2). Next: clipping masks and vector masks.
2. ~~Lasso, polygonal lasso, magic wand, add/subtract/intersect, feather~~ (done in v0.2). ~~Ellipse, select-and-move pixels~~ (v0.3). Next: select by color range, free transform of selections, a quick-mask editing mode, and saved selections.
3. **Non-destructive editing**: ~~adjustment layers, editable text layers~~ (v0.3). Next: smart filters, clipping masks.
4. **Retouching**: ~~clone stamp~~ (done in v0.2), ~~healing brush, spot healing~~ (v0.3), dodge/burn, smudge.
5. **History snapshots**: named snapshots, a history brush, and IndexedDB-backed history so large documents don't run out of memory.
6. ~~**Curves** with a point editor~~ (v0.3). Next: per-channel levels/curves, color balance, vibrance, white balance, LUT import (.cube).
7. **Performance**: ~~Web Worker for filters~~ (done in v0.2); next OffscreenCanvas, WebGL/WebGPU pipeline for real-time adjustments, tiled rendering for very large images.
8. **RAW support** via a WASM decoder (e.g. LibRaw compiled to WASM), EXIF reading and orientation, 16-bit pipeline.
9. **Plugin system**: a sandboxed filter/tool API (worker-based, ImageData in/out), a manifest format and a plugin manager.
10. **Packaging**: installable PWA with offline cache and file handling, and desktop builds (Tauri or Electron) with native open/save dialogs.
11. Multiple documents (tabs), ~~autosave and recovery~~ (v0.3), pen pressure, custom brushes, guides, rulers and snapping.

## License

MIT, original code. The name "Tintwork" is a working title for this project.
