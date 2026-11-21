# Tintwork self-audit (v1.6.0 → v1.7.0, updated through v1.35.0)

Date: 2026-11-02 (America/New_York). Target: the live site https://kcope19.github.io/tintwork/ (GitHub Pages).
Method: scripted Playwright runs on a Linux box (Chromium 1280×800 with `?platform=win`, plus WebKit iPhone 13
emulation), Lighthouse 12 desktop preset, and reading competitors' public documentation. **Every finding below was
reproduced 3 times out of 3 on fresh browser profiles** unless it says otherwise. Each regression test in
`scripts/v17-test.mjs` was also run against a v1.6.0 checkout (`TW_ROOT=<v1.6 checkout> node scripts/v17-test.mjs`):
it fails there (4 of 27 checks pass on v1.6, and those 4 are guards that should pass on both) and passes on v1.7 (35/35).

Scripts: `npm run bench:workflows`, `npm run audit:site`, `npm run audit:math`, `npm run audit:safety`. Raw results are in
[docs/audit/](audit/). The workflow scorecard is in [WORKFLOW_BENCHMARK.md](WORKFLOW_BENCHMARK.md).

## v1.35.0 update (2026-11-21, America/New_York)

This covers more of finding #10 from the persona test ([audit/persona-test-v131.md](audit/persona-test-v131.md)): history snapshots with a history brush, and skin smoothing without AI. It also checks that the v1.34 adjustments work in Actions and Batch. No AI was used. No straightening math changed, and no gate was loosened.

**A. History snapshots.** Snapshots belong to the document, so each tab has its own list. Each one holds frozen, shallow copies of the layer list. Canvases are immutable and shared, so a snapshot costs almost nothing until the layers change. The copies are taken before the 16-bit purge of old history steps, so that purge cannot reach them. An **Original** snapshot is made automatically when a document opens ("New canvas" for a blank one).

- **Create:** the ＋ Snapshot button, Edit ▸ New snapshot / New snapshot (named)…, or a history row's context menu ("New snapshot from this step").
- **Other actions:** restore (one undo step, "Restore snapshot “name”", refused during a free transform), rename (modal dialog), delete, and "use as History brush source".
- **Keyboard:** the snapshot list uses the v1.33 roving-row pattern. Arrow keys / Home / End move between rows, Enter restores, F2 renames, Delete deletes, B sets the source, and Shift+F10 or the Menu key opens the context menu.
- **Saving:** the autosave record stores `snapshots` and `histSrc` through the same image encoder as history steps. Project files go to format 9 with a `snapshots` array. A snapshot image that equals a document layer's image is written as a reference, not a second copy. Each layer gets a `uid`, so snapshot layers pair up with the document's layers again on load. Version 8 projects and older autosaves still open; they get only an "Original" snapshot.
- **Limits:**
  - Snapshots are 8-bit, with no 16-bit data and no RAW source.
  - Making a snapshot does not mark the document unsaved.

**B. History brush (Y).** It is the normal paint stroke engine with a source canvas. The stroke mask is built as usual (size, hardness, smoothing), then the layer is blended toward the snapshot's pixels for the same layer by cover × opacity (`destination-out` then `lighter`, an exact lerp, alpha included).

- **Refusals, each with a status message:** no snapshot is chosen; the snapshot's canvas size differs (after a crop or resize); the current layer did not exist in that snapshot.
- **Not done:** painting into masks, and painting from a single history step rather than a snapshot. Use "New snapshot from this step" first.

**C. Smooth skin.** This is `skinSmoothData` in `src/tone.js`, shared by the 8-bit and 16-bit paths:

- **Filter:** a self-guided filter (box means over radius r; ε = (threshold/100 · 0.3)²) smooths flat areas and keeps edges whose contrast is well above the threshold. Then fine texture (pixel minus a 1.5 px blur) is added back × Detail, and the result is mixed with the original by Strength.
- **Processing:** large images are processed in strips, padded by 2r+6 with write-back delayed. The test confirms this matches the one-pass result exactly.
- **Where it is:** Filter ▸ Smooth skin (whole layer / selection), and an adjustment layer (Filter ▸ Smooth skin layer…, or Layer ▸ New adjustment layer). With no selection the layer starts with a black mask, selects the mask, and switches to the Brush with white foreground. That makes two steps (add the layer, paint), where the v1.34 workaround took six. With a selection, the mask is the selection.
- **Measured on synthetic tests (`v135-test`):**
  - Noise σ goes from 7.0 to 0.8 at default settings, and a 140-level edge keeps 131.
  - Detail 100 keeps σ 7.4.
  - Strength 50 gives 3.9.
  - On a real portrait, local cheek texture goes from 2.14 to 1.34.
  - It works in 16-bit documents (checked: the layer changes the cheek; 8-bit vs 16-bit precision was not compared).
  - 12 MP takes about 3.0 s on this box's CPU (worker).
- **Not done:**
  - A GPU shader: the layer composites on the CPU, like the v1.34 layers.
  - PSD export: the layer is left out of the PSD's layers with the "no PSD equivalent" note; the composite keeps it.
  - Classic frequency separation as two layers: Tintwork has no Linear Light blend mode, and adding one across the CPU, GPU, 16-bit and PSD paths was too risky for this release.

**D. Actions and Batch.** v1.34 said these adjustments were "recorded into Actions by the same code path … not separately tested". `v135-test` now records an action with Vibrance, Shadows / highlights and Color balance, each direct and as an adjustment layer, plus Smooth skin (direct and layer). Each one was recorded with the values typed. Replaying on a fresh copy of the photo matches the hand-made result, and a Batch run with PNG output matches too (max difference 0 levels in both, in the local run; the test allows ≤1 and ≤2). Nothing needed fixing. The only addition is that the recorded Smooth skin layer step keeps its "black mask" flag, shown as "(black mask)" in the action list.

**E. Accessibility fix.** axe flagged the highlighted item in every context menu: white on the accent colour was 3.6:1. Hover and focus now use the darker accent, and axe no longer flags it.

**Regression:** Suggest on the 21-photo set was re-measured on v1.35 ([audit/workflows-v135-after.json](audit/workflows-v135-after.json), `scripts/_v135-after.mjs`). The results match v1.34 on all 21 photos (0 differences). The c4 Full ≤0.5° pin passes (in `npm test`). axe-core: 0 serious / critical with the snapshot context menu open, with keyboard focus in the snapshot list, and with the Smooth skin layer dialog open.

**Tests:** `v135-test` 54/54; `npm test` 1579 checks, 0 failures (WebKit included; about 23 minutes). **Test-change disclosure:**
- `v135-test` is new.
- The version pins of v112–v134 and v1341 accept 1.35.0.
- `v14-test`'s RAW-link project check accepted only format 8. It now accepts 8 or later, still requiring the link and no embedded RAW copy.
- Nothing else in the older tests changed.

**Not built (out of scope for this release):** pen / paths, a channels panel, content-aware fill.

## v1.34.1 update (2026-11-21, America/New_York)

Wording-only patch. Other vendors' product names were removed from the UI and docs, as the project's standing rule requires.

- **UI:** one tooltip changed. The upright "Crop edges" button said "closest to [a competitor's RAW app] Constrain Crop". It now says "like constrain crop in paid desktop editors". One source comment in `src/main.js` was reworded too. The user guide had no such names, so it did not change.
- **Docs:** COMPARISON, WORKFLOW_BENCHMARK, AUDIT, README, the raw benchmark JSON in `docs/audit/` and the paid-editor labels in `scripts/workflows-bench.mjs` now use **leading subscription editor**, **subscription RAW editor** and **RAW plug-in**. The COMPARISON table columns were renamed. Citations that linked to that vendor's help pages keep their titles (neutralized), but their links were removed. No scores, step counts or measurements changed; the JSON files were only relabelled and they still parse.
- **Kept on purpose:** the registered PSD and DNG MIME types (in `src/files.js`, `src/main.js`, `manifest.webmanifest` and the RAW tests) are format identifiers, not text a person reads. `test-assets/raw-samples.json` and its DNG sample are third-party RAW test fixtures whose file names include the converter that made them. The older test scripts name the brands only in negative checks that assert they are absent.
- **Tests:** `scripts/v1341-test.mjs` (12 checks) covers the version and SW cache, every visible string, tooltip, aria-label and placeholder with a photo open and the Perspective bar showing, the F1 user guide, README and the four docs, plus the renamed COMPARISON columns. The older pinned tests accept 1.34.1.
- **Verification:** full suite locally passed, with every suite green except two `v1341-test` checks that caught this patch's own README/AUDIT note spelling out the PSD MIME type. The note was reworded and `v1341-test` re-run at 12/12. The other docs-reading tests (v125–v131) were not re-run after that two-sentence edit; they only look for their own version notes. Live site (2026-11-21, about 1 PM America/New_York): `v1341-test` 12/12 × 3, and `v134-test` 35/35 × 1 on 1.34.1.

## v1.34.0 update (2026-11-21, America/New_York)

The findings still open after v1.33 from the persona test ([audit/persona-test-v131.md](audit/persona-test-v131.md)): #13 (autosave on close), #11 leftovers (1366×768 layout), #14 leftovers (status / Perspective bar) and #10 (missing adjustments, partly). No AI. No straightening math changed and no gate was loosened.

