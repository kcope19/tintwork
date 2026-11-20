# Persona usability test: Tintwork v1.31.0 (live site)

Date: 2026-11-20 (America/New_York). Target: https://kcope19.github.io/tintwork/ (live, v1.31.0, commit b3a251f).
No code was changed for this report. This doc and the `screenshots/persona-*.png` files are the only changes.

## How this was run, and what it does not cover

- **Driver:** Playwright, run against the live site. Edits were driven through the real UI: menu clicks, toolbar
  clicks, options-bar chips, dialog sliders and fields, keyboard shortcuts, mouse drags on the canvas, layer-panel
  clicks and the history panel. No internal JS API was called to perform an edit. The only page-side scripting was
  reading state for the report (status bar text, doc info, history list, focus, bounding boxes) and running axe-core.
- **Desktop:** headless Chromium on Linux with Windows-like viewports of 1366×768 and 1920×1080, driven by mouse.
  It is **not a real Windows machine**. With no GPU, the app reported "CPU engine", so the timings are pessimistic
  for a Windows PC with a GPU.
- **File dialogs:** Playwright cannot drive the operating system's native Open/Save pickers (the File System Access API).
  For every desktop run, those APIs were hidden. The app then fell back to its own `<input type=file>` path, and exports
  became browser downloads. This is the same path that Firefox and Safari users get. On real Chrome or Edge, the native
  picker would appear instead, and Batch would write to a chosen folder instead of a .zip. As a side effect, "Recent
  files" showed "need Chrome or Edge" in my runs. That message comes from the test setup, **not a finding**.
- **Mobile:** one pass using Playwright's iPhone 13 profile in WebKit (touch taps, 390×844). This is an emulation,
  **not a real iPhone or Safari**. Pinch-zoom and two-finger gestures were **not tested**.
- **Timings:** the times below are how long the app took while a script drove it. They are not human task times. Click
  counts are for the shortest path once a user knows where things are. Notes on discoverability are my judgement from
  what is actually visible on screen.
- **Screen reader:** no real screen reader (NVDA, JAWS, Narrator or VoiceOver) was run. Accessibility relies on axe-core
  4.x results, a 40-press Tab walk, and DOM checks for names, roles and live regions.
- **Photos:** `test-assets/real/*` (licensed in LICENSES.md), RAW and PSD samples from `test-assets/`, and synthetic
  files made from them: an EXIF-rotated phone JPEG, an 8000×6000 JPEG, a transparent PNG, a HEIC, a corrupt .jpg, and
  a red-eye portrait. The red-eye portrait is portrait-usda.jpg with red pupils painted in.
  The upright persona ran Auto upright on held-out photos v131-canyon and v131-white **only to observe the outcome**.
  Nothing was tuned, so they remain fair held-outs.
- **Console:** none of the runs had an uncaught page error. The only console output was Chromium's performance hint
  "Multiple readback operations using getImageData… willReadFrequently" (1–6 per run) and GL driver chatter, which is
  ignored.

Severity scale: **blocker** (task impossible), **major** (task fails or gives a bad result for this persona without
expert help), **minor** (friction, with a workaround), **polish** (cosmetic).

---

## Top findings (prioritized)

