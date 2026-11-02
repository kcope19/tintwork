# Tintwork user guide

Tintwork is a layered photo editor that runs entirely in your browser. Nothing is uploaded: images, projects and autosaves stay on your device. It works best in Chrome or Edge on Windows with a mouse; other Chromium browsers, Firefox, Safari and touch devices also work.

## Getting started

- **Welcome screen**: open an image, start a blank canvas, pick a size preset (Full HD, square, 4:5, A4, 24 MP) or reopen a recent file. It appears whenever no document is open.
- **Open** (Ctrl+O): JPEG, PNG (8- and 16-bit), WebP, GIF, BMP, Tintwork projects, layered PSD/PSB files and camera RAW files (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more). You can also drag files onto the window or paste an image (Ctrl+V). Opening several files gives each its own tab.
- **New canvas** (Ctrl+N): width, height and background (white, background color or transparent).
- **Recent files** (File ▸ Open recent): Chrome and Edge remember files you opened or saved.
- **Install**: in Chrome or Edge use the install icon in the address bar to run Tintwork in its own window, offline.

## The workspace

- **Menu bar** at the top, **tool options bar** under it, **tools** on the left, **panels** on the right (Color, Histogram, Layers, History, Looks), **status bar** at the bottom.
- **Document tabs** sit above the canvas. Ctrl+Tab and Ctrl+Shift+Tab switch, Ctrl+Alt+W closes.
- **Navigate**: mouse wheel zooms at the cursor, hold Space or middle-drag to pan, Ctrl+0 fits, Ctrl+1 shows actual pixels.
- Press **?** for every keyboard shortcut and **F1** for this guide.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Move | V | Drag the layer, selected layers or selected pixels; arrow keys nudge (Shift = 10 px) |
| Rectangle / Ellipse select | M / O | Drag a selection |
| Lasso / Polygonal lasso | L / P | Freehand or point-by-point outline |
| Magic wand | W | Select by color with a tolerance |
| Crop | C | Drag, choose a preset ratio or size, Enter applies |
| Straighten | | Draw along the horizon |
| Brush / Eraser | B / E | Size, hardness, opacity; Shift+click draws a straight line |
| Clone stamp | S | Alt+click sets the source, then paint |
| Healing / Spot healing | R / J | Remove blemishes and dust |
| Fill | G | Flood fill with a tolerance |
| Text | T | Click to type; click a text layer to edit it |
| Color picker | I | Alt+click with the brush also picks |
| Hand / Zoom | H / Z | Pan and zoom |

## Selections

- Hold **Shift** to add, **Alt** to subtract, **Shift+Alt** to intersect, or use the buttons in the options bar.
- Select ▸ All (Ctrl+A), Deselect (Ctrl+D), Invert (Ctrl+Shift+I), Feather (Shift+F6), Color range, Refine edge (Ctrl+Alt+R).
- A selection limits painting, fills, adjustments and filters. Feathered selections blend softly.

## Layers