**A. Autosave on close (#13).** Cause: the normal autosave waited 1.5 s, then awaited a PNG encode per changed canvas and two IndexedDB transactions; the existing pagehide / visibilitychange flush called the same async path, which a closing page does not get to finish. Fix: (1) debounce 1.5 s → 0.7 s, and the newest step's PNG encodes start immediately (`stageEncodes`); (2) on `visibilitychange` (hidden) and `pagehide`, `autosaveFlushSync` builds the record and issues every IndexedDB `put` synchronously inside the event, then calls `transaction.commit()`. Images already in IndexedDB are skipped; images whose PNG has finished are written as PNG; the rest are written as raw RGBA (`{ raw: 'rgba8' }`, read with `getImageData`, canvases up to 24 MP; the whole flush is capped at 96 MB, falling back to the current step only, then to the old async path). 16-bit data and RAW source files are included only if their encode has already finished (otherwise recovery gets the 8-bit copy, as for over-size 16-bit documents). An older async write that finishes after a flush no longer overwrites the newer record. Recovery reads both formats. **Test:** 5 brush strokes (and, separately, a whole-layer Vibrance), tab closed 150 ms later with `page.close({ runBeforeUnload: false })`, site reopened in the same profile: "Recover unsaved work?" appears and recovery restores 5/5 strokes with identical pixels (mean difference 0.000 levels). The same script on the live v1.33.0 site recovered only the "Open" step (0/5 strokes), 3/3 runs. **Limits:** only the active document tab is flushed (other open document tabs keep their last regular autosave, which runs when you switch away from them); a browser crash or power cut was not tested and is not covered by `pagehide`.

**B. Layout at 1366×768 and 1920×1080 (#11 leftovers).** v1.33 added a ▾ cue; six tools were still below the fold at 1366×768 (Zoom at 1920×1080), and Brush, Wand, Object select, Dodge/burn, Gradient and Shape overflowed the options bar (by 65–590 px). Now, on desktop layouts (wider than 820 px and taller than 500 px) the tool column becomes two columns (84 px) when one column does not fit, and the options bar wraps onto a second row (the bar's grid row is `minmax(40px, auto)`). Measured with every tool selected: 0 px overflow and at most two rows at both sizes; all 25 tools on screen. The phone layout keeps the v1.33 single swipeable row and floating Apply / Cancel (checked in WebKit, iPhone 13 profile). The ▾ cue remains for windows too short even for two columns.

**C. Status and Perspective bar (#14 leftovers).** Liquify's "Processing…" had already been fixed by v1.33's status change (re-checked here: the status reads "Liquify"); as a guard, the status can no longer be left on "Processing…" when the busy count returns to zero. In Perspective guide mode the hint said "Enter applies" twice next to two primary buttons; it now reads "Guided: n/4 guides · Enter applies guides · Esc cancels", Apply guides is the only primary button, the corner Apply is labelled "Apply corners", and Apply Lens is not primary there.

**D. New adjustments (#10, partly).** In `src/tone.js`, shared by the 8-bit (`pixels.js`) and 16-bit (`deep.js`) paths so the two differ only in precision (max 0.49 of an 8-bit level apart on the test colours):
- *Vibrance*: chroma is scaled about the pixel's Rec. 709 luma by `1 + v·(1−s)²·protect·1.6` (s = HSV saturation), where `protect` reduces the push by up to 75% inside an orange hue window (about 3–47°, red ≥ green ≥ blue). The scale is limited so no channel clips, which keeps the hue. Saturation scales chroma evenly. Measured at +100: muted blue chroma ×2.00, skin tone ×1.20, strong red ×1.05; hue shift 0.3°.
- *Shadows / highlights*: a luminance map blurred with three box passes (σ = radius; edges clamp, so a large radius does not brighten the borders, checked on a gradient with radius 80) sets a shadow and a highlight weight (smoothstep over the tone range). Shadows are lifted with `L^(1/(1+2.2·amount·w))`, highlights pulled down with the mirror curve, and RGB is scaled by the luma ratio (overflow added evenly so hue holds). On a grey ramp (radius 0): shadows 60% lift a dark grey by 63 levels and move a bright one 0; highlights 60% pull a bright grey down 64 and move a dark one 0. Reduced-size previews of the adjustment layer scale the radius; the dirty-rectangle shortcut is skipped for it because it is not per-pixel. Speed on this box's CPU: 1280×853 about 0.14 s, 6000×4000 about 3.3 s (the direct dialog previews at full resolution in the worker, so big photos preview with that lag).
- *Color balance*: three smooth luma bands; each slider moves one channel up and the other two down by half as much (up to about 20% at full band weight); Preserve luminosity rescales toward black or white to restore the pixel's luma (mid-grey +red: Δluma 0.07 with, 5.65 without). Shown as Shadows / Midtones / Highlights tabs over three sliders.
- Available in the Adjust menu (direct, live preview, one undo step; recorded into Actions by the same code path as the other Adjust dialogs, not separately tested) and as adjustment layers (Layer ▸ New adjustment layer, editable, maskable). 16-bit documents: the direct versions write 16-bit layer data and the layers composite in float. **Not done:** GPU shaders for the three adjustment layers (a document containing one composites on the CPU, with a one-time notice), and PSD export of them (left out of the PSD's layers with the existing "no PSD equivalent" note; the PSD composite includes them). Still missing from #10: frequency separation / skin smoothing, pen / paths, a channels panel, history snapshots / history brush, content-aware fill.

**Regression:** Suggest on the 21-photo set re-measured on v1.34 ([audit/workflows-v134-after.json](audit/workflows-v134-after.json), `scripts/_v134-after.mjs`): identical to v1.33 on all 21 photos (0 differences). The c4 Full ≤0.5° pin passes (in `npm test`). axe-core 4.14: 0 serious / critical with the Color balance layer dialog open, in the editor and on the iPhone crop screen (only a moderate `region` note in the editor state).

**Tests:** `v134-test` 35/35; `npm test` 1513 checks, 0 failures (WebKit included). **Test-change disclosure:** `v134-test` is new. The version pins of v112–v133 accept 1.34.0. `v133-test`'s "more tools" cue check now also accepts the v1.34 outcome (no overflow at all, so no cue); the cue-click check runs only when the column still overflows. Nothing else in the older tests changed.

### Live verification (v1.34.0, 2026-11-21 about 12:11 PM America/New_York)

Deployed commit 31f2613 (tag v1.34.0) to GitHub Pages; the live `sw.js` reports `tintwork-shell-v1.34.0` and precaches `src/tone.js`. `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v134-test.mjs`: **35/35, 3 runs out of 3** (fresh browser profiles). In each run the tab was closed 157–180 ms after the last edit and all edits were recovered with identical pixels; axe serious + critical: Color balance dialog 0, editor 0, iPhone crop 0. Screenshots: `screenshots/134-live-*.png` (vibrance, shadows-highlights, color-balance-layer, layout-1366, recover-offered).

## v1.33.0 update (2026-11-21, America/New_York)

Phone layout and keyboard / screen-reader fixes from the remaining findings of the persona test ([audit/persona-test-v131.md](audit/persona-test-v131.md): #6, #7, #8, #11, #14). No AI. No editing math changed and no gate was loosened.

**A. Phone (WebKit, Playwright iPhone 13 profile, 390×664 CSS px viewport).** In the phone layout (≤820 px wide or ≤500 px tall) the confirm buttons of Crop, Transform, Perspective and Object select (Cancel / Apply / Done) are mirrored into a floating group at the bottom right of the canvas (46 px tall); the options-bar copies are hidden there. The fit leaves room for them and for the tool column: a fitted photo now sits beside the column (towers: photo x 85–363, column ends at 58) and above the buttons; hiding / showing the column refits a fitted photo. Option-bar items no longer shrink (`flex-shrink: 0`), which is what drew the 4:5 chip under the Ratio select; on phones the Crop title is hidden so all five chips (1:1, 4:5, 16:9, 8×10, Free) are on screen and a tap at each chip's centre hits it. Desktop (Chromium 1366×768): no floating buttons, Apply stays in the options bar, fit identical to v1.32 (left / bottom insets are 0).

**B. Keyboard and screen readers.**
- Layers and History lists use a roving tabindex: one Tab stop each (the selected layer / current step), ↑/↓/Home/End move focus, Enter or Space selects the layer (Ctrl/Shift for multi-select as with the mouse) or restores that history step; a 2 px focus ring. Rows carry spoken labels ("Layer 3, 100%, selected", "New layer, step 3 of 4, current"), the current step has `aria-current="step"`, the eye button is named "Hide layer …" / "Show layer …" with `aria-pressed`. Only keyboard-focused rows (`:focus-visible`) take those keys, so a mouse user who clicks a row keeps the arrow-key nudge (Move tool) and Enter-to-apply (checked in v133-test).
- `#status` is `role=status aria-live=polite aria-atomic=true`. `#modal` has `aria-labelledby="modalTitle"` (Playwright `getByRole('dialog', { name: 'Curves' })` resolves). Tool buttons set `aria-pressed`. Document tabs are no longer `role=tab` containers holding a close button (axe nested-interactive); the name is a button with `aria-current="page"` for the open document.
- Skip links "Skip to canvas" and "Open image…" are the first two Tab stops (visible when focused); opening from the skip link continues on the canvas. A hidden page-level h1 and a labelled options-bar region clear axe's moderate page-has-heading-one / region rules. The `.seg` "on" colour is now `--accent-strong` (white text 4.66:1; was the axe color-contrast hit on the Curves RGB button).
- Page zoom: `maximum-scale=1, user-scalable=no` removed from the viewport meta. Safari's gesture events are now blocked only over the canvas area (`#viewport`), and `#view` keeps `touch-action: none`, so the editor's own pinch still applies there; phone text inputs are 16 px so iOS does not zoom on focus.

**axe-core 4.14.1** (`scripts/a11y-audit.mjs`; states: welcome 1366×768, document open, Curves dialog, iPhone 13 WebKit crop):

| State | v1.32.0 live (before) | v1.33.0 (after) |
|---|---|---|
| welcome | serious 0 · moderate: meta-viewport, region | 0 violations |
| document open | **serious 1** (nested-interactive `.doc-tab`) · moderate: meta-viewport, page-has-heading-one, region | 0 violations |
| Curves dialog | **serious 3** (aria-dialog-name, color-contrast, nested-interactive) · moderate: meta-viewport, region | 0 violations |
| iPhone crop | **serious 1** (nested-interactive) · moderate: meta-viewport, page-has-heading-one, region | 0 violations |
| **Total serious + critical** | **5 instances, 3 kinds; critical 0** | **0** |

Before: [audit/a11y-v132-before.json](audit/a11y-v132-before.json) (live v1.32.0). After: [audit/a11y-v133-live.json](audit/a11y-v133-live.json) (live v1.33.0). axe finds rule violations only; it does not check that the keyboard patterns work, which v133-test does.

**C. Extras.** A ▾ cue (sticky, mouse-only, `aria-hidden`) at the bottom of the tool column when it overflows (1366×768: yes; 1920×1080: no); clicking scrolls the column (the Zoom tool comes into view). History panel `min-height` 132 px (measured 142 px, about 5 rows, at 1366×768 and 1920×1080; was ~62 px). Stale status: a pointer-down, key-down or menu command marks the start of an action; when the action commits without having set a status message, the history label is shown (e.g. "Brush stroke"), and a leftover "Processing…" is always replaced. Messages an action sets itself are kept.

**Regression:** Suggest on the 21-photo set re-measured on v1.33 ([audit/workflows-v133-after.json](audit/workflows-v133-after.json), `scripts/_v133-after.mjs`): identical to v1.32 on all 21 photos (leftover, guide count, mode and gate record; 0 differences). c4 Full ≤0.5° pin passes (v125–v131 tests in `npm test`).

**Not verified on real devices:** a physical iPhone / Safari (WebKit emulation only), two-finger pinch on the canvas now that page zoom is enabled (Playwright cannot drive multi-touch page zoom; the editor-level pinch test in mobile-test still passes), and any real screen reader (NVDA, JAWS, Narrator, VoiceOver): announcements were checked only via ARIA attributes and accessible names. Windows was emulated (Chromium on Linux with `?platform=win`).

**Live verification:** `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v133-test.mjs` → **47/47 × 3** on the live site, including the WebKit iPhone 13 pass (commit 02fad2d, tag v1.33.0, 2026-11-21 ~8:58 AM America/New_York). Live axe (`scripts/a11y-audit.mjs v133-live`): 0 violations in all four states. Screenshots: `screenshots/133-live-phone-crop.png`, `133-live-phone-cropped.png`, `133-live-layer-focus.png`, `133-live-history-focus.png`, `133-live-skip-link.png`.

**Test-change disclosure:** `v133-test` new (47 checks, incl. a WebKit iPhone pass). Pins accept 1.33.0. `mobile-test`: the viewport-meta check now requires that page zoom is **not** disabled (intended reversal), and the free-transform step taps the floating Apply when it is shown (the options-bar copy is hidden on phones). The skip-link check counts the app's click on the file input; headless Chromium under load did not always surface Playwright's filechooser event for it (about 1 run in 3 locally), so the check does not depend on that event. Full serial `npm test` **1478** ok, 0 failures (WebKit; 1431 + 47; run on wip commit 94ebb36, code identical to the release).

## v1.32.0 update (2026-11-20, America/New_York)

Usability fixes from the persona test of live v1.31.0 ([audit/persona-test-v131.md](audit/persona-test-v131.md)). No AI. No upright / Suggest geometry was changed and no gate was loosened.

**A. Safe Auto upright.** After the warp, the kept share (crop rectangle ÷ photo area, same constrain-crop rectangle as v1.17–v1.31) is computed for every edge mode and shown in the status line. Below **60%** (a fixed threshold from the brief, not fit to any photo) the crop is not applied silently: a dialog offers **Apply (crop to N%)**, **Fill edges** (existing non-AI mirror + push-pull fill, full canvas kept) or **Cancel** (restores the pre-upright state; no redo entry). Upright + crop (or fill) is squashed into **one** undo step. Auto / Level / Vertical / Full record as an `upright` action step `{ req, edges, low }`; replay and Batch use the recorded choice and never show the dialog. Lens + Full is not recorded (its Distortion slider is per photo); Guided / Suggest upright is not recordable (guides are per photo) but does get the kept-% dialog.

| Photo | Size | v1.31: Auto upright (silent crop) | v1.32: kept % shown | v1.32: what happens |
|---|---|---|---|---|
| v128-towers | 853×1280 | 441×662, **26.7%** kept, 2 undo steps | **27%** | asks: Apply (crop to 27%) / Fill edges (100%) / Cancel; 1 undo step |
| v130-below | 1280×850 | 963×639, **56.6%**, 2 undo steps | **57%** | asks (under 60%); 1 undo step |
| v131-canyon (held-out, observed only) | 1280×853 | 642×428, **25.2%**, 2 undo steps | **25%** | asks; 1 undo step |
| v131-white (held-out, observed only) | 1280×962 | 1259×946, **96.7%**, 2 undo steps | **97%** | applies directly, shows 97% in the status; 1 undo step |
| c4 (regression) | 1280×1776 | 1101×1528, **74.0%**, 2 undo steps | **74%** | applies directly; 1 undo step |

canyon and white are held-out and were observed only. The 60% threshold came from the brief; the kept percentages are identical to v1.31 because the crop itself is unchanged (baseline measured on the v1.31.0 tree before any code change: `scripts/_v132-kept.mjs`, [audit/upright-kept-v132.json](audit/upright-kept-v132.json)).

**B. First run.** Start tool is **Hand** (a click or drag on the photo changes nothing). Hand now pans only when no Perspective / Transform / colour-sampler session is open, so guides can be drawn while Hand is active (before v1.32 Hand would have swallowed those drags; the default Brush hid this). **Ctrl+S** → File ▸ Save…: for a document that is one opened JPEG / PNG / WebP with no project-only features (one plain layer, no mask / text / adjustment / styles / RAW / opacity / blend) a choice opens: **Export as image (JPEG…)** or **Save project (.tintwork)**. After Save project, or once the document has project features, or for a new blank canvas, Ctrl+S saves the project directly as before. **Export** defaults to the source format (JPEG in → JPEG, PNG → PNG, WebP → WebP) and the source name, unless a named export preset was used last. **HEIC/HEIF** (by type or by `.heic/.heif` name; Windows often gives no MIME type) is tried with the browser's own decoder; if that fails a dialog says iPhone HEIC isn't supported in this browser and explains Settings ▸ Camera ▸ Formats ▸ Most Compatible and sharing as JPEG. Native decode was **not** verified on a HEIC-capable browser (no real HEIC sample or Safari on this box).

**Regression:** Suggest leftovers on the 21-photo set re-measured on v1.32 ([audit/workflows-v132-after.json](audit/workflows-v132-after.json)): all 21 photos identical to v1.31 (same leftover, guide count and mode; 0 differences). c4 Full ≤0.5° (v131-test) still passes.

**Live verification:** `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v132-test.mjs` → **32/32 × 3** on the live site (commit 8056984, tag v1.32.0, 2026-11-20 ~2:15 PM America/New_York). Screenshots: `screenshots/132-live-upright-low-kept.png`, `132-live-ctrl-s-choice.png`, `132-live-upright-filled.png`, `132-live-heic.png`.

**Test-change disclosure:** `v132-test` new (32 checks). Pins accept 1.32.0. `windows-test`: Ctrl+S on an opened PNG now clicks **Save project** in the new choice before checking the `.tintwork` picker name (intended behaviour change; the PNG is still never overwritten). `v18`, `v19`, `v110`, `v117`: set `state.opts.uprightAsk = false` after load, which answers the low-kept dialog with Apply (crop), i.e. exactly the v1.31 result those tests measure; no expected values changed. `v15-test` timed out once under parallel load and passed alone (79 s) and in the serial `npm test`. Full serial `npm test` **1431** ok (WebKit; 1399 + 32). One earlier serial run had a single `v10-test` autosave-recovery timing failure; v10 then passed 3/3 alone and in the next full serial run.

## v1.31.0 update (2026-11-20, America/New_York)

Suggest guides: **identity-gated mixed fallback**. When every official pure-V pair (`top2` / `sugV` / `ranked`) fails `uprightFromGuides` or `perspectiveMesh`, Suggest used to take the best mixed candidate with **no acceptMix check** and `lastSuggestGate` left null. Mixes are now scored against the uncorrected photo with the **same** acceptMix bars (vOk, the 1° mix-refusal rule, noOverallHarm, directional wins). None of those bars were loosened. Radial lens stays gated. Library Full ≤0.5° was not chased via Distortion. The angle leftover metric was not changed.

On looking-up shots like `v131-willis`, `estimateUpright` rejects a vertical vanishing point that falls inside the frame (here, in the sky just above the tower). The two-point “plumb each line” fallback then folds the mesh (corners map with `w < 0`). Of 105 detected vertical pairs, only 3 even produced a mesh, and those scored worse than doing nothing (~37–55° vs ~24.5°). The mixed path still “worked” because the H-only vanishing point produced a near-identity warp (~24.5° → **~23.6°**) that was applied ungated and looked like a successful 2V+2H suggestion. Forcing the in-frame VP is not a safe fix: it either still folds, or leaves ~71°.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F83 | If every official pure-V pair failed `uprightFromGuides`, Suggest applied `mixedList[0]` with no acceptMix gate (`lastSuggestGate` null). | safety | workflows-v131-holdout-baseline (willis); `_v131-willis-vp`; synthetic in-frame-VP facade | Score those mixes against identity with the existing acceptMix bars; refuse with both leftover numbers when they do not clearly win. | v1.31.0 |

**Not done:** willis leftover stays ~23.6° (the mix is only ~0.9° better than identity; verticals still trail). canyon ~12.8° and white ~27.3° unchanged. Angle remains ~18.6° (V already ~0.65°; do not change the leftover metric). Library Full ≤0.5°; auto radial still gated.

**Disclosure:** `v131-willis` was **inspected for diagnosis only** and was **not used to tune** any threshold. Its leftover and mode are unchanged (~23.6°, 2V+2H); the only change is that the mix now records `v2src=identity` and `acceptMix=true` (it already met the existing bars vs doing nothing). canyon and white still have a real pure-V baseline and are unchanged. A synthetic looking-up facade (in-frame VP, level floors) reproduces the hole: the old path would have applied a near-no-op mix; v1.31 refuses because the mix is not clearly better (~16.0° vs ~16.1°). No quality bars loosened. This is a **pure safety fix**: every measured leftover on the 21-photo set is the same.

**Test-change disclosure:** `v131-test` new. Version pins accept 1.31.0. Full npm test **1399** ok (WebKit; 1361 + 38).

### Live verification (v1.31.0, 2026-11-20 about 9:41 AM America/New_York)

- Live site reports `tintwork-shell-v1.31.0` / `APP_VERSION` 1.31.0 (Pages build `c9165f1`, status built; run 44755040713).
- `v131-test` against https://kcope19.github.io/tintwork/ : **38/38 × 3**.
- Screenshots: `screenshots/131-live-willis-suggest.png` (Suggest 2V+2H · ~23.6°, now gated vs identity), `131-live-canyon-suggest.png` (pure-V · ~12.8°), `131-live-white-suggest.png` (pure-V · ~27.3°), `131-live-synth-refuse.png` (no usable upright pair, ~16.0° vs ~16.1°).

## v1.30.0 update (2026-11-19, America/New_York)

Suggest guides: the mix-candidate horizontal pool keeps **same-row edges on a different facade** (Y-only diversity had dropped them) and slightly shorter edges (**minLenFrac 0.08**). The leftover probe and VP/H gates still use the 0.12-length set, and no acceptMix gate was loosened. Tuned on in-sample **v128-towers** (~32.2° → **~25.8°**, 2V+1H, vOk). Held-outs recorded on v1.29.0 before any change: highrise ~27.0° → **~23.5°**; angle unchanged ~18.6°; below ~0.5° → ~0.4°.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F81 | Looking-up towers Suggest stayed pure-V at ~32.2° because a useful same-row floor line on the other facade was dropped (Y-only H diversity) and sat just under the 0.12 length cut (~10.5% of the frame). | quality | workflows-v130-holdout-baseline; _v130-clean-search | Candidate H pool: minLenFrac 0.08 + X-or-Y diversity, cap 8. Probe/gate unchanged. | v1.30.0 |
| F82 | Need fresh looking-up held-outs: towers is in-sample as of this round. | audit | LICENSES.md; workflows-v130-holdout-baseline | CC0 `v130-angle.jpg`, `v130-highrise.jpg`, `v130-below.jpg`; baseline on v1.29.0 before any code change. | v1.30.0 |

**Not done:** towers mixed ~25.8° and highrise ~23.5° still trail a good upright. Angle held-out is unchanged at ~18.6° (V already ~0.65°; current H mixes do not move leftover). Library Full ≤0.5°; auto radial still gated.

**Disclosure:** `v128-towers` remains in-sample (it motivated this change). Held-outs were not used to tune. Interior flipped from pure-V ~6.6° to mixed ~3.8° with VP V 0.42°→0.43° (vOk); the new H guides are the door header and railing. Highrise leftover improved while its H-probe residual rose 1.68°→7.46° (overall worst is now the verticals, which improved). No quality bars loosened.

**Test-change disclosure:** `v130-test` new (31); v129 interior pin added one check (23). Version pins accept 1.30.0. v118 and v126–v129 interior/towers pins accept a vOk mixed leftover improvement. Full npm test **1361** expected (1329 + 1 + 31; recount after `npm test`).

### Live verification (v1.30.0, 2026-11-19 about 8:57 AM America/New_York)

- Live site reports `tintwork-shell-v1.30.0` / `APP_VERSION` 1.30.0 (Pages build `694814b`, status built; run 44537812505).
- `v130-test` against https://kcope19.github.io/tintwork/ : **31/31 × 3**.
- Screenshots: `screenshots/130-live-towers-suggest.png` (Suggest 2V+1H · ~25.8°), `130-live-highrise-suggest.png` (2V+2H · ~23.5°), `130-live-angle-suggest.png` (pure-V · ~18.6°), `130-live-below-suggest.png` (2V+2H · ~0.4°), `130-live-glass-suggest.png` (2V+2H · ~12.6°), `130-live-interior-suggest.png` (2V+2H · ~3.8°).

## v1.29.0 update (2026-11-14, America/New_York)

Suggest guides: **overall do-no-harm** (`noOverallHarm`). A mixed V+H candidate is now refused when its leftover tilt is more than 1° worse than the pure-V choice, even if a directional gate (vBetter, vOnlyBetter, hBetter) passes. On `v128-towers`, VP-inlier V was slightly better with the mix (3.27° vs 3.50°), so vBetter accepted a mix that left **~43.9°** against pure-V **~32.2°**. Now towers stays pure-V at ~32.2°.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F80 | A mix could pass vBetter on a tiny VP-V gain while leaving ~11.7° more overall leftover than pure-V (`v128-towers`). | quality | workflows-v128-after (v1.28 row) | Add `noOverallHarm`: refuse a mix whose leftover exceeds pure-V by >1°. No other gate changed. | v1.29.0 |

**Not done:** towers pure-V ~32.2° is still a large leftover (Suggest picks poor guides there); glass ~18.8°; library ≤0.5°; auto radial ungate. Fresh held-outs are needed again.

**Disclosure:** `v128-towers` is **no longer held-out** (it motivated this change). All 14 other rows in the v1.28 suite keep the same mode and leftover (re-measured before and after the change on the same box). No quality bars loosened.

**Test-change disclosure:** `v129-test` new. Version pins accept 1.29.0. The v128 towers check (Suggest returns ≥2 guides) still passes. Full npm test **1329** ok (WebKit; 1307 + 22).

### Live verification (v1.29.0, 2026-11-14 about 2:30 PM America/New_York)

- Live site reports `tintwork-shell-v1.29.0` (Pages build `11615db`, status built). `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v129-test.mjs`: 22/22, three times out of three.

## v1.28.0 update (2026-11-12, America/New_York)

Suggest guides: also mix diversified H with the **suggested vertical pair (sugV)** when it differs from top-2. On **glass**, top-2 V + H still fails **vOk** (VP-inlier V 5.59°→8.67°); sugV + the same H is accepted: leftover **~21.6° → ~18.8°**, VP V **5.59° → ~4.89°** (better, not merely within slack). Gates are unchanged. Among already-accepted mixes, pick by leftover tilt (VP-V only as a 0.25° tie-break) so a slightly better VP-V cannot displace a several-degree leftover win.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F78 | Glass Suggest stayed pure-V at ~21.6° because mixes used only top-2 V; that 2V+2H candidate cut leftover to ~16.7° but worsened VP V 5.59°→8.67° (vOk refuse). The preferred sugV pair + the same H yields ~18.8° with VP V ~4.89°. | quality | workflows-v128-holdout-baseline; workflows-v128-cand-dump; workflows-v128-after | Enumerate H mixes for sugV as well as top-2; prefer leftover among accepted mixes. No gate loosened. | v1.28.0 |
| F79 | Need fresh held-outs: resid was tuned in v1.27 (no longer held-out); glass is in-sample as of v1.28. | audit | LICENSES.md; workflows-v128-holdout-baseline | CC0 `v128-towers.jpg`, `v128-masonry.jpg`, `v128-balconies.jpg`; baseline recorded on v1.27.0 before any code change. | v1.28.0 |

**Not done:** glass leftover still ~18.8° (trails a tight upright); library ≤0.5°; auto radial ungate. `v128-towers` baseline mixed leftover (~43.9°) is worse than its own pure-V (~32.2°) because vBetter can accept a mix that hurts overall — not fixed this round (held-out).

**Disclosure:** glass is **in-sample** (motivated the sugV mix). resid has not been held-out since v1.27. city leftover ~5.0°→~0.8° is a side effect of the leftover-first picker, not a city-specific tune. Validate set (interior/brick/flat/lowangle/geneva pure-V; cathedral mixed ~1.2°) unchanged in mode. No quality bars loosened.

**Test-change disclosure:** `v128-test` new (27). Pins accept 1.28.0. v127 glass pin accepts v1.28 vOk mixed. Full npm test **1307** ok (WebKit; 1280 + 27).

### Live verification (v1.28.0, 2026-11-12 about 12:55 PM America/New_York)

- Live site reports `tintwork-shell-v1.28.0` / `APP_VERSION` 1.28.0 (Pages build `46de0d5`, status built; run 43273358969).
- `v128-test` against https://kcope19.github.io/tintwork/ : **27/27 × 3**.
- Screenshots: `screenshots/128-live-glass-suggest.png` (Suggest 2V+2H · ~18.8°), `128-live-city-suggest.png` (2V+2H · ~0.8°), `128-live-cathedral-suggest.png` (2V+1H · ~1.2°), `128-live-interior-suggest.png` (pure-V · ~6.6°).


## v1.27.0 update (2026-11-07, America/New_York)

Suggest guides: when the **H probe is thin** (<2 horizontals) and the broad mix score beats pure-V by **≥2°**, accept mixed if VP verticals stay within **vOk** (±0.5°). Fixes held-out **resid** (~15.8° pure-V → mixed ~3.4°) without reopening **interior** (thick H probe). Glass stays pure-V (vOk false).

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F77 | Resid held-out Suggest left ~15.8° pure-V; mix had overallBetter (3.4 vs 15.8) and vOk but second acceptMix AND required a directional flag, so overallBetter never fired alone. | quality | workflows-v126-holdout-baseline; gate sim | thinH ∧ bigOverall (≥2°) path in acceptMix | v1.27.0 |

**Not done:** glass held-out (~21.6°; mix hurts VP V); library ≤0.5°; auto radial ungate.

**Test-change disclosure:** `v127-test` new. Pins 1.27.0. v126 pins accept 1.27.0. No validate-set quality bars loosened.

### Live verification (v1.27.0, 2026-11-07 about 4:50 PM America/New_York)

- Live site reports `tintwork-shell-v1.27.0` / `APP_VERSION` 1.27.0 (Pages build `d4f37a3`, status built; earlier `99068a4` Pages build errored, retry landed).
- `v127-test` against https://kcope19.github.io/tintwork/ : **19/19 × 3**.

## v1.26.0 update (2026-11-06, America/New_York)

Suggest guides on **busy facades**: mixed V+H gate scores verticals on **VP inliers** (decoration no longer vetoes cathedral), while horizontals still use the **broad** H probe so interiors/brick stay pure-V. Enumerates top-2 V × diversified H mixes. Three new CC0 held-out facades (`v126-city/glass/resid`).

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F75 | Cathedral mixed refused: broad V probe worsened 0.74°→1.19° even when VP-inlier V improved. | quality | workflows-v124-gate-trace; v126 gates | `buildSuggestProbes` + inlier V gate; mixH enum; top-2 slack 0.75° when V improves. | v1.26.0 |
| F76 | Need more held-out busy facades beyond v117 set. | audit | plan v1.26 | `v126-city.jpg`, `v126-glass.jpg`, `v126-resid.jpg` (CC0); baseline in workflows-v126-holdout-baseline.json. | v1.26.0 |

**Not done:** library ≤0.5°; auto radial ungate; Adaptive Wide Angle. Glass/resid held-outs stay pure-V (disclosed).

**Test-change disclosure:** `v126-test` new. Pins accept 1.26.0. No quality bars loosened.

### Live verification (v1.26.0, 2026-11-06 6:37 PM America/New_York)

- Live site reports `tintwork-shell-v1.26.0` / `APP_VERSION` 1.26.0 (Pages build `048d235`, status built).
- `v126-test` against https://kcope19.github.io/tintwork/ : **22/22 × 3**.
- Full `npm test` (WebKit on): **1261** ok (1239 + 22).
- Screenshot: `screenshots/126-live-cathedral-suggest.png` (Suggest 2V+1H · ~1.2°).


## v1.25.0 update (2026-11-06, America/New_York)

Upright/perspective **UX + step counts** (Windows mouse-first). Plumb/Upright refuse status is plain language (Plumb includes check-set median/worst). **Apply Lens + Full** when Distortion ≠ 0 is one click / one undo. Panel: A/L/V/F/G/P, tooltips, default focus Full, Enter/Esc clarified. USER_GUIDE when-works/refuses table. Docs: library 0.73° marked in-sample.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F71 | Plumb refuse said only “No reliable lens bend found” without median/worst. | friction | status audit | `plumbRefuseStatus` one-liner with check median/worst + reason. | v1.25.0 |
| F72 | Lens then Full needed two clicks and two undos. | friction | mouse step count vs LR | `Apply Lens + Full` / Enter → one History step (`squashHistory`). | v1.25.0 |
| F73 | Perspective panel friction vs LR/Affinity (no letter keys, vague tooltips, Apply Lens primary when Distortion=0). | friction | E2E mouse audit | A/L/V/F/G/P; tooltips; primary Apply Lens+Full when Distortion≠0; focus Full; Enter/Esc. | v1.25.0 |
| F74 | Docs cited library 0.73° without in-sample caveat. | audit | README / AUDIT / WORKFLOW | Mark in-sample; held-out worst ~3° already disclosed in v1.24. | v1.25.0 |

**Not done:** library ≤0.5°; cathedral mixed Suggest; auto radial ungate; Adaptive Wide Angle.

**Test-change disclosure:** `v125-test` new. Pins accept 1.25.0. No quality bars loosened.

### Live verification (v1.25.0, 2026-11-06 5:36 PM America/New_York)

- Live site reports `tintwork-shell-v1.25.0` / `APP_VERSION` 1.25.0 (Pages build `8bdfdcf`, status built).
- `v125-test` against https://kcope19.github.io/tintwork/ : **25/25 × 3**.
- Full `npm test` (WebKit on): **1239** ok (1214 + 25).
- Screenshots: `screenshots/125-live-library-plumb.png`, `125-live-library-lens-full-btn.png`, `125-live-library-lens-full.png`, `125-live-brick-plumb.png`, `125-live-c4-full.png`, `125-live-geneva-refuse.png`.

## v1.24.0 update (2026-11-06, America/New_York)

Plumb Distortion refine uses **true apply+measure** on held-out check-set ridges (preview-res, cached Hough+ridges, ~0.7s, ms in status). Do-no-harm unchanged. Library ≤0.5° via Distortion **not reachable** (held-out worst stays ~3°). Cathedral mixed still refused (V worsen on broad probe).

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F68 | Analytical post-Full chords disagree with apply+measure (library −23 false accept). | quality | v1.23 validate | `scoreApplyMeasureStats` / ridge→undistort→Hu; refine uses it. | v1.24.0 |
| F69 | Library Distortion path cannot reach ≤0.5° on honest held-out worst (~3° at D0/+10/+20). | quality | workflows-v124-plumb-probe | Disclose; keep Plumb refuse + manual slider. | disclosed |
| F70 | Cathedral mixed still worsens V on broad Suggest probe (0.74°→1.19°). | quality | workflows-v124-gate-trace | Leave pure-V; optional wider top2 slack only when both V+H improve (does not unlock cathedral). | disclosed |

**Not done:** library ≤0.5°; cathedral mixed Suggest; auto radial ungate; Adaptive Wide Angle.

**Test-change disclosure:** `v124-test` new (31). Pins accept 1.24.0. No bars loosened.

### Live verification (v1.24.0, 2026-11-06 5:13 PM America/New_York)

- Live site reports `tintwork-shell-v1.24.0` / `APP_VERSION` 1.24.0 (Pages build `a29b98c`, status built).
- `v124-test` against https://kcope19.github.io/tintwork/ : **31/31 × 3**.
- Full `npm test` (WebKit on): **1214** ok.
- Screenshots: `screenshots/124-live-library-plumb.png`, `124-live-brick-plumb.png`, `124-live-c4-full.png`, `124-live-geneva-refuse.png`, `124-live-cathedral-suggest.png`.

## v1.23.0 update (2026-11-06, America/New_York)

Plumb Distortion refine is **do-no-harm**: score held-out detected verticals (not plumb traces), require median + worst improvement, sign consistency across check folds / alt trace, reject `Distortion`<5. Status when refused: **No reliable lens bend found**.

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F65 | v1.22 Plumb Distortion could worsen held-out edges (brick +20; alt sign flip). | quality / safety | workflows-v122-brick-heldout | fit/check split; check-set median+worst; fold/alt signs; too-mild. | v1.23.0 |
| F66 | Analytical median false-accepted library Distortion −23 vs apply+measure. | quality | workflows-v123-heldout-validate | Require worst-of-top5 also improves by ≥0.5×margin. | v1.23.0 |
| F67 | Library Full/Distortion still >0.5° on honest held-out / Full-only. | quality | held-out validate; manual +10 → 0.73° in-sample | Disclose trail; Priority 2 deferred. | disclosed |

**Not done:** library ≤0.5° honest held-out; cathedral mixed Suggest; auto radial ungate; Adaptive Wide Angle.

**Test-change disclosure:** `v123-test` new (25). Pins accept 1.23.0. No bars loosened.

### Live verification (v1.23.0, 2026-11-06 4:33 PM America/New_York)

- Live site reports `tintwork-shell-v1.23.0` / `APP_VERSION` 1.23.0 (Pages build `8183a7e`, status built).
- `v123-test` against https://kcope19.github.io/tintwork/ : **25/25 × 3**.
- Full `npm test` (WebKit on): **1183** ok (1158 + 25; v122 plumb bars accept Distortion 0 — disclosed).
- Screenshots: `screenshots/123-live-library-plumb.png`, `123-live-brick-plumb.png`, `123-live-c4-full.png`, `123-live-geneva-refuse.png`.

## v1.22.0 update (2026-11-06, America/New_York)

Perspective Plumb uses **full-res** ridge samples and chooses Distortion by **minimizing post-Full residual** (search around the plumb estimate). Auto Full radial stays gated. Cathedral mixed Suggest not restored (still hurts V).

| ID | Finding | Kind | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F61 | Plumb ridge on ≤640 preview under-samples long edges. | quality | v1.21 plumb | `plumbSamplesFromGuides` prefers `x.src` full-res; preview fallback. | v1.22.0 |
| F62 | Analytical plumb k alone can miss the Distortion that helps Full (wrong sign / too strong). | quality | library/brick sweeps | `refineDistortionByPostFull`: ladder + beat base0 ≥0.05°; mild among near-best; |slider|≤40. | v1.22.0 |
| F63 | Library Distortion path still >0.5° (best measured +10 → 0.73° **in-sample**; held-out worst ~3°). | quality | fine sweep / v122-test | Disclose trail; keep mild +10. | disclosed |
| F64 | Brick “0.01° after Distortion+20” was in-sample / null-seed artifact; held-out Vs ~1° unchanged; alt Plumb → −15. | audit / quality | workflows-v122-brick-heldout | Disclose; drop ≤0.5° brick bar from v122-test. | disclosed |

**Not done:** library Full/Distortion ≤0.5°; brick held-out ≤0.5°; cathedral mixed Suggest; auto ungate of radial; Adaptive Wide Angle.

**Test-change disclosure:** `v122-test` new (22). Pins accept 1.22.0. No bars loosened.

### Live verification (v1.22.0, 2026-11-06 3:58 PM America/New_York)

- Live site reports `tintwork-shell-v1.22.0` / `APP_VERSION` 1.22.0 (Pages build `11464bc`, status built).
- `v122-test` against https://kcope19.github.io/tintwork/ : **22/22 × 3**.
- Full `npm test` (WebKit on, no TW_SKIP_WEBKIT): **1158** ok.
- Screenshots: `screenshots/122-live-library-plumb.png`, `122-live-library-lens.png`, `122-live-library-lens-full.png`, `122-live-brick-plumb.png`, `122-live-c4-full.png`, `122-live-geneva-refuse.png`.

## v1.21.0 update (2026-11-06, America/New_York)

Manual Lens distortion + Plumb line (no AI). Auto Full radial stays gated.

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F58 | Auto radial fit fails / hurts library when force-applied. | quality | v1.20 force 0.86°→1.54° | Manual Distortion slider + Apply Lens (1 undo) before Upright; live preview; optional Vignette. | v1.21.0 |
| F59 | Need a non-AI way to set Distortion from bent edges. | friction | LR manual Distortion | Plumb tool: 1–3 edges, snap, `solveRadialFromPlumb` (mild-prefer). | v1.21.0 |
| F60 | Library Full still >0.5°. | quality | fixed seeds | Distortion +10 then Full → **0.73° in-sample** (best safe measured; held-out worst ~3°). Still trails 0.5°. | disclosed |

### What I might be wrong about
- A better plumb sample (full-res ridge, multi-k verify against Full residual) might reach ≤0.5° on library.
- Brick’s residual may be H/keystone more than radial; Distortion alone may not be the right lever.
- Cathedral mixed Suggest still not restored (left for v1.22 if safe).

**Not done:** auto ungate of radial; library/brick Full ≤0.5°; cathedral mixed Suggest; Adaptive Wide Angle.

**Test-change disclosure:** `v121-test` new (15). Pins accept 1.21.0. No bars loosened.

### Live verification (v1.21.0, 2026-11-06 about 2:58 PM America/New_York)

- Live site reports `tintwork-shell-v1.21.0` / `APP_VERSION` 1.21.0 (Pages build `5ae2a3e`, status built).
- `v121-test` against https://kcope19.github.io/tintwork/ : **15/15 × 3**.
- Screenshots: `screenshots/121-live-library-lens.png`, `121-live-library-lens-full.png`, `121-live-library-plumb.png`, `121-live-geneva-refuse.png`.
- Local full `npm test` (WebKit on, no TW_SKIP_WEBKIT): **1136** ok.

## v1.20.0 update (2026-11-06, America/New_York)

WebKit test restore + measured lens-aware Full (stayed gated).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F55 | `npm test` skipped WebKit after Playwright reinstall (missing host libs; apt http mirror 500). | infra | TW_SKIP_WEBKIT; ldd not found | Point apt at HTTPS kernel.org/cloudfront mirrors; `install-dependencies.sh --autoinstall` for WPE/GTK WebKit. Full suite **1121** ok (WebKit on). | v1.20.0 |
| F56 | Lens-aware Full target library/brick ≤0.5°. | quality | fixed seeds job 27/28 | Force-apply kEst=-0.05 on library: 0.86°→**1.54°** (worse). Stay gated; compare-gate retained. | measured / gated |
| F57 | Cathedral mixed gain from v1.18 not restored under full-res probe (mixed worsens V 0.74→1.21). | quality | dig on v117-cathedral | Leave pure-V; frame mixed −0.32° kept. | disclosed |

### What I might be wrong about
- A different radial estimator (or per-photo k) might help library without the force-apply path we tried.
- Brick’s 1.27° may need better H inliers, not radial (kEst=0).

**Not done:** Full ≤0.5° on library/brick; cathedral Suggest mixed; Adaptive Wide Angle; ICC.

**Test-change disclosure:** `v120-test` new (10). Pins accept 1.20.0. Radial not ungated (disclose force-apply harm).

### Live verification (v1.20.0, 2026-11-06 about 1:35 PM America/New_York)

- Live site reports `tintwork-shell-v1.20.0` / `APP_VERSION` 1.20.0 (Pages build `ce67225`, status built; prior `409a1c1` build errored, empty nudge commit fixed deploy).
- `v120-test` against https://kcope19.github.io/tintwork/ : **10/10 × 3**.
- Screenshots: `screenshots/120-live-library-full.png`, `120-live-c4-full.png`, `120-live-geneva-refuse.png`, `120-live-hongkong-refuse.png`.
- Local full `npm test` (WebKit on, no TW_SKIP_WEBKIT): **1121** ok (recounted 2026-11-06; WORKFLOW_BENCHMARK had incorrectly said 1111).

## v1.19.0 update (2026-11-06, America/New_York)

Suggest pure-V ranking + brick/c4 measurement clarification. Lens-aware Full radial **not** ungated.

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F53 | Suggest pure-V lagged hand diversify top-2 on flat (+0.14°), lowangle (+1.25°), geneva (+0.43°) — detection used mesh `small`, pairs could pick short partners. | quality | v1.18 scorecard | `uprightDetectImage` (full composite), `diversifyTop2Verticals`, `bestVerticalPairGuides` (sep + length ratio); prefer top-2 unless ranked beats by ≥0.5° without worsening top-2 edges; mixed needs top2Safe unless H improves ≥5° (c4). | v1.19.0 |
| F54 | brick/c4 "~17–18°" looked like Guided failure. | audit / docs | edgeAngle before/after split V/H | brick: V≤0.5° after 2V; 17° is non-level H seed. c4: H keystone real; Suggest mixed → ~2°. | v1.19.0 |

### What I might be wrong about
- Preferring diversify top-2 can skip a ranked pair that would help a third vertical not in the top-2 seeds.
- cathedral no longer takes mixed (Δ0 vs v1.18 −0.44°); probe did not clear the mixed gate after full-res detect.
- Ungating radial without a new held-out suite could re-break geneva/hongkong do-no-harm.

**Not done:** lens-aware Full apply (`kRad` still forced 0); Full ≤0.5° on library/brick auto path; Adaptive Wide Angle–style freehand.

**Test-change disclosure:** `v119-test` new (15). Pins accept 1.19.0. No bars loosened. Radial ungating deferred (disclose).

### Live verification (v1.19.0, 2026-11-06 about 12:41 PM America/New_York)

- Live site reports `tintwork-shell-v1.19.0` / `APP_VERSION` 1.19.0 (Pages build `12433c5`, status built).
- `v119-test` against https://kcope19.github.io/tintwork/ : **15/15 × 3**.
- Screenshots: `screenshots/119-live-suggest-lowangle.png`, `119-live-suggest-c4-mixed.png`, `119-live-suggest-c4-applied.png`, `119-live-suggest-brick-vok.png`.
- Local `npm test` with `TW_SKIP_WEBKIT=1`: **1024** ok checks (v119 +15; WebKit desktop ×2 + iPhone mobile skipped). **Disclosed:** Playwright 1.64 WebKit host libs unavailable after reinstall (apt mirror 500). Skip is opt-in via `TW_SKIP_WEBKIT` only.

## v1.18.0 update (2026-11-06, America/New_York)

Guided upright quality + **Suggest guides** (no AI). Tuned on library/cathedral; validated on v117 held-out + earlier reals. Optional lens-aware Full **deferred** — geneva Full still refuses (do-no-harm).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F50 | Guided multi-guide quality needed intentional mixed V+H; users had to draw 2–4 lines (job 18 / LR Guided steps). | friction / quality | v117 note; library top-2 4.65° | `suggestUprightGuides` + `applySuggestedGuides`: diversify long V/H, VP inliers, probe-scored candidates; Image menu + options-bar **Suggest guides**; Enter/edit. | v1.18.0 |
| F51 | Naive mixed V+H overfit interiors / brick-like H probes (interior +4.2° vs top-2). | quality / safety | `workflows-v118-suggest` early rows | Architecture bias: prefer ≥2V; accept mixed only if probe beats pure-V by ≥0.25° **and** (V improves ≥0.15° **or** H improves ≥2°) without worsening V by >0.5°. | v1.18.0 |
| F52 | `scoreSegmentsAfter` double-divided by `w` → bogus ~112° scores and false “no stable correction”. | bug | flat scoreGuides before fix | Use Cartesian `applyH` x,y directly (already divided). | v1.18.0 |

### What I might be wrong about
- The mixed gate is heuristic; a photo where H truly needs a 1° improvement may stay on pure-V.
- Suggest’s pure-V pair can trail a careful hand pick (lowangle +1.25°, geneva +0.43°) even when mixed is correctly refused.
- Lens distortion still dominates brick/c4 residuals (~17–18°); Suggest cannot fix that without a lens model.

**Not done:** lens-aware Full (gated attempt deferred; do-no-harm refusal kept on held-out); Full ≤0.5°; Adaptive Wide Angle–style freehand; ICC.

**Test-change disclosure:** `v118-test` new (17). Pins accept 1.18.0. No quality bars loosened. Lens-aware Full not enabled (disclose: would need held-out proof it never hurts geneva/brick).

### Live verification (v1.18.0, 2026-11-06 about 12:02 PM America/New_York)

- Live site reports `tintwork-shell-v1.18.0` / `APP_VERSION` 1.18.0 (Pages build `d7b5731`, status built).
- `v118-test` against https://kcope19.github.io/tintwork/ : **17/17 × 3**.
- Screenshots: `screenshots/118-live-suggest-library.png`, `118-live-suggest-interior.png`, `118-live-suggest-cathedral-applied.png`.
- Local `npm test`: **1096** checks (1079 in v1.17 + 17 v118).


## v1.17.0 update (2026-11-06, America/New_York)

Perspective/upright-only round (no AI, no heal% cycle). **Measured first** on 9 new CC0 held-out photos (`v117-*.jpg`, seeds from line detection on the original before any upright) plus library/brick/geneva/hongkong. Baseline: `docs/audit/workflows-v117-baseline.json`.

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F46 | Auto / Level / Vertical / Full **refuse** left the Perspective session open, so Esc was required and scripted waits hit ~25 s. | bug / friction | baseline Level/Full REFUSE rows ~25100 ms on flat/station/geneva/geo | `cancelMeshXf({ quiet: true })` on refuse; status kept. Refuse now ~100–400 ms. | v1.17.0 |
| F47 | Upright **Crop edges** always aspect-locked; on strong keystones it discarded most of the frame (e.g. flat 717×478 of 1280×853). | friction | baseline crop sizes; compare `innerOpaqueRect` free vs locked | Constrain-crop: keep aspect unless free-aspect opaque rect is ≥15% larger **and** aspect shift ≤1.35×. | v1.17.0 |
| F48 | Guided upright mouse strokes often missed the true edge (job 18 quality / v1.16 3–4 guide path unmeasured for precision). | friction | offset guide before snap moved ~63 px on c4 | `snapUprightGuide` projects both ends onto a nearby detected V/H line. | v1.17.0 |
| F49 | Manual Perspective had no grid while dragging corners. | friction | UX vs paid editors' transform overlays | Thirds + midline dashed grid inside the perspective quad (hidden in guide mode). | v1.17.0 |

### What I might be wrong about
- Constrain-crop free-aspect branch rarely fires on the held-out set (flat stayed aspect-locked because free AR was 3.2 vs 1.5). Area wins may be uncommon; the refuse fix is the clear measured win.
- Guide snap can attach to the wrong parallel edge in dense facades (geo/curvy). Tol is 14/zoom px; no undo of a single snap without removing the guide.
- Full ≤0.5° on library/brick was **not** retuned (radial stays gated). Auto-picked seeds on library differ from historical hand seeds — do not compare those ° directly to v1.12 scorecard rows.
- 3- and 4-guide Guided often matched 2-guide when guides were the top detected lines (not hand-chosen V+H pairs). Quality gain needs intentional mixed guides.

**Not done:** Full within 0.5°; radial warp on; Adaptive Wide Angle–style freehand; ICC.

**Test-change disclosure:** `v117-test` new (13). `v112`/`v114`/`v115`/`v116` version pins accept 1.17.0. No quality bars loosened.

### Live verification (v1.17.0, 2026-11-06 about 11:28 AM America/New_York)

- Live site reports `tintwork-shell-v1.17.0` / `APP_VERSION` 1.17.0.
- `v117-test` against https://kcope19.github.io/tintwork/ : **13/13 × 3**.
- Screenshots: `117-live-refuse-level.png`, `117-live-perspective-grid.png`, `117-live-guided-snap.png`.
- `npm test`: **1079** checks (1066 in v1.16 + 13 v117).


## v1.16.0 update (2026-11-06, America/New_York)

v1.16 is non-AI polish (no heal%/Full≤0.5° cycle; no new AI). Verified hunches first: RAW brush **Auto mask** already existed (not rebuilt). Soft-proof ICC still infeasible in-browser without profiles. Shipped: **export output sharpening** and **Guided upright 2–4 guides**. `scripts/v116-test.mjs` has 13 checks. Full `npm test`: **1066** checks (1052 in v1.15 + 13 v116 + disclosed Guided harness tweaks).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F44 | Export / batch had no output sharpening for screen or print (AUDIT ranked print gap). | gap | AUDIT print workflow; COMPARISON export | File ▸ Export **Output sharpening**: Off + Screen/Matte/Glossy × Low/Std/High; after resize, before watermark; web/print presets default screen-std / matte-std; batch inherits preset sharpen; skipped on PNG 16-bit with a note. | v1.16.0 |
| F45 | Guided upright hard-capped at 2 guides and applied immediately (job 18 quality vs multi-guide tools). | friction / quality | job 18 notes; LR Guided up to 4 | Draw **2–4** guides; live preview after ≥2; **Enter** / **Apply guides** / 4th finishes. Multi V/H uses vanishing-point upright; 2-guide keeps 4-point fallback. | v1.16.0 |

### What I might be wrong about
- Output sharpen amounts are approximate (unsharp mask), not printer-profile “print sharpening”. Glossy vs matte differ only by amount/radius/threshold tables I chose; they were not measured against a lab print.
- Radius floors so short (~800 px) exports still change pixels; a 4k export uses a larger radius. Someone who wants crunchier thumbnails may want a lower floor.
- Guided 3–4 guide VP path depends on `estimateUpright`; mixed or short guides can fall back to the 2-guide 4-point path — quality gain is not guaranteed on every photo.
- Job 18 two-vertical case is now **5 steps** (menu + 2 drags + Enter) vs v1.13’s 4; matches the subscription RAW editor Guided’s documented 5, but is one click more than Pixelmator Pro’s 4.

**Not done:** ICC soft proof; edge-aware auto-mask *as a new feature* (already present on RAW brushes); heal >79%; Full ≤0.5°; AI subject.

**Test-change disclosure:** `v113-test` and `v17-test` Guided checks loosened — preview then Enter (not auto-apply on 2nd); options bar may show `1/4 guides`; wall scan uses y=1600 under Keep (content ends ~1824). `v112`/`v114`/`v115` version pins accept 1.16.0.

### Live verification (v1.16.0, 2026-11-06 about 8:32 AM America/New_York)

- Live site reports `tintwork-shell-v1.16.0` / `APP_VERSION` 1.16.0.
- `v116-test` against https://kcope19.github.io/tintwork/ : **13/13 × 3**.
- Screenshots: `116-live-export-sharpen.png`, `116-live-guided-preview.png`.

## v1.15.0 update (2026-11-05, America/New_York)

v1.15 is an **adversarial polish pass** (no AI, no heal%/Full≤0.5° cycle). Scripted Chromium audits against live v1.14 and local; every fix below was reproduced **3/3**. `scripts/v115-test.mjs` has 18 checks. Full `npm test`: **1052** (1034 + 18).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F41 | **Done + feather** stacked a second history entry on the live “Object select” commit, so one Undo left a hard unfeathered mask. | bug | live+local audit 3/3; history tip `Object select` then `Object select + feather` | Squash consecutive tip Object select entries into one feathered commit. | v1.15.0 |
| F42 | Export on a **16-bit** document defaulted to 8-bit PNG and dithered down unless the user picked “PNG 16-bit”. | friction | open Export after RAW develop; `#eFmt` was `image/png` | Default `#eFmt` to `image/png16` when `is16()` and no last preset. | v1.15.0 |
| F43 | Switching tools mid Object select cleared the session with no status (selection kept). | friction | press W during objsel | Status “Object select kept.” (same end state as Done). | v1.15.0 |

**Audited OK (no change):** proofOff clears filter/CMY class; Image size Escape/Tab trap; crop chips + undo; Auto/Guided upright undo; Ctrl+Z in modal; SW CACHE matches APP; Refine edge Escape; 8-bit fill edge seam; Batch Open tabs API; export last-preset hotkey present.

### What I might be wrong about
- Escape “bug” in the first audit pass was a **false positive** (`#modalOk` stays in the DOM when the modal is hidden). Other Escape checks used `modal.classList.contains('hidden')`.
- Done+feather squash uses `/^Object select/` on tip labels — a future rename of those labels would stop the squash (test covers the current wording).
- 16-bit Export default only applies when there is **no** last preset; a remembered JPEG/WebP preset still wins (by design). Users who always export JPEG from RAW may never see the new default.
- Fill-edge seam check was on an 8-bit L-shape; 16-bit push-pull seams were not re-measured on a held-out photo this pass.
- Job 14 still trails ML on steps; this pass only fixed undo after feather, not IoU or stroke count.

**Not done:** ICC soft proof; heal >79%; Full ≤0.5°; one-click subject (AI).

### Live verification (v1.15.0, 2026-11-05 about 12:23 PM America/New_York)

- Live site reports `tintwork-shell-v1.15.0` / `APP_VERSION` 1.15.0.
- `v115-test` against https://kcope19.github.io/tintwork/ : **18/18 × 3**.
- Screenshots: `115-live-done-feather.png`, `115-live-export-png16.png`.

## v1.14.0 update (2026-11-05, America/New_York)

v1.14 is non-AI polish again (no heal% / Full≤0.5° cycle). Prefer trails→match on workflow. Every fix below was reproduced 3/3. `scripts/v114-test.mjs` has 21 checks and passed 21/21. The full `npm test` passed all **1034** checks (1013 in v1.13 + 21).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F37 | Soft proof only had glossy/matte; turning proof off forgot the last paper; CMY was easy to over-claim. | gap | AUDIT v1.13 “Not done”; COMPARISON soft proof | View ▸ **photo rag / newsprint / approximate CMY** + **Proof: last used** (prefs keep the last paper when off). CMY is greyscale of approximate ink load — not ICC CMYK. | v1.14.0 |
| F38 | Object select needed Shift/Alt for every refine stroke; feather after cutout was a separate Select ▸ Feather. | friction | job 14 trails on steps vs ML one-click | After the box, paint sticks on **+ Subject**; options bar **Done + feather** keeps and feathers in one step. | v1.14.0 |
| F39 | Crop presets lived only in a long dropdown. | friction | workflow step cuts | Option-bar chips **1:1 · 4:5 · 16:9 · 8×10 · Free**. | v1.14.0 |
| F40 | RAW before/after split was left/right only. | gap | COMPARISON / develop UX | Split button and **Y** cycle left/right → top/bottom → off. | v1.14.0 |

**Not done in v1.14:** ICC printer profiles; heal above 79%; Full upright within 0.5°; one-click (no box) subject / hair matting (AI); job 14 still trails ML on steps.

### Live verification (v1.14.0, 2026-11-05 about 12:00 PM America/New_York)

- Live site reports `tintwork-shell-v1.14.0` / `APP_VERSION` 1.14.0.
- `v114-test` against https://kcope19.github.io/tintwork/ : **21/21 × 3**.
- Screenshots: `114-live-proof-rag.png`, `114-live-objsel.png`.

## v1.13.0 update (2026-11-05, America/New_York)

v1.13 is non-AI polish again. Every fix below was reproduced 3/3. `scripts/v113-test.mjs` has 10 checks and passed 10/10 three times. The full `npm test` passed all **1013** checks (1003 in v1.12 + 10).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F32 | Auto / Level / Vertical / Full / Guided upright needed an extra Enter after the correction was already previewed (jobs 16/17/23 at 3 steps vs the subscription RAW editor's 2). | friction | workflow bench step counts | Corrections **apply immediately** (Crop / Fill / Keep from the edges option). Undo reverts. | v1.13.0 |
| F33 | Soft proof had no out-of-range cue without ICC profiles. | gap | AUDIT v1.12 "Not done" | View ▸ **Proof: ink warning on/off** — magenta overlay for crush past paper white/ink black and an approximate CMY ink limit (no ICC). | v1.13.0 |
| F34 | JPEG exports had no embedded colour profile; canvas PNG exports lacked an sRGB chunk (only `encodePNG` wrote one). | gap | byte inspection of exports | JPEG gets a compact sRGB ICC APP2; PNG gets an sRGB chunk after IHDR when missing. | v1.13.0 |
| F35 | Spot heal still ~79% on the real portrait; Fill empty edges was a pure push-pull smear. | quality | job 13; AUDIT ranked gap | Denser polar search + skip brush-overlapping sources + high-pass grain term; Fill empty edges mirrors nearest opaque then blends with push-pull (8-bit and 16-bit). Heal % unchanged on the tuning spot (still 79%); grain guard held. | v1.13.0 |
| F36 | New `src/srgb-icc.js` was not in the service worker shell list, so offline reload failed after the version bump. | bug (pre-release) | v12-test offline | Module added to `sw.js` SHELL. | v1.13.0 |

**Not done in v1.13:** Full upright within 0.5° on library/brick; radial warp (still gated); ICC printer profiles; heal above 79% without skin blur on the USDA portrait.

**Radial:** unchanged from v1.12 (estimate recorded, warp off).

**Heal:** denser polar search + brush-overlap skip + high-pass grain term did **not** raise removal on the USDA tuning spot (still **79%**, grain 1.33×, 3/3). Same method as v1.12 / v1.9. Bar not loosened.

### Live verification (v1.13.0, 2026-11-05 about 11:33–11:35 AM America/New_York)

- Live site reports `tintwork-shell-v1.13.0` / `APP_VERSION` 1.13.0.
- `v113-test` against https://kcope19.github.io/tintwork/ : **10/10 × 3**.
- `v112-test` live: **16/16** (do-no-harm / Open tabs unchanged; APP_VERSION 1.13.0).
- Spot heal live: **79%** removed, grain 1.33× (same as local / v1.12).
- Screenshots: `113-live-ink-warning.png`, `113-live-auto-upright.png`.

## v1.12.0 update (2026-11-05, America/New_York)

v1.12 is non-AI polish again. Every fix below was reproduced 3/3. `scripts/v112-test.mjs` has 16 checks and passed 16/16. The full `npm test` passed all 1003 checks (987 in v1.11 + 16).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F29 | Full upright on nearly level facades (dual tiny-rotate V+H) sheared horizontals worse than doing nothing (hongkong). | accuracy / safety | job 32 first Tintwork run: horizontals to 1.46° | Full refuses when both V and H are rotate with |angle|<2°, and refuses when applying horizontals would raise mean/worst horizontal tilt | v1.12.0 |
| F30 | Full on geneva-like dense near-vertical diagonals could still rotate and double hidden horizontal tilt. | accuracy / safety | job 31 | Do-no-harm: refuse tiny Vertical rotate when many near-verticals and no horizontals; Vertical fallback also refuses clear horizontal worsening | v1.12.0 (geneva: no correction; edges preserved) |
| F31 | Batch again only repeated a whole remembered folder, not a selection / last-opened subset. | gap | AUDIT v1.11 "Not done"; the subscription RAW editor exports the selection | **Open tabs** in Batch process; Batch again repeats a files/tabs run on matching open tabs (by remembered names) | v1.12.0 |

**Radial (item 1):** `estimateRadial` + mesh path exist, but applying the estimated *k* (with VP re-fit) **did not beat v1.11** on library/brick and hurt some edges, so the warp stays **gated off** (`kEst` recorded for diagnosis). Jobs 27/28 still fail the 0.5° bar at the same numbers as v1.11. New held-out `hongkong.jpg` (job 32) downloaded after the change; seeds fixed before the first Tintwork run.


### Live verification (v1.12.0, 2026-11-05 about 10:14–10:18 AM America/New_York)

- Live site reports `tintwork-shell-v1.12.0` / `APP_VERSION` 1.12.0.
- `v112-test` against https://kcope19.github.io/tintwork/ : **16/16 × 3**.
- Bench jobs 27/28/31/32 live: numbers match local; 31/32 refuse (do-no-harm). Screenshots `112-live-batch-open-tabs.png`, `112-live-upright-hongkong-refuse.png`.

**Not done in v1.12:** Full within 0.5° on library/brick/geneva; enabling radial warp; ICC printer profiles / gamut warning (still N/A without ICC — soft proof stays approximate).

## v1.11.0 update (2026-11-03, America/New_York)

v1.11 is non-AI polish again. Every fix below was reproduced 3/3. `scripts/v111-test.mjs` has 15 checks and passed 15/15 three times. On a v1.10.0 checkout it fails (1 of 7 checks passes before it stops). The full `npm test` passed all 987 checks (972 in v1.10 + 15).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F23 | Batch asked for the source and output folders every time (job 25: 7 steps against the subscription RAW editor's 4). | gap | AUDIT v1.10 ranked gap 6 | Source and **Output folder** handles kept in IndexedDB; permission asked again in a new session, inside the OK click | v1.11.0 |
| F24 | No one-step repeat of the last batch. | gap | job 29 fails on v1.10 3/3 | **File ▸ Batch again** (`Ctrl+Alt+Shift+B`) repeats folders, preset/action, look and naming; opens the dialog and says why when there is nothing to repeat or its preset/action/look was deleted | v1.11.0 (4 steps in a new session; the subscription RAW editor 4, Pixelmator Pro 3) |
| F25 | Found while attacking F23: a remembered output folder that was deleted or renamed would make every file fail. | bug (pre-release) | v111-test "deleted output folder" | The folder is checked first; if gone, Tintwork says so, forgets it and asks for a new one | v1.11.0 |
| F26 | Found while attacking F23: with the same folder as source and output, a repeat batch would process its own outputs ("-edited-edited"). | bug (pre-release) | v111-test "same folder" | The names the last batch wrote are skipped | v1.11.0 |
| F27 | Files could not be dropped onto Batch process (a drop opened them as documents). | gap | v111-test on v1.10 | Dropped images or a folder become the batch source; other files are ignored | v1.11.0 |
| F28 | Upright: one long leaning object (the library ladder, 2 lines of 848 px) outvoted ~20 building edges, leaving a vertical at 2.24°. | accuracy | job 27 | Each line's vote capped at 0.4 of the frame (RANSAC score and least-squares refit) | v1.11.0 (2.24° → 0.75°; still fails 0.5°; other photos unchanged) |

**Not done in v1.11:** Full upright within 0.5° on real photos (jobs 27, 28 and the new held-out job 31 fail; on job 31 Full makes 3 of 5 edges worse than doing nothing, in v1.10 too). Lens-distortion-aware upright. Batch on a selection of photos rather than a whole folder.

## v1.10.0 update (2026-11-03, America/New_York)

v1.10 is non-AI polish again. Every fix below was reproduced 3/3. `scripts/v110-test.mjs` has 19 checks. It passed 19/19 three times on v1.10. On a v1.9.0 checkout (`TW_ROOT=<v1.9.0 worktree>`) it fails: 3 of 9 checks pass before it stops, and all 3 are guards that also pass on v1.9 (see the benchmark's test-change disclosure). The full `npm test` passed all 972 checks (953 in v1.9 + 19).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F19 | Batch process could not use a saved export preset, so job 24 took 14 steps. | gap | job 25 fails on v1.9 3/3 | **Export preset** choice in Batch process: format, quality, size, ppi and the preset's own watermark. Remembers the last preset | v1.10.0 (7 steps; the subscription RAW editor 4) |
| F20 | The watermark dialog showed Color for logos (unused), and logos could only be sized by the short side, so a tall logo could overflow. | UI bug / gap | v110-test on v1.9 | Type-specific rows. **Logo size**: % of short side, % of width, or fit inside | v1.10.0 |
| F21 | Auto upright on the real high-rise left −0.50° (bar 0.5°). Cause: the line fits on the 640 px preview limit the vanishing point (full-resolution fits give VP (649.5, −710.3) against (643.5, −712.2)). | accuracy | job 17 fails on v1.9 3/3 | Each line is re-fitted on a ≤1600 px copy (sub-pixel gradient peaks, weighted least squares, outlier pass, ≤1° turn) | v1.10.0 (−0.34°; roughly neutral on 3 held-out photos) |
| F22 | No print preview. | gap | AUDIT v1.9 ranked gap 5 | View ▸ **Proof: glossy / matte paper**: paper-white and ink-black simulation in linear light, view only | v1.10.0 (approximate; no ICC, no gamut warning) |

**Not done in v1.10:** an sRGB gamut warning (meaningless in an sRGB-only editor), ICC printer profiles, and Full upright within 0.5° on real photos (jobs 27/28 fail on held-out photos).

## v1.9.0 update (2026-11-03, America/New_York)

The user asked for no AI in this release, so v1.9 polishes the non-AI tools. Every fix below was reproduced 3/3.
`scripts/v19-test.mjs` has 36 checks: it passed 36/36 three times on v1.9, and fails on a v1.8.0 checkout
(`TW_ROOT=<v1.8.0 worktree>`: 6 of 14 checks before it stops). The full `npm test` passed all 953 checks (917 in v1.8 + 36).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F13 | The export watermark could only be text. The subscription RAW editor's Watermark Editor also places graphics. | gap | v1.8 COMPARISON; bench job 24 fails on v1.8 3/3 | **Logo image** watermark (position, opacity, width %, margin), in single, multi-size, batch and 16-bit exports; each preset keeps its own copy | v1.9.0 |
| F14 | Upright corrected verticals only; there were no Level or Full modes. | gap | jobs 22/23 fail on v1.8 3/3 | **Auto · Level · Vertical · Full** with safety checks on the horizontals. Full falls back to exactly Vertical when they are unreliable, and Level accepts one long horizon | v1.9.0 (Full unproven on real photos, see the benchmark) |
| F15 | Fill empty edges refused on 16-bit layers. | gap | v18-test check | 16-bit push-pull fill; opaque pixels unchanged | v1.9.0 |
| F16 | The bench reported 66–76 s for the real-portrait heal. | **measurement error** (mine) | In-app timing: heal 27 ms after mouse-up | The bench now keeps images in the page and reports the app time (0.3–0.4 s). The app was not slow. | v1.9.0 (bench) |
| F17 | Dialogs taller than the window could not be closed: the Help ▸ performance benchmark result put **Close** below the screen. `v16-test` failed 3/3 on this box, on both v1.9 and the v1.8.0 checkout, so it depends on the environment rather than being a regression. | bug | `v16-test` timeout on `#modalOk` | Desktop dialogs get `max-height: 100vh − 32px` and scroll | v1.9.0 |
| F18 | In Full mode, a side-ratio check skipped one of its conditions (an operator-precedence slip), so a verticals-only result could be refused. | bug | code review | Brackets fixed | v1.9.0 |

**Not done in v1.9:** soft proofing (ICC printer profiles) was not started. Healing quality did not improve (79%; see the benchmark for the 9 variants I tried and rejected). Job 17 (high-rise Auto upright) still fails at −0.50°.

## Findings and fixes

Severity: **bug** = wrong result; **friction** = works but costs the user extra steps or trips them up; **site** = hosting/metadata.

| # | Finding (v1.6.0) | Severity | Repro (3/3) | Fix in v1.7.0 | Verified live |
|---|---|---|---|---|---|
| F1 | Print exports lose their resolution: an 8×10 in crop at 300 ppi exports as a JPEG with JFIF density 1:1 (unit 0, "no ppi"), so print software assumes 72 ppi (33×42 in). | bug | Open a photo ▸ Crop tool ▸ ratio *8×10 in (300 ppi)* ▸ Enter ▸ Ctrl+Shift+E ▸ JPEG ▸ OK ▸ read bytes 13–17 of the file. Bench job 8. | JPEG JFIF density and PNG pHYs are written from the document ppi; Export dialog gains **Resolution** and **Size** (long edge / width / %). | ✔ |
| F2 | Converging verticals can't be fixed accurately: dragging the four corners of Edit ▸ Perspective by eye left the facade edges leaning 152 px over the frame. | friction (capability) | Bench job 10 (synthetic building, measured edge x at 15 % and 85 % height). | **Image ▸ Guided upright**: draw two guides along edges that should be vertical/horizontal; corrected after the second guide; Guides button in the Perspective bar. Residual lean ≤ 3 px. | ✔ |
| F3 | Dialog sliders can't take typed values (no number box): exact values need many arrow presses or a careful drag. | friction | Open Adjust ▸ Brightness/contrast; there is no editable field for the value. | Number box beside every dialog slider; Enter applies the dialog. | ✔ |
| F4 | Adding a layer mask leaves the foreground/background colours as they were (orange/blue by default), so the first gradient or brush stroke on the mask gives a partial grey, not hide/reveal. | friction | New photo ▸ Layer ▸ Add layer mask ▸ check the colour swatches (still the defaults). | Adding a mask sets black/white (unless both are already greys) and says so in the status bar. Bench job 11: 8 → 7 steps. | ✔ |
| F5 | Alt does nothing: Windows users can't reach the menus from the keyboard (no Alt/F10, no arrow keys in menus). | friction (accessibility) | Load ▸ press and release Alt ▸ `document.activeElement` is still `body`. `audit:safety`. | Alt alone or F10 focuses the menu bar; ←/→, ↓/Enter/Space, ↑/↓, Esc. ARIA menubar/menu/menuitem roles. Not on Mac (Alt is Option there). | ✔ |
| F6 | Tab leaves an open dialog: 23 of 30 Tab presses put focus behind the modal. | friction (accessibility) | Open Image ▸ Image size ▸ press Tab 30× and check focus after each press. | Tab and Shift+Tab wrap inside the dialog. | ✔ |
| F7 | The Window menu advertises Ctrl+Shift+Tab for *Previous document*; Chrome and Edge keep that shortcut for their own tabs, so it never reaches the page. | bug (docs/UI) | Open the Window menu and read the shortcut. `audit:safety`. | Shown as Ctrl+Shift+F6 (which works); the combination is now on the reserved list on every platform. User guide also corrected for Ctrl+N, Ctrl+T, Ctrl+Shift+N and Ctrl+Tab (it listed browser-reserved keys; the menus already showed the alternates). | ✔ |
| F8 | No Content-Security-Policy. Not exploitable today (no third-party code, no uploads) but nothing would stop an injected script from sending image data out. | site / security | View source; `audit:safety` "CSP limits connections". | CSP meta tag: same-origin only for scripts, connections and workers; `object-src 'none'`, `form-action 'none'`, `base-uri 'self'`. No violations in a full open/edit/export session. | ✔ |
| F9 | No meta description, social preview image, canonical link; unknown URLs show GitHub's generic 404. Lighthouse SEO 91. | site | `audit:site`. | Description, Open Graph + Twitter card with a 1200×630 preview image, canonical link, branded `404.html`. | ✔ |
| F10 | White text on primary buttons and highlighted menu items is 3.63:1 (WCAG AA needs 4.5:1). | accessibility | Lighthouse colour-contrast, 3/3 runs. | `--accent-strong` #c94a32 for those fills (4.66:1). | ✔ |
| F11 | Updates can be missed or mixed: GitHub Pages sends `max-age=600`, and the service worker fetched files through the HTTP cache, so after a deploy a user could get a new `index.html` with 10-minute-old modules, and an open tab never learnt about a new version. | bug (data safety, rare) | `curl -I` shows `cache-control: max-age=600` on every file; v1.6 `sw.js` used plain `fetch(req)` and precached with default cache mode. Simulated deploy in `v17-test` (sw.js CACHE bumped). | The service worker revalidates every request (`cache: 'no-cache'`, precache with `cache: 'reload'`), checks for updates hourly and when the tab comes back after 10 min, and shows a **Reload / Later** bar with both version numbers. Nothing reloads by itself, so unsaved work is never lost to an update. | ✔ |
| F12 | Exclusion blend in 8-bit is off by up to 1.76/255 from the W3C formula (all other modes ≤ 1.04/255; 16-bit ≤ 0.5/65535). | minor | `npm run audit:math`, 3/3. | **Fixed in v1.8**: 8-bit Exclusion is now composited exactly in JavaScript (semi-transparent sources ≤ 0.75/255 in `v18-test`; the math audit's 8-bit tolerance is tightened from 2 to 1.1 levels). | v1.8.0 |

## Live verification (v1.7.0, 2026-11-03 about 12:50–1:10 AM America/New_York)

- Every fix above re-checked on the live site 3/3: bench jobs 8 and 10 (36/36 job runs pass), `audit:safety` 15/15 in each of 3 runs (F5–F8), `audit:site` (F9), and a live script for F3 (number box drives the slider), F4 (mask sets #000000/#ffffff), F7 (menu shows Ctrl+Shift+F6), F10 (button fill rgb(201,74,50)); Lighthouse colour-contrast passes 3/3. No console errors in any run.
- **Updates reaching v1.6 visitors:** three browser profiles were opened on v1.6.0 before the deploy and reopened after it. All three ended on 1.7.0 with only the v1.7 cache left: two on the first load, one on the second (the v1.6 service worker served one stale load). v1.6 has no update bar, so the bar can only appear from v1.7 onwards; the bar itself (v1.7 → next version) was tested with a simulated deploy in `v17-test`, not on the live site.

## Site audit (live)

| | v1.6.0 (before) | v1.7.0 (after) |
|---|---|---|
| App ready (median of 3, Chromium) | 307 ms | 277 ms |
| First-load transfer | 497 KB, 117 requests | 501 KB, 115 requests |
| Console errors / failed requests / third-party requests | 0 / 0 / 0 | 0 / 0 / 0 |
| Service worker, offline reload | installs; offline reload works 3/3 | installs; offline reload works 3/3 |
| Installable (manifest + icons) | yes | yes |
| Meta description / OG image / canonical / CSP / 404 page | no / no / no / no / GitHub's | yes / yes / yes / yes / Tintwork 404 (status 404) |
| README + user guide links | 14 checked, 0 broken | 16 checked, 0 broken |
| Lighthouse desktop: Performance / Accessibility / Best practices / SEO | 71 / 89 / 100 / 91 | 71–72 / 92 / 100 / 100 (3 runs) |
| WebKit (iPhone 13 emulation) | loads, 0 errors, offline works | loads, 0 errors, offline works |

Lighthouse items deliberately not changed: `meta-viewport` (`user-scalable=no` is intentional: pinch on the canvas
zooms the image, not the page, and iOS Safari still allows page zoom from Accessibility settings); `unminified-javascript`,
`unused-javascript`, `valid-source-maps` (no build step by design); `uses-long-cache-ttl` (GitHub Pages sets the headers).
Total Blocking Time is dominated by the one-off engine speed probe that runs on the first visit of each version; on this
box it runs on a software GPU, so the number is pessimistic.

## Image math (`npm run audit:math`, 50/50 pass)

All 11 blend modes at 100 % and 50 % opacity in 8-bit and 16-bit against the W3C Compositing formulas; Levels against a
reference at all 256 inputs (max error 0.5); invert exact; grayscale uses Rec. 709 weights; 16-bit PNG export has bit
depth 16 and round-trips exactly (0 of 3072 samples differ). Only finding: F12.

## Data safety, privacy and security (`npm run audit:safety`, live, 3/3)

Pass in both versions: no third-party requests during open/edit/export; every request is a GET (nothing is uploaded);
no console errors; closing a tab with unsaved changes asks first; after a crash the next visit offers recovery; a full
disk (quota error) shows a warning instead of silently dropping autosaves; a corrupt 60000×60000 PNG is refused with a
message and no uncaught errors; Esc closes dialogs; a `:focus-visible` style exists. A file and a layer named
`<img src=x onerror=…>` were displayed as text (no element created) in the title, tabs, layers panel and menus (1 probe,
not exhaustive). Failed in v1.6, fixed in v1.7: F5, F6, F7, F8.

## Windows specifics

Chrome and Edge keep Ctrl+N, Ctrl+T, Ctrl+W, Ctrl+Shift+N, Ctrl+Tab, Ctrl+Shift+Tab and a few others; Tintwork binds
the familiar key and shows a working alternate (Ctrl+Alt+N, Ctrl+Alt+T, Ctrl+Alt+W, Ctrl+Alt+Shift+N, Ctrl+F6,
Ctrl+Shift+F6) in menus and in the guide. The installed app (Chrome/Edge "Install") opens `.png .jpg .psd .dng`
and other RAW files from Explorer through `file_handlers`. Alt/F10 menu access is new (F5).

## Code health

- `src/main.js` is 7,366 lines, half of the app's 14.5k lines of top-level source. It works and is covered by 864
  browser checks, but every new feature lands there; splitting dialogs, the transform/perspective session and the
  service-worker/update code into modules would make review easier.
- No silent `catch {}` blocks in `src/`. 64 `innerHTML` assignments in `main.js`; the ones I checked that include
  user-controlled text (names) go through `escapeHtml` (not all 64 were reviewed), and the CSP now blocks inline handlers as a second line of defence.
- No build step, no dependencies at runtime; tests are 15 Playwright scripts run by `npm test`.
- The heavy pixel work has a worker path with a main-thread fallback (`ops.js`); the fallback is exercised by tests but is
  slower on big images.

## What is still missing, ranked (biggest gap first)

Updated for v1.12. Batch again can repeat an Open-tabs / files subset. Full refuses do-no-harm cases (geneva, hongkong). Radial warp still gated.

1. **One-click subject / background / sky selection (ML).** Not planned until the user wants AI.
2. **Content-aware / generative fill and remove** for real texture. Healing removes 79% on the real portrait, and the empty-edge fill smears.
3. **Upright Full on real photos:** the leaning ladder no longer steers it (library 2.24° → 0.75°), but it still misses 0.5° on all three photos with strong horizontals. It has no lens-distortion model (the library's shelf edge bends by about 1°), and photos dominated by slanted design elements (job 31's diagonal fins) defeat it: there Full makes the horizontals worse. A "do no harm" check and a distortion-aware fit are the next steps.
4. **AI denoise and camera-matching profiles for RAW.**
5. **Print workflow:** ICC printer profiles, a printer gamut warning, CMYK export. v1.16 adds approximate **output sharpening** (screen/matte/glossy × strength) on 8-bit export/batch; soft proof stays approximate (no ICC).
6. **Batch works on whole folders only.** Batch again repeats the last batch in 4 steps in a new session (the subscription RAW editor 4, Pixelmator Pro 3), but there is no "export the selected photos with this preset", because Tintwork has no library of photos to select from.
7. Edge-aware local adjustment brushes (masks like the subscription RAW editor's, with auto-mask).

## What I might be wrong about

- **Three held-out photos are not many.** The v1.10 line re-fit helped the photo it was diagnosed on and was roughly neutral on the held-out ones (the tower's worst edge got worse, 0.07° → 0.23°). It may be overfitted to job 17; more held-out photos would settle that.
- **Held-out reference edges were picked by me.** On the brick shop front, the window-frame "vertical" may not be truly vertical itself.
- **The permission prompts are simulated.** Job 29 counts 2 browser prompts in a new session. Chrome's persistent-permission prompt can cover all remembered folders at once and offers "Allow on every visit", so real Windows Chrome/Edge may need 3 or 2 steps. Equally, a browser could also ask on the first write. Not verified on a real Windows machine.
- **The upright cap was tuned on the two photos it fixes.** On the one new held-out photo it changed nothing (neither better nor worse), which is weak evidence either way.
- **"Trails" for Full assumes the subscription RAW editor does better** on these photos. That was not measured.

- **Competitor step counts come from their documentation, not from using the apps.** A practised user may need fewer steps (shortcuts, presets) or more (dialogs the docs skip). Treat them as ±2.
- **The test images are synthetic** (flat backgrounds, ideal edges). Jobs 3 and 4 pass partly because of that; on real photos the wand and the healing brush would do worse, and the paid editors' ML tools much better.
- **Only software rendering (SwiftShader) on this box.** Times and Lighthouse performance/TBT say little about a real Windows PC with a GPU; WebGPU paths were not exercised on real hardware.
- **Edge was not tested separately.** It is the same Chromium engine, so behaviour should match, but Edge-specific shortcuts or policies could differ.
- **Alt/F10 were tested in headless Linux Chromium.** Real Windows Chrome/Edge could treat a lone Alt press differently (e.g. if a browser extension or IME grabs it). Not verified on a Windows machine.
- **iPhone is WebKit emulation, not a device.** Touch gestures, memory limits and the share sheet behave differently on real iOS; the export file itself was not checked on iPhone.
- **The update bar has only been seen in a simulated deploy** (local server, bumped service-worker cache name). It will first appear for real with the next release after v1.7. The live v1.6 → v1.7 move worked 3/3 but needed a second load once; timing in the wild depends on when the browser re-checks `sw.js`.
- **The injection probe covered a handful of places** where names are shown, not every dialog.
- **robots.txt** can't be served for a project site under `/tintwork/` (it would have to be at the domain root), so the Lighthouse SEO "robots.txt" result reflects github.io, not Tintwork.
- **The background-colour swatch (`#bgColor`) is smaller than Lighthouse's 24 px target size** recommendation; left as is because it overlaps the foreground swatch by design. It may still be hard to hit on touch screens.
- Verdicts in the scorecard are mine. I defaulted to *trails* whenever I could find a documented reason; someone who weighs price, privacy (nothing leaves the browser) or "no install" more heavily would score Tintwork higher.
- **Guided upright is scored on the two facade edges only.** In the job-10 screenshot (`screenshots/17x-wf-10.png`) the outer windows still look slightly slanted. That may come from how the synthetic building was drawn (not a true projection) or may be a residual error in the correction; I did not measure it.