| # | Severity | Persona | Finding | Repro |
|---|---|---|---|---|
| 1 | major | 2 Real estate | Auto upright can crop away most of the photo without warning or preview. Measured area kept: towers 27%, canyon 25%, below 57%, c4 74%. On towers, the result shows only sky. | Open v128-towers.jpg → Image ▸ Auto upright |
| 2 | major | 2 Real estate | Upright cannot go into an Action, so a batch cannot straighten photos. The REC badge stays at "0 steps" after Auto upright or Suggest + Enter. Exposure and white balance do record. | Actions ▸ Start recording → Image ▸ Auto upright → status bar shows "● REC 0 steps" |
| 3 | major | 1 Casual | Ctrl+S (and File ▸ Save) writes a `.tintwork` project file instead of a photo. A first-timer who presses Ctrl+S ends up with a file Instagram can't use. | Open any JPEG → Ctrl+S → downloads `name.tintwork` |
| 4 | major | 1 Casual, 5 Mobile | The default tool is Brush, so the first click or tap on the photo paints a red dab and adds a "Brush stroke" history step. | Open a photo → click the middle of it → History shows "Brush stroke" |
| 5 | major | 5 Mobile, 7 Skeptic | HEIC, the iPhone's default format, does not open. The message is the same generic "may be damaged or in a format this browser cannot decode" text and gives no hint to convert to JPEG. | Ctrl+O → photo.heic |
| 6 | major | 5 Mobile | Crop on a phone: the Apply button sits about 630 px off-screen to the right in the options bar, so you have to swipe the bar sideways to find it. The tool column also covers the left ~15% of the photo and the crop's left edge. The 4:5 chip is drawn underneath the Ratio dropdown, so a tap hits the dropdown. | iPhone width → Tools ▸ Crop → choose Portrait 4:5 |
| 7 | major | 6 Accessibility | The Layers and History panels cannot be used with a keyboard: layer rows and history rows can't be focused (no tabindex or role), and there is no shortcut to select a layer. Status messages aren't announced (no aria-live). The dialog has no accessible name (axe: aria-dialog-name, serious). | Tab through the right panel; layer rows are never focused |
| 8 | minor | 6 Accessibility | It takes 45 Tab presses to reach "Open image…" on the welcome screen because there is no skip link. Pinch-zoom of the page is disabled (`user-scalable=no`, axe meta-viewport). The document tab nests interactive controls (axe nested-interactive, serious). | Load the site → press Tab repeatedly |
| 9 | minor | 1 Casual, 5 Mobile | Export defaults to PNG even when the photo is a JPEG (PNG files are large and not what a phone user expects). The file name defaults to the original name, so it is easy to save over the original with the native picker. | File ▸ Export image… → Format = "PNG (lossless)", name = original |
| 10 | minor | 3 Pro, 4 Retoucher | Expected tools are missing: skin smoothing or frequency separation, vibrance, colour balance, shadows/highlights (only in RAW develop), pen/paths, a channels panel, history snapshots or a history brush, and content-aware fill/patch. The skin-smoothing workaround takes 6 steps. | Search the menus; also checked by source search |
| 11 | minor | All, at 1366×768 | Six tools (Shape, Text, Color picker, WB picker, Hand, Zoom) are below the fold in the tool column, with no visible scroll cue. The options bar overflows by 224 px. The History panel is only about 62 px tall (2 rows), at 1920×1080 too. | 1366×768 window → look at the bottom of the tool column |
| 12 | minor | 2, 3 | One upright counts as two undo steps ("Upright" + "Crop empty edges"), so the first Ctrl+Z only undoes the crop. | Auto upright → Ctrl+Z → still warped |
| 13 | minor | 7 Skeptic | Edits made within about 1 s of closing the tab are not in the autosave. The site reopens with no recovery prompt. After a 6 s pause, recovery works. The beforeunload warning does fire, so this only matters if the user clicks "Leave" or the browser crashes. | Paint 5 strokes → close the tab within 1 s → reopen → no "Recover unsaved work?" |
| 14 | polish | many | The status bar goes stale. It still reads "Opened …" after a crop, a clip or a brush stroke, and "Processing…" stays after Liquify. The Perspective options bar repeats itself: "Enter applies · Enter applies guides · Esc cancels" next to both "Apply guides" and "Apply". | Crop → Apply → the status still says "Opened …" |

---

## Persona 1: first-time casual user (1366×768, mouse)

**Task:** open a phone photo, make it brighter, crop it for Instagram, and save it.
Photo: `phone-dark-exif6.jpg`, a 4032×3024 JPEG with EXIF orientation 6 (portrait).

| Step | Result | Clicks (shortest path) | App time |
|---|---|---|---|
| Open via the welcome "Open image…" button | ✅ Opened **3024×4032**, so the EXIF rotation was respected | 1 + file dialog | 1.2 s |
| Make it brighter: Adjust ▸ Brightness / contrast…, drag slider to +50, OK | ✅ | 4 | ~1 s |
| Crop for Instagram: Crop tool, then the **4:5** chip, then Apply | ✅ 1080×1350 (the 4:5 chip also turns on "Resize to 1080×1350") | 3 | ~0.8 s |
| Save: **Ctrl+S** (the first instinct) | ❌ Downloads `phone-dark-exif6.tintwork`, a project file | 1 key | — |
| Save, second try: File ▸ Export image…, Format JPEG, Export | ✅ 1080×1350 JPEG verified with PIL | 4 | 0.2 s |
| **Total, correct path** | | **12 clicks** | 3.3 s app time |

What worked:
- "Brightness / contrast" sits right at the top of the Adjust menu.
- The 1:1, 4:5, 16:9 and 8×10 chips appear in the options bar as soon as Crop is picked, and the
  Ratio dropdown spells out "Portrait 4:5 (1080×1350)" and "Story 9:16".
