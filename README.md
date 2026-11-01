# Tintwork

An original, browser-based layered image editor built on the HTML Canvas 2D API.
No frameworks, no build step, no server-side processing: images never leave your browser.

Tintwork takes general inspiration from what desktop photo editors can do (layers, tools,
adjustments, filters, history) but has its own name, UI, icons and code. It does not use
any third-party branding, assets or proprietary code.

![Workspace](screenshots/04-layer-blend-brush.png)

## Features (v0.1)

**Files**
- Open an image via file picker (Ctrl+O), drag and drop, or paste from the clipboard
- New blank canvas with presets and white / background-color / transparent fill (Ctrl+N)
- Place an image as a new layer (Ctrl+Shift+O, or drop onto an open document; hold Shift while dropping to open instead)
- Export PNG, JPEG or WebP with a quality setting (Ctrl+Shift+E); JPEG is flattened onto white
- Save / load a project file (`*.tintwork.json`: JSON with one PNG data URL per layer, plus name, visibility, opacity, blend mode and offset)

**Layers**
- Add, delete, duplicate, rename (double-click), reorder (drag in the list or ▲/▼), merge down, flatten
- Visibility, opacity and 16 blend modes (Canvas `globalCompositeOperation`: multiply, screen, overlay, soft light, difference, hue, color, luminosity and more)
- Live thumbnails

**Tools** (left toolbar)
| Tool | Key | Notes |
|---|---|---|
| Move | V | Drag the active layer; arrow keys nudge (Shift = 10 px) |
| Rectangle select | M | Shift = square; limits painting, fills, adjustments and filters |
| Crop | C | Drag, then Enter to apply / Esc to cancel |
| Brush | B | Size, hardness, opacity; Shift+click draws a straight line; Alt+click picks a color |
| Eraser | E | Size, hardness, opacity |
| Fill | G | Tolerance, contiguous or global |
| Text | T | Click to place; font, size, bold/italic, color, live preview; text goes on its own layer |
| Color picker | I | Sample the merged image or the current layer |
| Hand / Zoom | H / Z | Also: hold Space to pan, mouse wheel to zoom at the cursor, middle-drag to pan |

**Image / transform**: rotate 90° CW / CCW / 180°, flip horizontal / vertical (whole image or a single layer), image size (resample with proportional lock), canvas size (9-point anchor), crop to selection.

**Adjustments** (live preview, then OK to apply or Cancel to revert; applied to the selection when there is one)
- Brightness / contrast, Hue / saturation / lightness, Exposure (EV, offset, gamma)
- Levels with a histogram (input black / white, midtone gamma, output range), Auto levels
- Invert, Grayscale, Sepia tone

**Filters**: Gaussian blur (3-pass box approximation with premultiplied alpha), Sharpen (unsharp mask with threshold), Add noise (mono or color), Vignette (darken or lighten edges, size, feather).

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

Any static file server works, e.g. `python3 -m http.server 5173`. It needs to be served over
http(s) rather than opened as a `file://` URL because it uses ES modules.

### Tests and screenshots

```bash
npx playwright install chromium   # one time
npm test                          # runs scripts/smoke-test.mjs
```

The smoke test starts a temporary server, opens a generated test photo in headless Chromium, applies
hue/saturation and brightness/contrast, adds a Screen-blended layer with brush strokes, adds text, applies a vignette,
converts a selection to grayscale, runs levels and sharpen, undoes and redoes, rotates, exports PNG/JPEG/WebP, saves and reloads a project,
drops a file, and crops. It checks pixel results along the way and writes screenshots to `screenshots/`:

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

## Project layout

```
index.html            app shell
src/main.js           state, rendering, tools, layers, history, dialogs, file I/O
src/pixels.js         pixel operations (adjustments, blur, sharpen, noise, vignette, flood fill, histogram)
src/icons.js          original SVG icons
src/styles.css        dark theme
scripts/smoke-test.mjs  Playwright end-to-end test and screenshot generator
test-assets/          generated test image (export outputs are git-ignored)
```

`window.tintwork` exposes the state and commands for scripting and testing from the devtools console.

## Known limitations

- Selections are rectangles only (no lasso, magic wand, feathering or masks yet).
- Text is rasterized when you click "Add text" and can't be edited afterwards (it stays on its own layer, so you can still move it, change its opacity or delete it).
- Adjustments and filters are destructive once applied (the preview is live, but there are no adjustment layers yet).
- History stores full layer snapshots (shared when unchanged), so very large images with many steps use a lot of memory.
- Pixel operations run on the main thread; large images (more than about 20 MP) can briefly freeze the UI during blur or hue/saturation previews.
- 8-bit sRGB only; no RAW, 16-bit, color management or CMYK.
- Brush has no pressure sensitivity, spacing or texture settings yet.
- Single document at a time; no autosave.

## Roadmap

1. **Masks**: layer masks (paint black/white to hide/reveal), clipping masks, mask from selection.
2. **Selections**: lasso, polygonal lasso, ellipse, magic wand (reusing the flood-fill code), add/subtract/intersect, feather, select by color range, select and move pixels.
3. **Non-destructive editing**: adjustment layers and smart filters re-rendered from the source, editable text layers.
4. **Retouching**: clone stamp, healing brush (texture plus color match), spot removal, dodge/burn, smudge.
5. **History snapshots**: named snapshots, a history brush, and IndexedDB-backed history so large documents don't run out of memory.
6. **Curves** with a point editor, per-channel levels/curves, color balance, vibrance, white balance, LUT import (.cube).
7. **Performance**: Web Workers / OffscreenCanvas for filters, WebGL/WebGPU pipeline for real-time adjustments, tiled rendering for very large images.
8. **RAW support** via a WASM decoder (e.g. LibRaw compiled to WASM), EXIF reading and orientation, 16-bit pipeline.
9. **Plugin system**: a sandboxed filter/tool API (worker-based, ImageData in/out), a manifest format and a plugin manager.
10. **Packaging**: installable PWA with offline cache and file handling, and desktop builds (Tauri or Electron) with native open/save dialogs.
11. Multiple documents (tabs), autosave and recovery, pen pressure, custom brushes, guides, rulers and snapping.

## License

MIT, original code. The name "Tintwork" is a working title for this project.
