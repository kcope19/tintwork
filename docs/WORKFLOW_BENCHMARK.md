# Workflow benchmark (v1.7.0 → v1.8.0 → v1.9.0 → v1.10.0 → v1.11.0 → v1.12.0)

v1.8 adds nine jobs (13–21) that use **real photos** (public domain / CC0, `test-assets/real/LICENSES.md`) and the new
features, and re-scores jobs 3, 4 and 10 on them. Jobs 1–12 are unchanged from v1.7 (below, kept for history).

**Before** = the live site at v1.7.0, 3 runs (2026-11-03, about 1–2 AM America/New_York). **After** = the live site at
v1.8.0, 3 runs after deploy (2026-11-03, about 2:45–3:30 AM America/New_York): 57 of 63 runs pass; the 6 failures are job 15 (the wand baseline, fails by design) and job 17. Raw results: `docs/audit/workflows-v18-before.json` and `workflows-v18-after.json`. Screenshots now go to `screenshots/18x-wf-NN.png` (two are committed).

## v1.15 scorecard (adversarial polish: Done+feather undo, 16-bit Export default)

Local Chromium `?platform=win`, 2026-11-05 America/New_York. Audit-driven; not a feature stack.

| Area | v1.14 | v1.15 | Verdict |
|---|---|---|---|
| Done + feather undo | two history steps; Undo left hard mask | **one** step; Undo clears selection | **match** (expected undo) — was a bug, not a competitor race |
| Export 16-bit doc | Format defaulted to 8-bit PNG (dither) | Defaults to **PNG 16-bit** when no last preset | **match** (preserves depth) / still trails if last preset was JPEG |
| Job 14 / heal / Full / soft-proof ICC | trails | unchanged | **trails** |

**Summary (v1.15): bugfix on Done+feather undo; 16-bit Export default is a small honesty win. No trails→match on jobs 13/14/Full. npm test: 1052.**

**Test-change disclosure:** `v115-test` is new (18 checks). `v112-test` APP_VERSION pin accepts through 1.15.0. No quality bars loosened.

**Adversarial / why these could be wrong:**
- “Match” on undo is against user expectation, not a paid-app step count.
- 16-bit default is skipped when a last export preset exists — easy to miss in real use.
- Audit did not re-bench workflow jobs 1–32; scorecard jobs stay at v1.14 verdicts unless listed above.

## v1.14 scorecard (non-AI polish: soft-proof papers/CMY/last, objsel Done+feather, crop chips, RAW splitH)

Local Chromium `?platform=win`, 2026-11-05 America/New_York. No heal% or Full≤0.5° cycle this version.

| Job / area | What | v1.13 | v1.14 | Steps / note | Paid reference | Verdict |
|---|---|---|---|---|---|---|
| Soft proof | Papers + ink cue | glossy/matte + ink warning | + rag / newsprint / approx CMY + **last used** | — | Lightroom ICC Simulate Paper & Ink | **trails** (closer; still no ICC) |
| 14 | Object select cut-out | IoU ~0.95, 5 steps (box + 2 strokes) | Same solve; **Done + feather** and sticky +Subject cut a post-cutout feather step when needed | 5 (cut-out) / −1 when feathering | Photoshop Object Selection 2 (ML) | **trails** (no AI; UX closer) |
| Crop common ratios | Dropdown only | chips 1:1 / 4:5 / 16:9 / 8×10 / Free | 1 click vs open dropdown | — | — | **match** (common sizes) |
| RAW before/after | Left/right split | + top/bottom (Y cycles) | — | Lightroom Y / split orientations | **match** (orientations) |
| 13 / Full upright | heal 79%; Full fails 0.5° | unchanged (deliberately) | — | — | **trails** |

**Summary (v1.14): crop common presets and RAW split orientations move toward match; soft proof and job 14 still trail (no ICC / no ML). Heal and Full untouched. npm test: **1034** checks.**

**Test-change disclosure:** `v114-test` is new (21 checks). `v112-test` APP_VERSION pin accepts 1.12.0 / 1.13.0 / 1.14.0 on this tree (not a quality bar). Library Full bar stays the loosened 1.0° in `v112-test` (disclosed since v1.11). No quality bars loosened for heal or Full. `v13-test` Split leave: Y must be pressed twice (cycle includes top/bottom); adapted to the new cycle, not a weaker quality bar.