- Apply is clearly labelled "Apply (Enter)".

Where they got stuck:
- **The default tool is Brush.** Clicking the photo, which people do to "select" it, painted a red dab
  (`persona-1-brush-on-click.png`). Nothing on screen explains what happened. The only clue is "Brush stroke" in the
  History panel. Severity: **major**.
- **Ctrl+S saved a project file.** The status bar says "Saved project …tintwork", but a novice has no idea what a
  project file is (`persona-1-ctrl-s-saves-project.png`). Severity: **major**.
- **Export defaults to PNG.** It also shows Preset, Resolution (ppi), Watermark and Output-sharpening fields that a
  first-timer doesn't need. The Preset's "Delete" button wraps under its select (`persona-1-export-dialog.png`).
  Severity: **minor**.
- The tool icons have tooltips only, with no text labels, so finding Crop means hovering icons. Crop is the 8th icon,
  which is reasonable. Severity: **polish**.
- The status bar didn't change after Crop; it still said "Opened …". Severity: **polish**.

**Verdict:** A first-timer can brighten and crop without docs, but would probably save the wrong kind of file and may
paint on the photo by accident.

## Persona 2: real-estate photographer (1920×1080, mouse)

**Tasks:** straighten buildings and interiors, adjust exposure and white balance, and batch-export several photos.

**Auto upright (Image ▸ Auto upright), share of the image area kept after the automatic crop:**

| Photo | Before → after | Area kept |
|---|---|---|
| v117-interior | 1280×851 → 1258×836 | 97% |
| v117-station | 1280×960 → 1264×948 | 98% |
| library | 1280×853 → 1262×841 | 97% |
| v131-white (held-out) | 1280×962 → 1259×946 | 97% |
| v126-resid | 1280×853 → 1245×830 | 95% |
| v126-city | 1280×853 → 1214×809 | 90% |
| v128-balconies | 1280×854 → 1174×783 | 84% |
| c4 | 1280×1776 → 1101×1528 | 74% |
| v130-below | 1280×850 → 963×639 | 57% |
| v128-towers | 853×1280 → 441×662 | **27%**: only sky and a sliver of roofline remain (`persona-2-auto-upright-towers.png`) |
| v131-canyon (held-out) | 1280×853 → 642×428 | **25%** |

Each run took about 4–5 s on the CPU engine. The status message is always the same: "Upright applied and cropped to W×H
px so no empty corners show." Nothing warns the user when most of the frame is gone. **Major** (finding 1).

**Suggest guides + Enter on v126-city:**
- Suggest drew 4 guides and reported "~0.6°" (`persona-2-suggest-guides.png`).
- Enter warped the photo and auto-cropped it to **762×508 (35% of the area)**.
- The fire-escape building on the left, half the subject, was cropped out (`persona-2-suggest-applied-crop.png`).
- An RE photographer would undo this and stay with Auto upright (90% kept on this photo).
- The geometry may be "correct", but for this persona the framing makes the result unusable.

**Exposure and white balance:**
- Adjust ▸ Exposure… (typed +0.3) worked, and Adjust ▸ White balance… (temperature +10) worked.
- The White balance picker exists, but I didn't test it with a click on a grey wall.

**Batch:**
- Record an action: Actions ▸ Start recording, then upright, exposure and WB, then Stop.
- The saved action listed only **Exposure and White balance**. The upright was not recorded, and the REC badge showed
  "0 steps" after Auto upright too. **Major** (finding 2): every photo has to be straightened by hand.
- Then File ▸ Batch process… → Choose files… (4 photos) → Action "RE upright+expo" → Run.
- The batch ran in **1.0 s** and wrote `tintwork-batch.zip` with 4 JPEGs, each at its original size.
  The status read "Batch finished: 4 of 4 images".
- The batch dialog is long but clear (`persona-2-batch-dialog.png`).
- Folder output on real Chrome or Edge was not tested (see method).

**Other friction:**
- An upright creates two undo steps. **Minor.**
- The Perspective options bar has 20+ controls, including both "Apply guides" and "Apply", and repeats "Enter applies".
  **Polish.**

**Verdict:** Exposure, white balance and batch export work well. Auto upright is good on normal facades and
interiors (90–98% kept), but it can silently wreck look-up shots and can't be batched, which is this persona's main
need.

## Persona 3: experienced pro (1920×1080, mouse + shortcuts)

