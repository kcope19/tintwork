# Tintwork self-audit (v1.6.0 → v1.7.0, updated for v1.8.0, v1.9.0 and v1.10.0)

Date: 2026-11-02 (America/New_York). Target: the live site https://kcope19.github.io/tintwork/ (GitHub Pages).
Method: scripted Playwright runs on a Linux box (Chromium 1280×800 with `?platform=win`, plus WebKit iPhone 13
emulation), Lighthouse 12 desktop preset, and reading competitors' public documentation. **Every finding below was
reproduced 3 times out of 3 on fresh browser profiles** unless it says otherwise. Each regression test in
`scripts/v17-test.mjs` was also run against a v1.6.0 checkout (`TW_ROOT=<v1.6 checkout> node scripts/v17-test.mjs`):
it fails there (4 of 27 checks pass on v1.6, and those 4 are guards that should pass on both) and passes on v1.7 (35/35).

Scripts: `npm run bench:workflows`, `npm run audit:site`, `npm run audit:math`, `npm run audit:safety`. Raw results are in
[docs/audit/](audit/). The workflow scorecard is in [WORKFLOW_BENCHMARK.md](WORKFLOW_BENCHMARK.md).

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

Updated for v1.10. Batch with export presets (v1.9 item 6) is done; soft proofing is partly done.

1. **One-click subject / background / sky selection (ML).** Not planned until the user wants AI.
2. **Content-aware / generative fill and remove** for real texture. Healing removes 79% on the real portrait, and the empty-edge fill smears.
3. **Upright Full on real photos:** on two held-out real photos it uses 4 and 9 horizontals and cuts their tilt by 75–95%, but leaves up to 1° (brick) and 2.2° on a vertical misled by a leaning ladder (library). It needs robust rejection of non-architectural lines.
4. **AI denoise and camera-matching profiles for RAW.**
5. **Print workflow:** ICC printer profiles, a printer gamut warning, output sharpening, CMYK export. v1.10 has only an approximate paper-white / ink-black proof.
6. **Batch still asks for both folders every time** (7 steps against Lightroom's 4).
7. Edge-aware local adjustment brushes (Lightroom-style masks with auto-mask).

## What I might be wrong about

- **Three held-out photos are not many.** The v1.10 line re-fit helped the photo it was diagnosed on and was roughly neutral on the held-out ones (the tower's worst edge got worse, 0.07° → 0.23°). It may be overfitted to job 17; more held-out photos would settle that.
- **Held-out reference edges were picked by me.** On the brick shop front, the window-frame "vertical" may not be truly vertical itself.

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