**Adversarial / why these could be wrong:**
- **Crop chips match:** only the five common sizes; the full dropdown still has banners/custom. Competitors also expose presets in one click.
- **RAW split match:** orientation parity only — not a claim that develop quality matches Lightroom.
- **Job 14 still trails:** Done + feather does not raise IoU or remove the need for two strokes on the USDA portrait; ML Select Subject remains 2 steps.
- **Proof still trails:** approximate papers + greyscale CMY are not a printer profile.

## v1.13 scorecard (non-AI polish: auto-apply upright, ink warning, sRGB embed, heal/fill)

Local Chromium `?platform=win`, 2026-11-05 America/New_York. Step counts below exclude the shared open-file pair (Ctrl+O + pick), matching how competitor clicks are counted from docs.

| Job | What | v1.12 | v1.13 | Steps (Tintwork) | Paid reference | Verdict |
|---|---|---|---|---|---|---|
| 16 / 17 | Auto upright, church / high-rise | pass, **3** steps (menu + Enter) | pass, identical angles; **2** steps (apply immediate) | 2 | Lightroom Auto 2, Camera Raw 4, Affinity 5, Pixelmator Pro 4, Photopea 5 | **match** (was trails on steps) |
| 23 | Upright Level, sea horizon | pass, 3 steps | pass; **2** steps | 2 | Lightroom Level 2 | **match** |
| 18 | Guided upright | pass, **5** steps | pass; **4** steps (no Enter after 2nd guide) | 4 | Lightroom Guided 5, Pixelmator Pro 4 | **match** |
| 10 | Converging verticals (Auto) | pass via Auto | pass; Auto path **2** upright steps | 2 (Auto) | Lightroom 2 | **match** |
| 13 | Real portrait spot heal | pass 79% removed, grain ~1.39× | pass **79%** removed, grain **1.33×** (texture guard held; denser search did not raise %) | 2 | 2 in all five | **trails** (quality) |
| 22 / 27 / 28 / 31 / 32 | Full upright | fail 0.5° / refuse held-outs | unchanged (no Full math change; auto-apply only) | 2 | Lightroom Full 2 | **trails** |
| Soft proof ink warning | N/A | magenta crush + ~CMY limit overlay | — | Lightroom gamut warning (ICC) | **trails** (approx, no ICC) |
| Export sRGB | PNG chunk only via encodePNG; JPEG none | JPEG ICC + PNG sRGB on all PNG exports | — | — | **match** (sRGB tagged) |

**Summary (v1.13): several upright jobs move trails→match on steps (2, equal to Lightroom Auto/Level). Heal quality still trails (79%→79%). Full upright still fails 0.5°. No radial warp. npm test: 1013 checks.**

**Test-change disclosure:** `realUpright` and jobs 10/23 only press Enter when a mesh is still open (older builds). Job 13 pass bar unchanged (≥70% via `after < before * 0.3`, grain not part of the bench ok). `v113-test` is new (10 checks). `v112-test` APP_VERSION pin accepts 1.12.0 or 1.13.0 on this tree (not a quality bar). Library Full bar stays the loosened 1.0° in `v112-test` (disclosed since v1.11).

**Adversarial / why these matches could be wrong:**
- **Auto / Level match on steps:** Lightroom also offers Constrain Crop as a separate toggle and Upright often follows lens-profile correction ([help](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)). Tintwork's Crop/Fill/Keep is chosen *before* the menu click (or left at the Crop default); changing it after apply needs Undo + reset. Step count ties only when the default Crop is fine. Competitors' step counts still come from docs (±2). Default kept: **match** when Crop is already selected (the default).
- **Guided match (4 vs Lightroom 5 / Pixelmator 4):** Tintwork takes two drawn lines then applies; Lightroom Guided allows up to four guides. On jobs that need a horizontal + two verticals, Tintwork still trails on *quality*, not counted here. Default: **match** on the two-vertical case.
- **Heal still trails:** 79% removed, identical to v1.12/v1.9 on the same USDA spot (3/3). Texture guard held (grain 1.33×). Paid Remove / Spot Healing were not re-measured; assumed better on real skin. **trails**.
- **Ink warning trails:** no ICC, approximate CMY sum — not a substitute for a printer profile gamut warning.