| Tried | Result |
|---|---|
| Ctrl+J duplicate layer | ✅ |
| Blend mode select | ✅ 16 modes: Normal … Luminosity. No Linear burn/dodge, Vivid/Linear/Pin light or Hard mix. |
| Layer ▸ New adjustment layer: Curves… (dragged the curve in the dialog) | ✅ "New Curves layer" + "Edit Curves layer" |
| Ctrl+Alt+G clipping | ✅ clip arrow shown (the status bar did not update) |
| Layer ▸ Add layer mask, B, D, `]`×3, paint | ✅ "Paint mask". The status hint explains black hides and white reveals. `]` steps size 24→32 in 3 presses. |
| J (spot heal) while the mask is active | ⚠️ Refused: "This tool paints layer pixels. Click the layer thumbnail to target pixels." This is clear, but you have to leave mask mode by mouse. |
| Ctrl+1 / Space-drag / Ctrl+0 | ✅ |
| Image ▸ Mode: 16 bits/channel | ✅ "16-bit" in the doc info |
| Click an earlier History row | ✅ jumped back. Ctrl+Shift+Z redid forward. |
| 20× Ctrl+Z then 20× Ctrl+Shift+Z | ✅ the state came back exactly (3 layers, 16-bit, clip) |
| `?` shortcuts sheet | ✅ |

Gaps compared with the workflow they expect (checked in the menus and by searching the source):
- No pen tool or paths.
- No channels panel.
- No history snapshots or history brush.
- No content-aware fill or patch tool.
- For non-RAW images: no vibrance, colour balance, selective colour, gradient map, channel mixer or shadows/highlights.
  Vibrance and shadows exist only in the RAW develop dialog.
- No high-pass filter.
- No "blend if".

Small UI friction:
- At 1920 px, layer names truncate to "Bac…" once a mask thumbnail is shown (`persona-3-layers-mask-clip.png`).
- The History panel shows only about 2 rows. **Minor.**

**Verdict:** The core of layers, masks, clipping, adjustment layers, 16-bit and undo is solid and fast with familiar
shortcuts. A pro will miss paths, channels, history snapshots and several adjustment types.

## Persona 4: portrait retoucher (1920×1080, mouse)

Photo: portrait-usda.jpg with synthetic red pupils (`portrait-redeye.jpg`).

| Tool | Result |
|---|---|
| Red eye: toolbar icon, 1 click per eye | ✅ Pupils went from RGB ~(205,40,45) to ~(36,31,34), and the catch-light was kept (`persona-4-redeye-before-after.png`) |
| Spot healing: stroke on the cheek | ✅ "Spot healed" |
| Clone stamp: Alt+click source, then paint | ✅ the history entry was added; the status only ever said "Clone source set" |
| Dodge/burn: one stroke | ✅ Dodge/Burn, Shadows/Midtones/Highlights and Exposure options are present. The default strength is fairly strong; one pass left a visible bright streak. |
| Liquify: push | ✅ Push/Bloat/Pinch/Restore. The default size is 120 px. "Processing…" stayed in the status bar afterwards. |
| Skin smoothing | ❌ No dedicated tool. Workaround: Ctrl+J → Filter ▸ Gaussian blur 6 → Add layer mask → Invert mask → B, D, X → paint → layer opacity 60%. That is 6 menu or key steps and needs prior knowledge. |

Screenshot: `persona-4-retouch.png`. Exported a PNG at 1092×1280 to verify the edits.

**Verdict:** Red eye, healing, clone, dodge/burn and liquify all work on the first try. The gap is a real non-AI skin
smoothing tool (frequency separation, or a surface-blur brush with texture kept); today the workaround takes 6 steps.

## Persona 5: mobile-only iPhone user (WebKit, iPhone 13 emulation, touch)

| Step | Result | Taps |
|---|---|---|
| Open image… then the file sheet | ✅ 3024×4032, EXIF-correct | 1 |
| Tap the photo, as people do | ❌ Painted a brush dab ("Brush stroke") | 1 |
| Adjust tab → Brightness / contrast… → tap the slider at 75% → OK | ✅ +56 | 3 |
| Tools tab → Crop | ⚠️ The **first tap on "Tools" hid** the tool column, which was already showing, so it took a second tap | 3 |
| Choose 4:5 | ⚠️ The 4:5 chip is covered by the Ratio dropdown (elementFromPoint at its centre returns the `<select>`), so I used the dropdown's "Portrait 4:5 (1080×1350)" | 2 |
| Apply | ❌ **Apply is at x≈1020 px on a 390 px screen.** You have to swipe the options bar sideways to find it. | 2+ |
| Export tab → JPEG → Export | ✅ Downloaded `phone-dark-exif6.jpg` (251 KB), 1080×1350 | 3 |
| **Total** | Done in about 14 taps with 2 dead ends | ~14 |

