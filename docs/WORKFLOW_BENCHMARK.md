# Workflow benchmark (v1.7.0 → v1.8.0 → v1.9.0)

v1.8 adds nine jobs (13–21) that use **real photos** (public domain / CC0, `test-assets/real/LICENSES.md`) and the new
features, and re-scores jobs 3, 4 and 10 on them. Jobs 1–12 are unchanged from v1.7 (below, kept for history).

**Before** = the live site at v1.7.0, 3 runs (2026-11-03, about 1–2 AM America/New_York). **After** = the live site at
v1.8.0, 3 runs after deploy (2026-11-03, about 2:45–3:30 AM America/New_York): 57 of 63 runs pass; the 6 failures are job 15 (the wand baseline, fails by design) and job 17. Raw results: `docs/audit/workflows-v18-before.json` and `workflows-v18-after.json`. Screenshots now go to `screenshots/18x-wf-NN.png` (two are committed).

## v1.9 scorecard (non-AI polish: logo watermark, upright modes, 16-bit fill, healing)

v1.9 adds three jobs:
- **22:** Upright Full on the real church photo.
- **23:** Upright Level on a 3°-tilted synthetic sea horizon.
- **24:** Batch export of 6 photos with a logo watermark.

It also changes how **job 13** is timed (see below). Jobs 1–21 are otherwise unchanged.

The runs:
- **Before:** the live site at v1.8.0, 3 runs, 2026-11-03 about 8:28 AM America/New_York (`docs/audit/workflows-v19-before.json`).
- **After (local):** the v1.9 commit served locally, 3 runs (`workflows-v19-local.json`).
- **After (live):** the live site at v1.9.0 after deploy, 3 runs (`workflows-v19-after.json`). See *Live verification* below.

| # | Job | Before (v1.8, live) | After (v1.9) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 13 (3R) | Remove a blemish on a real portrait | pass 3/3: 25.0 → 5.3 levels (79% removed); stroke + heal 288–414 ms | pass 3/3: **identical** 25.0 → 5.3 (79%); grain 1.39× the photo's; stroke + heal 294–338 ms | 2 | 2 in all five | **trails** |
| 22 (10R) | Upright Full, church photo | fail 3/3: no Full mode | pass 3/3: −0.23° / −0.18° / 0.12°, but **with 0 horizontal lines used** (rejected as unreliable), so the result is exactly Vertical's | 3 | Lightroom Upright Full 2, Camera Raw 4, Affinity 5, Pixelmator Pro 4, Photopea 5 | **trails** |
| 23 | Level a 3° sea horizon | fail 3/3: no Level mode | pass 3/3: 3.00° → 0.01° (rotation from one horizon line, cropped to 1468×918) | 3 | Lightroom Upright Level 2, Pixelmator Pro Auto straighten 2, Camera Raw 3, Affinity 3, Photopea 4 | **trails** |
| 24 | Batch 6 photos to 2048 px with a logo watermark | fail 3/3: text watermark only | pass 3/3: 6 files, logo in the bottom-right of each (≥ 30,827 logo pixels per file, 0 in the top-left) | 14 | Lightroom Export with a graphic watermark ~9 | **trails** |
| 19 | Export preset + watermark (text) | pass 3/3 | pass 3/3 (unchanged: 9 steps first time, 1 to repeat) | 7 / 1 | Lightroom 6 / 1–2 | **matches** |
| 20 | Batch with a text watermark | pass 3/3 | pass 3/3 (unchanged, 12 steps) | 12 | Lightroom 6–7 | **trails** |
| 16 / 17 / 18 | Auto upright (church), Auto upright (high-rise), Guided | 16 pass, 17 **fail** (−0.50°), 18 pass | unchanged: 16 pass, 17 **fail 3/3** −0.50° / 0.10°, 18 pass | 3 / 3 / 5 | as in v1.8 | trails / trails / **matches** |

**Summary (v1.9): 0 beat, 2 match (18, 19), every other job trails (now 24 jobs). Job 17 still fails its own 0.5° bar.**
The new features turned three jobs from *fail* into *pass*, but none of them reaches a competitor's step count or capability.

### Live verification (v1.9.0)

