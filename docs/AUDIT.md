# Tintwork self-audit (v1.6.0 → v1.7.0, updated through v1.18.0)

Date: 2026-11-02 (America/New_York). Target: the live site https://kcope19.github.io/tintwork/ (GitHub Pages).
Method: scripted Playwright runs on a Linux box (Chromium 1280×800 with `?platform=win`, plus WebKit iPhone 13
emulation), Lighthouse 12 desktop preset, and reading competitors' public documentation. **Every finding below was
reproduced 3 times out of 3 on fresh browser profiles** unless it says otherwise. Each regression test in
`scripts/v17-test.mjs` was also run against a v1.6.0 checkout (`TW_ROOT=<v1.6 checkout> node scripts/v17-test.mjs`):
it fails there (4 of 27 checks pass on v1.6, and those 4 are guards that should pass on both) and passes on v1.7 (35/35).

Scripts: `npm run bench:workflows`, `npm run audit:site`, `npm run audit:math`, `npm run audit:safety`. Raw results are in
[docs/audit/](audit/). The workflow scorecard is in [WORKFLOW_BENCHMARK.md](WORKFLOW_BENCHMARK.md).

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
- Job 18 two-vertical case is now **5 steps** (menu + 2 drags + Enter) vs v1.13’s 4; matches Lightroom Guided’s documented 5, but is one click more than Pixelmator Pro’s 4.

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
| F32 | Auto / Level / Vertical / Full / Guided upright needed an extra Enter after the correction was already previewed (jobs 16/17/23 at 3 steps vs Lightroom's 2). | friction | workflow bench step counts | Corrections **apply immediately** (Crop / Fill / Keep from the edges option). Undo reverts. | v1.13.0 |
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
| F31 | Batch again only repeated a whole remembered folder, not a selection / last-opened subset. | gap | AUDIT v1.11 "Not done"; Lightroom exports the selection | **Open tabs** in Batch process; Batch again repeats a files/tabs run on matching open tabs (by remembered names) | v1.12.0 |

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
| F23 | Batch asked for the source and output folders every time (job 25: 7 steps against Lightroom's 4). | gap | AUDIT v1.10 ranked gap 6 | Source and **Output folder** handles kept in IndexedDB; permission asked again in a new session, inside the OK click | v1.11.0 |
| F24 | No one-step repeat of the last batch. | gap | job 29 fails on v1.10 3/3 | **File ▸ Batch again** (`Ctrl+Alt+Shift+B`) repeats folders, preset/action, look and naming; opens the dialog and says why when there is nothing to repeat or its preset/action/look was deleted | v1.11.0 (4 steps in a new session; Lightroom 4, Pixelmator Pro 3) |
| F25 | Found while attacking F23: a remembered output folder that was deleted or renamed would make every file fail. | bug (pre-release) | v111-test "deleted output folder" | The folder is checked first; if gone, Tintwork says so, forgets it and asks for a new one | v1.11.0 |
| F26 | Found while attacking F23: with the same folder as source and output, a repeat batch would process its own outputs ("-edited-edited"). | bug (pre-release) | v111-test "same folder" | The names the last batch wrote are skipped | v1.11.0 |
| F27 | Files could not be dropped onto Batch process (a drop opened them as documents). | gap | v111-test on v1.10 | Dropped images or a folder become the batch source; other files are ignored | v1.11.0 |
| F28 | Upright: one long leaning object (the library ladder, 2 lines of 848 px) outvoted ~20 building edges, leaving a vertical at 2.24°. | accuracy | job 27 | Each line's vote capped at 0.4 of the frame (RANSAC score and least-squares refit) | v1.11.0 (2.24° → 0.75°; still fails 0.5°; other photos unchanged) |

**Not done in v1.11:** Full upright within 0.5° on real photos (jobs 27, 28 and the new held-out job 31 fail; on job 31 Full makes 3 of 5 edges worse than doing nothing, in v1.10 too). Lens-distortion-aware upright. Batch on a selection of photos rather than a whole folder.

## v1.10.0 update (2026-11-03, America/New_York)

v1.10 is non-AI polish again. Every fix below was reproduced 3/3. `scripts/v110-test.mjs` has 19 checks. It passed 19/19 three times on v1.10. On a v1.9.0 checkout (`TW_ROOT=<v1.9.0 worktree>`) it fails: 3 of 9 checks pass before it stops, and all 3 are guards that also pass on v1.9 (see the benchmark's test-change disclosure). The full `npm test` passed all 972 checks (953 in v1.9 + 19).

| # | Finding | Severity | Evidence | Fix | Status |
|---|---|---|---|---|---|
| F19 | Batch process could not use a saved export preset, so job 24 took 14 steps. | gap | job 25 fails on v1.9 3/3 | **Export preset** choice in Batch process: format, quality, size, ppi and the preset's own watermark. Remembers the last preset | v1.10.0 (7 steps; Lightroom 4) |
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
| F13 | The export watermark could only be text. Lightroom's Watermark Editor also places graphics. | gap | v1.8 COMPARISON; bench job 24 fails on v1.8 3/3 | **Logo image** watermark (position, opacity, width %, margin), in single, multi-size, batch and 16-bit exports; each preset keeps its own copy | v1.9.0 |
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
6. **Batch works on whole folders only.** Batch again repeats the last batch in 4 steps in a new session (Lightroom 4, Pixelmator Pro 3), but there is no "export the selected photos with this preset", because Tintwork has no library of photos to select from.
7. Edge-aware local adjustment brushes (Lightroom-style masks with auto-mask).

## What I might be wrong about

- **Three held-out photos are not many.** The v1.10 line re-fit helped the photo it was diagnosed on and was roughly neutral on the held-out ones (the tower's worst edge got worse, 0.07° → 0.23°). It may be overfitted to job 17; more held-out photos would settle that.
- **Held-out reference edges were picked by me.** On the brick shop front, the window-frame "vertical" may not be truly vertical itself.
- **The permission prompts are simulated.** Job 29 counts 2 browser prompts in a new session. Chrome's persistent-permission prompt can cover all remembered folders at once and offers "Allow on every visit", so real Windows Chrome/Edge may need 3 or 2 steps. Equally, a browser could also ask on the first write. Not verified on a real Windows machine.
- **The upright cap was tuned on the two photos it fixes.** On the one new held-out photo it changed nothing (neither better nor worse), which is weak evidence either way.
- **"Trails" for Full assumes Lightroom does better** on these photos. That was not measured.

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