Also observed:
- The tool column covers the left ~15% of the canvas, including the left edge of the crop box
  (`persona-5-mobile-crop.png`).
- In the Export sheet, the Preset select spills past the right edge (`persona-5-mobile-export.png`).
- I could not check how iOS hands off the downloaded file (the share sheet or the Files app) in emulation.

**Verdict:** A phone user can get from open to export, but crop needs a hidden sideways swipe to apply. The tool column
covers part of the photo, and HEIC, the iPhone's own format, won't open.

## Persona 6: accessibility-minded, keyboard-only (1366×768)

**Worked:**
- **Focus is visible** on all 40 elements in the Tab walk (outline or box-shadow).
- **F10** focuses the menubar. Arrow keys move through it. ↓ opens a menu, and Enter runs an item: F10 → ×5 → ↓ → Enter
  opened Brightness / contrast with focus on its first field.
- **Dialogs trap focus**: 12 of 12 Tabs stayed inside. Arrow keys move sliders, and Esc closes.
- Every shortcut is shown in the menus.
- At 683×384 (the same as 200% browser zoom on a 1366×768 laptop), the layout reflows to the mobile layout
  (`persona-6-zoom200.png`).

**Problems:**
- 45 Tab presses to reach "Open image…" on the welcome screen: the menubar, then 8 options-bar inputs, then 25 tool
  buttons. There is no skip link. **Minor.**
- **Layers panel:** rows are not focusable. Only the eye ("Toggle visibility") button is. There is no keyboard way to
  pick a layer. **Major.**
- **History panel:** rows are not focusable. Ctrl+Z and Ctrl+Y work. **Minor.**
- **Tool buttons:** their names come from `title` only. That works as an accessible name, but there's no aria-label,
  and none of the 25 sets `aria-pressed` for the active tool. **Minor.**
- **No live region:** the status bar has no `aria-live`/`role=status`, so results like "Upright applied…" or "could not
  be read" are silent for screen-reader users. **Major.**