## v1.12 scorecard (non-AI polish: Full do-no-harm, gated radial estimate, Batch Open tabs)

v1.12 adds one job:
- **32:** Upright Full on a **new held-out** real photo (Hong Kong facade, CC0, `hongkong.jpg`). Seeds fixed before the first Tintwork run; never tuned on.

**Held-out method.** `hongkong.jpg` was downloaded after the v1.12 upright do-no-harm / radial work was in progress. Its five reference edges were fixed before Tintwork ran on it. `geneva.jpg` (job 31) remains a regression check (must not worsen). Library/brick stay tuning photos.

Local after (try12): jobs 16/17/22/26 pass unchanged; 27/28 fail 0.5° at v1.11 numbers; 31 and 32 **refuse** (no correction) — edges preserved.

| # | Job | Before (v1.11) | After (v1.12) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 27 (tuning) | Upright Full, library | fail: 0.75° / −0.08° / 0.85° / 0.68° / 0.50° | fail: **identical** (radial gated) | 3 | Lightroom Full 2 | **trails** |
| 28 (tuning) | Upright Full, brick | fail: 0.23° / 1.15° / −0.33° / −0.97° / −0.06° | fail: **identical** | 3 | as job 27 | **trails** |
| 31 (held out) | Upright Full, geneva fins | fail: applied and worsened (v1.11) / or same as v1.10 | fail bar: **no correction** (refuse); edges −0.21° / 0.50° / 0.60° / 0.38° / 0.43° preserved | 3 | as job 27 | **trails** (safer than v1.11 apply-and-worsen; still not a 0.5° pass) |
| 32 (held out) | Upright Full, Hong Kong facade | n/a (new) | fail bar: **no correction** (dual tiny-rotate refuse); edges −0.40° / 0.63° / 0.13° / −0.11° / 0.21° preserved. First apply without refuse had made horizontals up to 1.46° | 3 | as job 27 | **trails** |
| 16 / 17 / 22 / 26 | Auto / Full regression | pass | pass, identical | 3 | as before | trails |
| Batch Open tabs / again subset | selection-style repeat | Batch again folder-only | Open tabs + again on matching open tab names | — | Lightroom exports selection | **trails** (closer) |

**Summary (v1.12): 0 beat, 2 match (18, 19), every other job trails (now 32 jobs). Full still fails 0.5° on library/brick; held-outs no longer get a harmful correction.**

Radial disclosure: half-angle `estimateRadial` can report e.g. kEst≈−0.05 on the library, but applying it (mesh-only or with VP re-fit) raised edges vs v1.11 on the tuning set, so **kRad stays 0**.


### Live verification (v1.12.0)

Pages finished deploying commit 34251f5 at about 10:14 AM America/New_York on 2026-11-05; the live `sw.js` reports `tintwork-shell-v1.12.0`.

- `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v112-test.mjs` passed **16/16 three times** (Open tabs batch + Batch again subset, library Full ≤1.0°, geneva/hongkong refuse & not-worse, church Full ≤0.5°, APP_VERSION 1.12.0).
- Live workflow bench jobs 27/28/31/32 (`docs/audit/workflows-v112-live1.json` … `live3.json`): **identical 3/3** — library 0.75° / −0.08° / 0.85° / 0.68° / 0.50°; brick 0.23° / 1.15° / −0.33° / −0.97° / −0.06°; geneva and hongkong **no correction** (edges preserved). They still *fail* the 0.5° pass bar by design (refuse ≠ pass).
- Screenshots: `screenshots/112-live-batch-open-tabs.png` (Batch process → Open tabs: 2 images), `screenshots/112-live-upright-hongkong-refuse.png` (Full on hongkong → mode none / status says lines already look straight).

### Test-change disclosure (v1.12)
- `v112-test.mjs` library Full check keeps the **1.0° bar** (weaker than the bench 0.5°). Geneva/hongkong are checked for **refuse / not-worse**, not 0.5°. Church Full keeps the 0.5° bar. All disclosed here and in the test file.

## v1.11 scorecard (non-AI polish: batch remembers folders, Batch again, steadier Full upright)

