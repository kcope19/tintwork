# Tintwork vs. paid editors: living comparison

This document compares Tintwork with current paid editors at each milestone. It covers **functionality and general workflows only**. Tintwork copies no code, assets, icons, names or trade dress from these products. Product names are used here for comparison only, and each belongs to its owner.

Reference products: Adobe Photoshop, Affinity Photo, Pixelmator Pro, Capture One / Lightroom (where relevant), and Photopea (as the closest web reference).

Status key: ✅ done · 🟡 partial · ❌ not yet (milestone where planned)

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

### Benchmark caveat
`scripts/bench.mjs` ran on a Linux box with no GPU. Headless Chromium used SwiftShader (software) and WebKit used software GL, so GPU timings there are slower than the CPU worker and are not representative of real hardware (see README).

## Roadmap (feature areas researched as each milestone lands; Windows + Chrome/Edge first)
- v0.6: WebGPU engine, mouse precision (stabilizer, on-canvas brush resize, context menus), File System Access, installable PWA, Windows conventions; shapes, gradients, dodge/burn, warp, perspective, red-eye
- v0.7: groups, clipping masks, layer styles
- v0.8: auto enhance, auto white balance, straighten, looks and presets
- v0.9: multiple document tabs, crop presets, batch export
- v1.0: onboarding, help, accessibility, error handling, iPhone memory tuning