- **Canvas:** no accessible name or role. **Minor.**
- **axe-core violations:**
  - welcome screen: `meta-viewport` (moderate, `user-scalable=no`), `region` (#optionsbar outside landmarks)
  - with a document open: also `nested-interactive` (serious, `.doc-tab`), `page-has-heading-one`
  - in the Curves dialog: also `aria-dialog-name` (serious, #modal has no aria-labelledby), `color-contrast` (serious,
    the RGB channel button)
- After Esc, focus returns to the viewport section, which has no visible focus ring. **Polish.**
- Screenshot: `persona-6-keyboard-dialog.png`.
- **Not tested:** a real screen reader, Windows High Contrast mode, and reduced motion.

**Verdict:** The menus and dialogs are well built for keyboard users, but layers can't be selected without a mouse and
results aren't announced, so a screen-reader user can't do real editing yet.

## Persona 7: skeptic / power user (1920×1080)

| Test | Result |
|---|---|
| Open an 8000×6000 JPEG (48 MP) | ✅ 2.4 s |
| Gaussian blur r=20 on 48 MP | ✅ 13.8 s on the CPU engine, with no progress bar beyond the status text (should be faster with a GPU; not measured here) |
| 48 MP → 16-bit | ✅ 0.6 s |
| Export a 48 MP JPEG | ✅ 5.0 s, 8000×6000 verified |
| Transparent PNG → export PNG | ✅ alpha kept: corner (0,0,0,0), centre alpha 200 |
| Transparent PNG → export JPEG | ✅ flattened onto white, no warning (fine) |
| HEIC | ❌ "photo.heic could not be read. The file may be damaged or in a format this browser cannot decode." It recovers cleanly with no crash (`persona-7-heic.png`). Not verified on Windows Edge with the HEIF extension. |
| Corrupt "jpg" (text bytes) | ✅ same clean message, no page error |
| RAW: nikon-d3300.nef | ✅ decoded in 0.83 s; the Develop dialog shows camera EXIF; it opened 6000×4000 16-bit. The status warns that 16-bit autosave falls back to 8-bit at that size, which is honest. |
| Third-party PSD with text, smart object, effects and photo filter | ✅ 10 layers, and a clear "converted / dropped" notes dialog |
| 40 brush strokes, then 60× Ctrl+Z, then 60× Ctrl+Y, as fast as possible | ✅ 3.3 s; back to "Open" then to the last stroke; no errors |
| Ctrl+Alt+W on an unsaved doc | ✅ "Close document? … has unsaved changes" with Cancel |
| Close the browser tab with unsaved work | ✅ the beforeunload prompt fired |
| Reopen after closing **6 s after the last edit** | ✅ "Recover unsaved work? … 6 undo steps" restored the doc and its history (`persona-7-recover-autosave.png`) |
| Reopen after closing **~1 s after the last edit** | ⚠️ no recovery offered; the last edits are lost (`persona-7-reopen-after-close.png`). Note: Playwright's page close may not match a real tab close exactly. The app does try to save on `pagehide`, but the write evidently doesn't finish. |
| Offline reload: service worker active, network off | ✅ The app reloads fully offline. A JPEG opens offline, and a CR2 RAW opens to the Develop dialog offline (`persona-7-offline.png`). |

**Verdict:** Hard to break. There were no crashes or uncaught errors across huge, odd and corrupt files, rapid
undo/redo, or going offline. The real gaps are HEIC support and the about-1-second autosave window.

---

## Per-persona verdicts (one line each)

1. **Casual:** can brighten and crop for Instagram unaided, but Ctrl+S saves a project file and the default Brush
   paints on the first click.
2. **Real estate:** exposure, white balance and batch export are good, and Auto upright works on normal interiors and
   facades, but it silently crops look-up shots to a quarter and can't be batched.
3. **Pro:** solid layers, masks, clipping, adjustment layers, 16-bit and undo with familiar shortcuts; missing paths,
   channels, history snapshots and several adjustment types.
4. **Retoucher:** red eye, healing, clone, dodge/burn and liquify all work; real skin smoothing is missing (6-step
   workaround).
5. **Mobile:** completes the task, but crop's Apply is off-screen, the tool column covers the photo, and HEIC won't
   open.
6. **Accessibility:** great menubar and dialog keyboard support, but layers can't be selected by keyboard and status
   isn't announced.
7. **Skeptic:** robust: 48 MP, RAW, PSD, corrupt files, undo storms and offline all held up; HEIC and the 1 s autosave
   window are the gaps.

## Recommended top 3 fixes for the next release

1. **Make Upright safe and batchable.**
   - Before applying, compute the area that will be kept. Below about 60%, show "Upright would crop to N%: Apply /
     Fill edges / Cancel" instead of applying silently, or refuse as the Suggest gates already do.
   - Make upright plus its crop one undo step.
   - Record Auto upright (and Level/Vertical/Full) as Action steps so Batch can straighten.
   - Any upright code change should be validated with the usual held-out discipline (canyon and white are still fair).
2. **Fix the first-run "save" path and the default tool.**
   - Start on a non-painting tool (Move or Hand).
   - On a document opened from an image that has never been saved as a project, make Ctrl+S ask "Export as JPEG /
     Save project", or go straight to Export.
   - Default the export format to the source format (JPEG for a JPEG).
   - Give HEIC a specific message: "HEIC isn't supported by this browser — on iPhone set Camera ▸ Formats ▸ Most
     Compatible, or convert to JPEG".
3. **Accessibility and mobile basics.**
   - Make layer and history rows focusable (roving tabindex, with ↑/↓ to select and Enter to toggle).
   - Add `role="status" aria-live="polite"` to the status bar and `aria-labelledby="modalTitle"` to the dialog.
   - Add a skip link to the canvas and Open, and drop `user-scalable=no`.
   - On phones, pin Apply and Cancel where they can be seen (for example in the bottom bar) whenever a tool needs
     confirming, and stop the tool column from covering the canvas.

## Screenshots (all in `screenshots/`)

persona-1-brush-on-click, persona-1-ctrl-s-saves-project, persona-1-export-dialog, persona-1-1366-layout,
persona-2-suggest-guides, persona-2-suggest-applied-crop, persona-2-auto-upright-towers, persona-2-batch-dialog,
persona-3-layers-mask-clip, persona-4-retouch, persona-4-redeye-before-after, persona-5-mobile-crop,
persona-5-mobile-export, persona-6-keyboard-dialog, persona-6-zoom200, persona-7-heic, persona-7-recover-autosave,
persona-7-reopen-after-close, persona-7-offline.

The harness scripts are in `/workspace/persona/` on the build box. They were not committed, as instructed. They can
be promoted to `scripts/` if this test should be repeatable.
