# Workflow benchmark (v1.6.0 → v1.7.0)

`npm run bench:workflows` (local working tree) or `node scripts/workflows-bench.mjs <url> --label <name> --runs 3` scripts
twelve everyday jobs with Playwright in Chromium at 1280×800, the way a mouse-and-keyboard user on Windows does them
(`?platform=win`, Ctrl shortcuts, real clicks and drags on the canvas). Every job is checked by measuring the result
(pixels, file headers, layer state), not just by finishing without an error. Results are written to
`docs/audit/workflows-<label>.json`; one screenshot per job goes to `screenshots/17x-wf-NN.png`. An iPhone 13
(WebKit emulation) smoke pass opens a photo, edits it and exports.

**Before** = the live site at v1.6.0, 3 runs (2026-11-02, evening, America/New_York). **After** = the live site at v1.7.0, 3 runs after deploy.

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