Pages finished deploying at 8:58 AM America/New_York on 2026-11-03.
- `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v19-test.mjs` passed 36/36, three times out of three.
- The live bench (jobs 13, 16–20, 22–24, 3 runs each) matched the local results exactly. Job 17 failed 3/3 as before; everything else passed 3/3.
- Screenshots: `screenshots/19-live-upright-modes.png` shows the Auto · Level · Vertical · Full bar, and the status line saying Full fell back to the verticals on the church photo. `screenshots/19-live-logo-watermark.png` shows the logo watermark dialog.

### Healing: speed and quality, honestly

- **Speed:** in the v1.8 bench, job 13 took about 66–76 s per run. Timing the app itself showed this was the benchmark
  script, not the healer. The script passed multi-MB images between Node and the page as JSON number arrays.
  - In the app, opening the photo takes ~0.37 s and the heal 27 ms after mouse-up; the stroke plus heal takes ~0.3–0.4 s.
  - The bench now keeps the reference images in the page and reports the app time separately. The job takes ~6 s end to end, and v1.8 timed the same way also takes 0.29–0.41 s.
  - **So v1.9 did not make healing faster; it fixed a misleading number.**
- **Quality: unchanged at 79%.** I tried 9 variants of the source search offline, on 12 synthetic spots on the same portrait plus 10 held-out spots: patch-border width, 32 angles × 6 radii, a colour-mean penalty, and averaging the best 2 sources.
  - Held-out results (removed % / texture log-error, lower is better): current 60.6% / 0.185; best variant 63.8% / 0.272.
  - Averaging two sources reached 71.8% removed on the tuning spots, but it smooths the skin.
  - A plain smooth fill scores 76.3% on the tuning set with almost no grain (texture log-error 1.82), so the mean-error metric rewards blur.
  - No variant improved both measures on the held-out spots, so none shipped. The ceiling with the best single source offset is about 87%.
  - v1.9 adds a grain check (high-pass energy relative to the photo; 1.39× now) so a blur "improvement" cannot pass silently.
- **Counter-argument:** Lightroom's Remove tool and Photoshop's Spot Healing are content-aware or generative and were not measured on this image. Same clicks, but almost certainly better on real texture. **Trails.**

### The case against each v1.9 verdict

- **22 Full:** passes only because Full falls back to Vertical. On both real test photos (c4 church, c6 high-rise) the horizontal lines fail the safety checks: fewer than 3 agree, or their vanishing point is too close. Full therefore leaves the horizontals alone.
  - Its two-axis correction is proven only on a synthetic facade (≤ 0.02° in `v19-test`).
  - Lightroom's Full applies "level, horizontal, and vertical perspective corrections" ([help](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)). **Trails.**
- **23 Level:** the image is synthetic, with one clean horizon line and noise of ±6 levels. A real seascape with waves, haze or a boat would be harder.
  - v1.8's Image ▸ Auto straighten (Hough, ±20°) could probably already level this image. Level adds a 15° safety limit and lives in the upright bar; it is not a new capability.
  - 3 steps against 2 in Lightroom and Pixelmator Pro. **Trails.**
- **24 Logo batch:** works, but takes 14 steps (choosing the folders and logo, size, format, watermark type). A Lightroom user with a saved preset and graphic watermark needs about 9 the first time and 1–2 afterwards.
  - Tintwork's export presets keep the logo, but Batch process does not take an export preset. **Trails.**
  - Tintwork has no logo rotation and no fit/fill sizing, which Lightroom's Watermark Editor has ([help](https://helpx.adobe.com/lightroom-classic/desktop/workspace/using-watermark-editor.html)).
- **19 (matches):** the v1.8 counter-argument ("text only") is answered by the logo watermark. The step count is still one above Lightroom's on the first export. Kept at *matches* on the strength of the 1-step repeat.
- **18 (matches):** unchanged since v1.8 (same 5 steps as Lightroom Guided). The counter-argument stands: Lightroom's Guided takes up to 4 guides; Tintwork's takes 2.

### Not measured

- **16-bit Fill edges** has no bench job. It is covered by `v19-test`: every filled value comes from 16-bit data, opaque pixels are unchanged, and Undo works.
- Competitors' fill is content-aware in Photoshop, which is better on texture; Tintwork's push-pull fill smears.

### Test-change disclosure