v1.11 adds three jobs:
- **29:** repeat the job 25 batch (6 photos, saved preset with logo) **in a new browser session** with File ▸ Batch again. A setup batch runs first and is not counted; the page is then reloaded with folder permission reset to "ask" (simulating a new session), and each browser permission prompt counts as one step.
- **30:** the same, through the Batch process dialog (folders and preset already filled in).
- **31:** Upright Full on a **new held-out** real photo (office facade with diagonal fins, CC0, `geneva.jpg`).

**Held-out method.** `geneva.jpg` was downloaded after the v1.11 upright change was written and tuned. Its five reference edges (three verticals, two horizontals) were fixed with the same sub-pixel edge fit *before* Tintwork was first run on it, and were not changed afterwards. It was measured, and nothing was tuned on it. **Jobs 27 and 28 are no longer held out:** the library and brick photos were used to diagnose and tune the v1.11 change.

The runs:
- **Before:** the v1.10.0 tag served locally, 3 runs (`docs/audit/workflows-v111-before.json`). The live site was not used as the baseline because it was already serving a pushed v1.11 work-in-progress commit.
- **After (local):** the v1.11 commit served locally, 3 runs of jobs 13 and 16–31 (`workflows-v111-local.json`): 42 of 51 runs pass, and every job gave the same result 3/3.
- **After (live):** see *Live verification* below.

| # | Job | Before (v1.10) | After (v1.11) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 29 | Next session: repeat the batch with File ▸ Batch again | fail 3/3: no Batch again; the repeat is job 25's 7 steps | pass 3/3: 6 files, 2048 px, logo bottom-right; 0 folder dialogs | **4** (2 are permission prompts; 2 in the same session or after "Allow on every visit") | Lightroom Export with Preset 4, Photoshop Image Processor 6, Affinity batch job 9, Pixelmator Pro saved Shortcut 3, Photopea no batch | **trails** |
| 30 | Next session: repeat through the Batch process dialog | fail 3/3 (folders not remembered) | pass 3/3 | **5** (3 in the same session) | as job 29 | **trails** |
| 25 | Repeat job 24 with a saved preset (first session) | pass 3/3, 7 steps | pass 3/3, 7 steps (unchanged) | 7 | as job 29 | trails |
| 27 (tuning photo) | Upright Full, library shelves | fail 3/3: verticals **2.24°** / −0.54°, horizontals 0.89° / 0.81° / 0.90° | fail 3/3: verticals **0.75°** / −0.08°, horizontals 0.85° / 0.68° / 0.50° | 3 | Lightroom Upright Full 2, Camera Raw 4, Affinity 6, Pixelmator Pro 5, Photopea 6 | **trails** |
| 28 (tuning photo) | Upright Full, brick shop front | fail 3/3: 0.23° / 1.15° / −0.33° / −0.97° / −0.06° | fail 3/3: identical | 3 | as job 27 | **trails** |
| 31 (held out) | Upright Full, office facade with diagonal fins | fail 3/3: −0.66° / 0.00° / 0.11° / 0.86° / 0.92° (from −0.21° / 0.50° / 0.60° / 0.38° / 0.43°) | fail 3/3: identical | 3 | as job 27 | **trails** |
| 16 / 17 / 22 / 26 | Auto / Full upright regression set | pass | pass, identical to v1.10 (0.00° / −0.20° / −0.18°; −0.34° / 0.01°; −0.00° / 0.06° / 0.23°) | 3 | as before | trails |
| 13, 18–21, 23, 24 | unchanged jobs | pass | pass (same results) | as in v1.10 | as in v1.10 | as in v1.10 |

**Summary (v1.11): 0 beat, 2 match (18, 19), every other job trails (now 31 jobs). Job 29 equals Lightroom's 4 steps but is rated trails (see below). Full upright still fails the 0.5° bar on all three photos with strong horizontals.**

