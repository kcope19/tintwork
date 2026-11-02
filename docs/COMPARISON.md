# Tintwork vs. paid editors: living comparison

This document compares Tintwork with current paid editors at each milestone. It covers **functionality and general workflows only**. Tintwork copies no code, assets, icons, names or trade dress from these products. Product names are used here for comparison only, and each belongs to its owner.

Reference products: Adobe Photoshop, Affinity Photo, Pixelmator Pro, Capture One / Lightroom (where relevant), and Photopea (as the closest web reference).

Status key: ✅ done · 🟡 partial · ❌ not yet (milestone where planned)

## v1.1: camera RAW and layered PSD (researched 2026-11-02)

Compared with Photoshop + Camera Raw, Lightroom Classic and Affinity Photo 2 (Develop persona, PSD import/export).

| Feature | Photoshop / Camera Raw | Lightroom Classic | Affinity Photo | Tintwork 1.1 |
|---|---|---|---|---|
| RAW formats | Very broad camera list, updated with each release [46][47] | Same engine as Camera Raw [46] | Broad, own engine (Apple's engine optional on Mac) [62] | 🟡 DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 verified on 9 sample cameras; 17 more extensions accepted by the decoder, untested |
| Develop before editing | Camera Raw dialog/filter, non-destructive, re-openable [47] | Develop module, fully non-destructive | Develop persona, one-way into pixel layers [62][63] | 🟡 Develop dialog, one-way into a 16-bit pixel layer (like Affinity); last settings remembered for batch |
| White balance | As shot, auto, presets, temp/tint, eyedropper [46] | Same | Temp/tint, eyedropper [63] | 🟡 As shot, auto, custom temperature/tint; no eyedropper or presets |
| Tone | Exposure, contrast, highlights, shadows, whites, blacks, curves [46] | Same | Exposure, black point, brightness, shadows/highlights, curve [62] | 🟡 Exposure, highlight recovery, shadows, contrast; no curve, whites/blacks, clarity, vibrance |
| Noise reduction | Manual + AI denoise | Manual + AI denoise | Luminance/colour + assistant presets [62] | 🟡 Luminance and colour (bilateral), no detail/sharpening controls, no AI |
| Lens correction | Profile database (distortion, vignette, CA), auto from EXIF, amount sliders [64][65] | Same | Profile-based, manual distortion/CA/defringe/vignette [62][66] | 🟡 Distortion and vignetting from DNG opcodes (on/off) and a manual vignette slider; no profile database, so most CR2/NEF/ARW files get no automatic distortion fix; no CA/defringe |
| Local edits / masks in RAW | Brushes, gradients, AI masks | Same | Brush/gradient overlays | ❌ (edit after Open with layers and masks) |
| Bit depth after develop | 8/16/32-bit | n/a (export 8/16-bit) | 16/32-bit | ✅ 16-bit |
| Embedded JPEG fallback | n/a (always decodes supported cameras) | Shows embedded preview while loading | n/a | ✅ Automatic, with a notice, when the sensor data or container cannot be decoded; also on demand |
| PSD/PSB open: layers, groups, masks, blend modes, opacity | ✅ native | ❌ flattened composite only, and only if saved with Maximize Compatibility [67][68] | ✅ most layer work, PSB too [69][70] | ✅ incl. groups (pass-through), clipping, group masks, 8/16-bit, PSB |
| PSD open: adjustment layers | ✅ | ❌ | ✅ mapped to equivalents [69][70] | 🟡 brightness/contrast, levels, curves, exposure, hue/saturation, invert; others skipped with a notice |
| PSD open: text / smart objects / layer styles | ✅ editable | ❌ | 🟡 text optionally editable, smart objects editable when enabled, styles imported [69][71] | 🟡 rasterized from stored pixels with a notice; effects dropped |
| PSD export | ✅ | ❌ (writes PSD only via Edit in Photoshop) [72] | ✅ PSD (accuracy or editability presets), no PSB; live filters rasterized [71][73] | ✅ layers, groups, masks, clipping, blend modes, opacity, matching adjustments, composite, 8/16-bit; styles baked; no PSB |
| Fallback for unreadable layers | n/a | Uses the composite [67] | — | ✅ opens the composite with a notice |

### Summary
Tintwork now covers the everyday RAW path (open → white balance → exposure/tone → noise → 16-bit layered editing) and PSD as an interchange format, which puts it ahead of Lightroom for layered PSD files and roughly level with Affinity Photo on what survives a round trip (both rasterize parts of the file and both lack PSB export). It trails all three on RAW depth: no lens-profile database, no local adjustments or curves in develop, no AI denoise, no editable text or smart objects from PSD, and a single-threaded develop (about 4 s for a 24 MP file end to end on this box versus near-instant previews in the desktop apps).

## v1.0 "core complete" summary (2026-11-01)

Tintwork 1.0 is a free, local-first, browser-based layered editor. The tables below for v0.5–v0.9 hold the detail and sources; this is the overall picture.

**Where Tintwork matches the paid editors (everyday photo editing)**
- Layers with masks, groups (including pass-through), clipping masks, 16+ blend modes, opacity, multi-select, align/distribute.
- Non-destructive adjustment layers (curves, levels, hue/saturation, exposure, white balance, 3D LUTs), live filters, editable text, layer styles (drop/inner shadow, outer/inner glow, stroke, colour overlay).
- Selections (marquee, lasso, polygonal, wand, colour range, refine edge, feather), free transform, warp, perspective, liquify, crop/straighten with presets.
- Retouching (clone, healing, spot healing, dodge/burn, red eye), 16-bit documents end to end, PNG 16-bit in/out.
- Files: tabs, project files, recent files, multi-size export, recorded actions and folder batch processing, autosave with crash recovery, user guide and keyboard shortcuts that follow Windows conventions.

**Where it beats them**
- No install, no account, no subscription; it runs offline as a PWA, and images never leave the device.
- Crash recovery is on by default for every open document with its undo history.
- Looks are plain adjustment-layer groups you can open and edit, and batch export writes several sizes and formats in one pass.
- Transparent engineering: a built-in benchmark, a CPU fallback for every GPU feature, and an automated test suite (568 checks).

**Where it trails**
- No RAW development, ICC colour management, CMYK, 32-bit/HDR, or PSD/TIFF files (Photoshop, Affinity Photo and Pixelmator Pro all have these).
- No generative or AI-assisted features (generative fill, subject/sky selection, AI denoise or upscale), no content-aware fill or move.
- Fewer specialist tools: no vector shapes or vector masks, no pen tool, no smudge/mixer brush, no pressure or custom brushes, no bevel/emboss or pattern overlays, no frequency-separation helpers, no panorama/HDR merge or focus stacking.
- Scale: very large documents are limited by browser memory (guardrails warn and refuse), and full 24 MP recomposites take about 0.3 s on the CPU path; the GPU path is unverified on real Windows hardware until Help ▸ Run performance benchmark is run there.
- Actions record whole commands only; there are no conditional actions, droplets or scripting beyond the devtools API.

## v0.9: documents, presets, multi-size export, batch and actions (researched 2026-11-01)

| Area | Photoshop | Affinity Photo | Tintwork v0.9 |
|---|---|---|---|
| Document tabs | Tabs by default; Ctrl+Tab / Shift+Ctrl+Tab cycle; drag a layer onto another tab, or Duplicate Layer to another document [55][56] | Tabs | Tabs above the canvas, each with its own history, view and autosave slot; Ctrl+Tab / Ctrl+F6 cycle; drag a layer from the Layers panel onto a tab, or Layer ▸ Duplicate to document (centred); closing a changed document asks first |
| Crop presets | Ratio and W × H × Resolution, 1:1, 4:5, 5:7, 2:3, 16:9, New Crop Preset, swap orientation [57] | Ratio / absolute crop | Social (1:1, 4:5, 9:16, 16:9, 1.91:1), banners, print 4×6 / 5×7 / 8×10 / A4 at a chosen DPI, free ratios, swap, ratio lock, custom presets; one undo step for crop + resize |
| Resize to preset | Image Size with resolution [58] | Resize Document | Image ▸ Resize to preset: crop to fill (exact size) or fit inside, orientation auto / portrait / landscape, DPI written to JPEG/PNG |
| Multi-size export | Export As: several relative sizes with suffixes in one go [59] | Batch job with several formats, one size per job [61] | File ▸ Export multiple sizes: any mix of original, long edge, width, scale % and preset sizes, JPEG / PNG / WebP, naming pattern, to a folder (File System Access) or a ZIP |
| Actions | Record / stop / play; applied as one history step; editable steps [53] | Macros (record, library; export not recordable) [60] | Record / stop / replay (adjustments, filters, rotate / flip, crop & resize presets, looks, auto fixes, image size); 3 built-ins; import / export JSON; steps listed, not editable |
| Batch | File ▸ Automate ▸ Batch: action, source folder (+ subfolders), destination, file naming [54] | New Batch Job: files, macros, formats, W/H [60][61] | File ▸ Batch process: folder (+ subfolders) or files, an action and/or a look, several output sizes, naming tokens {name} {n:3} {N} {w} {h} {preset} {date}, progress bar and Cancel, failed files listed |
| v0.8 gaps closed | — | — | 3D LUT layers render on WebGL2 and WebGPU (match CPU within 3 levels); 16-bit shadow / glow / stroke pixels; options for auto enhance (which fixes, strength) and auto white balance (strength, warmth) [45] |

### Summary
Tintwork now covers the everyday "many files" workflow: several open documents, social/print presets, one-click multi-size export and folder batch processing with recorded actions. Still missing compared with the paid editors: editable / conditional action steps, droplets, recording tool strokes, saving back over originals, parallel batch processing, and floating or side-by-side document windows.

## v0.8: core structure, automatic tools and looks (researched 2026-11-01)

| Feature | Tintwork status | How paid tools do it | Our improvement / gap |
|---|---|---|---|
| Multi-layer selection | ✅ Ctrl+click toggles and Shift+click selects a range in the Layers panel. Move tool, arrow-key nudge, free transform, Group (Ctrl+G), Delete and Align/Distribute all act on every selected layer | Photoshop: Shift-click adjacent and Ctrl/Cmd-click non-adjacent layers, then use the Move tool or Layer ▸ Align / Distribute [41][42] | On par for everyday use. Gap: no "align to selection" option for multiple layers (a single layer aligns to the selection or the canvas) |
| Align / distribute | ✅ Left, horizontal centres, right, top, vertical centres and bottom; distribute horizontally or vertically by centres (needs 3 or more layers); each is one undo step | Photoshop: align to edges or centres for 2+ layers; distribute for 3+, including distribute-spacing variants [41][43] | Same core set. Gap: no "distribute spacing" (equal gaps) mode or key-object alignment |
| Free transform on groups | ✅ Ctrl+T on a group or on several layers transforms all of them as one box. Each layer (and its mask) is resampled once with the shared matrix | Photoshop: free transform works on groups and on several layers [42] | Comparable. Text and smart layers are converted to pixels when transformed as part of a group |
| Pass-through groups with opacity or a mask | ✅ Now rendered as true pass-through on the CPU, WebGL2 and WebGPU: the contents act on the layers below, then the result is mixed back with the untouched backdrop by opacity × mask (CPU/GPU results match in tests) | Photoshop: Pass Through is the default group mode; opacity and masks apply to the group's combined effect [24][25] | Fixes the v0.7 gap (these groups used to be isolated) |
| 16-bit groups, styles, warp, liquify | ✅ In 16-bit documents groups composite in float, styled layers keep their 16-bit body (only pixels the effects change are 8-bit), and warp, perspective and liquify resample the 16-bit data | Photoshop: groups, layer styles and transforms work in 16-bit mode [3] | Closes most of the v0.7 8-bit fallbacks. Gaps: effect pixels (stroke, glow, shadow) are still computed at 8 bits; a group that is itself clipped composites at 8 bits |
| Auto enhance | ✅ Image ▸ Auto enhance (Ctrl+Shift+L) analyses the picture and adds an editable "Auto enhance" group: white balance, levels (0.5% clip plus a midtone gamma), a gentle S-curve and, for dull pictures, a saturation boost. It only adds the steps the picture needs | Photoshop: Auto Tone / Auto Contrast / Auto Color, either destructive (Image menu) or as the Auto button on a Levels/Curves layer, with algorithm and clipping options (default 0.1% clip) [44][45]. Camera Raw / Lightroom: an Auto button sets the Basic sliders [47] | **Improvement:** non-destructive by default, and every step is a normal adjustment layer you can tweak or delete. Gap: no options dialog (algorithm, clip %, target colours) |
| Auto white balance, eyedropper, temperature/tint | ✅ White balance adjustment (Adjust menu or an adjustment layer) with Temperature and Tint (−100..100), computed in linear light and luminance-preserving, on every engine. Auto white balance uses a gray-world estimate over trustworthy pixels; the eyedropper makes the clicked spot neutral (it edits the selected WB layer or adds one) | Camera Raw: White Balance menu (As Shot, Auto, presets), Temperature and Tint (−100..100 for JPEG/TIFF) and a White Balance tool that makes the clicked spot neutral [46][47] | Same model for already-rendered images, as an editable layer. Gaps: no Kelvin scale or camera presets (we do not decode RAW) |
| Straighten (manual and auto) | ✅ Straighten tool: drag along a line that should be level or vertical; the picture is rotated and (optionally) cropped to the largest clean rectangle with the same aspect. Auto straighten finds the dominant near-horizontal or near-vertical line with a Hough transform on Sobel edges (±20°, 0.1° steps) | Photoshop: Straighten in the Crop tool's options bar, or the Ruler tool + Straighten (auto-crops; Alt avoids the crop) [48][49]. Camera Raw: Geometry ▸ Auto/Level upright with Constrain crop [47] | Comparable manual tool. **Auto** straighten without AI. Gaps: no content-aware fill of the corners instead of cropping; no multi-axis Upright |
| Looks / presets | ✅ Looks panel with 12 original presets built only from adjustment layers. Each one is added as an editable pass-through group whose opacity is the intensity slider. Save your own look from a group or selected adjustment layers, and import/export looks as JSON | Lightroom: Presets panel (Recommended, Premium, Yours) with an Amount slider from 0 to 200 [50][51] | **Improvement:** the look stays as visible, editable layers instead of hidden slider values. Gaps: intensity goes from 0 to 100% only (no exaggerate above 100%), and there are no AI-recommended or adaptive presets |
| 3D LUT import | ✅ Layer ▸ New adjustment layer ▸ 3D LUT from .cube file: trilinear lookup, an Amount control, layer opacity and mask; the table is saved inside the project file | Photoshop: Color Lookup adjustment layer, Load 3D LUT (.cube, .3dl, .look); strength through layer opacity [52] | Comparable for .cube. Gaps: no .3dl/.look/ICC formats or built-in LUT library; LUT layers render on the CPU (GPU engines fall back for that layer) |

### Summary
v0.8 finishes the core layer structure: multi-layer selection with move, transform, group, align and distribute; free transform on groups; true pass-through groups with opacity or masks on every engine; and 16-bit groups, styles, warp and liquify. On top of that it adds non-AI automatic tools that, unlike the paid editors' menu commands, always create editable adjustment layers (auto enhance, auto white balance, a white balance eyedropper and a Hough-based auto straighten), a Looks panel whose presets stay as editable layer groups, and .cube LUT import. The main gaps left are content-aware fill for straightened corners, a Kelvin/RAW white balance, preset amounts over 100%, and an options dialog for the auto tools.

## v0.7: groups, clipping, layer styles, warp/perspective/liquify, benchmark (researched 2026-11-01)

| Feature | Tintwork status | How paid tools do it | Our improvement / gap |
|---|---|---|---|
| Layer groups | ✅ Nested groups (Ctrl+G / Ctrl+Shift+G, New group), collapse/expand, group opacity, blend mode and mask, **Pass through** as the default group mode; moving the group moves its children; groups are saved in projects (format v6) | Photoshop: groups with their own opacity/mode/mask; Pass Through is the default and means the group has no blending of its own; any other mode composites the group first [24][25]. Affinity: Ctrl/Cmd+G groups, default pass-through, masks on groups [28]. Photopea: groups with masks, modes, opacity and styles [31] | Same model and defaults. Gaps: a pass-through group with opacity < 100% or a mask is rendered isolated (like Normal); free transform of a whole group is not available yet (the Move tool works); single-layer selection only, so "Group layers" groups the active layer |
| Clipping masks | ✅ Ctrl+Alt+G creates/releases; a clipped layer shows only where its base is opaque; chains of clipped layers share the base; indented row with an arrow in the panel; rendered identically on the CPU, WebGL2 and WebGPU engines (tested) | Photoshop: the base layer's alpha clips the layers above; by default clipped layers blend with the base layer's mode ("Blend Clipped Layers As Group") [24]. Affinity: clipping by nesting a child inside its parent [29]. Photopea: Layer ▸ Clipping Mask, Alt+Ctrl+G [32] | Comparable. Gap: no "Blend Clipped Layers As Group" option |
| Layer styles | ✅ Drop shadow, inner shadow, stroke (outside/inside/centre), outer glow, inner glow, colour overlay. Each has its own on/off switch and editable colour/opacity/size/angle/distance/blend; live preview, Cancel restores; "fx" badge and per-effect rows in the Layers panel (toggle/remove); show/hide all; clear; saved in projects; applied on every engine | Photoshop: 10 effects (adds bevel & emboss, satin, gradient and pattern overlay) with contours, global light and saved style presets [26][27]. Affinity: non-destructive effects, several instances of one effect, drag "fx" to copy [28]. Pixelmator Pro: Fill, Stroke, Shadow and Inner Shadow styles [30]. Photopea: full PSD-style set [31] | The six most-used effects with live editing. Gaps: no bevel/emboss, satin, gradient/pattern overlay, contours, global light, multiple instances of one effect, or style presets; shadow and glow blend modes apply within the layer's effect stack, not against the layers below |
| Warp (mesh) | ✅ Edit ▸ Warp: 3×3 / 4×4 / 5×5 control-point grids, smooth (Catmull-Rom) mesh, live low-res preview while dragging, Enter applies, Esc cancels, Reset; the layer mask is warped with it; GPU render (WebGPU/WebGL2) with a CPU fallback | Photoshop: Edit ▸ Transform ▸ Warp with 3×3/4×4/5×5 or custom grids, split lines, Bézier handles, preset styles and multi-point selection [33][34] | Same grid presets. Gaps: no custom sizes, split lines, Bézier handles, multi-point selection or preset warp styles; the warp ignores the selection; in 16-bit documents the warped layer drops to 8-bit precision |
| Perspective | ✅ Edit ▸ Perspective: drag the four corners (true projective mapping), live preview, Enter/Esc | Photoshop: Free Transform ▸ Perspective/Distort plus a separate multi-plane Perspective Warp that needs the GPU [35] | One-plane perspective covers the common keystone fix. Gap: no multi-plane quads or automatic straightening |
| Liquify-style brush | ✅ Liquify tool (K): push, bloat, pinch and restore, with size and strength; works directly on the canvas (no modal window); displacement field with a CPU preview while dragging, final render on the GPU when available; one undo step per stroke | Photoshop: Liquify filter workspace with forward warp, twirl, pucker, bloat, push-left, reconstruct, smooth, freeze/thaw masks and face-aware tools; GPU-accelerated [36][37]. Affinity: Liquify persona [29]. Pixelmator Pro: Bump, Pinch and Twirl reshape tools on canvas [38] | On-canvas like Pixelmator Pro. Gaps: no twirl, freeze mask, smooth or face-aware tools; restore works within a stroke only |
| Built-in benchmark | ✅ Help ▸ Run performance benchmark…: the same operations (blur, curves, 10-layer composite cold and warm, mesh warp) at 1/12/24 MP on CPU, WebGL2 and WebGPU with synthetic images; results table (fastest in green), adapter name/vendor, a "software adapter — not representative" flag, Copy results as text; open documents are not touched | Affinity: Help ▸ Benchmark (close documents first) with CPU and GPU raster scores; scores only compare within the same version [39][40] | Comparable idea, but reports per-operation milliseconds per engine (easier to act on than a score) and flags software adapters. Gap: numbers on this box come from SwiftShader and say nothing about real Windows GPUs |
| Automatic engine choice | ✅ Automatic now runs a quick probe (1 MP blur + curves + composite on each engine) and picks the fastest; View ▸ Rendering engine… shows the probe times and "Measure again" | Photoshop and Affinity: fixed GPU on/off settings; Photoshop disables some features without a GPU [1][5] | **Improvement:** measured instead of rule-based, so a slow or software GPU never wins by default |
| 16-bit dodge/burn and red eye | ✅ Both now compute and store at 16 bits per channel in 16-bit documents (previously touched pixels dropped to 8-bit) | Photoshop: dodge/burn and red eye work in 16-bit mode [3] | Now on par for these tools. Remaining 8-bit paths in 16-bit documents: brushes/eraser, clone/heal, transforms, warp, groups/styles compositing |

### Summary
v0.7 closes the biggest structural gap with the paid editors: Tintwork now has nested groups with pass-through, clipping masks and editable layer styles that round-trip through projects, plus warp, perspective and an on-canvas liquify brush rendered on the GPU with a CPU fallback. The built-in benchmark resembles Affinity's but reports per-operation times per engine, and it now drives the Automatic engine choice. The main remaining gaps are bevel/emboss and the other style effects, style presets, multi-layer selection and group transforms, advanced warp controls (splits, custom grids, multi-plane perspective), the fuller liquify toolset, and real Windows GPU measurements.

## v0.6: Windows/Chromium engine, files and core tools (researched 2026-11-01)

Source numbers like [12] refer to the Sources list below.

| Feature | Tintwork status | How paid tools do it | Our improvement / gap |
|---|---|---|---|
| GPU compute engine | ✅ WebGPU compute (composite, blur, LUT adjustments, hue/sat, brush dabs), with WebGL2 then CPU fallbacks and a selectable engine | Photoshop/Affinity: native GPU back ends (D3D12/Metal/OpenCL) with a CPU fallback [1][5]. Photopea: WebGL in the browser | Among browser editors, WebGPU is the newest API available. Gap: we could not measure on real Windows GPU hardware here (only SwiftShader); see the README tables |
| Save in place / Save As / recent files | ✅ File System Access: Ctrl+S writes back to the file, Ctrl+Shift+S always asks, opened images are never overwritten by a project save, and Open Recent keeps handles | Desktop editors: native Save/Save As/Open Recent. Photopea: File ▸ Save rewrites a file opened from the device in modern browsers [12][13]. The API is in Chromium on Windows, macOS, ChromeOS, Linux and Android [14] | On par with Photopea. A new document also gets Save (through Save As with a suggested name, which Photopea said it held back on because of picker naming [13]). Gap: no directory/folder access yet (batch export comes in v0.9) |
| Installable app + OS file handling | ✅ PWA with window controls overlay, file_handlers (.png/.jpg/.webp/.tintwork), app shortcuts and an offline shell | Photopea: an installable PWA that registers file handlers through `launchQueue` [15]. Desktop editors: native installers | Comparable to Photopea. Gap: no native installer, and no "Open with" for TIFF/PSD |
| Stroke smoothing (mouse) | ✅ A 0–100 stabilizer: the tip trails the pointer on a string, and catches up on pause or release | Photoshop: Smoothing 0–100 with Pulled String, Stroke Catch-up, Catch-up on Stroke End and Adjust for Zoom modes [16] | Same core behaviour with one simple control. Gap: no per-mode toggles or zoom adjustment |
| Gradient tool | ✅ Linear, radial and reflected; fg→bg or fg→transparent; reverse; opacity; dither; Shift snaps to 45°; selection-aware; paints masks; computed at 16 bits in a 16-bit document | Photoshop: linear, radial, angle, reflected and diamond types; reverse, dither and opacity; Shift constrains to 45°; a newer non-destructive gradient layer with on-canvas handles [17][18] | Dither is always on and the 16-bit path is native. Gaps: no angle/diamond types, no multi-stop editor, and no live gradient layer |
| Shapes | ✅ Rectangle, rounded rectangle, ellipse and line; fill, stroke or both; each on a new layer; Shift constrains, Ctrl draws from the centre; live preview | Pixelmator Pro: vector shape layers (rectangle, rounded rect, oval, polygon, star, line) with editable fill and stroke [19]. Photoshop: vector shape layers | Gap: our shapes are raster (they cannot be edited after they are drawn), and there are no polygons, stars or custom shapes. Vector shapes are planned after layer styles |
| Dodge / Burn | ✅ A brush with a Shadows/Midtones/Highlights range and exposure; Alt toggles between dodge and burn; masks are excluded | Photoshop and Affinity: Dodge/Burn tools with a tonal range (Shadows/Midtones/Highlights) and exposure; Alt toggles in Affinity [20][21] | Comparable. Gap: no "protect tones" option, and there is a non-destructive overlay-layer workflow only if done by hand |
| Red-eye removal | ✅ Click a pupil; pupil size and darken amount | Photoshop: Red Eye tool with Pupil Size and Darken Amount [22]. Pixelmator Pro: repair tools instead of a dedicated red-eye tool [23] | On par with Photoshop's controls. Gap: no automatic eye detection |
| Context menus | ✅ Right-click on the canvas (undo/redo, selection commands, copy/paste, free transform) and on layers (rename, duplicate, delete, merge, show/hide, mask) | All desktop editors offer context menus | Comparable |
| Warp / perspective | ❌ Deferred to v0.7 (✅ done in v0.7) | Photoshop: Edit ▸ Transform ▸ Warp/Perspective. Affinity: Mesh Warp / Perspective tools | Gap |

### Summary
In v0.6 Tintwork caught up with Photopea on the "desktop-like web app" basics: real Save/Save As, recent files, OS file handling and an installable window. It added a WebGPU engine with fallbacks. The core tools now include a mouse-friendly stroke stabilizer, gradients, shapes, dodge/burn and red eye. The biggest remaining gaps compared with paid desktop editors are editable vector shapes and live gradient layers, warp/perspective transforms (next milestone), groups, clipping masks and layer styles. GPU speed on real Windows hardware also remains unmeasured.

## v0.5: GPU rendering and high bit depth (researched 2026-11-01)

| Feature | Tintwork status | How paid tools do it | Our improvement / gap |
|---|---|---|---|
| GPU-accelerated compositing | ✅ WebGL2 engine composites layers, all of Tintwork's blend modes, opacity, layer masks and adjustment layers in float/half-float textures | Photoshop: Preferences ▸ Performance ▸ "Use Graphics Processor"; the current GPU mode (e.g. Metal / D3D12 / CPU / software) is shown in the document status / Info panel [1][2]. Affinity: Metal (macOS) / OpenCL (Windows) compute acceleration toggle [5]. Pixelmator Pro: Metal / Core Image GPU engine. Photopea: WebGL [8] | Same model of a user-visible switch with a status readout. Docinfo shows `GPU`/`CPU`, and View ▸ Rendering engine… shows the renderer, texture limits, memory use and probe time |
| Automatic CPU fallback | ✅ Falls back to the CPU / worker path when WebGL2 or float render targets are missing, when the context is lost, or when the documented texture limits or memory budget would be exceeded. A toast explains why | Photoshop: features with a CPU pipeline fall back. Some features need a GPU and are disabled without one [1]. Photopea: without WebGL2 + `EXT_texture_norm16` it disables WebGL and uses the CPU [8][9] | **Improvement:** an automatic *speed probe* (1 MP blur) keeps the CPU path when the GPU is a software rasterizer or slower than the worker, so it never "accelerates" into a stall. Every Tintwork feature works on both paths |
| Force GPU / CPU setting | ✅ Automatic / GPU / CPU radio buttons, saved per browser | Photoshop: GPU checkbox plus Advanced settings [2]. Affinity: hardware-acceleration checkbox, plus a built-in benchmark [5][6] | Comparable. Gap: no full user-facing benchmark (only the startup probe; `scripts/bench.mjs` is developer-side) |
| GPU filters | ✅ Separable Gaussian blur, unsharp-mask sharpen, noise, vignette, curves/levels (LUT textures), hue/saturation, exposure, brightness/contrast, invert, grayscale, sepia; live (smart) filter stacks | Photoshop: GPU for Blur Gallery, Liquify, Smart Sharpen, etc. [1]. Affinity: most raster filters and adjustments run on Metal/OpenCL; vector work and some blends stay on the CPU [5]. Pixelmator Pro: all Core Image filters on the GPU | Gap: the GPU noise uses a different hash from the CPU path, so the two match only statistically. Linear-light blur runs on the CPU |
| 16 bits per channel documents | ✅ Image ▸ Mode: 8 / 16 bits/channel. Layer data is kept at Uint16. Adjustments, adjustment layers, merge and flatten run at 16 bits | Photoshop: Image ▸ Mode ▸ 8/16/32 bits/channel. Nearly all tools work in 16-bit, and converting down discards data [3][4]. Affinity: Document ▸ Colour Format 8/16/32-bit, all filters in 8/16-bit [6]. Pixelmator Pro: Image ▸ Color Depth 8/16, RAW layers always processed at 16-bit [7]. Photopea 5.6: 16/32-bit, GPU-accelerated [8] | Gap: no 32-bit float / HDR. Brushes, transforms and selection-moves edit the 8-bit proxy and are then reconciled into 16-bit (16-bit precision is kept where pixels are untouched) |
| Linear-light processing | 🟡 Optional "blur & sharpen in linear light" for 16-bit documents (CPU path) | Photoshop: "Blend RGB colors using gamma 1.0" setting and 32-bit linear mode. Affinity: 32-bit linear | Gap: GPU linear path, linear blending of layers (planned for after v1.0) |
| Opening 16-bit PNG | ✅ Bundled pure-JS PNG decoder (fflate inflate, MIT). 16-bit PNGs open as 16-bit documents | All four open 16-bit PNG/TIFF/PSD [3][6][7][8] | Gap: no 16-bit TIFF/PSD, and no ICC / gAMA handling in the decoder (assumes sRGB) |
| 16-bit PNG export | ✅ "PNG 16-bit" export, exact round trip | All four export 16-bit PNG/TIFF | Comparable for PNG |
| Dithered 8-bit output | ✅ 8-bit export of a 16-bit document is dithered by default | Photoshop: Color Settings ▸ "Use Dither (8-bit/channel images)" [10]. Others: dither on conversion or export | Built in, no setting to find. In the benchmark, a steep curve on a narrow ramp gave 41 output levels in the 8-bit pipeline versus 4062 internally (256 after rounding to 8-bit) in 16-bit |
| Project format storing 16-bit | ✅ Project v5 stores 16-bit layers as 16-bit PNG. v4 projects still open | PSD/PSB, .afphoto and .pxd store native bit depth | Open and documented (JSON + PNG) |
| Platform keyboard conventions | ✅ Ctrl/Alt/Shift on Windows and Linux, ⌘/⌥/⇧ on Mac, in menus, tooltips and the shortcuts dialog. Shortcuts that browsers reserve (Ctrl+N/T/W, Ctrl+Shift+N, devtools keys, ⌘M/⌘Q) get alternates. Ctrl+Y and Ctrl+Shift+Z both redo | Photoshop publishes separate Windows (Ctrl/Alt) and macOS (Cmd/Option) shortcut sets [11]. Native apps own every key; web apps such as Photopea run inside the browser's reserved set | **Improvement for the web:** reserved combinations are detected per platform, and each menu shows a combination that actually works in that browser |
| Memory limits | ✅ GPU texture budget (384 MB on iOS, 1.5 GB on desktop), tiles capped at 2048 px on iOS, a 16-bit memory limit, and fewer 16-bit history steps on iOS. A notice explains each downgrade | Photoshop: Memory Usage slider, scratch disks, cache levels [2]. Affinity: RAM usage limit and undo limit [5] | **Improvement for the web:** graceful downgrade with an explanation rather than a crash on iOS Safari. Gap: no disk-backed scratch (planned for after v1.0) |

### Summary
For the v0.5 features, Tintwork now matches the core workflows of the paid editors: a GPU switch with a status readout, CPU fallback, an 8/16-bit mode, 16-bit file I/O and dithered 8-bit output. It improves on Photopea's web approach in two ways. First, it does not need `EXT_texture_norm16`: it uses half-float/float textures, which iOS Safari supports. Second, it probes GPU speed so that software GL never slows users down. The main gaps compared with the desktop tools are 32-bit/HDR, color management (ICC), TIFF/PSD and RAW, a fully 16-bit brush/transform path, and disk-backed memory.

## Sources
1. Adobe, "Photoshop GPU FAQ / graphics processor usage": https://helpx.adobe.com/photoshop/desktop/get-started/technical-requirements-installation/photoshop-and-graphics-processor-gpu-card-usage.html
2. Adobe, "Performance preferences": https://helpx.adobe.com/photoshop/using/performance-preferences.html
3. Adobe, "Bit depth in Photoshop": https://helpx.adobe.com/photoshop/desktop/adjust-color/color-modes/bit-depth-in-photoshop.html
4. Adobe, "Bit depth": https://helpx.adobe.com/in/photoshop/using/bit-depth.html
5. Serif, Affinity Photo help, "Hardware acceleration": https://affinity.bz/help_photo/kr.lproj/pages/Extras/hardwareAcceleration.html, and https://www.affinity.studio/fr_fr/help/extras-hardware-acceleration/
6. Affinity forum, "What performance settings should I use?": https://forum.affinity.serif.com/index.php?/topic/119917-what-performance-settings-should-i-use/
7. Apple, Pixelmator Pro User Guide, "Change the color depth of an image": https://support.apple.com/guide/pixelmator-pro/change-the-color-depth-of-an-image-pixa0ae0513d/mac
8. Photopea blog, "Photopea 5.6: advanced color depth": https://blog.photopea.com/photopea-5-6-advanced-color-depth.html
9. caniuse, `EXT_texture_norm16`: https://caniuse.com/wf-ext-texture-norm16
10. Photoshop dither setting (Color Settings): https://www.underwaterphotography.com/PhotoShop/PhotoShop/1_7_10_4.html
11. Adobe, "Default keyboard shortcuts in Photoshop": https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html
12. Photopea, "Open and Save": https://www.photopea.com/learn/opening-saving
13. Photopea GitHub issue #2118, "Optionally support the Native File System API": https://github.com/photopea/photopea/issues/2118
14. Chrome for Developers, "The File System Access API": https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
15. Chrome for Developers, "How Photopea uses the File Handling API": https://developer.chrome.com/blog/how-photopea-uses-the-file-handling-api
16. Adobe, "Create smoother brush strokes using stroke smoothing": https://helpx.adobe.com/photoshop/desktop/repair-retouch/clean-restore-images/create-smoother-more-polished-brush-strokes-with-stroke-smoothing.html
17. Adobe, "Using gradients" (Photoshop Elements): https://helpx.adobe.com/uk/photoshop-elements/using/gradients.html
18. Photoshop Essentials, "How to Use Live Gradients in Photoshop 2023": https://www.photoshopessentials.com/basics/how-to-use-live-gradients-in-photoshop-2023/
19. Apple, Pixelmator Pro User Guide, "Draw vector shapes and graphics": https://support.apple.com/guide/pixelmator-pro/draw-vector-shapes-and-graphics-pixe136a0db0/mac
20. Affinity forum, "Dodge and Burn Brush: Shadows/Highlights Only": https://forum.affinity.serif.com/index.php?/topic/57578-dodge-and-burn-brush-shadowshighlights-only/
21. Digital Camera World, "Master the dodge and burn tools in Affinity Photo": https://www.digitalcameraworld.com/tutorials/master-the-dodge-and-burn-tools-in-affinity-photo-for-incredible-contrast
22. Adobe, "Remove red eye in flash photos": https://helpx.adobe.com/photoshop/desktop/repair-retouch/clean-restore-images/remove-red-eye-in-flash-photos.html
23. Apple, Pixelmator Pro User Guide, "Repair and clone areas": https://support.apple.com/guide/pixelmator-pro/repair-remove-and-clone-objects-in-images-pixc5f9d789e/macos
24. Adobe, "Layer opacity and blending modes" (group Pass Through, Blend Clipped Layers As Group): https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html
25. Adobe, "Create and manage layers and groups": https://helpx.adobe.com/photoshop/using/create-layers-groups.html
26. Adobe, "Layer style effects and options overview": https://helpx.adobe.com/photoshop/desktop/create-manage-layers/apply-layer-effects/layer-style-effects-and-options-overview.html
27. Photoshop Essentials, "Using Layer Effects and Layer Styles in Photoshop" (effect stacking order): https://www.photoshopessentials.com/basics/using-layer-effects-and-layer-styles-in-photoshop-cc-2020-complete-guide/
28. Affinity Photo, "Layer Effects" tutorial (official channel): https://www.youtube.com/watch?v=ga1Hf3Yv-gE, and Edits 101, "Layers in Affinity Photo": https://edits101.com/layers-affinity-photo/
29. Affinity forum, "Live filter layer: mask layer vs. clipped child": https://forum.affinity.serif.com/index.php?/topic/192171-ap-live-filter-layer-mask-layer-vs-clipped-child/, and Edits 101, "Affinity Photo Personas" (Liquify persona): https://edits101.com/personas-affinity-photo/
30. Pixelmator, "Customize layers using styles": https://support.pixelmator.com/pixelmator-pro-user-guide/customize-layers-using-styles.md
31. Photopea, "Layer Styles": https://www.photopea.com/learn/layer-styles
32. Photopea, "Other Layers" (clipping masks): https://www.photopea.com/learn/other-layers
33. Adobe, "Reshape and distort images with Transform Warp": https://helpx.adobe.com/photoshop/desktop/effects-filters/artistic-stylize-filters/reshape-and-distort-images-with-transform-warp.html
34. Photoshop Essentials, "Warp images with the enhanced Warp tool": https://www.photoshopessentials.com/basics/warp-images-with-the-enhanced-warp-tool-in-photoshop-cc-2020/
35. Adobe, "Edit different perspectives in the same image" (Perspective Warp): https://helpx.adobe.com/photoshop/desktop/repair-retouch/clean-restore-images/edit-different-perspectives-in-the-same-image.html
36. Adobe, "Overview of Liquify filter": https://helpx.adobe.com/photoshop/desktop/effects-filters/artistic-stylize-filters/overview-of-liquify-filter.html
37. Adobe, "Distort filters" (Liquify tools: warp, twirl, pucker, bloat, reconstruct): https://helpx.adobe.com/si/photoshop-elements/using/distort-filters.html
38. Apple, Pixelmator Pro User Guide, "Reshape areas of an image": https://support.apple.com/guide/pixelmator-pro/reshape-areas-of-an-image-pixab55580d5/macos, and "Warp a layer": https://support.apple.com/guide/pixelmator-pro/warp-a-layer-md49514rvgv2/mac
39. Talk Photography, "Affinity Photo 2 performance testing" (Help ▸ Benchmark): https://www.talkphotography.co.uk/threads/affinity-photo-2-performance-testing.764179/
40. Notebookcheck, "Affinity Photo 2 benchmark comparison": https://www.notebookcheck.net/Affinity-Photo-2-benchmark-comparison-Apple-M1-faces-off-against-Intel-Core-AMD-Ryzen-and-Nvidia-GeForce.672070.0.html
41. Adobe, "Align layers in Photoshop": https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/align-content-of-layers-and-groups.html
42. Adobe, "Align and distribute layers": https://helpx.adobe.com/uk/photoshop/using/aligning-layers.html
43. Adobe, "Distribute layers": https://helpx.adobe.com/photoshop/desktop/create-manage-layers/create-layer-compositions/distribute-layers-groups-evenly.html
44. Adobe, "Use Auto Tone, Auto Contrast, and Auto Color": https://helpx.adobe.com/photoshop/desktop/adjust-color/color-corrections/apply-auto-tone-auto-contrast-and-auto-color.html
45. Adobe, "Make quick tonal adjustments" (Auto Color Correction Options): https://helpx.adobe.com/sg/photoshop/using/making-quick-tonal-adjustments.html
46. Adobe, "Make color and tonal adjustments in Camera Raw" (White Balance, Temperature, Tint, White Balance tool): https://helpx.adobe.com/camera-raw/using/make-color-tonal-adjustments-camera.html
47. Adobe, "Introduction to Camera Raw" (Auto, Geometry, Constrain crop): https://helpx.adobe.com/camera-raw/using/introduction-camera-raw.html
48. Adobe, "Straighten tilted photos": https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/crop-straighten/straighten-tilted-photos.html
49. Adobe, "Adjust rotation and canvas size" (Ruler tool Straighten): https://helpx.adobe.com/uk/photoshop/using/adjusting-crop-rotation-canvas.html
50. Adobe, "Edit photos with Presets in Lightroom" (Amount slider 0–200): https://helpx.adobe.com/lightroom/desktop/edit-photos/presets.html
51. Adobe, "Apply Presets in Lightroom Classic": https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/apply-presets.html
52. Adobe, "Edit a photo with color lookup adjustment": https://helpx.adobe.com/ph_fil/photoshop/how-to/edit-photo-color-lookup-adjustment.html
53. Adobe, "Use the Actions panel": https://helpx.adobe.com/photoshop/desktop/automate-tasks/automation-settings-and-presets/use-the-actions-panel.html, and "Record an action": https://helpx.adobe.com/photoshop/desktop/automate-tasks/create-record-actions/record-an-action.html
54. Adobe, "Batch-process files": https://helpx.adobe.com/photoshop/desktop/automate-tasks/process-a-batch-of-files/batch-process-files.html
55. Adobe, "Default keyboard shortcuts" (cycle through open documents): https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html
56. Photoshop Essentials, "Moving Photos Between Tabbed Documents": https://www.photoshopessentials.com/basics/move-photos-tabbed-documents/, and Ask Tim Grey, "Dragging a Layer Across Tabs": https://asktimgrey.com/2024/06/26/dragging-a-layer-across-tabs/
57. Adobe, "Crop tool options": https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/crop-straighten/crop-tool-options.html, and PetaPixel, "How to Crop in Photoshop": https://petapixel.com/how-to-crop-in-photoshop/
58. Adobe, "Resize images" (Image Size parameters): https://helpx.adobe.com/photoshop/desktop/crop-resize-transform/resize-adjust-resolution/resizing-parameters-in-photoshop.html
59. Adobe, "Export files in different sizes": https://helpx.adobe.com/photoshop/desktop/save-and-export/export-files-to-different-formats/export-files-in-different-sizes.html
60. MakeUseOf, "How to Automate and Batch Process Images in Affinity Photo": https://www.makeuseof.com/how-to-automate-batch-process-images-affinity-photo/
61. Affinity forum, "export large amount of images in different sizes and folders": https://forum.affinity.serif.com/index.php?/topic/205542-is-this-possible-in-2024-with-photo-or-designer-to-export-large-amount-of-images-in-different-sizes-and-folders/, and Affinity Photo "Batch Processing" (official video): https://www.youtube.com/watch?v=4qrQjD_0LyI
62. Affinity, "Everything you need to know about editing RAW images and working with RAW files": https://www.affinity.studio/blog/editing-raw-images-and-working-with-raw-files
63. Affinity Photo, "RAW Development" (official video): https://www.youtube.com/watch?v=XCcZiELzrqc
64. Adobe, "Correct lens distortions in Camera Raw": https://helpx.adobe.com/camera-raw/desktop/using/correct-lens-distortions-camera-raw.html
65. Adobe, "Supported lenses" (Camera Raw, updated 2026-09-29): https://helpx.adobe.com/camera-raw/desktop/dng-and-file-formats/supported-lenses.html
66. Digital Camera World, "How to process RAW files in Affinity Photo": https://www.digitalcameraworld.com/photography/photo-editing/how-to-process-raw-files-in-affinity-photo
67. Ask Tim Grey, "Maximize Compatibility for Lightroom Classic": https://asktimgrey.com/2024/04/19/maximize-compatibility-for-lightroom-classic/
68. Ask Tim Grey, "Import Error for Compatibility": https://asktimgrey.com/2025/07/11/import-error-for-compatibility/
69. Affinity, "How to open a PSD file in Affinity": https://www.affinity.studio/blog/how-to-open-a-psd-file
70. Affinity Photo, "PSD/PSB import, export and smart object functionality" (official video): https://www.youtube.com/watch?v=rYcE65H8GA0
71. Beyond Photo Tips, "How Well Does Affinity Handle Adobe PSD files?": https://www.beyondphototips.com/affinity-photo-adobe-psd-files/
72. Adobe, "Edit Lightroom Classic photos in Photoshop": https://helpx.adobe.com/lightroom-classic/help/editing-photoshop.html
73. CreativePro, "Affinity for Photoshop Users": https://creativepro.com/affinity-photoshop-users/

### Benchmark caveat
`scripts/bench.mjs` ran on a Linux box with no GPU. Headless Chromium used SwiftShader (software) for both WebGL2 and WebGPU and WebKit used software GL, so GPU timings there are slower than the CPU worker and are not representative of real hardware (see README).

## Roadmap (feature areas researched as each milestone lands; Windows + Chrome/Edge first)
- ~~v0.6: WebGPU engine, mouse precision, File System Access, installable PWA, Windows conventions; shapes, gradients, dodge/burn, red-eye~~ (done)
- ~~v0.7: groups, clipping masks, layer styles, warp and perspective, liquify, built-in benchmark~~ (done)
- ~~v0.8: auto enhance, auto white balance, straighten, looks and presets~~ (done)
- ~~v0.9: multiple document tabs, crop presets, batch export, actions~~ (done)
- ~~v1.0: onboarding, help, accessibility, error handling, iPhone memory tuning~~ (done)
- ~~v1.1: camera RAW develop, PSD/PSB import and layered PSD export~~ (done)