- `scripts/v18-test.mjs`: the v1.8 check that "16-bit Fill empty edges refuses" now accepts either that refusal or a successful 16-bit fill, because v1.9 implements the fill. This loosens that one check; the new behaviour is tested strictly in `v19-test`.
- Bench job 13 changed its timing method (above), but its pass bar and metric did not change: 25.0 → 5.3 on both versions.
- Job 22 counts only edges still in the frame. On v1.9 all 3 edges are in the frame.

## v1.8 scorecard (real photos and new features)

How the new jobs are measured:
- **Subject selection (14, 21, 15):** IoU (overlap ÷ union) of the selection with the cut-out that Wikimedia Commons
  publishes for the same photo. Job 14 measures inside the cut-out's frame (its cut-out is cropped); job 21 measures the
  whole frame. Pass > 0.9 (14), > 0.8 (21). **Disclosure:** stroke weight and reach were tuned on job 14's photo; job 21's
  photo was used only after tuning (box only, no strokes), as a holdout.
- **Upright (16–18):** before and after, straight architectural edges are measured by a sub-pixel least-squares edge
  fit on the photo (independent of the app's line detector, which works on a 640 px copy). Edges are only used where at
  least half of the rows support the fit; the first seed edges I picked in v1.8 development had 13–33% support (they
  spanned several structures) and were replaced. Pass: every edge within 0.5° of vertical after the correction.
- **Blemish (13):** mean colour error inside a spot painted onto a real portrait, against the untouched photo.

| # | Job | Before (v1.7, live) | After (v1.8, live) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 13 (3R) | Remove a blemish on a real portrait | pass 3/3: error 25.0 → 5.3 levels (79% removed) | pass 3/3: 25.0 → 5.3 levels (79% removed), 66 s per run | 2 | 2 in all five | **trails** |
| 14 (4R) | Select a real subject (box + 2 strokes) | fail 3/3: no object select | pass 3/3: IoU 0.954, 7 steps, 1.2 s per solve | 5 | Photoshop Object Selection 2, Lightroom Select Subject 2, Pixelmator Pro 3, Affinity 4, Photopea 4 | **trails** |
| 21 (4R) | Holdout subject, box only | fail 3/3: no object select | pass 3/3: IoU 0.974, 5 steps | 3 | as above | **trails (closer)** |
| 15 | Baseline: same subject with the magic wand (v1.7 route) | IoU 0.201 (fails by design) | IoU 0.201 (unchanged; baseline) | 10 | — | baseline |
| 16 (10R) | Auto upright, church among towers | fail 3/3: no Auto | pass 3/3: −0.23° / −0.18° / 0.12° | 3 | Lightroom Upright Auto 2, Camera Raw 4, Affinity 5, Pixelmator Pro 4, Photopea 5 | **trails** |
| 17 (10R) | Auto upright, high-rise looking up | fail 3/3: no Auto | **fail 3/3**: −0.50° / 0.10° (bar is < 0.5°) | 3 | as above | **trails** |
| 18 (10R) | Guided upright on the church photo | not measurable on v1.7 (no correction record in the test API) | pass 3/3: 0.02° / −0.12° / 0.04° | 5 | Lightroom Guided 5, Camera Raw 7, Affinity 5, Pixelmator Pro 4, Photopea 5 | **matches** |
| 19 | Export for web with a saved preset + watermark | fail 3/3: no presets | pass 3/3: 9 steps first time, 1 step to repeat; watermark only in its corner | 7 first time, **1** after | Lightroom 6 first time, 1–2 after | **matches** |
| 20 | Batch 6 photos to 2048 px with a watermark | fail 3/3: no batch watermark | pass 3/3: 6 files, watermark in each | 12 | Lightroom 6–7 (export preset with watermark) | **trails** |
| 10 | Converging verticals, synthetic building | pass 3/3 via Guided, 7 steps | pass 3/3 via Auto, 5 steps; lean −0.09° / 0.00° | 3 (Auto) | Lightroom 2 | **trails** |

**Summary (v1.8): 0 beat, 2 match (18, 19), the rest trail; 1 real-photo upright job fails its own 0.5° bar.**

### The case against each verdict

- **13 Blemish (real photo)** — Passes, but removes 79% of the error, not 100%, and took about 76 s per run on this
  box's software renderer (v1.7 the same). Lightroom's Remove tool (generative) and Photoshop's Spot Healing
  (content-aware) are documented for real texture; nothing here shows Tintwork matching them. Job 3's "matches"
  (synthetic flat skin, Δ 0) is withdrawn: **trails**.
- **14 Object select** — 0.954 needs a box and two strokes (5 steps); the box alone gives 0.72 on this photo (the dark
  suit against a dark background is the weak spot). Photoshop's Object Selection tool takes a box and selects the object
  with ML ([help](https://helpx.adobe.com/photoshop/desktop/make-selections/get-started-selections/select-objects-with-object-selection-tool.html)); Lightroom/Pixelmator/Photopea have one-click Select Subject. The strokes were tuned on this
  photo; untuned stroke placements gave 0.91–0.92. A wrong stroke hurts more than a missing one, and a stroke reach
  above about 200 px over-grows. **Trails.** (Job 4, synthetic, now takes 11 steps instead of 12 with Object select.)
- **21 Holdout** — 0.974 with the box alone on a photo not used for tuning is good, but one photo with a clean
  background is not a sample; ML tools need no box. **Trails (closer).**
- **16/17 Auto upright** — Church: every measured edge within 0.23°. High-rise: −0.50° / 0.10°, failing the 0.5° bar by
  rounding; Guided gets 0.02–0.12° on the church. On a diagonal shot (c1, Copley Place) Auto applies a keystone that a
  person would not want (Esc cancels; Guided is the fix). Lightroom's Upright also has Level, Full and Vertical modes
  and constrain crop ([help](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)); Tintwork only corrects verticals. **Trails.**
- **18 Guided upright** — Same step count as Lightroom Guided, edges within 0.12° and the empty corners cropped by
  default (Lightroom: Constrain Crop). Counter-argument: Lightroom allows up to four guides (verticals and horizontals
  together) and shows a loupe while drawing; Tintwork takes two. Kept as **matches** for two-edge vertical fixes only.
- **19 Export preset + watermark** — First export 7 steps vs Lightroom's 6; repeats are 1 step (Ctrl+Alt+Shift+E), like
  Lightroom's Export With Previous ([help](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-presets-settings-plug-ins.html)).
  Counter-argument: Lightroom's Watermark Editor also places image (logo) watermarks and exports to a chosen folder with
  renaming ([help](https://helpx.adobe.com/lightroom-classic/desktop/workspace/using-watermark-editor.html)); Tintwork's is text only. **Matches** for a text watermark only.
- **20 Batch with watermark** — Works (6 files, watermark in every one), but 12 steps vs Lightroom's preset export of a
  selection. **Trails.**
- **10 Verticals (synthetic)** — Auto upright does it in 3 steps, outer windows lean ≤ 0.09° on average (the 7° lean I
  flagged in v1.7 was the test image: its outer windows were drawn as upright rectangles, not in perspective; with
  windows drawn in perspective the lean after Auto is −0.09° / 0.00°). Lightroom needs 2. **Trails.**

### Verdict changes from v1.7
- Job 3: *matches on steps* → **trails** (real photo shows 79% removal, not Δ 0).
- Job 6 (watermark): *matches for one image, trails for many* → still **matches for one**, and for many now
  depends on the batch route (job 20: trails).

## v1.7 scorecard (jobs 1–12, history)


`npm run bench:workflows` (local working tree) or `node scripts/workflows-bench.mjs <url> --label <name> --runs 3` scripts
twelve everyday jobs with Playwright in Chromium at 1280×800, the way a mouse-and-keyboard user on Windows does them
(`?platform=win`, Ctrl shortcuts, real clicks and drags on the canvas). Every job is checked by measuring the result
(pixels, file headers, layer state), not just by finishing without an error. Results are written to
`docs/audit/workflows-<label>.json`; one screenshot per job goes to `screenshots/17x-wf-NN.png`. An iPhone 13
(WebKit emulation) smoke pass opens a photo, edits it and exports.

**Before** = the live site at v1.6.0, 3 runs (2026-11-02, evening, America/New_York). **After** = the live site at v1.7.0, 3 runs after deploy (2026-11-03, about 1 AM America/New_York).

## How to read the numbers

- **Steps** are user actions: a click, a drag, a key press, a value typed, a file picked. Opening the photo counts as 2 (Ctrl+O and picking the file) in Tintwork's column; the competitor counts start from a photo that is already open, so compare against **Tintwork steps − 2** (− 1 for job 1, 0 for job 9).
- **Competitor step counts are my reading of each vendor's public documentation, not hands-on timings.** They are approximate (±1–2) and assume the user knows where the command is.
- **Time** is wall-clock for the scripted run on this box (software-rendered GPU, no human think time). It is useful for spotting regressions, not for comparing with a human in another app.
- **Verdict** defaults to *trails*. A job is marked *matches* only when the step count is comparable **and** I could not find a documented competitor feature that makes the job clearly easier or better. The strongest counter-argument is written next to each verdict.

## Scorecard

| # | Job | Before (v1.6, live) | After (v1.7, live) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 1 | RAW: exposure + white balance, 16-bit | pass 3/3, 4 steps, 3.2–3.6 s | pass 3/3, 4 steps | 3 | Lightroom Classic 3, Camera Raw 4, Affinity Develop 5, Photopea 6 | **trails** |
| 2 | Crop + straighten a tilted horizon | pass 3/3, 7 steps, 5.8–5.9 s | pass 3/3, 7 steps | 5 | Lightroom 4, Photoshop 4, Affinity 5, Pixelmator Pro 4, Photopea 5 | **trails** |
| 3 | Remove a blemish | pass 3/3, 4 steps, 5.6–5.7 s | pass 3/3, 4 steps | 2 | 2 in all five | **matches on steps; quality unproven** |
| 4 | Select the subject, blur the background | pass 3/3, 12 steps, 7.7 s | pass 3/3, 12 steps | 10 | Photoshop 5, Lightroom 4, Affinity 7, Pixelmator Pro 5, Photopea 6 | **trails (clearly)** |
| 5 | Dodge and burn a portrait | pass 3/3, 6 steps, 5.9 s | pass 3/3, 6 steps | 4 | Photoshop 6, Lightroom 5, Affinity 5, Pixelmator Pro 4, Photopea 5 | **trails** |
| 6 | Text watermark at 50% opacity | pass 3/3, 8 steps, 5.3–5.4 s | pass 3/3, 8 steps | 6 | Photoshop 6, Lightroom (export watermark) 6, Affinity 5, Pixelmator Pro 5, Photopea 5 | **matches for one image; trails for many** |
| 7 | Instagram 4:5, 1080×1350 JPEG | pass 3/3, 8 steps, 5.6 s | pass 3/3, 8 steps | 6 | Lightroom 7, Photoshop 8, Affinity 8, Pixelmator Pro 7, Photopea 8 | **matches** |
| 8 | Print: 8×10 in at 300 ppi JPEG | **FAIL 3/3**: file said 1 dpi, unit 0 (no ppi) | pass 3/3: JFIF 300 ppi | 7 | Lightroom 6, Photoshop 8, Affinity 8, Pixelmator Pro 7, Photopea 9 | **trails** (was: broken) |
| 9 | Batch-resize 6 photos to 2048 px JPEG | pass 3/3, 9 steps, 2.3–2.4 s | pass 3/3, 9 steps | 9 | Lightroom 6, Photoshop Image Processor 7, Affinity Batch Job 8, Pixelmator Pro 7, Photopea: no batch | **trails** (beats Photopea only) |
| 10 | Fix converging verticals (building) | **FAIL 3/3**: edges still lean 152 px | pass 3/3 with Guided upright: edges within 3 px | 5 | Lightroom Upright Auto 2 / Guided 4, Camera Raw 4, Affinity 5, Pixelmator Pro 4, Photopea 5 | **trails** (was: could not be done accurately) |
| 11 | Blend two photos with a gradient mask | pass 3/3, 8 steps, 5.8 s | pass 3/3, **7 steps** | 5 | Photoshop 6, Affinity 6, Pixelmator Pro 6, Photopea 6, Lightroom: not possible | **trails** (Photoshop Sky Replacement) |
| 12 | Re-edit a saved project's adjustment | pass 3/3, 12 steps, 6.4–6.6 s | pass 3/3, 12 steps | 10 | Lightroom 3 (catalog), Photoshop 5, Affinity 5, Pixelmator Pro 5, Photopea 6 | **trails** |

**Summary: 0 jobs beat the paid editors, 3 match (one with a caveat), 9 trail.** v1.6 failed 2 of 12 jobs outright (6 of
36 runs); v1.7 passes 12 of 12 (36 of 36 runs). iPhone smoke pass: works in both versions (export goes through the
share sheet in WebKit; the emulated run cannot tap the sheet, so the file itself is not checked on iPhone).

## The case against each verdict

1. **RAW** — Steps are level with Lightroom, but Lightroom and Camera Raw have one-click *Auto* tone, camera-matching profiles and AI denoise; quality of Tintwork's own demosaic was not compared here. *Trails.*
2. **Straighten** — Lightroom's crop overlay has *Auto* straighten and the Straighten tool inside crop, so straighten + crop is one tool ([Lightroom Classic Upright](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)). Tintwork needs two tools. *Trails.*
3. **Blemish** — Same click count, and the result matched clean skin exactly (Δ 0). Counter-argument: the test image is synthetic flat skin; Photoshop's Spot Healing uses content-aware fill and Lightroom's Remove tool uses generative AI on real texture, which this bench does not test. Kept as *matches on steps* only.
4. **Subject + blur** — Every paid editor has a one-click ML subject selection: Lightroom Select Subject ([masking](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/masking.html)), Pixelmator Pro Edit ▸ Select Subject, Control-S ([guide](https://support.apple.com/guide/pixelmator-pro/make-intelligent-selections-pixefcaa405e/mac)), Affinity Photo 2.6+ Select ▸ Select Subject after downloading models ([Serif](https://support.serif.com/hc/en-us/articles/12017241295119-Affinity-Photo-v2-6-includes-Machine-Learning-Features)), Photopea's Select Subject button ([learn](https://www.photopea.com/learn/selections)). Tintwork's 3 magic-wand clicks only work because the test background is flat; on a real photo the wand would fail. *Trails clearly.*
5. **Dodge/burn** — Lightroom's brush masks and Photoshop's dodge/burn on 50% grey with range control are standard; Tintwork's tone tool is not edge-aware. *Trails.*
6. **Watermark** — For one image, level. Lightroom puts a saved watermark on every export automatically ([Watermark Editor](https://helpx.adobe.com/lightroom-classic/desktop/workspace/using-watermark-editor.html)); Tintwork would need an action. *Matches for one image, trails for many.*
7. **Instagram** — Tintwork's 4:5 crop preset already sets 1080×1350, so it saves the resize step. Counter-argument: Lightroom export presets make it one click after setup. Still *matches*.
8. **Print** — v1.6 wrote no resolution into the file (bug, fixed). Counter-argument: Lightroom has soft proofing with printer ICC profiles and print sharpening ([develop options](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)); Tintwork has neither. *Trails.*
9. **Batch** — Works and is fast, but needs more steps than Lightroom's export and has no saved export presets. *Trails* (beats Photopea, which has no batch).
10. **Verticals** — Lightroom's Upright *Auto/Vertical* fixes this in one click; its Guided mode (Shift+T, two lines, corrected after the second) is what Tintwork's new Guided upright resembles ([Guided Upright](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/guided-upright-perspective-correction.html)). Lightroom also offers *Constrain crop*; Tintwork leaves transparent corners to crop. *Trails.*
11. **Gradient blend** — v1.7 removed a step (mask colours are now black/white automatically). But for the most common case, a sky, Photoshop's Edit ▸ Sky Replacement detects the sky and relights the foreground ([help](https://helpx.adobe.com/photoshop/desktop/effects-filters/artistic-stylize-filters/replace-the-sky-in-images.html)). *Trails.*
12. **Re-edit** — Lightroom's edits are always live in the catalog; there is no save/close/reopen at all. *Trails.*

## What changed between before and after

- Job 8: JPEG/PNG exports now carry the document ppi (JFIF density / PNG pHYs), and the Export dialog has a Resolution field.
- Job 10: new Image ▸ Guided upright (and a Guides button in Edit ▸ Perspective). With manual corner dragging in v1.6 the script could not get the facade edges closer than 152 px of lean.
- Job 11: one step fewer because adding a mask now switches the colours to black/white.
- Number boxes next to every dialog slider, so exact values can be typed.