What the upright numbers say, plainly:
- **The change:** each line's vote in the vanishing-point fit is capped at 0.4 of the frame's long side (in both the RANSAC score and the least-squares refit). The library's two ladder rails were the longest lines in the photo (848 px each, 3.5° off vertical); they outvoted about 20 book and shelf edges of ~210 px. With the cap the ladder is rejected as an outlier and the verticals are treated as parallel. Caps of 0.15, 0.25 and 0.4 were tried; all gave the library about 0.75–0.78° on its worst vertical. 0.4 was kept because it leaves every other photo's measured result identical to v1.10.
- **It did not reach 0.5° on jobs 27/28.** The causes are in the photos, not only the fit:
  - *Library:* the bottom shelf edge bends: a sub-pixel fit gives 3.69° on its left half and 4.76° on its right half (lens distortion). No single perspective transform can straighten both halves, and the detector finds the left half as a separate line. Using the five reference edges alone, the best possible transform would leave ≤ 0.2° on the horizontals, so a lens-distortion-aware fit would be the next step.
  - *Brick:* the measured window-frame edge (0.89°) and the pilaster edge 8 px from it (−0.06°) disagree by about 1° in the photo itself. Any correction leaves about 1° between them; v1.11 leaves 0.23° / 1.15°.
- **The new held-out photo fails, and v1.11 neither helps nor hurts it** (identical to v1.10). Its many diagonal fins are nearly vertical (0.4–0.8°) and outnumber the true building edges. Full finds no horizontal lines at all (probably because the fins' strong edges take up the detector's top-12% gradient threshold), so it rotates by 0.5° to fix the verticals, and that doubles the horizontals' tilt (0.4° → 0.9°) and leaves the left silhouette at −0.66°. Here Full makes the photo **worse** than doing nothing on 3 of 5 edges. An orientation-specific edge threshold that would find those horizontals was tried *before* this photo was added and was rejected, because it made the library worse (horizontals up to 1.6°) and changed jobs 16/17.
- Also tried and rejected on the tuning photos: more lines per photo (60 instead of 30; job 26 regressed to −0.82°), iterated line re-fitting (library better, brick horizontals lost), and robust (Cauchy-weighted) vanishing-point refits (no change).

### The case against each v1.11 verdict