- **New layer** Ctrl+Shift+N, **duplicate** Ctrl+J, **merge down** Ctrl+E, **reorder** by dragging or Ctrl+[ and Ctrl+].
- Each layer has visibility, opacity and a blend mode. Double-click a name to rename it.
- **Masks**: Layer ▸ Add layer mask. Paint black to hide and white to reveal. Press `\` to switch between mask and pixels; Shift+click the mask thumbnail to disable it.
- **Groups** (Ctrl+G), **clipping masks** (Ctrl+Alt+G) and **layer styles** (drop shadow, inner shadow, outer and inner glow, stroke, color overlay).
- **Multi-select**: Ctrl+click and Shift+click layers, then move, transform, align, distribute or group them together.
- **Live layers** (Filter ▸ Convert to live layer) keep filters editable.

## Adjustments and looks

- **Destructive** adjustments are in the Adjust menu: Brightness/contrast (Ctrl+B), Hue/saturation (Ctrl+U), Levels (Ctrl+L), Curves (Ctrl+M), Exposure, White balance and more. They show a live preview; OK applies.
- **Adjustment layers** (Layer ▸ New adjustment layer) never change pixels and can be edited later by double-clicking them. On big photos the preview updates at reduced resolution while you drag and sharpens a moment after you stop.
- **Auto enhance** (Ctrl+Shift+L) and **Auto white balance** add editable layers.
- **Looks panel**: one-click looks made of adjustment layers; Intensity sets the strength. Save your own looks and import 3D LUT (.cube) files.

## Filters and transforms

- Filter menu: Gaussian blur, Sharpen, Add noise, Vignette.
- **Free transform** (Ctrl+T): scale, rotate, skew, perspective and warp grids. Enter applies, Esc cancels.
- Image menu: rotate, flip, Image size, Canvas size, Resize to preset, Auto straighten.

## Saving, exporting and recovery

- **Save** (Ctrl+S) writes a `.tintwork` project that keeps layers, masks, styles, adjustment layers and 16-bit data. **Save as** is Ctrl+Shift+S.
- **Export** (Ctrl+Shift+E): PNG, JPEG or WebP with a quality setting. **Export multiple sizes** writes several sizes at once into a folder or a ZIP.
- **Autosave**: every open document is saved in the browser a few seconds after each change. If the browser or the tab closes unexpectedly, the next start offers to **Restore** it.
- **Actions and batch**: record steps in the Actions menu and replay them on a folder of images with File ▸ Batch process.

## Camera RAW files

Opening a RAW file (File ▸ Open, drag and drop, Open recent, or double-clicking a file once Tintwork is installed) shows the **Develop** dialog with a live preview:

- **White balance**: *As shot* uses the camera's setting, *Auto* measures the photo, *Custom* lets you set **Temperature** (kelvin) and **Tint**. Moving either slider switches to Custom.
- **Tone**: **Exposure** (in stops), **Highlight recovery**, **Shadows** and **Contrast**.
- **Noise reduction**: **Luminance** smooths grain, **Color** removes coloured speckles. Both are a little slower to apply at full size.
- **Lens**: when the file carries correction data (most DNG files from phones and many converters), **Corrections** fixes distortion and corner darkening. Untick it to see the uncorrected image. **Vignette fix** brightens or darkens the corners by hand.
- **Reset** returns to the defaults; **Use camera JPEG** opens the small, already processed JPEG stored inside the file instead.
- **Open** develops the full image into a new 16 bits/channel document. Decoding and developing run in the background, so the window stays responsive; a 24 MP file usually takes a few seconds.

If Tintwork cannot decode a file's sensor data (an unusual camera or compression), it opens the camera's embedded JPEG instead and says so. That image is 8-bit and the develop settings do not apply. Batch processing develops RAW files with the settings you last used.

## Layered PSD files

- **Open** a `.psd` or `.psb` file to get its layers, names, opacity, visibility, blend modes, groups, clipping and layer masks, and adjustment layers that Tintwork also has (brightness/contrast, levels, curves, exposure, hue/saturation, invert). 16-bit files stay 16-bit.
- Some parts are converted: text, smart objects and fill or shape layers become pixel layers using the pixels stored in the file, and layer effects are left off. Blend modes Tintwork does not have use the closest match, and adjustment types it does not have are skipped. A notice lists everything that was converted. If the layers cannot be read, the flattened image stored in the file opens instead.
- **Export** (File ▸ Export layered PSD…, or PSD in the Export dialog) writes layers, groups, masks, clipping, blend modes, opacity, matching adjustment layers and a flattened copy for other apps. Layer styles are baked into their layer's pixels, text and live layers are written as pixels, and 3D LUT and white balance layers are left out (a notice says which). Batch processing can write PSD too.

## 16-bit editing

Open a 16-bit PNG, a 16-bit PSD or a camera RAW file, or choose Image ▸ Mode: 16 bits/channel. Painting, adjustments, filters, transforms, groups, masks and every layer style keep 16-bit precision. Export to PNG or PSD keeps 16 bits; JPEG and WebP are 8-bit.

## Large images and memory

Tintwork estimates how much memory a document needs (width × height × layers). Very large canvases show a warning; ones too big for the browser are refused, and an image that is too large to open is offered at a reduced size. Close unused tabs and flatten finished groups to save memory. Up to 16384 × 16384 pixels is supported.

## Performance and the rendering engine

View ▸ Rendering engine chooses WebGPU, WebGL2 or the CPU fallback. Help ▸ Run performance benchmark measures your hardware and reports the times. If something renders wrongly, switching to the CPU engine is the safest fallback.

## When something goes wrong

- Errors show a short message at the bottom of the window and your work is autosaved immediately. Reload the page and choose **Restore** if anything looks wrong.
- Files that cannot be read (damaged or unsupported) are reported by name; nothing else is changed.
- Recent files that were moved or deleted are removed from the list with a notice.

## Accessibility

Every control can be reached with the keyboard (Tab and Shift+Tab); the focused control has a visible outline. Buttons with only an icon have a spoken name. Dialogs open with the first field focused; Enter confirms and Esc cancels.