- **29 Batch again (trails, although it ties Lightroom's 4 steps):** Lightroom exports the *selected* photos with a preset ([help](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-presets-settings-plug-ins.html)); Batch again always processes the whole remembered folder, so it cannot redo just three photos. Pixelmator Pro needs 3. The 4 steps include 2 browser permission prompts. Chrome's persistent-permission prompt lists every remembered handle at once and offers "Allow on every visit" ([Chrome blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)), so on real Windows Chrome it may be 3 steps, or 2 after "Allow on every visit". That is not verified on a real Windows machine: the bench simulates the prompts. Against a "match": the tie is on step count only, and the step counts for competitors come from docs (±2). Default kept: **trails**.
- **30 dialog (trails):** 5 steps, worse than job 29 by one click, for the same reasons.
- **27 / 28 / 31 Full (trails):** all fail the 0.5° bar. Lightroom documents Full as a "combination of full Level, Vertical, and Auto perspective corrections" and says enabling lens profile corrections "is highly recommended, before processing the photo with the Upright modes" ([help](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)), which matters for the library's bent shelf. Its accuracy on these photos was not measured, so "trails" is an assumption about Lightroom, not a measurement.

### Live verification (v1.11.0)

Pages finished deploying commit 75c8b3a at about 10:41 AM America/New_York on 2026-11-03; the live `sw.js` reports `tintwork-shell-v1.11.0`.
- `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v111-test.mjs` passed 15/15 in a clean set of three runs (3/3). One earlier live run, started about 2 minutes after the deploy, crashed in Node before it finished. Only its last line was kept, so the cause is unknown. Two runs in that same batch passed 15/15.
- The live bench for jobs 29–31 (3 runs each; 6 of 9 runs pass) matched the local results exactly:
  - Job 29 (Batch again) passed 3/3 in 4 steps.
  - Job 30 (the dialog) passed 3/3 in 5 steps.
  - Job 31 (geneva, held out) failed 3/3, with the same −0.66° / 0.00° / 0.11° / 0.86° / 0.92° edges as local.
- Screenshots:
  - `screenshots/111-live-batch-folders.png` shows Batch process on a new session with the remembered "batch-in" and "batch-out" folders, Forget folders and the preset.
  - `screenshots/111-live-batch-again.png` shows the result of File ▸ Batch again ("Batch finished: 6 of 6 images, 6 files written to batch-out.").

### Test-change disclosure

- `scripts/v111-test.mjs` (15 checks, new). It simulates the folder pickers with private browser storage (OPFS) and a new session by making the stored folders answer "prompt" until permission is requested again.
- Its library Full check uses a bar of **1.0°, weaker than the bench's 0.5°**, because v1.11 does not reach 0.5° there. The held-out office facade is **printed, not checked**, because v1.11 fails it. Both are stated in the test file.
- On a v1.10.0 worktree (`TW_ROOT`) the test fails: 1 of 7 checks passes before it stops (the first batch, which v1.10 already did).
- Bench: jobs 29–31 are new; job 25 is unchanged. The bench's start-up script now also simulates the permission prompts (jobs 1–28 never request permission, so they are unaffected).
- `lastUpright.debug` (the detected lines, in document pixels) was added to the test API for diagnosis.
- No existing test or bench bar was loosened.

## v1.10 scorecard (non-AI polish: batch with presets, logo sizing, sharper upright lines, soft proof)

v1.10 adds four jobs:
- **25:** repeat job 24 (batch 6 photos with a logo) using a saved export preset. The preset is saved during setup and not counted, as for the competitors' saved presets.
- **26:** Auto upright on a **held-out** real tower photo.
- **27, 28:** Upright Full on two **held-out** real photos with converging horizontals (library shelves; brick shop front). Both verticals and horizontals are measured.

**Held-out method.** The three new photos (CC0, `test-assets/real/LICENSES.md`) were downloaded *after* the upright change was written and tuned on the v1.8/v1.9 photos (c4 church, c6 high-rise). Their reference edges were picked by eye and snapped to the strongest gradient before any result was seen, and were not changed afterwards. Each photo was measured once per version and nothing was tuned on it.

The runs:
- **Before:** the live site at v1.9.0, 3 runs, 2026-11-03 (`docs/audit/workflows-v110-before.json`).
- **After (local):** the v1.10 commit served locally, 3 runs (`workflows-v110-local.json`).
- **After (live):** the live site at v1.10.0 after deploy, 3 runs (`workflows-v110-after.json`). See *Live verification* below.

| # | Job | Before (v1.9, live) | After (v1.10) | Tintwork steps excl. open | Competitors (docs) | Verdict |
|---|-----|------|------|------|------|------|
| 25 | Repeat job 24 with a saved export preset | fail 3/3: Batch process has no preset choice | pass 3/3: 6 files, 2048 px, logo bottom-right only | **7** (was 14 in job 24) | Lightroom Export with Preset 4, Photoshop Image Processor 6, Affinity batch job 9, Pixelmator Pro saved Shortcut 3, Photopea no batch | **trails** |
| 17 (10R) | Auto upright, high-rise looking up | **fail** 3/3: −0.50° / 0.10° (bar 0.5°) | **pass** 3/3: −0.34° / 0.01° | 3 | as in v1.8 | **trails** |
| 26 (held out) | Auto upright, second real tower | pass 3/3: 0.07° / 0.03° / 0.07° | pass 3/3: −0.00° / 0.06° / 0.23° (**worst edge worse**) | 3 | as job 16 | **trails** |
| 27 (held out) | Upright Full, library shelves | fail 3/3: verticals 2.23° / −0.29°, horizontals 0.73° / 0.88° / 0.13° (from −4.15° / 4.57° / −4.33°) | fail 3/3: verticals 2.24° / −0.54°, horizontals 0.89° / 0.81° / 0.90° | 3 | Lightroom Upright Full 2, Camera Raw 4, Affinity 6, Pixelmator Pro 5, Photopea 6 | **trails** |
| 28 (held out) | Upright Full, brick shop front | fail 3/3: verticals 0.14° / 1.03°, horizontals −0.48° / −1.02° / 0.16° (from 5.13° / 4.21° / 1.60°) | fail 3/3: verticals 0.23° / 1.15°, horizontals −0.33° / −0.97° / −0.06° | 3 | as job 27 | **trails** |
| 16 / 22 | Auto / Full upright, church | pass: −0.23° / −0.18° / 0.12° | pass: 0.00° / −0.20° / −0.18° | 3 | as in v1.9 | trails |
| 24, 19, 20, 18, 23, 13 | unchanged jobs | pass | pass (same results) | as in v1.9 | as in v1.9 | as in v1.9 |

**Summary (v1.10): 0 beat, 2 match (18, 19), every other job trails (now 28 jobs). Job 17 now passes its 0.5° bar; jobs 27 and 28 (Full on held-out real photos) fail it.**

What the held-out photos say, plainly:
- **The job 17 fix is not clearly a general improvement.** v1.10 re-fits each detected line on a sharper copy of the photo (up to 1600 px instead of the 640 px preview). That moves job 17 from −0.50° to −0.34°. On the held-out tower it still passes, but its worst edge went from 0.07° to 0.23°. On the library it is worse on 3 of 5 edges, and on the brick front better on 3 of 5. My reading: the re-fit is roughly neutral on average, and it happened to help the photo it was diagnosed on. I kept it because it passes every bar it passed before, but this is weak evidence against overfitting.
- **Full already used real horizontals in v1.9** on both held-out photos (4 and 9 lines). So item 4, "Full horizontals working on a real photo", was already half true before this release; v1.9's tests only showed it falling back on the church and the high-rise. On the held-out photos Full cuts the horizontal tilt by 75–95%, but it leaves up to 1° on the brick front and does not meet the 0.5° bar. On the library a leaning ladder and books pull the vertical vanishing point, leaving one vertical at 2.2°. That is a documented case for Guided upright.

### Live verification (v1.10.0)

Pages finished deploying at about 9:44 AM America/New_York on 2026-11-03.
- `TW_URL=https://kcope19.github.io/tintwork/ node scripts/v110-test.mjs` passed 19/19, three times out of three.
- The live bench (jobs 13, 16–20 and 22–28, 3 runs each; 33 of 39 runs pass) matched the local results exactly. Jobs 27 and 28 failed 3/3; everything else passed 3/3.
- Screenshots: `screenshots/110-live-batch-preset.png` shows Batch process with an export preset chosen, its size, format and quality filled in, and its logo. `screenshots/110-live-soft-proof.png` shows the matte-paper proof on the library photo.

### The case against each v1.10 verdict

- **25 Batch with preset (trails):** 7 steps against Lightroom's 4 (select all, File ▸ Export with Preset ▸ preset) and Pixelmator Pro's 3. Tintwork still asks for both folders every time, because browsers do not let a page remember folder handles across sessions without a permission prompt. It beats Affinity's 9 and Photoshop's 6 on step count, but those tools also run actions and macros, which Tintwork does not. Default kept at **trails**.
- **17 Auto upright (trails):** it now passes its own 0.5° bar, but Lightroom does this in 2 steps, and the held-out evidence above shows the fix is not clearly general.
- **26 held-out tower (trails):** passes, but slightly worse than v1.9.
- **27 / 28 Full (trails):** both fail the bar. Lightroom's Full applies "level, horizontal, and vertical perspective corrections" ([help](https://helpx.adobe.com/lightroom-classic/desktop/help/upright-automatic-perspective-correction.html)). Its quality on these photos was not measured.
- **Soft proof (no bench job):** Tintwork's proof only simulates paper white and ink black (two fixed papers). Lightroom's soft proofing uses the printer's ICC profile, a rendering intent, and monitor and printer gamut warnings ([help](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)). **Trails** clearly.
- **Logo sizing (no bench job):** v1.10 adds three size modes (short side, width, fit inside). Lightroom's Watermark Editor also has rotation and fill ([help](https://helpx.adobe.com/lightroom-classic/desktop/workspace/using-watermark-editor.html)). **Trails.**

### Not done

- **sRGB gamut warning:** not built. Tintwork edits and exports sRGB only and reads no ICC profiles, so an "out of sRGB" warning would never fire. A useful printer gamut warning needs ICC printer profiles, which Tintwork does not have.

### Test-change disclosure

- `scripts/v110-test.mjs` (19 checks, new). Two of its upright checks also pass on v1.9.0, because v1.9 already did well on those photos:
  - the held-out tower check;
  - the brick Full check.
  
  They are regression guards and do not prove that v1.10 improved anything. The brick check is also **weaker than the 0.5° bench bar**: it asks for at least 3 horizontals and the worst horizontal tilt cut to under a third. This is stated in the test file.
- On a v1.9.0 worktree (`TW_ROOT`), the test fails: 3 of 9 checks pass before it stops (the 2 guards above and "no page errors").
- Bench `edgeAngle` was extended to measure horizontal edges (column scan, vertical gradient). Existing vertical measurements are unchanged: v1.9 still reads −0.50° / 0.10° on job 17.
- No existing test or bench bar was loosened.

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
