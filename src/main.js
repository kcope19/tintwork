// Tintwork — an original, browser-based layered image editor (Canvas 2D).
import { floodMask, similarMask, histogram, runOp, channelHistograms, colorRangeMask, HUE_PRESETS, wbFromNeutral, parseCube } from './pixels.js';
import * as auto from './auto.js';
import { LOOKS, lookToLayers, normalizeLook } from './looks.js';
import { createCurvesEditor, identityCurves } from './curves-editor.js';
import { readAutosave, writeAutosave, clearAutosave, markAutosaveClean, listAutosaves, readImages, imageRef, deepRef, isDeepId, rawRef, isRawId, adoptImage, decodeImage, MAX_SLOTS } from './autosave.js';
import { makeSelection, shapeMask, rectMask, combine, invertSelection, selectionCanvas, selectionOutline, maskRegion, translateSelection } from './selection.js';
import * as ops from './ops.js';
import { ICONS } from './icons.js';
import { createEngine } from './gpu.js';
import { createWebGPUEngine, webgpuAvailable } from './webgpu.js';
import { runBenchmark, benchText, benchKinds, probeEngines, stackId, BENCH_SIZES, BENCH_OPS } from './bench.js';
import * as mesh from './mesh.js';
import * as seg from './segment.js';
import { FX_TYPES, FX_ORDER, defaultEffect, hasActiveStyles, normalizeStyles, renderStyled, effectStack, BODY_BLENDS } from './layerfx.js';
import { fsaSupported, pickOpen, pickSave, writeFile, ensurePermission, listRecent, addRecent, removeRecent, clearRecent, EXPORT_TYPES, putLink, getLink, deleteLink, newLinkId, pickRaw } from './files.js';
import { blendIndex, createDeep, cloneDeep, deepFromImageData, deepToImageData, reconcileDeep, compositeDeep, accToDeep, runDeep, DEEP_OPS } from './deep.js';
import { decodePNG, encodePNG, pngInfo } from './png.js';
import { srgbIccBytes } from './srgb-icc.js';
import { BUILTIN_PRESETS, RATIO_ONLY, allPresets, presetById, presetPixels, centredRatioRect, constrainRect, describePreset, saveCustomPreset, deleteCustomPreset, customPresets } from './presets.js';
import { applyExportSharpen, exportSharpOptionsHTML, exportSharpLabel, EXPORT_SHARP_PRESETS, scaledSharpParams } from './export-sharpen.js';
import { formatName, variantSize, uniqueNamer, zipFiles } from './batch.js';
import { IS_MAC, PLATFORM, primaryMod, keyLabel, platformText, comboOf, RESERVED } from './platform.js';
import { isRawName, isPsdName, isPsdBytes, readPSDAsync, writePSDAsync, openRawSession, setDevelopEnv, setDevelopEngine, developEngineInfo, getDevelopEnginePref, developBenchmark, RAW_EXTS, PSD_EXTS } from './codecs.js';
import { blendFromKey, decodeAdjustment, encodeAdjustment, BLEND_TO_PSD, ADJ_KEYS } from './psd.js';
import { DEFAULT_SETTINGS as RAW_DEFAULTS, cleanSettings as cleanRawSettings, curveIsIdentity, presetFile as rawPresetFile, parsePresetFile as parseRawPresetFile, affineCompose, profileDistortion, LOCAL_RANGES, MAX_LOCALS, MASK_OPS, MAX_PARTS } from './raw.js';

const APP = 'Tintwork';
const APP_VERSION = '1.16.0';
const PSD_TYPE = 'image/vnd.adobe.photoshop';
const PROJECT_FORMAT = 'tintwork-project';
const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const viewport = $('#viewport');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  tool: 'brush',
  zoom: 1, panX: 0, panY: 0,
  fg: '#e8553a', bg: '#ffffff',
  crop: null,         // pending crop rect (doc coords)
  hover: null,        // cursor position in doc coords
  opts: {
    brushSize: 24, brushHardness: 70, brushOpacity: 100, smoothing: 0,
    eraserSize: 40, eraserHardness: 50, eraserOpacity: 100,
    fillTolerance: 32, fillContiguous: true,
    textFont: 'system-ui', textSize: 64, textBold: true, textItalic: false, textAlign: 'left',
    sampleAll: true,
    selMode: 'new', objBrush: 24, objPaint: 'box', objRefine: true, uprightEdges: 'crop', wandTolerance: 32, wandContiguous: true, wandSampleAll: false, featherRadius: 8,
    cloneSize: 40, cloneHardness: 60, cloneOpacity: 100, cloneAligned: true,
    healSize: 40, healHardness: 80, healOpacity: 100, spotSize: 30, spotHardness: 80, spotOpacity: 100,
    xfKeepAspect: false, xfSkew: false,
    gradType: 'linear', gradColors: 'fg-bg', gradReverse: false, gradOpacity: 100,
    shapeKind: 'rect', shapeStyle: 'fill', shapeStroke: 8, shapeRadius: 0,
    toneSize: 60, toneHardness: 40, toneOpacity: 40, toneMode: 'dodge', toneRange: 'midtones',
    redeyeSize: 40, redeyeDarken: 60,
    liquifySize: 120, liquifyStrength: 50, liquifyMode: 'push',
    straightenCrop: true, lookIntensity: 100,
    cropPreset: '', cropDpi: 300, cropOrient: 'auto', cropResize: true, cropLockRatio: null, resizePreset: 'sq',
    crMode: 'sampled', crColor: null, crFuzziness: 40, refineSmooth: 0, refineShift: 0, refineFeather: 0,
  },
  selPreview: null,   // in-progress rectangle / lasso outline
  poly: null,         // in-progress polygonal lasso { pts, mode }
  cloneSrc: null, cloneOffset: null,
  xf: null,           // free-transform session (see startTransform)
  busy: 0,
};
let nextLayerId = 1;
let globalRev = 1;
let compDirty = true;
const comp = document.createElement('canvas');
const compCtx = comp.getContext('2d', { willReadFrequently: true });
// iOS Safari refuses canvases above ~16.7 MP and gets killed when total canvas memory runs high,
// so phones get a lower working-size cap and a shorter undo history.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const MAX_PIXELS = IS_IOS ? 16_000_000 : 64_000_000;
const WARN_PIXELS = 16_000_000;
const history = { entries: [], index: -1, limit: IS_IOS ? 24 : IS_TOUCH ? 36 : 60 };
// ---- Document tabs (v0.9) ----------------------------------------------------------------------------
// `state.doc` is the active document; assigning a new document opens it in a new tab after the current one.
// Each tab keeps its own undo history, saved/autosaved markers and view (zoom/pan); the globals below
// (history, cleanEntry, writtenEntry, state.zoom/pan) always hold the active tab's values.
const tabs = []; // { doc, entries, index, cleanEntry, writtenEntry, view }
let activeDoc = null;
function stashTab() {
  const t = tabs.find((x) => x.doc === activeDoc); if (!t) return null;
  Object.assign(t, { entries: history.entries, index: history.index, cleanEntry, writtenEntry, view: { zoom: state.zoom, panX: state.panX, panY: state.panY } });
  return t;
}
const tabDirty = (t) => t.cleanEntry ? t.entries[t.index] !== t.cleanEntry : t.index > 0;
function setActiveDoc(d) {
  if (d === activeDoc) return;
  if (activeDoc && autosaveTimer) autosaveNow(); // captures the outgoing tab's history synchronously
  const cur = stashTab();
  let t = d && tabs.find((x) => x.doc === d);
  if (d && !t) { t = { doc: d, entries: [], index: -1, cleanEntry: null, writtenEntry: null, view: null }; tabs.splice(cur ? tabs.indexOf(cur) + 1 : tabs.length, 0, t); }
  activeDoc = d;
  history.entries = t ? t.entries : []; history.index = t ? t.index : -1;
  cleanEntry = t ? t.cleanEntry : null; writtenEntry = t ? t.writtenEntry : null;
  if (t?.view) Object.assign(state, t.view);
  state.xf = null; state.mxf = null; state.crop = null; state.poly = null; state.selPreview = null; state.cloneSrc = null; state.cloneOffset = null;
  compDirty = true;
}
Object.defineProperty(state, 'doc', { get: () => activeDoc, set: setActiveDoc, enumerable: true }); // { width, height, layers: [], activeId, selection, name }
// Rendering engine (gpu.js) — View ▸ Rendering engine… chooses Auto / GPU / CPU (remembered per browser).
const ENGINE_KEY = 'tintwork.engine';
const readPref = (k, def) => { try { return localStorage.getItem(k) || def; } catch { return def; } };
const gfx = { pref: readPref(ENGINE_KEY, 'auto'), engine: null, reason: 'not started', path: 'cpu', notices: new Set(), frame: 0, linear: readPref('tintwork.linear', '0') === '1' };
// GPU memory budget for textures. iPhones share RAM between CPU and GPU and kill tabs early, so keep it small.
// Desktop budget scales with the reported device memory (Chrome/Edge: navigator.deviceMemory, capped at 8 GB).
const DEVICE_GB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
const GPU_BUDGET_MB = IS_IOS ? 384 : DEVICE_GB >= 8 ? 3072 : DEVICE_GB >= 4 ? 2048 : 1024;
// 16-bit documents keep layer data as Uint16 (8 bytes per pixel); only the newest steps keep 16-bit undo data.
const DEEP_HISTORY = IS_IOS ? 4 : 10;
const DEEP_LIMIT_MB = IS_IOS ? 512 : 3072;
/** Clamp a working size to the device's canvas budget, keeping the aspect ratio. */
function fitPixels(w, h, max = MAX_PIXELS) {
  if (w * h <= max) return { w, h, scaled: false };
  const k = Math.sqrt(max / (w * h));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)), scaled: true };
}
function sizeWarning(w, h, scaled, ow, oh) {
  const mp = (n) => (n / 1e6).toFixed(1);
  if (scaled) toast(`Image was ${ow}×${oh} (${mp(ow * oh)} MP) — scaled to ${w}×${h} to stay within this device's ${mp(MAX_PIXELS)} MP canvas limit.`, 6000);
  else if (w * h > WARN_PIXELS) toast(`Large image (${mp(w * h)} MP). Editing may be slow and phones (especially iPhone Safari) can run out of memory.`, 5000);
}
let clipboard = null;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
function ctxOf(c) { return c.getContext('2d', { willReadFrequently: true }); }

function createLayer(name, w, h, opts = {}) {
  const canvas = makeCanvas(w, h);
  return {
    id: nextLayerId++, name, canvas, visible: true, opacity: 1, blend: 'source-over',
    x: 0, y: 0, rev: ++globalRev, mask: null, editMask: false, ...opts,
  };
}
function touch(layer) { layer.rev = ++globalRev; compDirty = true; }
/** Canvas that defines a layer's geometry (adjustment layers are just a mask). */
const geomCanvas = (l) => (l.kind === 'adjust' || (l.kind === 'group' && l.mask) ? l.mask.canvas : l.canvas);
/** Turn a live text or live-filter layer into plain pixels (before painting, destructive filters…). */
function rasterize(l, why) {
  if (l?.kind === 'text') {
    delete l.kind; delete l.text; l.name = l.name.replace(/^Text: /, '') + ' (pixels)';
    if (why) toast(`Text layer converted to pixels for ${why}.`);
  } else if (l?.kind === 'smart') {
    delete l.kind; delete l.source; delete l.filters; delete l.fmask; delete l.editFMask; smartCache.delete(l.id);
    if (why) toast(`Live layer converted to pixels for ${why} (its filters are now baked in).`);
  }
}
function touchMask(layer) { if (layer.mask) layer.mask.rev = ++globalRev; compDirty = true; }
/** Canvas currently being edited on a layer: its mask (when targeted) or its pixels. */
/** Live-filter layers can target their filter mask (white = filters show). */
const editingFMask = (l = activeLayer()) => !!(l && l.kind === 'smart' && l.fmask && l.editFMask);
const editingMask = (l = activeLayer()) => !!(l && (editingFMask(l) || (l.mask && (l.editMask || l.kind === 'adjust' || l.kind === 'group'))));
const targetCanvas = (l = activeLayer()) => (editingFMask(l) ? l.fmask.canvas : editingMask(l) ? l.mask.canvas : l.canvas);
function touchTarget(l) {
  if (editingFMask(l)) { l.fmask.rev = ++globalRev; composeSmart(l, filteredSync(l)); }
  else if (editingMask(l)) touchMask(l); else touch(l);
}
/** Mask canvas: white with alpha = how much of the layer shows (255 = fully revealed). */
function makeMaskCanvas(w, h, reveal = true) {
  const c = makeCanvas(w, h);
  if (reveal) { const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  return c;
}
function cloneMask(m) { return m ? { ...m, canvas: cloneCanvas(m.canvas) } : null; }
const maskScratch = new WeakMap();
/** Layer pixels with its mask applied (or the raw canvas when there is no enabled mask). */
function renderSource(l) {
  if (!l.mask || !l.mask.enabled) return l.canvas;
  let c = maskScratch.get(l);
  if (!c || c.width !== l.canvas.width || c.height !== l.canvas.height) { c = makeCanvas(l.canvas.width, l.canvas.height); maskScratch.set(l, c); }
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, c.width, c.height);
  x.drawImage(l.canvas, 0, 0);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(l.mask.canvas, 0, 0);
  x.globalCompositeOperation = 'source-over';
  return c;
}
const luminance = (hex) => { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const doc = () => state.doc;
const activeLayer = () => state.doc?.layers.find((l) => l.id === state.doc.activeId);
const activeIndex = () => state.doc.layers.findIndex((l) => l.id === state.doc.activeId);

function rectIntersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}
/** Region of a layer (in layer pixel coords) that an operation should touch. */
function opRegion(layer) {
  const g = geomCanvas(layer), full = { x: 0, y: 0, w: g.width, h: g.height };
  const sel = doc().selection;
  if (!sel) return full;
  return rectIntersect(full, { x: sel.x - layer.x, y: sel.y - layer.y, w: sel.w, h: sel.h });
}
/** Restrict a layer-sized canvas to the selection (multiplies alpha by the selection mask). */
function maskBySelection(ctx, layer) {
  const sel = doc().selection;
  if (!sel) return;
  ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.globalAlpha = 1;
  ctx.drawImage(selectionCanvas(sel), -layer.x, -layer.y);
  ctx.restore();
}
function setSelection(sel, label) {
  doc().selection = sel; commit(label); requestRender(); buildOptionsBar();
}
/** Grow a layer's canvas so it covers the whole document (used before painting). */
function ensureCoversDoc(layer) {
  if (layer.kind === 'adjust' || layer.kind === 'group') return;
  const { width: W, height: H } = doc();
  const x0 = Math.min(0, layer.x), y0 = Math.min(0, layer.y);
  const x1 = Math.max(W, layer.x + layer.canvas.width), y1 = Math.max(H, layer.y + layer.canvas.height);
  if (x0 === layer.x && y0 === layer.y && x1 - x0 === layer.canvas.width && y1 - y0 === layer.canvas.height) return;
  const c = makeCanvas(x1 - x0, y1 - y0);
  c.getContext('2d').drawImage(layer.canvas, layer.x - x0, layer.y - y0);
  if (layer.mask) { // newly added area is revealed
    const m = makeMaskCanvas(x1 - x0, y1 - y0), mx = m.getContext('2d');
    mx.clearRect(layer.x - x0, layer.y - y0, layer.canvas.width, layer.canvas.height);
    mx.drawImage(layer.mask.canvas, layer.x - x0, layer.y - y0);
    layer.mask.canvas = m; touchMask(layer);
  }
  if (layer.kind === 'smart') { // grow the original pixels and the filter mask, then re-run the filters
    const grow = (src, reveal) => {
      const n = reveal ? makeMaskCanvas(x1 - x0, y1 - y0) : makeCanvas(x1 - x0, y1 - y0), nx = n.getContext('2d');
      if (reveal) nx.clearRect(layer.x - x0, layer.y - y0, src.width, src.height);
      nx.drawImage(src, layer.x - x0, layer.y - y0); return n;
    };
    layer.source = grow(layer.source, false);
    if (layer.fmask) { layer.fmask.canvas = grow(layer.fmask.canvas, true); layer.fmask.rev = ++globalRev; }
    layer.x = x0; layer.y = y0; composeSmart(layer, filteredSync(layer));
    return;
  }
  if (layer.deep) { layer.deepOX = (layer.deepOX || 0) + layer.x - x0; layer.deepOY = (layer.deepOY || 0) + layer.y - y0; }
  const sameRaw = layer.raw && layer.raw.rev === layer.rev, ox = x0 - layer.x, oy = y0 - layer.y;
  layer.canvas = c; layer.x = x0; layer.y = y0; touch(layer);
  if (layer.raw) trackRaw(layer, { a: 1, b: 0, c: 0, d: 1, e: ox, f: oy }, sameRaw); // grown with transparent edges
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------
function newDocument(width, height, background = 'white', name = 'Untitled') {
  const fit = fitPixels(width, height); sizeWarning(fit.w, fit.h, fit.scaled, width, height); width = fit.w; height = fit.h;
  const base = createLayer('Background', width, height);
  if (background !== 'transparent') {
    const c = base.canvas.getContext('2d');
    c.fillStyle = background === 'white' ? '#ffffff' : background === 'bg' ? state.bg : background;
    c.fillRect(0, 0, width, height);
  }
  state.doc = { width, height, layers: [base], activeId: base.id, selection: null, name };
  afterDocChange('New canvas');
}
function documentFromImage(img, name) {
  const ow = img.naturalWidth || img.width, oh = img.naturalHeight || img.height, fit = fitPixels(ow, oh);
  const base = createLayer('Background', fit.w, fit.h);
  const bc = base.canvas.getContext('2d'); bc.imageSmoothingQuality = 'high'; bc.drawImage(img, 0, 0, fit.w, fit.h);
  sizeWarning(fit.w, fit.h, fit.scaled, ow, oh);
  state.doc = { width: base.canvas.width, height: base.canvas.height, layers: [base], activeId: base.id, selection: null, name };
  afterDocChange('Open');
}
/** Open a 16-bit PNG as a 16 bits/channel document (false = too big, use the 8-bit path). */
function documentFromDeepPNG(buf, name, info) {
  const fit = fitPixels(info.width, info.height);
  if (fit.scaled || info.width * info.height * 8 > DEEP_LIMIT_MB * 1048576 / 2) {
    toast(`${name} is a 16-bit PNG but too large to edit at 16 bits/channel on this device; opening it as 8-bit.`, 6000);
    return false;
  }
  const p = decodePNG(buf), deep = createDeep(p.width, p.height, p.data);
  const base = createLayer('Background', p.width, p.height);
  setDeep(base, deep);
  sizeWarning(p.width, p.height, false, p.width, p.height);
  state.doc = { width: p.width, height: p.height, layers: [base], activeId: base.id, selection: null, name, depth: 16 };
  afterDocChange('Open');
  status(`Opened ${name} (${p.width}×${p.height}, 16 bits/channel)`);
  return true;
}
function afterDocChange(label) {
  history.entries = []; history.index = -1; cleanEntry = null;
  state.doc.slot ||= newSlot(); state.xf = null;
  state.crop = null; state.poly = null; state.selPreview = null; state.cloneSrc = null; state.cloneOffset = null;
  compDirty = true;
  commit(label);
  fitToScreen();
  $('#welcome').classList.add('hidden');
  updateAll();
}

// ---------------------------------------------------------------------------
// History (snapshot based; unchanged layer canvases are shared between steps)
// ---------------------------------------------------------------------------
function snapshot() {
  const prev = history.entries[history.index]?.snap;
  const d = doc();
  return {
    width: d.width, height: d.height, activeId: d.activeId, depth: d.depth || 8,
    selection: d.selection, // selections are immutable, so they can be shared
    layers: d.layers.map((l) => {
      const old = prev?.layers.find((p) => p.id === l.id && p.rev === l.rev);
      const oldMask = l.mask && prev?.layers.find((p) => p.id === l.id && p.mask && p.mask.rev === l.mask.rev)?.mask;
      const oldF = l.fmask && prev?.layers.find((p) => p.id === l.id && p.fmask && p.fmask.rev === l.fmask.rev)?.fmask;
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
        x: l.x, y: l.y, rev: l.rev, canvas: old ? old.canvas : cloneCanvas(l.canvas), editMask: l.editMask,
        kind: l.kind, adj: l.adj, text: l.text, // treated as immutable: edits replace the object
        parent: l.parent ?? null, clip: !!l.clip, styles: l.styles || null, collapsed: !!l.collapsed, look: l.look || null, // styles are immutable too
        ...(l.deep ? { deep: l.deep, deepRev: l.deepRev, deepOX: l.deepOX || 0, deepOY: l.deepOY || 0 } : {}), // 16-bit data is immutable too
        raw: l.raw || null, // RAW source + develop settings (immutable: re-develop and crop replace the object)
        mask: l.mask ? { enabled: l.mask.enabled, rev: l.mask.rev, canvas: oldMask ? oldMask.canvas : cloneCanvas(l.mask.canvas) } : null,
        ...(l.kind === 'smart' ? { // live filters: the source canvas and the filter list are immutable, so they are shared
          source: l.source, filters: l.filters, editFMask: l.editFMask,
          fmask: l.fmask ? { enabled: l.fmask.enabled, rev: l.fmask.rev, canvas: oldF ? oldF.canvas : cloneCanvas(l.fmask.canvas) } : null,
        } : {}),
      };
    }),
  };
}
function commit(label) {
  if (!doc()) return;
  if (state.xf) applyTransform(); // e.g. a Layers-panel change while transforming: finish the transform first
  history.entries.length = history.index + 1;
  history.entries.push({ label, snap: snapshot() });
  if (history.entries.length > history.limit) history.entries.shift();
  history.index = history.entries.length - 1;
  // 16-bit undo data costs 8 bytes/pixel per changed layer: older steps fall back to their 8-bit pixels
  for (let i = 0; i < history.entries.length - 1 - DEEP_HISTORY; i++) for (const L of history.entries[i].snap.layers) if (L.deep) L.deep = null;
  updateHistoryPanel();
  updateLayersPanel();
  scheduleHistogram();
  updateDocInfo();
}
function restore(i) {
  const e = history.entries[i];
  if (!e) return;
  const s = e.snap;
  state.doc.width = s.width; state.doc.height = s.height; state.doc.depth = s.depth || 8;
  state.doc.activeId = s.activeId;
  state.doc.selection = s.selection;
  state.doc.layers = s.layers.map((l) => ({ ...l, canvas: cloneCanvas(l.canvas), mask: cloneMask(l.mask), ...(l.kind === 'smart' ? { fmask: cloneMask(l.fmask) } : {}) }));
  state.poly = null; state.selPreview = null; state.xf = null;
  history.index = i;
  state.crop = null;
  compDirty = true;
  updateAll();
}
function undo() { if (state.mxf) { cancelMeshXf(); return; } if (state.xf) { cancelTransform(); return; } if (history.index > 0) { restore(history.index - 1); status(`Undo: ${history.entries[history.index + 1].label}`); } }
function redo() { if (history.index < history.entries.length - 1) { restore(history.index + 1); status(`Redo: ${history.entries[history.index].label}`); } }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let checker = null;
function checkerPattern() {
  if (checker) return checker;
  const c = makeCanvas(16, 16), x = c.getContext('2d');
  x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#6c6c6c'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  checker = vctx.createPattern(c, 'repeat');
  return checker;
}
function composite(target = comp, opts = {}) {
  const d = doc();
  if (target.width !== d.width || target.height !== d.height) { target.width = d.width; target.height = d.height; }
  const c = target === comp ? compCtx : target.getContext('2d');
  c.save();
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
  if (!opts.cpu && gfx.engine && gpuComposite(c, opts, target === comp)) { c.restore(); return target; }
  if (target === comp) gfx.path = 'cpu';
  if (opts.rect) { // dirty-rectangle update (brush strokes): redraw only the touched area of the composite
    const items = resolveItems(d, null);
    if (!items.some((it) => it.kind === 'passBegin')) {
      const r = opts.rect; c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip(); c.clearRect(r.x, r.y, r.w, r.h);
      drawItems(c, items, [''], opts); c.restore(); return target;
    }
  }
  c.clearRect(0, 0, d.width, d.height);
  if (opts.background) { c.fillStyle = opts.background; c.fillRect(0, 0, d.width, d.height); }
  drawItems(c, resolveItems(d, null), [opts.background || ''], opts);
  c.restore();
  return target;
}

// --- layer tree: groups, clipping masks and layer styles ------------------------------------
// d.layers stays one flat bottom → top list. l.parent is the id of the containing group (null = top
// level) and every group sits directly above its contents. resolveItems() turns the tree into a flat list of
// draw items that the CPU composite, both GPU engines and the 16-bit composite consume:
//  • pass-through groups with nothing of their own (100%, no mask / styles) are simply inlined, so the
//    layers inside blend with everything below, as expected;
//  • other groups are composited in isolation (CPU, cached by the contents' signatures) and drawn as one
//    layer with the group's opacity, blend mode and mask;
//  • a clipped layer (l.clip) shows only where its base (the nearest unclipped layer below it in the same
//    group) has pixels: its mask becomes own mask × base alpha and its opacity is multiplied by the base's;
//  • layers with styles are drawn from a padded, cached render of the layer + effects (mask baked in).
const isGroup = (l) => l?.kind === 'group';
const parentId = (l) => l?.parent ?? null;
const layerById = (d, id) => (id == null ? null : d.layers.find((l) => l.id === id) || null);
const childrenOf = (d, pid) => d.layers.filter((l) => (l.parent ?? null) === pid);
function descendantsOf(d, g) {
  const out = [], walk = (id) => { for (const l of d.layers) if ((l.parent ?? null) === id) { if (isGroup(l)) walk(l.id); out.push(l); } };
  walk(g.id); return out;
}
function ancestorsOf(d, l) { const out = []; let p = layerById(d, parentId(l)); while (p && out.length < 64) { out.push(p); p = layerById(d, parentId(p)); } return out; }
const blockOf = (d, l) => (isGroup(l) ? [...descendantsOf(d, l), l] : [l]);
/** Keep each group directly above its contents (bottom → top), preserving sibling order; drop dangling parents. */
function normalizeTree(d = doc()) {
  for (const l of d.layers) if (l.parent != null && !isGroup(layerById(d, l.parent))) l.parent = null;
  const out = [], seen = new Set(), walk = (pid) => { for (const l of childrenOf(d, pid)) { if (seen.has(l)) continue; seen.add(l); if (isGroup(l)) walk(l.id); out.push(l); } };
  walk(null);
  if (out.length === d.layers.length) d.layers = out;
}
/** Move l (a group moves with its contents) 'above' / 'below' ref, or 'into' the top of group ref. */
function placeLayer(d, l, ref, where) {
  if (!ref || ref === l || (isGroup(l) && descendantsOf(d, l).includes(ref))) return false;
  const block = blockOf(d, l), inBlock = new Set(block), rest = d.layers.filter((x) => !inBlock.has(x));
  let idx;
  if (where === 'into') { if (!isGroup(ref)) return false; l.parent = ref.id; idx = rest.indexOf(ref); }
  else if (where === 'above') { l.parent = parentId(ref); idx = rest.indexOf(ref) + 1; }
  else { l.parent = parentId(ref); idx = rest.indexOf(blockOf(d, ref).find((x) => !inBlock.has(x))); }
  if (idx < 0) return false;
  rest.splice(idx, 0, ...block); d.layers = rest; normalizeTree(d); return true;
}
/** Insert a new layer above the active one (inside the active group when a group is selected). */
function insertLayer(d, layer) {
  const a = activeLayer();
  if (!a) { d.layers.push(layer); return; }
  if (isGroup(a) && !a.collapsed) { layer.parent = a.id; d.layers.splice(d.layers.indexOf(a), 0, layer); }
  else { layer.parent = parentId(a); d.layers.splice(d.layers.indexOf(a) + 1, 0, layer); }
  normalizeTree(d);
}
const groupCache = new Map(), styleCache = new Map(), clipCache = new Map(), cpuMaskCache = new Map();
let fxVer = 0;
const volOf = (l) => (isVolatile(l) ? `:f${gfx.frame}` : '');
const maskOn = (l) => !!(l.mask && l.mask.enabled);
function maskItem(l) { return maskOn(l) ? { key: `m${l.id}:${l.mask.rev}${volOf(l)}`, slot: `m${l.id}`, canvas: l.mask.canvas, x: l.x, y: l.y } : null; }
/** src (at sx, sy) with mask m applied; nothing survives outside the mask's rectangle. */
function maskedCopy(src, sx, sy, m, into = null) {
  const c = into && into.width === src.width && into.height === src.height ? into : makeCanvas(src.width, src.height), x = c.getContext('2d');
  x.save(); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0);
  const mx = m.x - sx, my = m.y - sy, mw = m.canvas.width, mh = m.canvas.height;
  x.globalCompositeOperation = 'destination-in'; x.drawImage(m.canvas, mx, my); x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, c.width, Math.max(0, my)); x.clearRect(0, my + mh, c.width, c.height); x.clearRect(0, 0, Math.max(0, mx), c.height); x.clearRect(mx + mw, 0, c.width, c.height);
  x.restore(); return c;
}
function groupKey(d, g) { return `${d.width}x${d.height}|${descendantsOf(d, g).map(layerSignature).join('|')}`; }
/** The group's contents composited on their own (document-sized, cached). */
function groupCanvas(d, g) {
  const key = groupKey(d, g); let e = groupCache.get(g.id);
  if (e && e.key === key) return e;
  const c = e?.canvas && e.canvas.width === d.width && e.canvas.height === d.height ? e.canvas : makeCanvas(d.width, d.height);
  const x = c.getContext('2d'); x.save(); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, c.width, c.height);
  drawItems(x, resolveItems(d, g.id), [`g${g.id}`], { sync: true }); x.restore();
  e = { key, canvas: c, ver: ++fxVer }; groupCache.set(g.id, e); return e;
}
function styledOf(l, src, sx, sy, sig) {
  const key = `${sig}|${JSON.stringify(l.styles)}`; let e = styleCache.get(l.id);
  if (e && e.key === key) return e;
  const r = renderStyled(src, l.styles);
  e = { key, canvas: r ? r.canvas : null, x: sx + (r ? r.x : 0), y: sy + (r ? r.y : 0), ver: ++fxVer };
  styleCache.set(l.id, e); return e;
}
const pix = (o) => ({ kind: 'pixels', plain: false, ...o });
/** One draw item for a layer or an isolated group (null = nothing to draw). */
function leafItem(d, l) {
  const opacity = l.opacity;
  if (l.kind === 'adjust') return { kind: 'adjust', l, opacity, blend: l.blend, mask: maskItem(l), sig: layerSignature(l) };
  if (isGroup(l)) {
    const g = groupCanvas(d, l), blend = l.blend === 'pass-through' ? 'source-over' : l.blend;
    const sig = `G${l.id}:${g.ver}:${layerSignature(l)}`;
    if (hasActiveStyles(l.styles)) {
      const src = maskOn(l) ? maskedCopy(g.canvas, 0, 0, { canvas: l.mask.canvas, x: l.x, y: l.y }) : g.canvas;
      const st = styledOf(l, src, 0, 0, sig); if (!st.canvas) return null;
      const deepSrc = maskOn(l) ? null : styledDeepOf(st, l, g.canvas, 0, 0, () => deepGroupOf(d, l), src);
      return pix({ l, key: `s${l.id}:${st.ver}`, slot: `p${l.id}`, src: st.canvas, deepSrc, x: st.x, y: st.y, opacity, blend, mask: null, sig });
    }
    return pix({ l, key: `g${l.id}:${g.ver}`, slot: `p${l.id}`, src: g.canvas, x: 0, y: 0, opacity, blend, mask: maskItem(l), sig });
  }
  const sig = layerSignature(l);
  if (hasActiveStyles(l.styles)) {
    const fxSrc = renderSource(l), st = styledOf(l, fxSrc, l.x, l.y, sig); if (!st.canvas) return null;
    const deepSrc = l.kind ? null : styledDeepOf(st, l, l.canvas, l.x, l.y, () => deepOf(l), fxSrc);
    return pix({ l, key: `s${l.id}:${st.ver}`, slot: `p${l.id}`, src: st.canvas, deepSrc, x: st.x, y: st.y, opacity, blend: l.blend, mask: null, sig });
  }
  const deep = deepIfSynced(l), src = deep || l.canvas;
  return { kind: 'pixels', plain: true, l, key: `${deep ? 'd' : 'c'}${l.id}:${l.rev}${volOf(l)}`, slot: `p${l.id}`, src, x: l.x, y: l.y, opacity, blend: l.blend, mask: maskItem(l), sig };
}
/** Where a clipping base has pixels (lazy: only built when a clipped layer needs it). */
function clipBaseOf(d, l) {
  const sig = isGroup(l) ? `G${l.id}:${groupKey(d, l)}:${l.mask ? l.mask.rev + (l.mask.enabled ? 'e' : 'd') : '-'}` : layerSignature(l);
  return { l, opacity: l.opacity, sig, get: () => {
    if (isGroup(l)) { const g = groupCanvas(d, l).canvas; return { canvas: maskOn(l) ? maskedCopy(g, 0, 0, { canvas: l.mask.canvas, x: l.x, y: l.y }) : g, x: 0, y: 0 }; }
    if (l.kind === 'adjust') return maskOn(l) ? { canvas: l.mask.canvas, x: l.x, y: l.y } : null;
    return { canvas: renderSource(l), x: l.x, y: l.y };
  } };
}
function applyClip(d, it, l, base) {
  const r = it.kind === 'adjust' ? (it.mask ? { x: it.mask.x, y: it.mask.y, w: it.mask.canvas.width, h: it.mask.canvas.height } : { x: 0, y: 0, w: d.width, h: d.height })
    : { x: it.x, y: it.y, w: it.src.width, h: it.src.height };
  const key = `${r.x},${r.y},${r.w},${r.h}|${it.mask ? it.mask.key.replace(/:f\d+$/, '') + ':' + (it.mask.key.match(/:f\d+$/) ? gfx.frame : '') : '-'}|${base.sig}`;
  let e = clipCache.get(l.id);
  if (!e || e.key !== key) {
    const c = e?.canvas && e.canvas.width === r.w && e.canvas.height === r.h ? e.canvas : makeCanvas(r.w, r.h), x = c.getContext('2d');
    x.save(); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.clearRect(0, 0, r.w, r.h);
    if (it.mask) x.drawImage(it.mask.canvas, it.mask.x - r.x, it.mask.y - r.y); else { x.fillStyle = '#fff'; x.fillRect(0, 0, r.w, r.h); }
    const A = base.get();
    if (A) {
      const ax = A.x - r.x, ay = A.y - r.y, aw = A.canvas.width, ah = A.canvas.height;
      x.globalCompositeOperation = 'destination-in'; x.drawImage(A.canvas, ax, ay); x.globalCompositeOperation = 'source-over';
      x.clearRect(0, 0, r.w, Math.max(0, ay)); x.clearRect(0, ay + ah, r.w, r.h); x.clearRect(0, 0, Math.max(0, ax), r.h); x.clearRect(ax + aw, 0, r.w, r.h);
    }
    x.restore();
    e = { key, canvas: c, ver: ++fxVer }; clipCache.set(l.id, e);
  }
  it.mask = { key: `k${l.id}:${e.ver}`, slot: `k${l.id}`, canvas: e.canvas, x: r.x, y: r.y };
  it.opacity *= base.opacity; it.sig += `|clip(${base.sig})`;
  return it;
}
const passThroughInline = (l) => isGroup(l) && l.blend === 'pass-through' && l.opacity >= 1 && !maskOn(l) && !hasActiveStyles(l.styles);
/** Pass-through group with opacity < 100% or a mask: its contents act on what is below, and the result is
 * mixed back with the untouched backdrop by opacity × mask (passBegin … passEnd markers). */
const passThroughMixed = (l) => isGroup(l) && l.blend === 'pass-through' && !hasActiveStyles(l.styles) && (l.opacity < 1 || maskOn(l));
/**
 * Flatten the tree under pid into draw items (bottom → top). mk.groups: isolated groups become
 * groupBegin … groupEnd markers instead of one cached 8-bit canvas (16-bit GPU display and 16-bit export).
 */
function resolveItems(d, pid, mk = {}) {
  if (pid == null) pruneFxCaches(d);
  const items = []; let base = null;
  for (const l of childrenOf(d, pid)) {
    const vis = l.visible && l.opacity > 0;
    if (l.clip && base) {
      if (!base.vis || !vis) continue;
      const it = leafItem(d, l); if (it) items.push(applyClip(d, it, l, base.clip));
      continue;
    }
    base = { vis, clip: clipBaseOf(d, l) };
    if (!vis) continue;
    if (passThroughInline(l)) { items.push(...resolveItems(d, l.id, mk)); continue; }
    if (passThroughMixed(l)) {
      const sig = layerSignature(l);
      items.push({ kind: 'passBegin', l, sig: `P${sig}` }, ...resolveItems(d, l.id, mk), { kind: 'passEnd', l, opacity: l.opacity, blend: 'source-over', mask: maskItem(l), sig: `/P${sig}` });
      continue;
    }
    if (mk.groups && isGroup(l) && !hasActiveStyles(l.styles)) {
      const sig = layerSignature(l), blend = l.blend === 'pass-through' ? 'source-over' : l.blend;
      items.push({ kind: 'groupBegin', l, sig: `B${sig}` }, ...resolveItems(d, l.id, mk), { kind: 'groupEnd', l, opacity: l.opacity, blend, mask: maskItem(l), sig: `/B${sig}` });
      continue;
    }
    const it = leafItem(d, l); if (it) items.push(it);
  }
  return items;
}
function pruneFxCaches(d) {
  if (groupCache.size + styleCache.size + clipCache.size + cpuMaskCache.size < 8) return;
  const ids = new Set(d.layers.map((l) => l.id));
  for (const m of [groupCache, styleCache, clipCache]) for (const k of m.keys()) if (!ids.has(k)) m.delete(k);
  for (const k of cpuMaskCache.keys()) if (!ids.has(+String(k).slice(1))) cpuMaskCache.delete(k);
}
/** Canvas 2D composite of draw items (used by the CPU engine and inside isolated groups). */
// Big layers are drawn only over their opaque bounds. The bounds are measured the second time a layer is drawn
// unchanged (so a layer being painted does not pay for the scan on every stroke) and cached per revision.
const boundsCache = new WeakMap();
const SOURCE_ONLY_BLENDS = new Set(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'lighter']);
function drawBounds(l) {
  const cv = l.canvas; if (!cv || cv.width * cv.height < 4_000_000) return undefined;
  let e = boundsCache.get(cv);
  if (!e || e.rev !== l.rev || e.w !== cv.width || e.h !== cv.height) { boundsCache.set(cv, { rev: l.rev, w: cv.width, h: cv.height, seen: 1 }); return undefined; }
  if (e.b === undefined) { if (e.seen++ < 1) return undefined; e.b = alphaBounds(cv); }
  return e.b;
}
function drawItems(c, items, below, opts) {
  const stack = [];
  for (const it of items) {
    if (it.kind === 'passBegin') { stack.push(cloneCanvas(c.canvas)); below.push(it.sig); continue; }
    if (it.kind === 'passEnd') { mixPassThrough(c, stack.pop(), it); below.push(it.sig); continue; }
    if (it.kind === 'adjust') drawAdjustmentLayer(c, it.l, below.join('|'), opts, it);
    else {
      let src;
      if (it.plain && (!it.mask || it.mask.slot === `m${it.l.id}`)) src = renderSource(it.l);
      else if (it.mask) {
        const ck = `${it.key}|${it.mask.key}`; let e = cpuMaskCache.get(it.slot);
        if (!e || e.key !== ck) { e = { key: ck, canvas: maskedCopy(it.plain ? it.l.canvas : it.src, it.x, it.y, it.mask, e?.canvas) }; cpuMaskCache.set(it.slot, e); }
        src = e.canvas;
      } else src = it.src;
      c.globalAlpha = it.opacity; c.globalCompositeOperation = it.blend;
      const b = !opts.rect && src === it.l.canvas ? drawBounds(it.l) : undefined;
      if (b === null) { /* fully transparent: nothing to draw */ } else if (it.blend === 'exclusion' && exactBlendOK(c)) exclusionExact(c, src, Math.round(it.x), Math.round(it.y), it.opacity, opts.rect);
      else if (b && SOURCE_ONLY_BLENDS.has(it.blend)) c.drawImage(src, b.x, b.y, b.w, b.h, it.x + b.x, it.y + b.y, b.w, b.h);
      else c.drawImage(src, it.x, it.y);
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    }
    below.push(it.sig);
  }
}

// v1.8: the browser's 8-bit 'exclusion' rounds its intermediates (up to 1.76/255 off the W3C formula), so it is
// blended in software: B(b, s) = b + s − 2bs, composited with source-over alpha (W3C Compositing Level 1, §5.8).
const exactBlendOK = (c) => { const m = c.getTransform?.(); return !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0); };
function exclusionExact(c, src, x, y, opacity, rect) {
  const W = c.canvas.width, H = c.canvas.height;
  let x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + src.width), y1 = Math.min(H, y + src.height);
  if (rect) { x0 = Math.max(x0, Math.floor(rect.x)); y0 = Math.max(y0, Math.floor(rect.y)); x1 = Math.min(x1, Math.ceil(rect.x + rect.w)); y1 = Math.min(y1, Math.ceil(rect.y + rect.h)); }
  const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0) return;
  let sc = src.getContext ? src : null;
  if (!sc) { sc = makeCanvas(w, h); sc.getContext('2d').drawImage(src, x - x0, y - y0); }
  const s = (sc === src ? ctxOf(src).getImageData(x0 - x, y0 - y, w, h) : sc.getContext('2d').getImageData(0, 0, w, h)).data;
  const img = c.getImageData(x0, y0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const as = (s[i + 3] / 255) * opacity; if (as <= 0) continue;
    const ab = d[i + 3] / 255, ao = as + ab * (1 - as);
    for (let k = 0; k < 3; k++) {
      const cs = s[i + k] / 255, cb = d[i + k] / 255, B = cb + cs - 2 * cb * cs;
      d[i + k] = Math.round(((as * (1 - ab) * cs + as * ab * B + (1 - as) * ab * cb) / ao) * 255);
    }
    d[i + 3] = Math.round(ao * 255);
  }
  c.putImageData(img, x0, y0);
}
/** out = backdrop·(1−k) + result·k with k = opacity × mask (exact lerp; 'lighter' adds the two parts). */
function mixPassThrough(c, backdrop, it) {
  const W = c.canvas.width, H = c.canvas.height, K = makeCanvas(W, H), kx = K.getContext('2d');
  kx.globalAlpha = it.opacity;
  if (it.mask) kx.drawImage(it.mask.canvas, it.mask.x, it.mask.y); else { kx.fillStyle = '#000'; kx.fillRect(0, 0, W, H); }
  const R = cloneCanvas(c.canvas), rx = R.getContext('2d');
  rx.globalCompositeOperation = 'destination-in'; rx.drawImage(K, 0, 0);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'copy'; c.drawImage(backdrop, 0, 0);
  c.globalCompositeOperation = 'destination-out'; c.drawImage(K, 0, 0);
  c.globalCompositeOperation = 'lighter'; c.drawImage(R, 0, 0); c.restore();
}
// --- 3D LUTs (.cube): tables live in a registry keyed by id so adjustment params stay small ----
const lutRegistry = new Map();
function lutStoreLoad() { try { const o = JSON.parse(localStorage.getItem('tintwork.luts') || '{}'); for (const [id, v] of Object.entries(o)) if (!lutRegistry.has(id)) lutRegistry.set(id, lutDecode(v)); } catch { /* ignore */ } }
function lutStoreSave() {
  try { const o = {}; for (const [id, t] of [...lutRegistry].slice(-6)) o[id] = lutEncode(t); localStorage.setItem('tintwork.luts', JSON.stringify(o)); } catch { /* quota: LUTs stay in the project file */ }
}
function lutEncode(t) {
  const b = new Uint8Array(t.data.buffer.slice(0)); let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return { size: t.size, title: t.title || '', domainMin: t.domainMin, domainMax: t.domainMax, data: btoa(bin) };
}
function lutDecode(v) {
  const bin = atob(v.data), b = new Uint8Array(bin.length); for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i);
  return { size: v.size, title: v.title, domainMin: v.domainMin || [0, 0, 0], domainMax: v.domainMax || [1, 1, 1], data: new Float32Array(b.buffer) };
}
function lutId(t) { let h = 2166136261; const u = new Uint32Array(t.data.buffer); for (let i = 0; i < u.length; i += 7) { h ^= u[i]; h = Math.imul(h, 16777619); } return `lut${t.size}-${(h >>> 0).toString(36)}`; }
function registerLut(t) { const id = lutId(t); lutRegistry.set(id, t); lutStoreSave(); return id; }
/** Adjustment params as the pixel code needs them (3D LUT layers get their table). */
function adjParamsOf(adj) {
  const p = adj.params || {};
  return adj.type === 'lut3d' ? { ...p, table: lutRegistry.get(p.lut) || null } : p;
}
// --- adjustment layers: re-applied to everything below them on each composite ----
// Results are cached per layer, keyed by a signature of the layers underneath, so
// painting above an adjustment layer costs nothing extra. Big documents compute in
// the pixel worker (showing the previous result until the new one is ready).
const ADJ_LAYER = {
  brightnessContrast: 'Brightness / contrast', hueSaturation: 'Hue / saturation', exposure: 'Exposure',
  levels: 'Levels', curves: 'Curves', invert: 'Invert', grayscale: 'Grayscale',
  whiteBalance: 'White balance', lut3d: 'Color lookup (3D LUT)',
};
const ADJ_SYNC_PIXELS = 2_500_000;
// Interactive preview: while an adjustment slider moves on a big document, adjustment layers are computed on a
// ~2 MP proxy (about screen size) and the full-resolution result follows in the worker once the slider rests.
const PROXY_PIXELS = 2_000_000;
let adjProxyUntil = 0, adjProxyTimer = 0;
const adjInteractive = (ms = 220) => { adjProxyUntil = performance.now() + ms; };
let compRect = null; // pending dirty rectangle of the composite (CPU path), in document pixels
function addCompRect(x, y, w, h) {
  const d = doc(); if (!d) return;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(d.width, Math.ceil(x + w)), y1 = Math.min(d.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  if (!compRect) compRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  else { const a = Math.min(compRect.x, x0), b = Math.min(compRect.y, y0); compRect = { x: a, y: b, w: Math.max(compRect.x + compRect.w, x1) - a, h: Math.max(compRect.y + compRect.h, y1) - b }; }
}
const adjCache = new Map();
let adjPending = 0;
let adjScratch = null;
function layerSignature(l) {
  return `${l.id}:${l.rev}:${l.visible ? 1 : 0}:${l.opacity}:${l.blend}:${l.x},${l.y}:${l.mask ? `${l.mask.rev}${l.mask.enabled ? 'e' : 'd'}` : '-'}${l.kind === 'adjust' ? ':' + JSON.stringify(l.adj) : ''}${l.clip ? ':clip' : ''}:${l.parent ?? ''}${l.styles ? ':' + JSON.stringify(l.styles) : ''}`;
}
function putInto(canvas, img) {
  if (!canvas || canvas.width !== img.width || canvas.height !== img.height) canvas = makeCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
function drawAdjustmentLayer(c, l, below, opts, it = null) {
  const op = it ? it.opacity : l.opacity, bl = it ? it.blend : l.blend;
  const mk = it ? it.mask : l.mask && l.mask.enabled ? { canvas: l.mask.canvas, x: l.x, y: l.y } : null;
  const d = doc(), W = d.width, H = d.height;
  const key = `${W}x${H}|${below}|${JSON.stringify(l.adj)}`;
  let e = adjCache.get(l.id); if (!e) { e = { key: null, canvas: null, running: false }; adjCache.set(l.id, e); }
  const R = opts.rect;
  let proxy = null; // a reduced-size result shown while a slider is being dragged on a big document
  if (R && e.key !== key && e.canvas && e.canvas.width === W && e.canvas.height === H) {
    // only the dirty rectangle changed below: patch the cached result there (synchronously; adjustments are per-pixel)
    const img = c.getImageData(R.x, R.y, R.w, R.h); runOp(l.adj.type, img, adjParamsOf(l.adj));
    e.canvas.getContext('2d').putImageData(img, R.x, R.y); e.key = key; if (e.proxy) e.proxy = null;
  } else if (e.key !== key && !opts.sync && !R && W * H > ADJ_SYNC_PIXELS && performance.now() < adjProxyUntil) {
    if (e.proxy?.key !== key) {
      const k = Math.min(1, Math.sqrt(PROXY_PIXELS / (W * H))), pw = Math.max(1, Math.round(W * k)), ph = Math.max(1, Math.round(H * k));
      const pc = e.proxy?.canvas?.width === pw && e.proxy.canvas.height === ph ? e.proxy.canvas : makeCanvas(pw, ph), px = pc.getContext('2d');
      px.globalCompositeOperation = 'copy'; px.drawImage(c.canvas, 0, 0, pw, ph);
      const img = px.getImageData(0, 0, pw, ph); runOp(l.adj.type, img, adjParamsOf(l.adj)); px.putImageData(img, 0, 0);
      e.proxy = { key, canvas: pc };
    }
    proxy = e.proxy.canvas;
    clearTimeout(adjProxyTimer); adjProxyTimer = setTimeout(() => { compDirty = true; requestRender(); }, Math.max(0, adjProxyUntil - performance.now()) + 20);
  } // after the drag the full-size job starts below; the preview stays on screen until it lands
  if (!proxy && e.key !== key) {
    if (!opts.sync && W * H > ADJ_SYNC_PIXELS && ops.workerStatus().available) {
      if (!e.running) {
        e.running = true; adjPending++;
        const img = c.getImageData(0, 0, W, H);
        ops.process(l.adj.type, img, adjParamsOf(l.adj)).then((out) => { e.canvas = putInto(e.canvas, out); e.key = key; })
          .catch((err) => status(`Adjustment layer failed: ${err.message}`))
          .finally(() => { e.running = false; adjPending--; compDirty = true; requestRender(); });
      }
      if (e.proxy?.key === key) proxy = e.proxy.canvas;
      else if (!e.canvas || e.canvas.width !== W || e.canvas.height !== H) return; // first result not ready yet
    } else {
      const img = c.getImageData(0, 0, W, H);
      runOp(l.adj.type, img, adjParamsOf(l.adj));
      e.canvas = putInto(e.canvas, img); e.key = key;
    }
  }
  if (!mk && op >= 1 && bl === 'source-over') { // the cached result already is "below, adjusted": just copy it in
    c.save(); c.globalAlpha = 1; c.globalCompositeOperation = 'copy';
    if (proxy) { c.imageSmoothingQuality = 'medium'; c.drawImage(proxy, 0, 0, W, H); } else c.drawImage(e.canvas, 0, 0);
    c.restore(); return;
  }
  if (!adjScratch || adjScratch.width !== W || adjScratch.height !== H) adjScratch = makeCanvas(W, H);
  const sx = adjScratch.getContext('2d');
  sx.save(); if (R) { sx.beginPath(); sx.rect(R.x, R.y, R.w, R.h); sx.clip(); }
  sx.globalAlpha = 1; sx.globalCompositeOperation = 'copy';
  if (proxy) { sx.imageSmoothingQuality = 'medium'; sx.drawImage(proxy, 0, 0, W, H); } else sx.drawImage(e.canvas, 0, 0);
  const masked = !!mk;
  if (masked) {
    sx.globalCompositeOperation = 'destination-in'; sx.drawImage(mk.canvas, mk.x, mk.y);
    sx.globalCompositeOperation = 'source-over';
    const mx = mk.x, my = mk.y, mw = mk.canvas.width, mh = mk.canvas.height; // nothing outside the mask
    sx.clearRect(0, 0, W, Math.max(0, my)); sx.clearRect(0, my + mh, W, H); sx.clearRect(0, 0, Math.max(0, mx), H); sx.clearRect(mx + mw, 0, W, H);
  }
  sx.restore();
  c.save(); c.globalAlpha = op;
  if (bl === 'source-over') {
    // result = below × (1 − k) + adjusted × k, with k = mask × opacity (exact on premultiplied pixels)
    c.globalCompositeOperation = 'destination-out';
    if (masked) c.drawImage(mk.canvas, mk.x, mk.y); else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    c.globalCompositeOperation = 'lighter';
  } else c.globalCompositeOperation = bl;
  c.drawImage(adjScratch, 0, 0);
  c.restore();
}
// ---------------------------------------------------------------------------
// GPU engine glue. Every GPU job has a CPU fallback: unsupported, too large, out of budget or a lost
// context all drop back to the Canvas 2D / worker path (with a one-time notice).
// ---------------------------------------------------------------------------
let engineGen = 0;
/**
 * Pick the rendering engine. Automatic mode measures instead of guessing: a quick probe (1 MP blur + curves +
 * 4-layer composite, ~1–2 s, once per browser + graphics stack + version, cached in localStorage) times the CPU,
 * WebGL2 and WebGPU engines and the fastest wins (a GPU within 10% of the best is preferred). 'webgpu' and 'gpu'
 * (WebGL2) force that engine even on a software renderer. Start-up is asynchronous: the CPU path renders until
 * the engine is ready. Returns a promise that resolves once the final engine is in place.
 */
const ENGINE_NAMES = { cpu: 'CPU', webgl: 'WebGL2', webgpu: 'WebGPU' };
const PROBE_KEY = 'tintwork.engineProbe';
function initEngine() {
  const gen = ++engineGen;
  if (gfx.engine) { try { gfx.engine.destroy(); } catch { /* already gone */ } }
  gfx.engine = null; ops.setAccelerator(null); gfx.path = 'cpu'; gfx.notices.clear(); gfx.webgpuReason = ''; gfx.asyncFailed = false;
  if (gfx.pref === 'cpu') { gfx.reason = 'CPU engine selected'; compDirty = true; updateDocInfo(); return (gfx.ready = Promise.resolve(null)); }
  if (gfx.pref === 'gpu') { initWebGL(); return (gfx.ready = Promise.resolve(gfx.engine)); }
  if (gfx.pref === 'webgpu') return (gfx.ready = startWebGPU(gen));
  gfx.reason = 'measuring engines…'; updateDocInfo();
  gfx.ready = (async () => {
    let choice = 'cpu';
    try { choice = await autoChoice(gen); } catch (err) { console.warn('engine probe failed', err); }
    if (gen !== engineGen) return gfx.engine;
    const p = gfx.probe, ms = (k) => (p?.ms?.[k] != null ? `${p.ms[k]} ms` : p?.errors?.[k] ? 'unavailable' : '—');
    const summary = `probe: CPU ${ms('cpu')}, WebGL2 ${ms('webgl')}, WebGPU ${ms('webgpu')}`;
    if (choice !== 'webgpu') gfx.webgpuReason = p?.errors?.webgpu || `slower than ${ENGINE_NAMES[choice]} in the speed probe${p?.info?.webgpu?.software ? ' (software adapter)' : ''} — ${summary}`;
    if (choice === 'webgpu') return startWebGPU(gen, summary);
    if (choice === 'webgl') { initWebGL(); if (!gfx.engine) gfx.reason += ` (${summary})`; requestRender(); return gfx.engine; }
    gfx.reason = `automatic: the CPU engine was fastest here (${summary})`; compDirty = true; requestRender(); updateDocInfo();
    return null;
  })();
  return gfx.ready;
}
/** Cached or freshly measured automatic choice: 'webgpu' | 'webgl' | 'cpu'. */
async function autoChoice(gen) {
  const id = await stackId(APP_VERSION);
  try { const c = JSON.parse(localStorage.getItem(PROBE_KEY) || 'null'); if (c && c.id === id) { gfx.probe = { ...c, cached: true }; return c.choice; } } catch { /* ignore */ }
  const curves = defaultAdjParams('curves'); curves.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
  const r = await probeEngines({ curves, budgetMB: Math.min(GPU_BUDGET_MB, 1024), keepWinner: false });
  const c = { id, choice: r.choice, ms: r.ms, info: r.info, errors: r.errors, at: r.at };
  if (gen === engineGen) { gfx.probe = c; try { localStorage.setItem(PROBE_KEY, JSON.stringify(c)); } catch { /* ignore */ } }
  return r.choice;
}
function startWebGPU(gen, why = '') {
  gfx.reason = 'starting WebGPU…'; updateDocInfo();
  return (async () => {
    let e;
    try { e = await createWebGPUEngine({ budgetMB: GPU_BUDGET_MB, tile: 4096, onLost: onGpuLost }); } catch (err) { e = { error: err?.message || String(err) }; }
    if (gen !== engineGen) { if (!e.error) e.destroy(); return gfx.engine; }
    if (e.error) {
      gfx.webgpuReason = e.error;
      if (gfx.pref === 'webgpu') { toast(`WebGPU unavailable (${e.error}) — using the CPU engine.`, 5000); gfx.reason = e.error; compDirty = true; requestRender(); updateDocInfo(); return null; }
      initWebGL(); requestRender(); return gfx.engine;
    }
    gfx.engine = e; ops.setAccelerator(e); gfx.reason = why;
    smartCache.clear(); compDirty = true; requestRender(); updateDocInfo();
    return e;
  })();
}
/** WebGL2 engine (automatic choice or forced by pref 'gpu'). */
function initWebGL() {
  let e;
  try { e = createEngine({ budgetMB: Math.min(GPU_BUDGET_MB, IS_IOS ? 384 : 2048), tile: IS_IOS ? 2048 : 4096, onLost: onGpuLost }); }
  catch (err) { e = { error: err?.message || String(err) }; }
  if (e.error) {
    gfx.reason = e.error;
    if (gfx.pref === 'gpu') toast(`GPU engine unavailable (${e.error}) — using the CPU engine.`, 5000);
  } else { gfx.engine = e; ops.setAccelerator(e); gfx.reason = ''; }
  compDirty = true; updateDocInfo();
}
function onGpuLost() {
  gfx.engine = null; ops.setAccelerator(null); gfx.reason = 'GPU context lost'; gfx.path = 'cpu';
  toast('The GPU stopped responding (context lost) — switched to the CPU engine. View ▸ Rendering engine… can retry.', 6000);
  compDirty = true; requestRender(); updateDocInfo();
}
function setEnginePref(p) {
  gfx.pref = p; try { localStorage.setItem(ENGINE_KEY, p); } catch { /* private mode */ }
  smartCache.clear();
  const done = initEngine().then(() => { for (const l of doc()?.layers || []) if (l.kind === 'smart') composeSmart(l, filteredSync(l)); requestRender(); return gfx.engine; });
  for (const l of doc()?.layers || []) if (l.kind === 'smart') composeSmart(l, filteredSync(l));
  requestRender();
  return done;
}
function gpuNotice(key, msg) { if (gfx.notices.has(key)) return; gfx.notices.add(key); toast(msg, 5000); status(msg); }
/** Layers being edited right now are re-uploaded every frame (their canvas changes between revisions). */
const isVolatile = (l) => !!(drag || state.xf) && l.id === doc().activeId;
function gpuLayerList(d) {
  return resolveItems(d, null, { groups: d.depth === 16 }).map((it) => {
    if (it.kind === 'groupBegin' || it.kind === 'passBegin') return { kind: it.kind };
    if (it.kind === 'groupEnd' || it.kind === 'passEnd') return { kind: it.kind, opacity: it.opacity, mode: blendIndex(it.blend), mask: it.mask };
    if (it.kind === 'adjust') return { kind: 'adjust', op: it.l.adj.type, params: adjParamsOf(it.l.adj), opacity: it.opacity, mode: blendIndex(it.blend), mask: it.mask };
    const src = d.depth === 16 && it.deepSrc ? it.deepSrc : it.src;
    return { kind: 'pixels', key: src === it.src ? it.key : `${it.key}D`, slot: it.slot, src, x: it.x, y: it.y, w: src.width, h: src.height, opacity: it.opacity, mode: blendIndex(it.blend), mask: it.mask };
  });
}
function gpuComposite(c, opts, display) {
  const d = doc(), e = gfx.engine; if (!e || e.lost) return false;
  gfx.frame++;
  const layers = gpuLayerList(d), big = d.width > e.info.maxTextureSize || d.height > e.info.maxTextureSize;
  if (!e.canComposite(layers, d.width, d.height)) {
    gpuNotice(`size:${d.width}x${d.height}`, big ? `This canvas (${d.width}×${d.height}) is larger than this GPU's texture limit (${e.info.maxTextureSize}px), so it is composited on the CPU.`
      : `${d.width}×${d.height} does not fit this device's GPU memory budget (${e.budgetMB} MB), so it is composited on the CPU.`);
    return false;
  }
  const copts = { background: opts.background ? hexToRgb(opts.background) : null, dither: d.depth === 16 };
  if (e.kind === 'webgpu' && !e.syncOutput) {
    if (gfx.asyncFailed) return false;
    // WebGPU without canvas presentation: the display composite is asynchronous (the previous frame stays
    // up until it lands); other callers (export, flatten…) need pixels now and use the CPU.
    if (!display) return false;
    asyncComposite(e, layers, d.width, d.height, copts);
    return true;
  }
  try {
    const fmt = e.composite(layers, d.width, d.height, c, copts);
    if (fmt === 'rgba8') gpuNotice(`acc8:${d.width}x${d.height}`, 'Large canvas: GPU compositing runs at 8-bit precision to fit in GPU memory.');
    if (display) gfx.path = fmt === 'rgba8' ? 'gpu-8' : 'gpu';
    return true;
  } catch (err) {
    console.warn('GPU composite failed; using the CPU', err);
    if (err.code === 'memory') gpuNotice(`mem:${d.width}x${d.height}`, `GPU memory budget exceeded, so this canvas is composited on the CPU. (${err.message})`);
    else if (err.code !== 'lost') gpuNotice(`err:${err.message}`, `GPU compositing failed (${err.message}); using the CPU.`);
    return false;
  }
}
let asyncJob = null, asyncAgain = null;
/** Run a WebGPU display composite off the critical path; coalesces requests that arrive while one runs. */
function asyncComposite(e, layers, W, H, copts) {
  if (asyncJob) { asyncAgain = [e, layers, W, H, copts]; return; }
  const buf = makeCanvas(W, H);
  asyncJob = e.compositeAsync(layers, W, H, buf.getContext('2d'), copts).then((fmt) => {
    if (gfx.engine !== e || doc()?.width !== W || doc()?.height !== H) return;
    compCtx.save(); compCtx.globalCompositeOperation = 'copy'; compCtx.drawImage(buf, 0, 0); compCtx.restore();
    gfx.path = fmt === 'rgba8' ? 'gpu-8' : 'gpu'; gfx.asyncFrames = (gfx.asyncFrames || 0) + 1;
    if (fmt === 'rgba8') gpuNotice(`acc8:${W}x${H}`, 'Large canvas: GPU compositing runs at 8-bit precision to fit in GPU memory.');
    requestRender();
  }).catch((err) => {
    if (gfx.engine !== e) { compDirty = true; requestRender(); return; } // engine was switched or shut down mid-frame: not an error
    console.warn('WebGPU composite failed; using the CPU', err);
    if (err.code === 'memory') gpuNotice(`mem:${W}x${H}`, `GPU memory budget exceeded, so this canvas is composited on the CPU. (${err.message})`);
    else if (err.code !== 'lost') gpuNotice(`err:${err.message}`, `GPU compositing failed (${err.message}); using the CPU.`);
    gfx.asyncFailed = true; compDirty = true; requestRender();
  }).finally(() => {
    asyncJob = null;
    if (asyncAgain) { const a = asyncAgain; asyncAgain = null; asyncComposite(...a); }
  });
}
/** Resolves when no asynchronous GPU composite is pending. */
const compositeSettled = async () => { while (asyncJob) await asyncJob; };
/** Live filters on the GPU (null = not possible, use the CPU). */
function gpuFilter(l, filters) {
  const e = gfx.engine; if (!e || e.lost || (e.kind === 'webgpu' && !e.syncOutput)) return null;
  const chain = filters.filter((f) => f.enabled).map((f) => ({ name: f.type, params: filterParams(f) }));
  if (!chain.every((f) => e.supports(f.name, l.source.width, l.source.height))) return null;
  try { return e.filterCanvas(l.source, chain, filterInfo(l)); } catch (err) { console.warn('GPU filter failed; using the CPU', err); return null; }
}

// --- 16-bit layer data ------------------------------------------------------------------------
// l.deep (DImage) holds 16-bit pixels; l.canvas is always its rounded 8-bit proxy. l.deepRev === l.rev
// means the two are in step. After an 8-bit edit (brush, transform…) deepOf() reconciles them: untouched
// pixels keep 16 bits, edited ones take the 8-bit value. l.deepOX/OY = offset of l.deep inside the canvas.
const is16 = () => doc()?.depth === 16;
const deepIfSynced = (l) => (is16() && l.deep && l.deepRev === l.rev && !l.kind ? l.deep : null);
function deepOf(l) {
  if (l.kind) return deepFromImageData(ctxOf(l.canvas).getImageData(0, 0, l.canvas.width, l.canvas.height)); // text / live layers stay 8-bit
  if (l.deep && l.deepRev === l.rev && !l.deepOX && !l.deepOY && l.deep.width === l.canvas.width && l.deep.height === l.canvas.height) return l.deep;
  const img = ctxOf(l.canvas).getImageData(0, 0, l.canvas.width, l.canvas.height);
  const d = reconcileDeep(l.deep || null, l.deepOX || 0, l.deepOY || 0, img);
  l.deep = d; l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0;
  return d;
}
function setDeep(l, d) {
  if (l.canvas.width !== d.width || l.canvas.height !== d.height) l.canvas = makeCanvas(d.width, d.height);
  ctxOf(l.canvas).putImageData(deepToImageData(d), 0, 0); touch(l);
  l.deep = d; l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0;
}
const useDeep = (l) => is16() && !editingMask(l) && !l.kind;
function cropDeep(d, r) {
  const out = createDeep(r.w, r.h);
  for (let y = 0; y < r.h; y++) out.data.set(d.data.subarray(((r.y + y) * d.width + r.x) * 4, ((r.y + y) * d.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
function pasteDeep(d, part, r) {
  const out = createDeep(d.width, d.height, new Uint16Array(d.data));
  for (let y = 0; y < r.h; y++) out.data.set(part.data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * d.width + r.x) * 4);
  return out;
}
/** Run a filter / adjustment on region r of a layer at 16 bits (GPU float32 when possible, else the worker). */
async function deepOp(l, src, r, op, params, info, mask) {
  const res = await ops.processDeep(op, cropDeep(src, r), params, { ...info, linear: gfx.linear }, mask);
  ctxOf(l.canvas).putImageData(deepToImageData(res), r.x, r.y);
  touch(l); l.deep = pasteDeep(src, res, r); l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0;
}
function maskDesc(l, dx = 0, dy = 0) {
  if (!l.mask || !l.mask.enabled) return null;
  const m = l.mask.canvas, a = ctxOf(m).getImageData(0, 0, m.width, m.height).data, alpha = new Uint8Array(m.width * m.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = a[i * 4 + 3];
  return { alpha, w: m.width, h: m.height, x: l.x + dx, y: l.y + dy };
}
function maskDescOf(m) {
  if (!m) return null;
  const a = ctxOf(m.canvas).getImageData(0, 0, m.canvas.width, m.canvas.height).data, alpha = new Uint8Array(m.canvas.width * m.canvas.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = a[i * 4 + 3];
  return { alpha, w: m.canvas.width, h: m.canvas.height, x: m.x, y: m.y };
}
/** Float composite of the document (or a subset of layers) -> 16-bit DImage. Groups, clipping and styles are
 * resolved the same way as on screen (group contents and effects are 8-bit; plain layers keep 16 bits). */
function compositeDeepDoc({ background = null, layers = doc().layers } = {}) {
  const d = doc(), list = [];
  const src = layers === d.layers ? d : { ...d, layers };
  list.push(...deepList(resolveItems(src, null, { groups: is16() })));
  return accToDeep(compositeDeep(d.width, d.height, list, { background: background ? hexToRgb(background) : null, info: { linear: gfx.linear } }), d.width, d.height);
}
/** Draw items -> compositeDeep layer list. In 16-bit documents groups arrive as markers (composited in float),
 * styled layers bring a 16-bit body (deepSrc), so nothing passes through an 8-bit buffer except effect pixels. */
function deepList(items) {
  return items.map((it) => {
    const mode = blendIndex(it.blend);
    if (it.kind === 'groupBegin' || it.kind === 'passBegin') return { kind: it.kind };
    if (it.kind === 'groupEnd' || it.kind === 'passEnd') return { kind: it.kind, opacity: it.opacity, mode, mask: maskDescOf(it.mask) };
    const mask = maskDescOf(it.mask);
    if (it.kind === 'adjust') return { kind: 'adjust', op: it.l.adj.type, params: adjParamsOf(it.l.adj), opacity: it.opacity, mode, mask };
    const img = it.plain ? (is16() ? deepOf(it.l) : deepOf({ ...it.l, kind: 'tmp' })) : is16() && it.deepSrc ? it.deepSrc : deepFromImageData(ctxOf(it.src).getImageData(0, 0, it.src.width, it.src.height));
    return { kind: 'pixels', img, x: it.x, y: it.y, opacity: it.opacity, mode, mask };
  });
}
/** A group's contents composited in float (16-bit result, document-sized, cached by contents). */
const deepGroupCache = new Map();
function deepGroupOf(d, g) {
  const key = groupKey(d, g), e = deepGroupCache.get(g.id); if (e && e.key === key) return e.img;
  const img = accToDeep(compositeDeep(d.width, d.height, deepList(resolveItems(d, g.id, { groups: true })), { info: { linear: gfx.linear } }), d.width, d.height);
  deepGroupCache.set(g.id, { key, img }); return img;
}
/**
 * 16-bit body for a styled layer: pixels the effects did not change (styled == plain content) take the
 * 16-bit content; pixels an effect touched (shadow, glow, stroke, overlay) keep the effect's 8-bit value.
 */
/**
 * 16-bit styled layer (v0.9): shadow / glow / stroke coverage is computed in float (effectStack) and composited
 * with the 16-bit pixels, so effect gradients keep 16-bit precision. Effects that recolour the pixels
 * v1.0: inner glow / shadow and colour overlay are applied in float too (separable blend modes); other blend modes
 * and masked layers use styledDeep8: 16-bit where the pixels show unchanged.
 */
function styledDeep(st, content8, cx, cy, deep, styles, fxSrc) {
  const fx = fxSrc === content8 ? effectStack(content8, styles) : null;
  if (!fx || fx.bodyFx || fx.w !== st.canvas.width || fx.h !== st.canvas.height) return styledDeep8(st, content8, cx, cy, deep);
  const sw = fx.w, sh = fx.h, n = sw * sh, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  const paint = (it) => {
    const r = it.rgb[0] / 255, g = it.rgb[1] / 255, b = it.rgb[2] / 255, P = it.a, k = it.opacity;
    for (let i = 0; i < n; i++) { const a = P[i] * k; if (a <= 0) continue; const q = 1 - a; R[i] = r * a + R[i] * q; G[i] = g * a + G[i] * q; B[i] = b * a + B[i] * q; A[i] = a + A[i] * q; }
  };
  fx.under.forEach(paint);
  const body = fx.body || [];
  const D = deep.data, cw = deep.width, ch = deep.height;
  for (let y = 0; y < sh; y++) {
    const v = y + st.y - cy; if (v < 0 || v >= ch) continue;
    for (let x = 0; x < sw; x++) {
      const u = x + st.x - cx; if (u < 0 || u >= cw) continue;
      const j = (v * cw + u) * 4, a = D[j + 3] / 65535; if (a <= 0) continue;
      const i = y * sw + x, q = 1 - a; let r = D[j] / 65535, g = D[j + 1] / 65535, b = D[j + 2] / 65535;
      for (const f of body) { // inner glow / shadow / colour overlay, applied atop the pixels in float
        const m = (f.full ? 1 : f.a[i]) * f.opacity; if (m <= 0) continue;
        const fn = BODY_BLENDS[f.blend], fr = f.rgb[0] / 255, fg = f.rgb[1] / 255, fb = f.rgb[2] / 255;
        r += (fn(r, fr) - r) * m; g += (fn(g, fg) - g) * m; b += (fn(b, fb) - b) * m;
      }
      R[i] = r * a + R[i] * q; G[i] = g * a + G[i] * q; B[i] = b * a + B[i] * q; A[i] = a + A[i] * q;
    }
  }
  fx.over.forEach(paint);
  const out = createDeep(sw, sh), o = out.data, c16 = (x) => (x <= 0 ? 0 : x >= 1 ? 65535 : Math.round(x * 65535));
  for (let i = 0; i < n; i++) { const a = A[i]; if (a <= 0) continue; const j = i * 4; o[j] = c16(R[i] / a); o[j + 1] = c16(G[i] / a); o[j + 2] = c16(B[i] / a); o[j + 3] = c16(a); }
  out.fx16 = true; return out;
}
function styledDeep8(st, content8, cx, cy, deep) {
  const sw = st.canvas.width, sh = st.canvas.height, S = ctxOf(st.canvas).getImageData(0, 0, sw, sh).data;
  const C = ctxOf(content8).getImageData(0, 0, content8.width, content8.height).data, cw = content8.width, ch = content8.height, D = deep.data;
  const out = createDeep(sw, sh), o = out.data;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4, u = x + st.x - cx, v = y + st.y - cy;
    if (u >= 0 && v >= 0 && u < cw && v < ch) {
      const j = (v * cw + u) * 4;
      if (S[i] === C[j] && S[i + 1] === C[j + 1] && S[i + 2] === C[j + 2] && S[i + 3] === C[j + 3]) { o[i] = D[j]; o[i + 1] = D[j + 1]; o[i + 2] = D[j + 2]; o[i + 3] = D[j + 3]; continue; }
    }
    o[i] = S[i] * 257; o[i + 1] = S[i + 1] * 257; o[i + 2] = S[i + 2] * 257; o[i + 3] = S[i + 3] * 257;
  }
  return out;
}
function styledDeepOf(st, l, content8, cx, cy, deepFn, fxSrc = null) {
  if (!is16()) return null;
  if (st.deep && st.deepKey === st.key) return st.deep;
  st.deep = styledDeep(st, content8, cx, cy, deepFn(), l.styles, fxSrc); st.deepKey = st.key; return st.deep;
}
/** Image ▸ Mode ▸ 8 / 16 bits per channel (a history step). */
function setDepth(bits) {
  const d = doc(); if ((d.depth || 8) === bits) { status(`The document is already ${bits} bits/channel.`); return; }
  if (bits === 16) {
    let bytes = 0; for (const l of d.layers) if (!l.kind) bytes += l.canvas.width * l.canvas.height * 8;
    if (bytes > DEEP_LIMIT_MB * 1048576) {
      toast(`Not enough memory for 16 bits/channel on this device: ${Math.round(bytes / 1048576)} MB of layer data needed, ${DEEP_LIMIT_MB} MB allowed. The document stays 8-bit.`, 6500);
      return;
    }
    d.depth = 16;
  } else { d.depth = 8; for (const l of d.layers) { delete l.deep; delete l.deepRev; delete l.deepOX; delete l.deepOY; } }
  compDirty = true; requestRender(); commit(`Mode: ${bits} bits/channel`); updateDocInfo();
  status(bits === 16 ? 'Document is now 16 bits/channel: adjustments, filters, merges and exports keep 16-bit precision.' : 'Document is now 8 bits/channel.');
}
function openEngineDialog() {
  const e = gfx.engine, i = e?.info, body = document.createElement('div');
  const opt = (v, label) => `<label class="radio-row"><input type="radio" name="engine" value="${v}" ${gfx.pref === v ? 'checked' : ''}/> ${label}</label>`;
  body.innerHTML = `<div class="field two"><span>Engine</span><span>${opt('auto', 'Automatic (fastest in a quick speed probe)')}${opt('webgpu', 'GPU (WebGPU compute)')}${opt('gpu', 'GPU (WebGL2)')}${opt('cpu', 'CPU (Canvas 2D + worker)')}</span></div>
    <div class="field two"><span>16-bit blur</span><label><input type="checkbox" id="engLinear" ${gfx.linear ? 'checked' : ''}/> Blur &amp; sharpen in linear light (16-bit documents)</label></div>
    <div class="field two"><span>RAW develop</span><span style="min-width:0"><select id="engDev" aria-label="RAW develop engine" style="max-width:100%">${[['auto', 'Automatic (a hardware GPU if there is one)'], ['webgpu', 'GPU (WebGPU compute)'], ['webgl2', 'GPU (WebGL2) + CPU filters'], ['cpu', 'CPU (all cores)']].map(([v, l]) => `<option value="${v}"${getDevelopEnginePref() === v ? ' selected' : ''}>${l}</option>`).join('')}</select><br><span class="muted small" id="engDevInfo" style="overflow-wrap:anywhere">Checking…</span></span></div>
    <p class="muted" id="engInfo">${e ? `Active: ${e.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} — ${escapeHtml(i.renderer)}${i.software ? ' (software renderer)' : ''}<br>Max texture ${i.maxTextureSize}px · tile ${i.tile}px · memory ${e.usedMB.toFixed(0)} / ${e.budgetMB} MB${e.kind === 'webgpu' ? ` · output: ${e.syncOutput ? 'canvas' : 'buffer readback (async)'}` : ` · half-float ${i.halfFloat ? 'yes' : 'no'} · float32 targets ${i.float32 ? 'yes' : 'no'}${i.webgpu ? ' · WebGPU present' : ''}`}${gfx.webgpuReason ? `<br>WebGPU not used: ${escapeHtml(gfx.webgpuReason)}` : ''}`
      : `Active: CPU${gfx.reason ? ` — ${escapeHtml(gfx.reason)}` : ''}`}${gfx.probe ? `<br>Automatic choice: ${ENGINE_NAMES[gfx.probe.choice]} — speed probe (1 MP)${gfx.probe.cached ? ', cached' : ''}: ${['cpu', 'webgl', 'webgpu'].map((k) => `${ENGINE_NAMES[k]} ${gfx.probe.ms?.[k] != null ? gfx.probe.ms[k] + ' ms' : 'n/a'}`).join(' · ')} <button type="button" class="link" id="engReprobe">Measure again</button>` : ''}</p>`;
  body.querySelector('#engReprobe')?.addEventListener('click', () => { try { localStorage.removeItem(PROBE_KEY); } catch { /* ignore */ } closeModal(); setEnginePref('auto').then(() => { status(`Automatic engine: ${ENGINE_NAMES[gfx.probe?.choice || 'cpu']}`); }); });
  const devInfo = (r) => { const el = body.querySelector('#engDevInfo'); if (el) el.textContent = `In use: ${r.label}${r.renderer ? ` — ${r.renderer}` : ''}${r.software ? ' (software: slower than the CPU)' : ''}${r.note ? ` · ${r.note}` : ''}`; };
  developEngineInfo().then(devInfo, (err) => devInfo({ label: 'unknown', note: err.message }));
  showModal({ title: 'Rendering engine', body, okLabel: 'Apply', ok: () => {
    const dv = body.querySelector('#engDev').value;
    if (dv !== getDevelopEnginePref()) setDevelopEngine(dv).then((r) => status(`RAW develop engine: ${r.label}${r.renderer ? ` (${r.renderer})` : ''}`), () => {});
    const v = body.querySelector('input[name=engine]:checked')?.value || 'auto';
    gfx.linear = body.querySelector('#engLinear').checked; try { localStorage.setItem('tintwork.linear', gfx.linear ? '1' : '0'); } catch { /* ignore */ }
    const report = () => status(gfx.engine ? `Rendering engine: ${gfx.engine.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} (${gfx.engine.info.renderer})` : `Rendering engine: CPU${gfx.reason ? ` (${gfx.reason})` : ''}`);
    if (v !== gfx.pref || (v !== 'cpu' && !gfx.engine)) setEnginePref(v).then(report); else report();
  } });
}
const engineLabel = () => { const e = gfx.engine; if (!e) return 'CPU'; const n = e.kind === 'webgpu' ? 'WebGPU' : 'WebGL'; return gfx.path === 'cpu' ? `${n} idle` : gfx.path === 'gpu-8' ? `${n} 8-bit` : n; };

function defaultAdjParams(type) {
  if (type === 'curves') return identityCurves();
  const def = ADJ[type]; return def ? Object.fromEntries(def.params.map((q) => [q.key, q.value])) : {};
}
function newAdjustmentLayer(type) {
  const d = doc(), sel = d.selection;
  const l = createLayer(ADJ_LAYER[type], 1, 1, { kind: 'adjust', adj: { type, params: defaultAdjParams(type) }, editMask: true });
  const m = makeMaskCanvas(d.width, d.height, !sel);
  if (sel) m.getContext('2d').drawImage(selectionCanvas(sel), 0, 0);
  l.mask = { canvas: m, enabled: true, rev: ++globalRev };
  addLayer(l, `New ${ADJ_LAYER[type]} layer`);
  if (type !== 'invert' && type !== 'grayscale') openAdjustmentLayerDialog(l, true);
}
/** Edit an adjustment layer's settings live; Cancel restores (or removes a brand-new layer). */
function openAdjustmentLayerDialog(l, isNew = false) {
  const before = l.adj, type = before.type;
  const values = structuredClone(before.params || {});
  const apply = () => { l.adj = { type, params: structuredClone(values) }; adjInteractive(); compDirty = true; requestRender(); };
  const body = document.createElement('div');
  if (type === 'curves') {
    // histogram of what the curve will act on (everything below this layer)
    const d = doc(), idx = d.layers.indexOf(l), tmp = makeCanvas(d.width, d.height);
    const saved = d.layers; d.layers = saved.slice(0, idx); composite(tmp, { sync: true }); d.layers = saved;
    const small = makeCanvas(Math.min(512, d.width), Math.min(512, d.height)); small.getContext('2d').drawImage(tmp, 0, 0, small.width, small.height);
    body.append(createCurvesEditor(values, apply, channelHistograms(small.getContext('2d').getImageData(0, 0, small.width, small.height))));
  } else if (ADJ[type]) {
    for (const q of ADJ[type].params) body.append(paramField({ ...q, value: values[q.key] ?? q.value }, values, apply, q.value));
  } else { status(`${ADJ_LAYER[type]} has no settings.`); return; }
  showModal({
    title: `${ADJ_LAYER[type]} layer`, body, passive: true, okLabel: 'Done',
    ok: () => { apply(); if (JSON.stringify(before) !== JSON.stringify(l.adj)) commit(`Edit ${ADJ_LAYER[type]} layer`); else if (isNew) updateLayersPanel(); if (isNew && type !== 'lut3d') recordStep({ t: 'adjLayer', type, params: l.adj.params, name: l.name }); },
    cancel: () => {
      l.adj = before; compDirty = true;
      if (isNew) { undo(); history.entries.length = history.index + 1; updateHistoryPanel(); }
      requestRender();
    },
  });
}
/** Re-open the settings of an adjustment or text layer (double-click in the Layers panel). */
function editLayer(l = activeLayer()) {
  if (!l) return;
  if (l.kind === 'adjust') openAdjustmentLayerDialog(l);
  else if (isGroup(l)) openStylesDialog(l);
  else if (l.kind === 'text') openTextDialog(null, l);
  else if (l.kind === 'smart') openLiveFilterPanel(l);
  else if (l.raw) redevelopRaw(l);
  else status('Only adjustment, text, live filter and RAW layers have settings to edit.');
}

// --- live filter layers: the original pixels are kept and the filter stack re-runs on change -----
// l.source   original pixels (immutable canvas, shared with history)
// l.filters  [{ type, params, enabled }] applied bottom (index 0) to top; replaced, never mutated
// l.fmask    optional filter mask { canvas, enabled, rev }: white = filtered, black = original
// l.canvas   the rendered result, recomputed by composeSmart()
const SMART_FILTERS = ['gaussianBlur', 'sharpen', 'noise', 'vignette'];
const canvasIds = new WeakMap(); let canvasSeq = 0;
const canvasId = (c) => { let i = canvasIds.get(c); if (!i) { i = ++canvasSeq; canvasIds.set(c, i); } return i; };
const smartCache = new Map(); // layer id -> a few recent filter results [{ key, canvas }]
const smartKey = (l, filters) => `${canvasId(l.source)}|${JSON.stringify(filters.filter((f) => f.enabled).map((f) => [f.type, f.params]))}`;
const filterInfo = (l) => ({ docW: l.source.width, docH: l.source.height, offX: 0, offY: 0 }); // vignette etc. are layer-relative
const filterParams = (f) => ({ ...f.params, ...(ADJ[f.type].extra || {}) });
function smartCacheGet(l, key) { return smartCache.get(l.id)?.find((e) => e.key === key)?.canvas || null; }
function smartCachePut(l, key, canvas) {
  const list = (smartCache.get(l.id) || []).filter((e) => e.key !== key); list.unshift({ key, canvas });
  list.length = Math.min(list.length, 4); smartCache.set(l.id, list); return canvas;
}
function filteredSync(l, filters = l.filters) {
  if (!filters.some((f) => f.enabled)) return l.source;
  const key = smartKey(l, filters), hit = smartCacheGet(l, key); if (hit) return hit;
  const g = gpuFilter(l, filters); if (g) return smartCachePut(l, key, g);
  const src = l.source, img = ctxOf(src).getImageData(0, 0, src.width, src.height);
  for (const f of filters) if (f.enabled) runOp(f.type, img, filterParams(f), filterInfo(l));
  return smartCachePut(l, key, putInto(null, img));
}
async function filteredAsync(l, filters = l.filters) {
  if (!filters.some((f) => f.enabled)) return l.source;
  const key = smartKey(l, filters), hit = smartCacheGet(l, key); if (hit) return hit;
  const g = gpuFilter(l, filters); if (g) return smartCachePut(l, key, g);
  const src = l.source; let img = ctxOf(src).getImageData(0, 0, src.width, src.height);
  for (const f of filters) if (f.enabled) img = await ops.process(f.type, img, filterParams(f), filterInfo(l));
  return smartCachePut(l, key, putInto(null, img));
}
let smartScratch = null;
/** l.canvas = source × (1 − fmask) + filtered × fmask (exact on premultiplied pixels). */
function composeSmart(l, filtered) {
  const src = l.source, w = src.width, h = src.height;
  let c = l.canvas; if (c.width !== w || c.height !== h) c = makeCanvas(w, h);
  const x = c.getContext('2d'); x.save(); x.globalAlpha = 1; x.globalCompositeOperation = 'copy';
  const fm = l.fmask && l.fmask.enabled && filtered !== src ? l.fmask.canvas : null;
  if (!fm) x.drawImage(filtered, 0, 0);
  else {
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(fm, 0, 0);
    if (!smartScratch || smartScratch.width !== w || smartScratch.height !== h) smartScratch = makeCanvas(w, h);
    const t = smartScratch.getContext('2d'); t.save(); t.globalCompositeOperation = 'copy'; t.drawImage(filtered, 0, 0);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(fm, 0, 0); t.restore();
    x.globalCompositeOperation = 'lighter'; x.drawImage(smartScratch, 0, 0);
  }
  x.restore(); l.canvas = c; touch(l);
}
const renderSmartSync = (l) => composeSmart(l, filteredSync(l));
/** Apply a geometry change (rotate, scale, crop…) to the original pixels and filter mask, then re-render. */
function smartGeom(l, fn) {
  l.source = fn(l.source);
  if (l.fmask) { l.fmask.canvas = fn(l.fmask.canvas); l.fmask.rev = ++globalRev; }
  renderSmartSync(l);
}
/** Re-render after a filter-stack change (worker for big layers) and optionally record a history step. */
async function updateSmart(l, label) {
  const big = l.source.width * l.source.height > ADJ_SYNC_PIXELS && ops.workerStatus().available;
  if (big) {
    setBusy(1);
    try { const fc = await filteredAsync(l); composeSmart(l, fc); }
    catch (err) { status(`Live filter failed: ${err.message}`); }
    finally { setBusy(-1); }
  } else composeSmart(l, filteredSync(l));
  requestRender();
  if (label) { commit(label); status(label); } else updateLayersPanel();
}
function setSmartFilters(l, filters, label) { l.filters = filters; return updateSmart(l, label); }
function convertToSmart(l = activeLayer()) {
  if (!l) return null;
  if (l.kind === 'adjust') { status('Adjustment layers cannot hold live filters.'); return null; }
  if (l.kind === 'smart') { status('This is already a live filter layer.'); return l; }
  if (l.kind === 'text') rasterize(l);
  ensureCoversDoc(l); // filters need transparent room around tight layers (e.g. after a transform) to spread into
  Object.assign(l, { kind: 'smart', source: cloneCanvas(l.canvas), filters: [], fmask: null, editFMask: false });
  touch(l); requestRender(); commit('Convert to live layer');
  toast('Live layer: filters added from the Filter menu stay editable (✎ in Layers).');
  return l;
}
function addFilterMask(l, fromSelection) {
  const sel = fromSelection ? doc().selection : null;
  const m = makeMaskCanvas(l.source.width, l.source.height, !sel);
  if (sel) m.getContext('2d').drawImage(selectionCanvas(sel), -l.x, -l.y);
  l.fmask = { canvas: m, enabled: true, rev: ++globalRev };
}
function invertFilterMask(l) {
  const f = l.fmask, m = makeMaskCanvas(f.canvas.width, f.canvas.height), x = m.getContext('2d');
  x.globalCompositeOperation = 'destination-out'; x.drawImage(f.canvas, 0, 0);
  f.canvas = m; f.rev = ++globalRev; renderSmartSync(l); requestRender(); commit('Invert filter mask');
}
function filterSummary(f) {
  return ADJ[f.type].params.filter((q) => q.type !== 'checkbox').map((q) => `${q.label} ${f.params[q.key]}${q.unit || ''}`).join(', ');
}
/** Add (index = null) or edit one live filter with a live preview; Cancel restores the stack. */
function openSmartFilterDialog(l, index = null, type = null) {
  const before = l.filters, fmaskBefore = l.fmask, shown = cloneCanvas(l.canvas);
  const f0 = index != null ? before[index] : { type, params: Object.fromEntries(ADJ[type].params.map((q) => [q.key, q.value])), enabled: true };
  const def = ADJ[f0.type], values = { ...f0.params };
  if (index == null && !l.fmask && doc().selection) addFilterMask(l, true); // a selection limits the new filter
  const build = () => { const f = { type: f0.type, params: { ...values }, enabled: true }; return index != null ? before.map((g, j) => (j === index ? f : g)) : [...before, f]; };
  let closed = false, running = false, dirty = false;
  const pump = async () => {
    running = true;
    while (dirty && !closed) {
      dirty = false; const filters = build(); setBusy(1);
      try { const fc = await filteredAsync(l, filters); if (!closed) { composeSmart(l, fc); requestRender(); } }
      catch (err) { status(err.message); } finally { setBusy(-1); }
    }
    running = false;
  };
  const preview = () => { dirty = true; if (!running) pump(); };
  const body = document.createElement('div');
  body.innerHTML = `<p class="muted live-note">Live filter: stays editable. Toggle, reorder or edit it later from the Layers panel.</p>`;
  for (const q of def.params) body.append(paramField({ ...q, value: values[q.key] }, values, preview, q.value));
  showModal({
    title: `${index != null ? 'Edit live' : 'Live'} ${def.title.toLowerCase()}`, body, passive: true, okLabel: index != null ? 'Done' : 'Add filter',
    ok: () => { closed = true; l.filters = build(); updateSmart(l, `${index != null ? 'Edit' : 'Add'} live filter: ${def.title}`); },
    cancel: () => { closed = true; l.filters = before; l.fmask = fmaskBefore; l.canvas = shown; touch(l); requestRender(); },
  });
  preview();
}
/** The live-filter panel: list, toggle, edit, reorder and delete filters; manage the filter mask. */
function openLiveFilterPanel(l) {
  const body = document.createElement('div'); body.className = 'live-panel';
  const draw = () => {
    const rows = l.filters.map((f, i) => `<div class="live-row" data-i="${i}"><label><input type="checkbox" data-live="toggle" ${f.enabled ? 'checked' : ''}/> ${ADJ[f.type].title}</label>` +
      `<span class="muted">${escapeHtml(filterSummary(f))}</span><span class="live-btns"><button type="button" data-live="edit">Edit</button>` +
      `<button type="button" data-live="up" title="Move up (applied later)" ${i === l.filters.length - 1 ? 'disabled' : ''}>▲</button>` +
      `<button type="button" data-live="down" title="Move down (applied earlier)" ${i === 0 ? 'disabled' : ''}>▼</button>` +
      `<button type="button" data-live="delete" title="Remove filter">✕</button></span></div>`).reverse().join('');
    body.innerHTML = `<p class="muted">Filters run from the bottom up on the layer's original pixels.</p>${rows || '<p class="muted">No filters yet.</p>'}` +
      `<h4>Add filter</h4><div class="choice-list live-add">${SMART_FILTERS.map((t) => `<button type="button" data-live-add="${t}">${ADJ[t].title}</button>`).join('')}</div>` +
      `<h4>Filter mask</h4><div class="live-mask">${l.fmask
        ? `<label><input type="checkbox" data-live="maskEnabled" ${l.fmask.enabled ? 'checked' : ''}/> Enabled</label> <button type="button" data-live="maskPaint">Paint mask</button> <button type="button" data-live="maskInvert">Invert</button> <button type="button" data-live="maskDelete">Delete</button>`
        : `<button type="button" data-live="maskAdd">Add (show all)</button> <button type="button" data-live="maskSel" ${doc().selection ? '' : 'disabled'}>From selection</button>`}</div>`;
  };
  const act = async (what, i) => {
    const fs = l.filters;
    if (what === 'toggle') await setSmartFilters(l, fs.map((f, j) => (j === i ? { ...f, enabled: !f.enabled } : f)), `${fs[i].enabled ? 'Hide' : 'Show'} live filter`);
    else if (what === 'edit') { closeModal(); openSmartFilterDialog(l, i); return; }
    else if (what === 'up' || what === 'down') {
      const j = what === 'up' ? i + 1 : i - 1; if (j < 0 || j >= fs.length) return;
      const n = fs.slice(); [n[i], n[j]] = [n[j], n[i]]; await setSmartFilters(l, n, 'Reorder live filters');
    } else if (what === 'delete') await setSmartFilters(l, fs.filter((_, j) => j !== i), 'Delete live filter');
    else if (what === 'maskEnabled') { l.fmask.enabled = !l.fmask.enabled; l.fmask.rev = ++globalRev; await updateSmart(l, l.fmask.enabled ? 'Enable filter mask' : 'Disable filter mask'); }
    else if (what === 'maskPaint') { l.editFMask = true; l.editMask = false; closeModal(); setTool('brush'); updateLayersPanel(); status('Painting the filter mask: black hides the filters, white shows them.'); return; }
    else if (what === 'maskInvert') invertFilterMask(l);
    else if (what === 'maskDelete') { l.fmask = null; l.editFMask = false; await updateSmart(l, 'Delete filter mask'); }
    else if (what === 'maskAdd' || what === 'maskSel') { addFilterMask(l, what === 'maskSel'); await updateSmart(l, 'Add filter mask'); }
    draw();
  };
  body.addEventListener('click', (e) => {
    const add = e.target.closest('[data-live-add]'); if (add) { closeModal(); openSmartFilterDialog(l, null, add.dataset.liveAdd); return; }
    const b = e.target.closest('button[data-live]'); if (!b) return;
    act(b.dataset.live, +(b.closest('[data-i]')?.dataset.i ?? -1));
  });
  body.addEventListener('change', (e) => {
    const c = e.target.closest('input[data-live]'); if (!c) return;
    act(c.dataset.live, +(c.closest('[data-i]')?.dataset.i ?? -1));
  });
  draw();
  showModal({ title: `Live filters: ${l.name}`, body, hideCancel: true, okLabel: 'Done', passive: true });
}
/** Filter menu: on a live layer the filter is added to its stack; otherwise it is applied to pixels. */
function filterCmd(type) {
  const l = activeLayer();
  if (l && l.kind === 'smart' && !editingMask(l)) openSmartFilterDialog(l, null, type);
  else openAdjust(ADJ[type]);
}

// --- text layers: kept as editable text and re-rendered on change ----------------------
// Bundled open-licensed fonts (SIL OFL 1.1, see fonts/README.md) with a generic fallback each.
const BUNDLED_FONTS = { Inter: 'sans-serif', Lora: 'serif', 'Bebas Neue': 'sans-serif', Pacifico: 'cursive', 'JetBrains Mono': 'monospace' };
const GENERIC_FONTS = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive']);
const TEXT_FONTS = [...Object.keys(BUNDLED_FONTS), 'system-ui', 'sans-serif', 'serif', 'monospace', 'Georgia', 'Verdana', 'Courier New', 'cursive'];
const fontFamilyCSS = (f) => (GENERIC_FONTS.has(f) ? f : `"${f}"`) + (BUNDLED_FONTS[f] ? `, ${BUNDLED_FONTS[f]}` : '');
function textFont(t) { return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : ''}${t.size}px ${fontFamilyCSS(t.font)}`; }
/** Bundled fonts download on first use: true when `t` can be drawn with its real font now. */
const fontReady = (t) => !BUNDLED_FONTS[t.font] || !document.fonts || document.fonts.check(textFont(t));
const loadFont = (t) => (document.fonts ? document.fonts.load(textFont(t)).catch(() => []) : Promise.resolve([]));
/** Draw `l.text` into a canvas sized to the text, keeping its anchor point fixed. */
function renderTextLayer(l) {
  const t = l.text, lines = t.text.split('\n'), lh = Math.round(t.size * 1.2);
  const mx = ctxOf(makeCanvas(1, 1)); mx.font = textFont(t);
  const widths = lines.map((ln) => mx.measureText(ln).width), w = Math.max(1, ...widths);
  const pad = Math.ceil(t.size * 0.35);
  const c = makeCanvas(Math.ceil(w) + pad * 2, lh * lines.length + pad * 2), x = ctxOf(c);
  x.font = textFont(t); x.fillStyle = t.color; x.textBaseline = 'top'; x.textAlign = t.align;
  const ax = Math.round(t.align === 'center' ? pad + w / 2 : t.align === 'right' ? pad + w : pad); // whole pixels: no drift on re-edit
  lines.forEach((ln, i) => x.fillText(ln, ax, pad + i * lh + t.size * 0.1));
  // anchor (doc coords) = l.x + t.ox ; keep it where it was
  const anchorX = Math.round(l.x + (t.ox ?? 0)), anchorY = Math.round(l.y + (t.oy ?? 0));
  l.text = { ...t, ox: ax, oy: pad };
  l.canvas = c; l.x = Math.round(anchorX - ax); l.y = Math.round(anchorY - pad);
  l.name = `Text: ${lines[0].slice(0, 24) || '(empty)'}`;
  touch(l);
}
function textLayerAt(p) {
  const d = doc();
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const l = d.layers[i];
    if (l.kind === 'text' && l.visible && p.x >= l.x && p.y >= l.y && p.x < l.x + l.canvas.width && p.y < l.y + l.canvas.height) return l;
  }
  return null;
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
let antsOffset = 0;
function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (view.width !== Math.round(w * dpr) || view.height !== Math.round(h * dpr)) {
    view.width = Math.round(w * dpr); view.height = Math.round(h * dpr);
  }
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.fillStyle = '#111215'; vctx.fillRect(0, 0, w, h);
  const d = doc();
  if (!d) return;
  freshComp();
  const { zoom: z, panX: px, panY: py } = state;
  const sx = px, sy = py, sw = d.width * z, sh = d.height * z;
  vctx.save();
  vctx.shadowColor = '#0009'; vctx.shadowBlur = 18;
  vctx.fillStyle = checkerPattern(); vctx.fillRect(sx, sy, sw, sh);
  vctx.restore();
  vctx.save();
  vctx.imageSmoothingEnabled = z < 2;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(comp, sx, sy, sw, sh);
  vctx.restore();
  if (proofMode && proofWarn) {
    // downscale for speed; magenta overlay for crushed / over-ink pixels (approximate, no ICC)
    const maxSide = 720, k = Math.min(1, maxSide / Math.max(d.width, d.height));
    const tw = Math.max(1, Math.round(d.width * k)), th = Math.max(1, Math.round(d.height * k));
    const tc = makeCanvas(tw, th), tx = tc.getContext('2d', { willReadFrequently: true });
    tx.drawImage(comp, 0, 0, tw, th);
    const mask = proofWarnMask(tx.getImageData(0, 0, tw, th), PROOF_PAPERS[proofMode]);
    const ov = makeCanvas(tw, th); ov.getContext('2d').putImageData(new ImageData(mask, tw, th), 0, 0);
    vctx.save(); vctx.imageSmoothingEnabled = false; vctx.drawImage(ov, sx, sy, sw, sh); vctx.restore();
  }
  const toS = (x, y) => [px + x * z, py + y * z];

  const al = activeLayer();
  if (state.tool === 'move' && al && !state.xf) {
    const [x, y] = toS(al.x, al.y);
    vctx.save(); vctx.strokeStyle = '#7a5cff'; vctx.setLineDash([4, 3]);
    vctx.strokeRect(x + .5, y + .5, al.canvas.width * z, al.canvas.height * z); vctx.restore();
  }
  const ants = (pathObj, closed = true) => { // marching ants in document space
    vctx.save(); vctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * px, dpr * py);
    vctx.lineWidth = 1 / z; vctx.setLineDash([5 / z, 5 / z]);
    vctx.strokeStyle = '#000'; vctx.lineDashOffset = -antsOffset / z; vctx.stroke(pathObj);
    vctx.strokeStyle = '#fff'; vctx.lineDashOffset = (-antsOffset + 5) / z; vctx.stroke(pathObj);
    vctx.restore();
  };
  if (drag?.float) { const f = drag.float, p = new Path2D(); p.addPath(selectionOutline(f.sel), new DOMMatrix().translate(f.dx, f.dy)); ants(p); }
  else if (d.selection && !state.xf) ants(selectionOutline(d.selection));
  if (state.selPreview) {
    const sp = state.selPreview, path = new Path2D();
    if (sp.ellipse) { const e = sp.ellipse; path.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2); }
    else if (sp.rect) path.rect(sp.rect.x, sp.rect.y, sp.rect.w, sp.rect.h);
    else if (sp.pts?.length) { path.moveTo(sp.pts[0].x, sp.pts[0].y); for (const q of sp.pts) path.lineTo(q.x, q.y); path.closePath(); }
    ants(path);
  }
  if (state.objSel && state.objSel.doc === d && state.tool === 'objsel') { // object select: box and refine strokes
    const s = state.objSel;
    vctx.save(); vctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * px, dpr * py); vctx.lineCap = vctx.lineJoin = 'round';
    for (const st of [...s.strokes, ...(s.draft ? [s.draft] : [])]) {
      vctx.beginPath(); st.pts.forEach(([a, b], i) => (i ? vctx.lineTo(a, b) : vctx.moveTo(a, b))); if (st.pts.length === 1) vctx.lineTo(st.pts[0][0] + 0.01, st.pts[0][1]);
      vctx.lineWidth = st.r * 2; vctx.strokeStyle = st.fg ? 'rgba(60,220,110,0.45)' : 'rgba(255,70,70,0.45)'; vctx.stroke();
    }
    vctx.setLineDash([4 / z, 4 / z]); vctx.lineWidth = 1 / z; vctx.strokeStyle = '#3ad1ff'; vctx.strokeRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h);
    vctx.restore();
  }
  if (state.strLine) {
    const { a, b } = state.strLine;
    vctx.save(); vctx.setTransform(dpr, 0, 0, dpr, 0, 0); vctx.beginPath();
    vctx.moveTo(px + a.x * z, py + a.y * z); vctx.lineTo(px + b.x * z, py + b.y * z);
    vctx.lineWidth = 3; vctx.strokeStyle = '#000a'; vctx.stroke(); vctx.lineWidth = 1.5; vctx.strokeStyle = '#ffd34d'; vctx.stroke(); vctx.restore();
  }
  if (state.shapePreview) {
    const g = state.shapePreview, o = state.opts;
    vctx.save(); vctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * px, dpr * py);
    const path = shapePath(g), style = g.kind === 'line' ? 'stroke' : o.shapeStyle;
    vctx.globalAlpha = 0.75;
    if (style !== 'stroke') { vctx.fillStyle = state.fg; vctx.fill(path); }
    if (style !== 'fill') { vctx.strokeStyle = style === 'both' ? state.bg : state.fg; vctx.lineWidth = Math.max(1, o.shapeStroke); vctx.lineCap = g.kind === 'line' ? 'round' : 'butt'; vctx.stroke(path); }
    vctx.restore(); ants(path);
  }
  if (state.gradPreview) {
    const { a, b } = state.gradPreview, [x1, y1] = toS(a.x, a.y), [x2, y2] = toS(b.x, b.y);
    vctx.save(); vctx.lineWidth = 3; vctx.strokeStyle = '#000a'; vctx.beginPath(); vctx.moveTo(x1, y1); vctx.lineTo(x2, y2); vctx.stroke();
    vctx.lineWidth = 1; vctx.strokeStyle = '#fff'; vctx.stroke();
    for (const [x, y, c] of [[x1, y1, state.fg], [x2, y2, state.opts.gradColors === 'fg-bg' ? state.bg : '#0000']]) { vctx.beginPath(); vctx.arc(x, y, 5, 0, Math.PI * 2); vctx.fillStyle = c; vctx.fill(); vctx.stroke(); }
    if (state.opts.gradType === 'radial') { vctx.setLineDash([4, 4]); vctx.beginPath(); vctx.arc(x1, y1, Math.hypot(x2 - x1, y2 - y1), 0, Math.PI * 2); vctx.stroke(); }
    vctx.restore();
  }
  if (state.poly?.pts.length) {
    const path = new Path2D(), pts = state.poly.pts;
    path.moveTo(pts[0].x, pts[0].y); for (const q of pts) path.lineTo(q.x, q.y);
    if (state.hover) path.lineTo(state.hover.x, state.hover.y);
    ants(path);
    const [fx, fy] = toS(pts[0].x, pts[0].y);
    vctx.save(); vctx.strokeStyle = '#fff'; vctx.fillStyle = '#e8553a'; vctx.beginPath(); vctx.arc(fx, fy, 4, 0, Math.PI * 2); vctx.fill(); vctx.stroke(); vctx.restore();
  }
  if ((state.tool === 'clone' || state.tool === 'heal') && state.cloneSrc) {
    const off = drag?.clone ? { dx: drag.dx, dy: drag.dy } : state.opts.cloneAligned ? state.cloneOffset : null;
    const src = off && state.hover ? { x: state.hover.x + off.dx, y: state.hover.y + off.dy } : state.cloneSrc;
    const [cx, cy] = toS(src.x, src.y);
    vctx.save(); vctx.lineWidth = 3; vctx.strokeStyle = '#000a';
    const cross = () => { vctx.beginPath(); vctx.moveTo(cx - 9, cy); vctx.lineTo(cx + 9, cy); vctx.moveTo(cx, cy - 9); vctx.lineTo(cx, cy + 9); vctx.stroke(); };
    cross(); vctx.lineWidth = 1; vctx.strokeStyle = '#fff'; cross(); vctx.restore();
  }
  if (state.crop) {
    const c = state.crop; const [x, y] = toS(c.x, c.y); const cw = c.w * z, ch = c.h * z;
    vctx.save(); vctx.fillStyle = '#000a';
    vctx.beginPath(); vctx.rect(sx, sy, sw, sh); vctx.rect(x, y, cw, ch); vctx.fill('evenodd');
    vctx.strokeStyle = '#fff'; vctx.lineWidth = 1; vctx.strokeRect(x + .5, y + .5, cw, ch);
    vctx.strokeStyle = '#fff6';
    for (let i = 1; i < 3; i++) {
      vctx.beginPath(); vctx.moveTo(x + (cw * i) / 3, y); vctx.lineTo(x + (cw * i) / 3, y + ch);
      vctx.moveTo(x, y + (ch * i) / 3); vctx.lineTo(x + cw, y + (ch * i) / 3); vctx.stroke();
    }
    vctx.restore();
  }
  if (state.xf) drawTransformBox(toS);
  if (state.mxf) drawMeshBox(toS);
  if (state.hover && PAINT_TOOLS.includes(state.tool) && !state.xf && !state.mxf) {
    const size = state.opts[`${state.tool}Size`];
    const [x, y] = toS(state.hover.x, state.hover.y);
    const r = Math.max(1, (size / 2) * z);
    vctx.save(); vctx.beginPath(); vctx.arc(x, y, r, 0, Math.PI * 2);
    vctx.strokeStyle = '#000a'; vctx.lineWidth = 3; vctx.stroke();
    vctx.strokeStyle = '#fff'; vctx.lineWidth = 1; vctx.stroke(); vctx.restore();
  }
}
setInterval(() => {
  if (doc()?.selection || state.poly || state.selPreview) { antsOffset = (antsOffset + 1) % 10; requestRender(); }
}, 90);

const TABBAR_H = 28; // the document tab strip overlays the top of the viewport
function fitToScreen() {
  const d = doc(); if (!d) return;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  state.zoom = Math.min((w - 48) / d.width, (h - 48 - TABBAR_H) / d.height, 1);
  centerView();
}
function centerView() {
  const d = doc();
  state.panX = Math.round((viewport.clientWidth - d.width * state.zoom) / 2);
  state.panY = Math.round((viewport.clientHeight + TABBAR_H - d.height * state.zoom) / 2);
  updateZoomLabel(); requestRender();
}
function zoomAt(factor, cx, cy) {
  if (!doc()) return;
  if (cx === undefined) { cx = viewport.clientWidth / 2; cy = viewport.clientHeight / 2; }
  const nz = Math.min(64, Math.max(0.02, state.zoom * factor));
  state.panX = cx - ((cx - state.panX) * nz) / state.zoom;
  state.panY = cy - ((cy - state.panY) * nz) / state.zoom;
  state.zoom = nz;
  updateZoomLabel(); requestRender();
}
function setZoom(z) { state.zoom = z; centerView(); }
function updateZoomLabel() { $('#zoomLabel').textContent = doc() ? `${Math.round(state.zoom * 1000) / 10}%` : ''; }
function screenToDoc(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left - state.panX) / state.zoom, y: (e.clientY - r.top - state.panY) / state.zoom };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const PAINT_TOOLS = ['brush', 'eraser', 'clone', 'heal', 'spot', 'tone', 'redeye', 'liquify']; // tools with a round size cursor and [ ] sizing
const TOOLS = [
  { id: 'move', name: 'Move', key: 'V' },
  { id: 'select', name: 'Rectangle select', key: 'M' },
  { id: 'ellipse', name: 'Ellipse select', key: 'O' },
  { id: 'lasso', name: 'Lasso', key: 'L' },
  { id: 'polylasso', name: 'Polygonal lasso', key: 'P' },
  { id: 'wand', name: 'Magic wand', key: 'W' },
  { id: 'objsel', name: 'Object select (W again): drag a box around the subject', key: 'W' },
  { id: 'crop', name: 'Crop', key: 'C' },
  { id: 'straighten', name: 'Straighten (draw along the horizon)', key: 'C' },
  { sep: true },
  { id: 'brush', name: 'Brush', key: 'B' },
  { id: 'eraser', name: 'Eraser', key: 'E' },
  { id: 'clone', name: 'Clone stamp (Alt+click sets source)', key: 'S' },
  { id: 'heal', name: 'Healing brush (Alt+click sets source)', key: 'R' },
  { id: 'spot', name: 'Spot healing', key: 'J' },
  { id: 'redeye', name: 'Red eye (J again)', key: 'J' },
  { id: 'tone', name: 'Dodge / burn (O again)', key: 'O' },
  { id: 'liquify', name: 'Liquify (push / bloat / pinch)', key: 'K' },
  { id: 'gradient', name: 'Gradient', key: 'G' },
  { id: 'fill', name: 'Fill (G again)', key: 'G' },
  { id: 'shape', name: 'Shape', key: 'U' },
  { id: 'text', name: 'Text', key: 'T' },
  { id: 'eyedropper', name: 'Color picker', key: 'I' },
  { id: 'wbpick', name: 'White balance picker (click something grey)', key: 'I' },
  { sep: true },
  { id: 'hand', name: 'Hand (hold Space)', key: 'H' },
  { id: 'zoom', name: 'Zoom (Alt to zoom out)', key: 'Z' },
];

function setTool(id) {
  if (state.xf && id !== state.tool) applyTransform();
  if (state.mxf && id !== state.tool) applyMeshXf();
  if (state.tool === 'crop' && id !== 'crop') state.crop = null;
  if (state.tool === 'polylasso' && id !== 'polylasso') state.poly = null;
  if (state.tool === 'objsel' && id !== 'objsel' && state.objSel) {
    state.objSel = null;
    status('Object select kept.');
  }
  state.tool = id;
  for (const b of document.querySelectorAll('#toolbar button')) b.classList.toggle('active', b.dataset.tool === id);
  const cursors = { move: 'move', select: 'crosshair', lasso: 'crosshair', polylasso: 'crosshair', wand: 'crosshair', objsel: 'crosshair', crop: 'crosshair', brush: 'none', eraser: 'none', clone: 'none', heal: 'none', spot: 'none', tone: 'none', redeye: 'none', liquify: 'none', gradient: 'crosshair', shape: 'crosshair', fill: 'cell', text: 'text', eyedropper: 'copy', hand: 'grab', zoom: 'zoom-in' };
  view.style.cursor = cursors[id] || 'default';
  buildOptionsBar();
  requestRender();
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function makeStamp(size, hardness, color) {
  const d = Math.max(1, Math.ceil(size));
  const c = makeCanvas(d + 2, d + 2), x = c.getContext('2d');
  const r = size / 2, cx = (d + 2) / 2;
  if (hardness >= 1) {
    x.fillStyle = color; x.beginPath(); x.arc(cx, cx, r, 0, Math.PI * 2); x.fill();
  } else {
    const [R, G, B] = hexToRgb(color);
    const g = x.createRadialGradient(cx, cx, 0, cx, cx, r);
    g.addColorStop(0, `rgba(${R},${G},${B},1)`);
    g.addColorStop(Math.min(0.99, hardness), `rgba(${R},${G},${B},1)`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    x.fillStyle = g; x.beginPath(); x.arc(cx, cx, r, 0, Math.PI * 2); x.fill();
  }
  return c;
}

let drag = null;
let lastPaintPoint = null;
let spaceDown = false;

// --- selection helpers ------------------------------------------------------
/** Shift = add, Alt = subtract, Shift+Alt = intersect; otherwise the options-bar mode. */
function selModeFor(e) {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return state.opts.selMode;
}
const MODE_LABEL = { new: '', add: ' (add)', subtract: ' (subtract)', intersect: ' (intersect)' };
function applyShape(shape, mode, label) {
  const d = doc();
  const sel = combine(d.selection, d.width, d.height, shape, mode);
  setSelection(sel, sel ? label + MODE_LABEL[mode] : 'Deselect');
}
function polygonMask(pts) {
  const d = doc();
  return shapeMask(d.width, d.height, (x) => { x.moveTo(pts[0].x, pts[0].y); for (const q of pts) x.lineTo(q.x, q.y); x.closePath(); });
}
function finishPolygon() {
  const poly = state.poly; state.poly = null; queueMicrotask(buildOptionsBar);
  if (!poly || poly.pts.length < 3) { requestRender(); return; }
  applyShape(polygonMask(poly.pts), poly.mode, 'Polygonal lasso');
}
/**
 * Object select (v1.8, no machine learning): the box seeds colour models of subject and background and a graph
 * cut finds the boundary between them (segment.js). Refine strokes (Shift = part of the subject, Alt = background)
 * become hard constraints and the cut is solved again; an edge-aware filter then softens the outline.
 */
let objSelJob = Promise.resolve(null);
function objSelRun() {
  const s = state.objSel; if (!s) return objSelJob;
  setBusy(1); status(s.strokes.length ? 'Object select: refining…' : 'Object select: finding the subject…');
  objSelJob = new Promise((res) => setTimeout(() => {
    try { res(objSelCompute(s)); } catch (err) { reportError('Object select failed', err); res(null); } finally { setBusy(-1); }
  }, 16));
  return objSelJob;
}
function objSelCompute(s) {
  const d = doc(); if (!d || s.doc !== d || state.objSel !== s) return null;
  freshComp();
  const W = d.width, H = d.height, r = s.rect, mx = Math.max(8, r.w * 0.08), my = Math.max(8, r.h * 0.08);
  const x0 = Math.max(0, Math.floor(r.x - mx)), y0 = Math.max(0, Math.floor(r.y - my));
  const x1 = Math.min(W, Math.ceil(r.x + r.w + mx)), y1 = Math.min(H, Math.ceil(r.y + r.h + my)), iw = x1 - x0;
  const img = compCtx.getImageData(x0, y0, iw, y1 - y0), t0 = performance.now();
  const res = seg.objectSelect(img, { x: r.x - x0, y: r.y - y0, w: r.w, h: r.h }, {
    refine: state.opts.objRefine !== false,
    strokes: s.strokes.map((st) => ({ fg: st.fg, r: st.r, pts: st.pts.map(([a, b]) => [a - x0, b - y0]) })),
  });
  const m = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) m.set(res.alpha.subarray((y - y0) * iw, (y - y0 + 1) * iw), y * W + x0);
  s.ms = Math.round(performance.now() - t0);
  const sel = combine(s.base, W, H, m, s.mode), n = s.strokes.length;
  setSelection(sel, sel ? `Object select${n ? ` (refined ×${n})` : ''}${MODE_LABEL[s.mode]}` : 'Deselect');
  status(sel ? `Object select: ${sel.w} × ${sel.h} px in ${s.ms} ms · +Subject / −Background (or Shift / Alt) · Enter keeps · Done + feather softens the edge`
    : 'Object select found nothing: draw a larger box, or paint +Subject over the subject.');
  buildOptionsBar(); requestRender();
  return { sel, ms: s.ms };
}
function objSelDone() { if (!state.objSel) return; state.objSel = null; status('Object select kept.'); buildOptionsBar(); requestRender(); }
/** v1.14: keep the cut-out and feather it in one step (uses the remembered Feather radius). */
/**
 * Keep the cut-out and feather it as **one** undo step (v1.15): the live Object select
 * commits from the box/strokes are squashed into a single “Object select + feather” entry,
 * so Undo returns to the pre-select state instead of a hard unfeathered mask.
 */
async function objSelDoneFeather() {
  if (!state.objSel) return;
  const d = doc(), sel = d?.selection;
  objSelDone();
  if (!sel || doc() !== d) return;
  const radius = Math.max(0.5, Math.min(250, +state.opts.featherRadius || 8));
  setBusy(1);
  try {
    const m = await ops.featherMask(sel.mask, sel.W, sel.H, radius);
    if (doc() !== d) return;
    d.selection = makeSelection(sel.W, sel.H, m);
    const label = `Object select + feather ${radius}px`;
    // Squash consecutive tip “Object select…” history entries into this one feathered commit.
    let i = history.index;
    while (i > 0 && /^Object select/.test(history.entries[i]?.label || '')) i--;
    if (history.index > i && /^Object select/.test(history.entries[history.index]?.label || '')) {
      const last = history.entries[history.index];
      last.label = label;
      last.snap = snapshot();
      history.entries.splice(i + 1, history.index - i, last);
      history.index = i + 1;
      updateHistoryPanel();
      requestRender();
      buildOptionsBar();
    } else {
      commit(label);
    }
    status(`Object select kept and feathered ${radius}px.`);
  } finally { setBusy(-1); }
}
function objSelCancel() {
  const s = state.objSel; if (!s) return; state.objSel = null;
  if (doc() === s.doc && doc().selection !== s.prev) setSelection(s.prev, 'Cancel object select');
  status('Object select cancelled.'); buildOptionsBar(); requestRender();
}
function objSelUndoStroke() { const s = state.objSel; if (!s || !s.strokes.length) return; s.strokes.pop(); objSelRun(); }
function magicWand(p, mode) {
  const d = doc(), x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
  let img;
  if (state.opts.wandSampleAll) {
    freshComp();
    img = compCtx.getImageData(0, 0, d.width, d.height);
  } else {
    const l = activeLayer(), c = makeCanvas(d.width, d.height);
    c.getContext('2d').drawImage(l.canvas, l.x, l.y);
    img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
  }
  const tol = state.opts.wandTolerance;
  const m = state.opts.wandContiguous ? floodMask(img, x, y, tol) : similarMask(img, x, y, tol);
  for (let i = 0; i < m.length; i++) if (m[i]) m[i] = 255;
  applyShape(m, mode, 'Magic wand');
}

const toolHandlers = {
  move: {
    down(p, e) {
      const l = activeLayer(); if (!l) return;
      const now = performance.now(), last = moveLastDown; moveLastDown = { t: now, p };
      const dbl = e.detail >= 2 || (last && now - last.t < 400 && Math.hypot(p.x - last.p.x, p.y - last.p.y) * state.zoom < 6);
      if (dbl && l.kind) { drag = null; moveLastDown = null; editLayer(l); return; } // double-click edits text / adjustment layers
      const many = pickedLayers(doc());
      if (isGroup(l) || many.length > 1) { const set = [...new Set(many.flatMap((m) => blockOf(doc(), m)))]; drag = { start: p, layer: l, moved: false, members: set.map((m) => ({ m, ox: m.x, oy: m.y })) }; return; }
      if (doc().selection && !(l.kind === 'adjust' && !l.mask)) { startFloat(l, p, e.altKey); return; }
      drag = { start: p, ox: l.x, oy: l.y, layer: l, moved: false };
    },
    move(p) {
      if (drag.float) { moveFloat(p); return; }
      if (drag.members) { const dx = Math.round(p.x - drag.start.x), dy = Math.round(p.y - drag.start.y); for (const o of drag.members) { o.m.x = o.ox + dx; o.m.y = o.oy + dy; } }
      else { const l = drag.layer; l.x = Math.round(drag.ox + p.x - drag.start.x); l.y = Math.round(drag.oy + p.y - drag.start.y); }
      drag.moved = true; compDirty = true; requestRender(); buildOptionsBar();
    },
    up() {
      if (drag.float) { endFloat(); return; }
      if (drag.moved) commit('Move layer');
    },
  },
  select: {
    down(p, e) { drag = { start: clampPt(p), moved: false, mode: selModeFor(e) }; },
    move(p) {
      const r = rectFromPoints(drag.start, clampPt(p), false);
      state.selPreview = r.w >= 1 && r.h >= 1 ? { rect: r } : null; drag.moved = true; requestRender();
    },
    up() {
      const r = state.selPreview?.rect; state.selPreview = null;
      if (!drag.moved || !r) { if (drag.mode === 'new' && doc().selection) setSelection(null, 'Deselect'); requestRender(); return; }
      const d = doc();
      applyShape(rectMask(d.width, d.height, r), drag.mode, 'Rectangle select');
    },
  },
  ellipse: {
    down(p, e) { drag = { start: clampPt(p), moved: false, mode: selModeFor(e) }; },
    move(p, e) {
      // Ctrl (Windows/Linux) or Cmd (Mac) = draw from the center
      let r = primaryMod(e) ? rectFromPoints({ x: 2 * drag.start.x - p.x, y: 2 * drag.start.y - p.y }, p, false) : rectFromPoints(drag.start, clampPt(p), false);
      state.selPreview = r.w >= 1 && r.h >= 1 ? { ellipse: r } : null; drag.moved = true; requestRender();
    },
    up() {
      const r = state.selPreview?.ellipse; state.selPreview = null;
      if (!drag.moved || !r) { if (drag.mode === 'new' && doc().selection) setSelection(null, 'Deselect'); requestRender(); return; }
      const d = doc();
      applyShape(shapeMask(d.width, d.height, (x) => x.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2)), drag.mode, 'Ellipse select');
    },
  },
  lasso: {
    down(p, e) { drag = { mode: selModeFor(e), pts: [p] }; state.selPreview = { pts: drag.pts }; },
    move(p) {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * state.zoom >= 2) { drag.pts.push(p); requestRender(); }
    },
    up() {
      state.selPreview = null;
      if (drag.pts.length < 3) { if (drag.mode === 'new' && doc().selection) setSelection(null, 'Deselect'); requestRender(); return; }
      applyShape(polygonMask(drag.pts), drag.mode, 'Lasso');
    },
  },
  polylasso: {
    down(p, e) {
      drag = {};
      if (!state.poly) { state.poly = { pts: [p], mode: selModeFor(e) }; buildOptionsBar(); requestRender(); return; }
      const pts = state.poly.pts, first = pts[0];
      const nearStart = Math.hypot(p.x - first.x, p.y - first.y) * state.zoom < (e.pointerType === 'touch' ? 24 : 8);
      if (e.detail >= 2 || (nearStart && pts.length >= 3)) { finishPolygon(); return; }
      pts.push(p); requestRender();
    },
  },
  wand: { down(p, e) { magicWand(p, selModeFor(e)); } },
  objsel: {
    down(p, e) {
      const s = state.objSel, paint = state.opts.objPaint;
      if (s && s.doc === doc() && (e.shiftKey || e.altKey || paint !== 'box')) { // refine strokes on the current object
        const fg = e.altKey ? false : e.shiftKey ? true : paint === 'fg';
        drag = { objStroke: { fg, r: Math.max(1, state.opts.objBrush / 2), pts: [[p.x, p.y]] } }; s.draft = drag.objStroke; requestRender(); return;
      }
      drag = { start: clampPt(p), moved: false, objBox: true, mode: s ? state.opts.selMode : selModeFor(e) };
    },
    move(p) {
      if (drag?.objStroke) { const a = drag.objStroke.pts, l = a[a.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) * state.zoom >= 2) { a.push([p.x, p.y]); requestRender(); } return; }
      if (!drag?.objBox) return;
      const r = rectFromPoints(drag.start, clampPt(p), false);
      state.selPreview = r.w >= 1 && r.h >= 1 ? { rect: r } : null; drag.moved = true; requestRender();
    },
    up() {
      if (drag?.objStroke) { const s = state.objSel; if (s) { s.draft = null; s.strokes.push(drag.objStroke); objSelRun(); } return; }
      const r = state.selPreview?.rect; state.selPreview = null;
      if (!drag?.moved || !r || r.w * state.zoom < 6 || r.h * state.zoom < 6) { requestRender(); status('Object select: drag a box around the subject.'); return; }
      const d = doc();
      state.objSel = { doc: d, rect: r, strokes: [], base: drag.mode === 'new' ? null : d.selection, prev: d.selection, mode: drag.mode };
      // v1.14: after the box, sticky “+ Subject” so mouse users refine without holding Shift
      if (state.opts.objPaint === 'box') state.opts.objPaint = 'fg';
      buildOptionsBar();
      objSelRun();
    },
  },
  crop: {
    down(p) { drag = { start: clampPt(p) }; },
    move(p, e) { const a = cropAspect(), d = doc(); state.crop = a ? constrainRect(drag.start, clampPt(p), a.w, a.h, { w: d.width, h: d.height }) : rectFromPoints(drag.start, clampPt(p), e.shiftKey); buildOptionsBar(); requestRender(); },
    up() { if (state.crop && (state.crop.w < 2 || state.crop.h < 2)) state.crop = null; buildOptionsBar(); requestRender(); },
  },
  brush: paintTool('brush'),
  eraser: paintTool('eraser'),
  clone: paintTool('clone'),
  heal: paintTool('heal'),
  spot: paintTool('spot'),
  fill: { down(p) { fillAt(p); } },
  tone: paintTool('tone'),
  redeye: { down(p) { redEyeAt(p); } },
  get liquify() { return liquifyTool; },
  gradient: {
    down(p) { const l = activeLayer(); if (!l) return; drag = { a: p, b: p }; state.gradPreview = drag; },
    move(p, e) { drag.b = e.shiftKey ? snap45(drag.a, p) : p; requestRender(); },
    up() {
      const g = state.gradPreview; state.gradPreview = null; requestRender();
      if (!g || Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * state.zoom < 3) return;
      applyGradient(g.a, g.b);
    },
  },
  shape: {
    down(p) { if (!doc()) return; drag = { a: p, b: p, mods: {} }; state.shapePreview = shapeGeom(drag); },
    move(p, e) { drag.b = p; drag.mods = { square: e.shiftKey, center: primaryMod(e) }; state.shapePreview = shapeGeom(drag); requestRender(); },
    up() {
      const g = state.shapePreview; state.shapePreview = null; requestRender();
      if (!g || (g.kind === 'line' ? Math.hypot(g.x2 - g.x1, g.y2 - g.y1) : Math.min(g.w, g.h)) * state.zoom < 2) return;
      addShapeLayer(g);
    },
  },
  eyedropper: { down(p) { drag = {}; pickColor(p); }, move(p) { pickColor(p); } },
  straighten: { down: (p, e) => straightenTool.down(p, e), move: (p, e) => straightenTool.move(p, e), up: (p, e) => straightenTool.up(p, e) },
  wbpick: { down: (p) => wbPickTool.down(p) },
  text: { down(p) { const hit = textLayerAt(p); if (hit) { doc().activeId = hit.id; openTextDialog(null, hit); } else openTextDialog(p); } },
  zoom: { down(p, e) { const r = view.getBoundingClientRect(); zoomAt(e.altKey ? 1 / 1.5 : 1.5, e.clientX - r.left, e.clientY - r.top); } },
};

// --- Free transform (Ctrl+T): scale, rotate and skew a layer or the selected pixels -------------
// The piece's local box (0..w, 0..h) maps to the document through M = T(c) · R(rot) · Skew(kx, ky) · S(sx, sy) · T(−w/2, −h/2).
function xfFrame(x) { // R · Sk as a 2×2 matrix
  const c = Math.cos(x.rot), s = Math.sin(x.rot);
  return { a: c - s * x.ky, b: s + c * x.ky, c: c * x.kx - s, d: s * x.kx + c };
}
function xfMatrix(x) {
  const F = xfFrame(x), a = F.a * x.sx, b = F.b * x.sx, c = F.c * x.sy, d = F.d * x.sy;
  return { a, b, c, d, e: x.cx - (a * x.w / 2 + c * x.h / 2), f: x.cy - (b * x.w / 2 + d * x.h / 2) };
}
const applyM = (m, x, y) => ({ x: m.a * x + m.c * y + (m.e || 0), y: m.b * x + m.d * y + (m.f || 0) });
function invertM(m) {
  const det = m.a * m.d - m.b * m.c || 1e-9, e = m.e || 0, f = m.f || 0;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * f - m.d * e) / det, f: (m.b * e - m.a * f) / det };
}
const XF_KEYS = ['cx', 'cy', 'sx', 'sy', 'rot', 'kx', 'ky'];
const xfParams = (x) => Object.fromEntries(XF_KEYS.map((k) => [k, x[k]]));
function startTransform() {
  const d = doc(), l = activeLayer();
  if (!l || state.xf) return;
  if (isGroup(l) || pickedLayers(d).length > 1) { startMultiTransform(); return; }
  if (l.kind === 'adjust') { status('Adjustment layers have no pixels to transform (transform the layers below instead).'); return; }
  if (state.crop) { state.crop = null; }
  const sel = d.selection;
  if (l.kind === 'text') rasterize(l, 'the transform');
  if (sel && !editingMask(l)) rasterize(l, 'transforming selected pixels');
  const x = { layer: l, sel, onMask: false, base: null, bx: 0, by: 0, maskBase: null, rx: 0, ry: 0, rot: 0, sx: 1, sy: 1, kx: 0, ky: 0 };
  if (sel) {
    ensureCoversDoc(l);
    const cv = targetCanvas(l);
    const piece = makeCanvas(sel.w, sel.h), px = piece.getContext('2d');
    px.drawImage(cv, l.x - sel.x, l.y - sel.y);
    px.globalCompositeOperation = 'destination-in'; px.drawImage(selectionCanvas(sel), -sel.x, -sel.y);
    const base = cloneCanvas(cv), bc = base.getContext('2d');
    bc.globalCompositeOperation = 'destination-out'; bc.drawImage(selectionCanvas(sel), -l.x, -l.y);
    Object.assign(x, { piece, base, bx: l.x, by: l.y, w: sel.w, h: sel.h, cx: sel.x + sel.w / 2, cy: sel.y + sel.h / 2, onMask: editingMask(l) });
    if (!x.onMask && l.mask) x.maskBase = cloneCanvas(l.mask.canvas);
  } else {
    // the box hugs the layer's visible pixels (masks need the whole canvas so nothing is cut off)
    const hasMasks = l.mask || (l.kind === 'smart' && l.fmask);
    const t = hasMasks ? { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height } : alphaBounds(l.kind === 'smart' ? l.source : l.canvas);
    if (!t) { status('This layer is empty: nothing to transform.'); return; }
    const crop = (c) => { const k = makeCanvas(t.w, t.h); k.getContext('2d').drawImage(c, -t.x, -t.y); return k; };
    Object.assign(x, {
      trim: t, piece: crop(l.canvas), w: t.w, h: t.h, cx: l.x + t.x + t.w / 2, cy: l.y + t.y + t.h / 2, rawSame: !!l.raw && l.raw.rev === l.rev,
      maskPiece: l.mask ? cloneCanvas(l.mask.canvas) : null, fmaskPiece: l.kind === 'smart' && l.fmask ? cloneCanvas(l.fmask.canvas) : null,
      sourcePiece: l.kind === 'smart' ? crop(l.source) : null,
    });
  }
  x.start = xfParams(x);
  state.xf = x; drag = null;
  previewTransform(); buildOptionsBar(); requestRender();
  status('Free transform: drag the handles; Enter applies, Esc cancels.');
}
/** Free transform of a group and/or several selected layers: one box around all of them; every layer is
 * re-rendered from its own untouched copy with the shared matrix (M ∘ its offset inside the box). */
function startMultiTransform() {
  const d = doc(); if (state.crop) state.crop = null;
  const leaves = transformLeaves(d);
  if (!leaves.length) { status('Nothing to transform: the selected layers have no pixels.'); return; }
  if (d.selection) status('Transforming whole layers (the selection is ignored with several layers or a group).');
  const parts = [];
  for (const l of leaves) {
    rasterize(l, 'the transform');
    const t = l.mask ? { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height } : alphaBounds(l.canvas); if (!t) continue;
    const piece = makeCanvas(t.w, t.h); piece.getContext('2d').drawImage(l.canvas, -t.x, -t.y);
    parts.push({ layer: l, piece, w: t.w, h: t.h, dx: l.x + t.x, dy: l.y + t.y, tx: t.x, ty: t.y, rawSame: !!l.raw && l.raw.rev === l.rev, maskPiece: l.mask ? cloneCanvas(l.mask.canvas) : null });
  }
  if (!parts.length) { status('Nothing to transform: the selected layers are empty.'); return; }
  const x0 = Math.min(...parts.map((p) => p.dx)), y0 = Math.min(...parts.map((p) => p.dy));
  const x1 = Math.max(...parts.map((p) => p.dx + p.w)), y1 = Math.max(...parts.map((p) => p.dy + p.h));
  for (const p of parts) { p.ox = p.dx - x0; p.oy = p.dy - y0; }
  const x = { layer: activeLayer(), parts, sel: null, onMask: false, base: null, bx: 0, by: 0, maskBase: null, rx: 0, ry: 0, rot: 0, sx: 1, sy: 1, kx: 0, ky: 0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  x.start = xfParams(x);
  state.xf = x; drag = null;
  previewTransform(); buildOptionsBar(); requestRender();
  status(`Free transform: ${parts.length} layer${parts.length === 1 ? '' : 's'}; Enter applies, Esc cancels.`);
}
/** Pixel layers moved by a transform of the picked layers / active group (group contents included). */
function transformLeaves(d) {
  const out = [], seen = new Set();
  for (const r of pickedLayers(d)) for (const l of blockOf(d, r)) if (!seen.has(l) && !isGroup(l) && l.kind !== 'adjust') { seen.add(l); out.push(l); }
  return out;
}
const mulOffset = (M, ox, oy) => ({ a: M.a, b: M.b, c: M.c, d: M.d, e: M.a * ox + M.c * oy + M.e, f: M.b * ox + M.d * oy + M.f });
/** Draw `src` (local box) transformed by M into a new canvas whose origin is (ox, oy) in the document. */
function drawTransformed(src, M, ox, oy, w, h, under = null, ux = 0, uy = 0) {
  const c = makeCanvas(w, h), x = c.getContext('2d');
  if (under) x.drawImage(under, ux - ox, uy - oy);
  x.save(); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.setTransform(M.a, M.b, M.c, M.d, M.e - ox, M.f - oy); x.drawImage(src, 0, 0); x.restore();
  return c;
}
function xfBounds(x, M) {
  const d = doc(), pts = [[0, 0], [x.w, 0], [x.w, x.h], [0, x.h]].map(([u, v]) => applyM(M, u, v));
  let x0 = Math.floor(Math.min(...pts.map((p) => p.x))), y0 = Math.floor(Math.min(...pts.map((p) => p.y)));
  let x1 = Math.ceil(Math.max(...pts.map((p) => p.x))), y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  // never allocate far beyond the document (memory on phones)
  x0 = Math.max(x0, -d.width); y0 = Math.max(y0, -d.height); x1 = Math.min(x1, 2 * d.width); y1 = Math.min(y1, 2 * d.height);
  return { x0, y0, x1: Math.max(x1, x0 + 1), y1: Math.max(y1, y0 + 1) };
}
/** Re-render the transformed piece into the layer (pixels, mask or filter mask). */
function previewTransform() {
  const x = state.xf; if (!x) return;
  const l = x.layer, M = xfMatrix(x);
  if (x.parts) {
    for (const p of x.parts) {
      const Mp = mulOffset(M, p.ox, p.oy), { x0, y0, x1, y1 } = xfBounds({ w: p.w, h: p.h }, Mp), w = x1 - x0, h = y1 - y0, L = p.layer;
      L.canvas = drawTransformed(p.piece, Mp, x0, y0, w, h);
      if (p.maskPiece) { L.mask.canvas = drawTransformed(p.maskPiece, Mp, x0, y0, w, h); touchMask(L); }
      L.x = x0; L.y = y0; touch(L);
    }
    compDirty = true; return;
  }
  if (x.base && x.onMask) { // selected part of a (filter) mask: the mask keeps its size
    const out = drawTransformed(x.piece, M, x.bx, x.by, x.base.width, x.base.height, x.base, x.bx, x.by);
    if (editingFMask(l)) { l.fmask.canvas = out; touchTarget(l); } else { l.mask.canvas = out; touchMask(l); }
    compDirty = true; return;
  }
  let { x0, y0, x1, y1 } = xfBounds(x, M);
  if (x.base) { x0 = Math.min(x0, x.bx); y0 = Math.min(y0, x.by); x1 = Math.max(x1, x.bx + x.base.width); y1 = Math.max(y1, x.by + x.base.height); }
  const w = x1 - x0, h = y1 - y0;
  l.canvas = drawTransformed(x.piece, M, x0, y0, w, h, x.base, x.bx, x.by);
  if (x.base && x.maskBase) { // keep the layer mask where it was; new area is revealed
    const m = makeMaskCanvas(w, h), mx = m.getContext('2d');
    mx.clearRect(x.bx - x0, x.by - y0, x.maskBase.width, x.maskBase.height); mx.drawImage(x.maskBase, x.bx - x0, x.by - y0);
    l.mask.canvas = m; touchMask(l);
  }
  if (!x.base) {
    if (x.maskPiece) { l.mask.canvas = drawTransformed(x.maskPiece, M, x0, y0, w, h); touchMask(l); }
    if (x.fmaskPiece) { l.fmask.canvas = drawTransformed(x.fmaskPiece, M, x0, y0, w, h); l.fmask.rev = ++globalRev; }
  }
  l.x = x0; l.y = y0; touch(l); compDirty = true;
}
/** Bounding box of the non-transparent pixels of a canvas, or null when it is empty. */
function alphaBounds(c) {
  const w = c.width, h = c.height, a = ctxOf(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4) if (a[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function xfIsIdentity(x) { return XF_KEYS.every((k) => Math.abs(x[k] - x.start[k]) < 1e-6); }
function applyTransform() {
  const x = state.xf; if (!x) return;
  if (xfIsIdentity(x)) { cancelTransform(true); return; }
  state.xf = null; drag = null;
  const l = x.layer, M = xfMatrix(x), d = doc();
  if (x.sel) { // the selection follows the pixels
    const sc = makeCanvas(d.width, d.height), c = sc.getContext('2d');
    c.save(); c.imageSmoothingEnabled = true; c.setTransform(M.a, M.b, M.c, M.d, M.e, M.f);
    c.drawImage(selectionCanvas(x.sel), x.sel.x, x.sel.y, x.w, x.h, 0, 0, x.w, x.h); c.restore();
    const a = ctxOf(sc).getImageData(0, 0, d.width, d.height).data, m = new Uint8Array(d.width * d.height);
    for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
    d.selection = makeSelection(d.width, d.height, m);
  } else if (l.kind === 'smart') { // live layers: transform the original pixels and re-run the filters
    l.source = drawTransformed(x.sourcePiece, M, l.x, l.y, l.canvas.width, l.canvas.height);
    renderSmartSync(l);
  }
  // RAW layers stay re-developable: new pixel → document → piece (M⁻¹) → old pixel (piece offset in the old canvas)
  const rawXf = (L, Mx, tx, ty, same) => { if (L.raw) trackRaw(L, affineCompose({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }, affineCompose(invertM(Mx), { a: 1, b: 0, c: 0, d: 1, e: L.x, f: L.y })), same); };
  if (x.parts) for (const p of x.parts) rawXf(p.layer, mulOffset(M, p.ox, p.oy), p.tx, p.ty, p.rawSame);
  else if (!x.sel && x.trim && l.kind !== 'smart') rawXf(l, M, x.trim.x, x.trim.y, x.rawSame);
  else if (x.sel && !x.onMask && l.raw) l.raw = { ...l.raw, untracked: 'a transform of selected pixels' };
  compDirty = true; requestRender();
  commit(x.sel ? 'Transform selection' : 'Free transform');
  buildOptionsBar(); updateLayersPanel();
  const deg = Math.round((x.rot * 180) / Math.PI * 10) / 10;
  status(`Transformed: ${Math.round(x.sx * 100)}% × ${Math.round(x.sy * 100)}%, ${deg}°`);
}
function cancelTransform(quiet = false) {
  if (!state.xf) return;
  state.xf = null; drag = null;
  restore(history.index); // the transform never touched history: put the last state back
  buildOptionsBar(); requestRender();
  if (!quiet) status('Transform cancelled');
}
function xfRotHandle(x, M) {
  const top = applyM(M, x.w / 2, 0);
  let dx = top.x - x.cx, dy = top.y - x.cy; const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = Math.sin(x.rot); dy = -Math.cos(x.rot); } else { dx /= len; dy /= len; }
  const off = (IS_TOUCH ? 34 : 24) / state.zoom;
  return { x: top.x + dx * off, y: top.y + dy * off, top };
}
const XF_HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const xfHandlePoints = (x, M) => XF_HANDLES.map(([u, v]) => ({ u, v, ...applyM(M, ((u + 1) / 2) * x.w, ((v + 1) / 2) * x.h) }));
function drawTransformBox(toS) {
  const x = state.xf, M = xfMatrix(x);
  const quad = [[0, 0], [x.w, 0], [x.w, x.h], [0, x.h]].map(([u, v]) => { const p = applyM(M, u, v); return toS(p.x, p.y); });
  const rh = xfRotHandle(x, M), [rx, ry] = toS(rh.x, rh.y), [tx, ty] = toS(rh.top.x, rh.top.y);
  vctx.save();
  vctx.beginPath(); quad.forEach(([a, b], i) => (i ? vctx.lineTo(a, b) : vctx.moveTo(a, b))); vctx.closePath();
  vctx.moveTo(tx, ty); vctx.lineTo(rx, ry);
  vctx.lineWidth = 3; vctx.strokeStyle = '#000a'; vctx.stroke(); vctx.lineWidth = 1; vctx.strokeStyle = '#fff'; vctx.stroke();
  const hs = IS_TOUCH ? 7 : 4.5;
  for (const h of xfHandlePoints(x, M)) {
    const [hx, hy] = toS(h.x, h.y);
    vctx.fillStyle = '#fff'; vctx.strokeStyle = '#1b1c20'; vctx.lineWidth = 1.5;
    vctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2); vctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2);
  }
  vctx.beginPath(); vctx.arc(rx, ry, hs + 1, 0, Math.PI * 2); vctx.fillStyle = '#7a5cff'; vctx.fill(); vctx.strokeStyle = '#fff'; vctx.stroke();
  const [ccx, ccy] = toS(x.cx, x.cy); // centre mark
  vctx.beginPath(); vctx.moveTo(ccx - 5, ccy); vctx.lineTo(ccx + 5, ccy); vctx.moveTo(ccx, ccy - 5); vctx.lineTo(ccx, ccy + 5);
  vctx.strokeStyle = '#fff'; vctx.lineWidth = 1; vctx.stroke();
  vctx.restore();
}
function xfHit(p, e) {
  const x = state.xf, M = xfMatrix(x), tol = (e.pointerType === 'touch' ? 22 : 9) / state.zoom;
  const rh = xfRotHandle(x, M);
  if (Math.hypot(p.x - rh.x, p.y - rh.y) <= tol) return { kind: 'rotate' };
  let best = null, bd = tol;
  for (const h of xfHandlePoints(x, M)) { const dd = Math.hypot(p.x - h.x, p.y - h.y); if (dd <= bd) { bd = dd; best = h; } }
  if (best) {
    const edge = (best.u === 0) !== (best.v === 0);
    return { kind: edge && (primaryMod(e) || state.opts.xfSkew) ? 'skew' : 'scale', u: best.u, v: best.v };
  }
  const q = applyM(invertM(M), p.x, p.y);
  return q.x >= 0 && q.y >= 0 && q.x <= x.w && q.y <= x.h ? { kind: 'move' } : { kind: 'rotate' };
}
function xfDrag(p, e) {
  const x = state.xf, g = drag.hit, s0 = drag.s0;
  Object.assign(x, s0);
  if (g.kind === 'move') {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    x.cx = s0.cx + dx; x.cy = s0.cy + dy;
  } else if (g.kind === 'rotate') {
    const a0 = Math.atan2(drag.start.y - s0.cy, drag.start.x - s0.cx), a1 = Math.atan2(p.y - s0.cy, p.x - s0.cx);
    let r = s0.rot + a1 - a0;
    if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
    x.rot = r;
  } else if (g.kind === 'scale') {
    const F = xfFrame(x), Fi = invertM(F), fromCentre = e.altKey;
    // anchor: the opposite handle (or the centre with Alt), in the document
    const al = fromCentre ? { x: 0, y: 0 } : { x: (-g.u * s0.sx * x.w) / 2, y: (-g.v * s0.sy * x.h) / 2 };
    const anchor = { x: s0.cx + F.a * al.x + F.c * al.y, y: s0.cy + F.b * al.x + F.d * al.y };
    const q = applyM(Fi, p.x - anchor.x, p.y - anchor.y), span = fromCentre ? 0.5 : 1;
    let sx = g.u ? q.x / (g.u * x.w * span) : s0.sx, sy = g.v ? q.y / (g.v * x.h * span) : s0.sy;
    if (e.shiftKey || state.opts.xfKeepAspect) {
      if (g.u && g.v) { const kx = sx / s0.sx, ky = sy / s0.sy, k = Math.abs(kx) > Math.abs(ky) ? kx : ky; sx = s0.sx * k; sy = s0.sy * k; }
      else if (g.u) sy = s0.sy * (sx / s0.sx); else sx = s0.sx * (sy / s0.sy);
    }
    const clampS = (v) => (Math.abs(v) < 0.01 ? 0.01 * (Math.sign(v) || 1) : v);
    x.sx = clampS(sx); x.sy = clampS(sy);
    if (!fromCentre) {
      const cl = { x: (g.u * x.sx * x.w) / 2, y: (g.v * x.sy * x.h) / 2 };
      x.cx = anchor.x + F.a * cl.x + F.c * cl.y; x.cy = anchor.y + F.b * cl.x + F.d * cl.y;
    }
  } else if (g.kind === 'skew') {
    const c = Math.cos(s0.rot), s = Math.sin(s0.rot), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    const lx = c * dx + s * dy, ly = -s * dx + c * dy; // pointer movement in the unrotated frame
    if (g.v) x.kx = s0.kx + lx / ((g.v * s0.sy * x.h) / 2);
    else x.ky = s0.ky + ly / ((g.u * s0.sx * x.w) / 2);
    x.kx = Math.max(-5, Math.min(5, x.kx)); x.ky = Math.max(-5, Math.min(5, x.ky));
  }
}
const xfHandler = {
  down(p, e) {
    const hit = xfHit(p, e);
    if (e.detail >= 2 && hit.kind === 'move') { applyTransform(); return; } // double-click / double-tap inside applies
    drag = { xf: true, hit, start: p, s0: xfParams(state.xf) };
  },
  move(p, e) { if (!drag?.xf) return; xfDrag(p, e); previewTransform(); updateXfFields(); requestRender(); },
  up() { drag = null; updateXfFields(); },
};
const samplerHandler = { down: (p) => colorRangeSampler?.(p.x, p.y) };
const GROUP_PIXEL_TOOLS = new Set(['brush', 'eraser', 'clone', 'heal', 'spot', 'tone', 'redeye', 'gradient', 'fill', 'liquify']);
const GROUP_MASK_TOOLS = new Set(['brush', 'eraser', 'gradient', 'fill']);
function toolHandler() {
  const l = activeLayer(), t = state.tool;
  if (isGroup(l) && GROUP_PIXEL_TOOLS.has(t) && !(GROUP_MASK_TOOLS.has(t) && l.mask)) {
    return { down: () => { drag = null; status(l.mask ? 'This tool needs pixels: select a layer inside the group (a group only has its mask to paint on).' : 'Groups have no pixels of their own: select a layer inside the group, or add a group mask to paint on.'); } };
  }
  return toolHandlers[t];
}
const handler = () => (colorRangeSampler ? samplerHandler : state.mxf ? mxfHandler : state.xf ? xfHandler : toolHandler());
function setXfField(k, v) {
  const x = state.xf; if (!x || !Number.isFinite(v)) return;
  if (k === 'sx' || k === 'sy') {
    let sv = v / 100; if (Math.abs(sv) < 0.01) sv = 0.01 * (Math.sign(sv) || 1);
    if (state.opts.xfKeepAspect) { const r = sv / x[k]; x.sx *= r; x.sy *= r; } else x[k] = sv;
  } else if (k === 'rot') x.rot = (v * Math.PI) / 180;
  else x[k] = Math.tan((Math.max(-80, Math.min(80, v)) * Math.PI) / 180);
  previewTransform(); updateXfFields(); requestRender();
}
const xfFieldValues = (x) => ({
  sx: Math.round(x.sx * 1000) / 10, sy: Math.round(x.sy * 1000) / 10, rot: Math.round((x.rot * 1800) / Math.PI) / 10,
  kx: Math.round((Math.atan(x.kx) * 1800) / Math.PI) / 10, ky: Math.round((Math.atan(x.ky) * 1800) / Math.PI) / 10,
});
function updateXfFields() {
  if (!state.xf) return; const v = xfFieldValues(state.xf);
  document.querySelectorAll('#optionsbar [data-xf]').forEach((i) => { if (document.activeElement !== i) i.value = v[i.dataset.xf]; });
}
function xfBarParts() {
  const v = xfFieldValues(state.xf), o = state.opts;
  const num = (k, label, unit) => `<label>${label} <input type="number" class="xf-num" data-xf="${k}" step="${k === 'sx' || k === 'sy' ? 1 : 0.5}" value="${v[k]}" />${unit}</label>`;
  return [`<span class="tool-title">${state.xf.sel ? 'Transform selection' : 'Free transform'}</span>`,
    num('sx', 'W', '%'), num('sy', 'H', '%'), num('rot', 'Angle', '°'), num('kx', 'Skew H', '°'), num('ky', 'V', '°'),
    `<label><input type="checkbox" data-opt="xfKeepAspect" ${o.xfKeepAspect ? 'checked' : ''}/> Keep aspect</label>`,
    `<label><input type="checkbox" data-opt="xfSkew" ${o.xfSkew ? 'checked' : ''}/> Skew edges</label>`,
    `<button data-cmd="xfApply" class="primary">Apply</button>`, `<button data-cmd="xfCancel">Cancel</button>`,
    `<span class="muted">${IS_TOUCH ? 'Drag handles · pinch/rotate with two fingers · ⇧ keeps aspect' : 'Shift keeps aspect · Alt from centre · drag outside to rotate · Ctrl+edge skews · Enter / Esc'}</span>`];
}

function clampPt(p) {
  return { x: Math.max(0, Math.min(doc().width, Math.round(p.x))), y: Math.max(0, Math.min(doc().height, Math.round(p.y))) };
}
let moveLastDown = null, nudgeTimer = 0;
// --- moving selected pixels (Move tool with an active selection; Alt = move a copy) ---
function startFloat(l, p, copy) {
  if (!editingMask(l)) rasterize(l, 'moving pixels');
  ensureCoversDoc(l);
  const sel = doc().selection, cv = targetCanvas(l), c = ctxOf(cv);
  const piece = makeCanvas(sel.w, sel.h), px = piece.getContext('2d');
  px.drawImage(cv, l.x - sel.x, l.y - sel.y);
  px.globalCompositeOperation = 'destination-in'; px.drawImage(selectionCanvas(sel), -sel.x, -sel.y);
  const original = cloneCanvas(cv);
  if (!copy) { c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(selectionCanvas(sel), -l.x, -l.y); c.restore(); }
  const base = copy ? original : cloneCanvas(cv);
  drag = { float: { layer: l, piece, base, original, sel, copy, start: p, dx: 0, dy: 0, onMask: editingMask(l) }, moved: false };
  touchTarget(l); requestRender();
}
function moveFloat(p) {
  const f = drag.float, l = f.layer;
  f.dx = Math.round(p.x - f.start.x); f.dy = Math.round(p.y - f.start.y); drag.moved = true;
  const c = ctxOf(targetCanvas(l));
  c.save(); c.globalCompositeOperation = 'copy'; c.drawImage(f.base, 0, 0); c.restore();
  c.drawImage(f.piece, f.sel.x + f.dx - l.x, f.sel.y + f.dy - l.y);
  touchTarget(l); requestRender(); status(`Moving selection: ${f.dx >= 0 ? '+' : ''}${f.dx}, ${f.dy >= 0 ? '+' : ''}${f.dy} px`);
}
function endFloat() {
  const f = drag.float, l = f.layer; drag = null;
  if (!f.dx && !f.dy) { // no movement: put everything back
    const c = ctxOf(targetCanvas(l)); c.save(); c.globalCompositeOperation = 'copy'; c.drawImage(f.original, 0, 0); c.restore();
    touchTarget(l); requestRender(); return;
  }
  doc().selection = translateSelection(f.sel, f.dx, f.dy);
  commit(f.copy ? 'Duplicate selection' : 'Move selection'); updateLayersPanel(); buildOptionsBar();
}
function rectFromPoints(a, b, square) {
  let w = b.x - a.x, h = b.y - a.y;
  if (square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  const x = Math.min(a.x, a.x + w), y = Math.min(a.y, a.y + h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) };
}

/** Brush, eraser and clone stamp share the same stroke machinery. */
function paintTool(kind) {
  const erase = kind === 'eraser', clone = kind === 'clone' || kind === 'heal', heal = kind === 'heal' || kind === 'spot';
  const LABEL = { brush: 'Brush stroke', eraser: 'Eraser', clone: 'Clone stamp', heal: 'Healing brush', spot: 'Spot healing', tone: 'Dodge / burn' };
  return {
    down(p, e) {
      const layer = activeLayer(); if (!layer) return;
      if (!layer.visible) { status('The active layer is hidden. Show it to paint.'); return; }
      if (clone) {
        if (e.altKey) { state.cloneSrc = { x: p.x, y: p.y }; state.cloneOffset = null; status(`Clone source set at ${Math.round(p.x)}, ${Math.round(p.y)}`); buildOptionsBar(); requestRender(); return; }
        if (!state.cloneSrc) { status('Alt+click to set a source point first.'); return; }
      }
      if ((clone || heal || kind === 'tone') && editingMask(layer)) { status('This tool paints layer pixels. Click the layer thumbnail to target pixels.'); return; }
      if (e.altKey && kind === 'brush') { pickColor(p); return; }
      if (!editingMask(layer)) rasterize(layer, 'painting');
      ensureCoversDoc(layer);
      const o = state.opts;
      const size = o[`${kind}Size`];
      const hardness = o[`${kind}Hardness`] / 100;
      const onMask = editingMask(layer);
      const canvas = targetCanvas(layer);
      drag = {
        layer, erase, clone, heal, kind, onMask, canvas, size, bb: null,
        opacity: o[`${kind}Opacity`] / 100,
        lum: onMask && !erase ? luminance(state.fg) : 0,
        backup: cloneCanvas(canvas),
        stroke: makeCanvas(canvas.width, canvas.height),
        tmp: doc().selection || clone ? makeCanvas(canvas.width, canvas.height) : null,
        stamp: makeStamp(size, hardness, kind === 'spot' ? '#3a3f4a' : erase || clone || onMask || kind === 'tone' ? '#ffffff' : state.fg),
        // dodge / burn: Alt flips the mode for this stroke
        tone: kind === 'tone' ? { burn: (o.toneMode === 'burn') !== !!e.altKey, range: o.toneRange } : null,
        last: null, dirty: null, hardness,
        stampColor: kind === 'spot' ? '#3a3f4a' : erase || clone || onMask || kind === 'tone' ? '#ffffff' : state.fg,
        // large brushes stamp on the GPU (WebGPU with synchronous output); everything else uses Canvas 2D
        gpuDabs: kind !== 'tone' && size >= GPU_DAB_MIN && gfx.engine?.kind === 'webgpu' && gfx.engine.syncOutput && !gfx.engine.lost ? [] : null,
        lazy: { x: p.x, y: p.y }, // stabilizer ("lazy mouse") position
      };
      if (kind === 'tone' && useDeep(layer)) { drag.deep0 = deepOf(layer); drag.deepOut = cloneDeep(drag.deep0); } // 16-bit dodge / burn
      gfx.dabPath = drag.gpuDabs ? 'webgpu' : 'cpu';
      if (clone) {
        if (!o.cloneAligned || !state.cloneOffset) state.cloneOffset = { dx: state.cloneSrc.x - p.x, dy: state.cloneSrc.y - p.y };
        drag.dx = state.cloneOffset.dx; drag.dy = state.cloneOffset.dy;
        drag.srcTmp = makeCanvas(canvas.width, canvas.height);
      }
      if (e.shiftKey && lastPaintPoint && !clone && !heal) stampLine(lastPaintPoint, p);
      else stampAt(p);
      drag.last = p;
      applyStroke();
    },
    move(p) {
      if (!drag?.stroke) return;
      const q = stabilize(p); if (!q) return;
      stampLine(drag.last, q); drag.last = q; applyStroke();
    },
    up() {
      if (!drag?.stroke) return;
      if (state.opts.smoothing > 0 && drag.hover && (drag.hover.x !== drag.last.x || drag.hover.y !== drag.last.y)) { stampLine(drag.last, drag.hover); drag.last = drag.hover; applyStroke(); } // catch up
      lastPaintPoint = drag.last;
      if (drag.heal) { finishHeal(drag); return; }
      touchTarget(drag.layer);
      if (drag.deepOut) { const l = drag.layer; l.deep = drag.deepOut; l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0; }
      commit(drag.onMask ? (erase ? 'Erase mask' : 'Paint mask') : kind === 'tone' ? (drag.tone.burn ? 'Burn' : 'Dodge') : LABEL[kind]);
      updateLayersPanel();
    },
  };
}
const GPU_DAB_MIN = 200; // px: below this the Canvas 2D stamp is already cheap
/**
 * Stroke stabilizer (original "string" model): the brush tip trails the pointer on a string whose length
 * grows with Options ▸ Smoothing (0–100 → 0–60 screen px). The tip moves only when the string is taut,
 * which removes hand jitter without the lag of averaging; the stroke catches up on release.
 * Returns the new tip position, or null if it did not move.
 */
function stabilize(p) {
  drag.hover = p;
  const sm = state.opts.smoothing || 0; if (sm <= 0) return p;
  const len = (sm * 0.6) / state.zoom, z = drag.lazy, dx = p.x - z.x, dy = p.y - z.y, d = Math.hypot(dx, dy);
  if (d <= len) return null;
  const k = (d - len) / d; z.x += dx * k; z.y += dy * k;
  return { x: z.x, y: z.y };
}
function stampAt(p) {
  const s = drag.stamp, l = drag.layer;
  // sub-pixel placement: the stamp is drawn at the exact fractional position (no rounding)
  const x = p.x - l.x - s.width / 2, y = p.y - l.y - s.height / 2;
  if (drag.gpuDabs) drag.gpuDabs.push(p.x - l.x, p.y - l.y, drag.size / 2, drag.hardness);
  else drag.stroke.getContext('2d').drawImage(s, x, y);
  const b = drag.bb;
  drag.bb = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x + s.width), y1: Math.max(b.y1, y + s.height) } : { x0: x, y0: y, x1: x + s.width, y1: y + s.height };
  const r = drag.dirty;
  drag.dirty = r ? { x0: Math.min(r.x0, x), y0: Math.min(r.y0, y), x1: Math.max(r.x1, x + s.width), y1: Math.max(r.y1, y + s.height) } : { x0: x, y0: y, x1: x + s.width, y1: y + s.height };
}
/** Flush queued GPU dabs into the stroke canvas (region = the dirty rectangle). */
function flushGpuDabs(rect) {
  const list = drag.gpuDabs; if (!list || !list.length) return;
  const n = list.length / 4, e = gfx.engine;
  try {
    if (!e || e.lost || e.kind !== 'webgpu') throw new Error('engine gone');
    e.stampDabs(drag.stroke, rect, new Float32Array(list), new Float32Array(n).fill(1), { color: hexToRgb(drag.stampColor) });
    gfx.dabPath = 'webgpu';
  } catch (err) {
    console.warn('GPU dabs failed; using Canvas 2D', err);
    const c = drag.stroke.getContext('2d'), s = drag.stamp;
    for (let i = 0; i < list.length; i += 4) c.drawImage(s, list[i] - s.width / 2, list[i + 1] - s.height / 2);
    drag.gpuDabs = null; gfx.dabPath = 'cpu';
  }
  if (drag.gpuDabs) drag.gpuDabs.length = 0;
}
/**
 * Dodge (lighten) / burn (darken) inside the stroke coverage: a gamma curve whose strength follows coverage ×
 * exposure × a tonal-range weight (shadows, midtones or highlights). Alpha is preserved.
 */
function toneRect(c, cover, rx, ry, rw, rh) {
  if (drag.deep0) return toneRectDeep(c, cover, rx, ry, rw, rh);
  const src = ctxOf(drag.backup).getImageData(rx, ry, rw, rh), d = src.data;
  const cv = cover.getContext('2d', { willReadFrequently: true }).getImageData(rx, ry, rw, rh).data;
  const { burn, range } = drag.tone, k0 = drag.opacity;
  for (let i = 0; i < d.length; i += 4) {
    const a = cv[i + 3]; if (!a || !d[i + 3]) continue;
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    const w = range === 'shadows' ? (1 - L) * (1 - L) : range === 'highlights' ? L * L : 1;
    const k = (a / 255) * k0 * w; if (k <= 0) continue;
    const g = burn ? 1 + k : 1 / (1 + k);
    for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.round(255 * Math.pow(d[i + ch] / 255, g));
  }
  c.putImageData(src, rx, ry);
}
/** 16-bit dodge / burn: reads the stroke's 16-bit starting data, writes 16-bit results and their 8-bit proxy. */
function toneRectDeep(c, cover, rx, ry, rw, rh) {
  const s0 = drag.deep0.data, so = drag.deepOut.data, W = drag.deep0.width;
  const img = c.createImageData(rw, rh), d = img.data;
  const cv = cover.getContext('2d', { willReadFrequently: true }).getImageData(rx, ry, rw, rh).data;
  const { burn, range } = drag.tone, k0 = drag.opacity;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = (y * rw + x) * 4, q = ((ry + y) * W + rx + x) * 4, a = cv[i + 3];
    let k = 0;
    if (a && s0[q + 3]) {
      const L = (0.299 * s0[q] + 0.587 * s0[q + 1] + 0.114 * s0[q + 2]) / 65535;
      const w = range === 'shadows' ? (1 - L) * (1 - L) : range === 'highlights' ? L * L : 1;
      k = (a / 255) * k0 * w;
    }
    const g = k > 0 ? (burn ? 1 + k : 1 / (1 + k)) : 1;
    for (let ch = 0; ch < 3; ch++) { const v = g === 1 ? s0[q + ch] : Math.round(65535 * Math.pow(s0[q + ch] / 65535, g)); so[q + ch] = v; d[i + ch] = v / 257; }
    so[q + 3] = s0[q + 3]; d[i + 3] = s0[q + 3] / 257;
  }
  c.putImageData(img, rx, ry);
}
function stampLine(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const step = Math.max(0.5, drag.size * 0.12);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 1; i <= n; i++) stampAt({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
}
/** Re-render the whole stroke from the backup (keeps opacity uniform within a stroke). */
function applyStroke() {
  const l = drag.layer, cv = drag.canvas, c = ctxOf(cv);
  // only the rectangle touched since the last call changes: clip every pass to it (big canvases stay fast)
  const r = drag.dirty; drag.dirty = null; if (!r) return;
  const rx = Math.max(0, Math.floor(r.x0) - 1), ry = Math.max(0, Math.floor(r.y0) - 1);
  const rw = Math.min(cv.width, Math.ceil(r.x1) + 1) - rx, rh = Math.min(cv.height, Math.ceil(r.y1) + 1) - ry;
  if (rw <= 0 || rh <= 0) return;
  flushGpuDabs({ x: rx, y: ry, w: rw, h: rh });
  const clip = (ctx) => { ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); };
  // coverage = stroke stamps limited by the selection
  let cover = drag.stroke;
  if (drag.tmp && doc().selection) {
    const t = drag.tmp.getContext('2d'); t.save(); clip(t);
    t.globalCompositeOperation = 'copy'; t.drawImage(drag.stroke, 0, 0); t.globalCompositeOperation = 'source-over';
    maskBySelection(t, l); t.restore();
    cover = drag.tmp;
  }
  drag.cover = cover;
  c.save(); clip(c);
  c.globalCompositeOperation = 'copy';
  c.drawImage(drag.backup, 0, 0);
  c.globalCompositeOperation = 'source-over';
  if (drag.clone) {
    // source pixels shifted by the clone offset, cut to the brush coverage
    const t = drag.srcTmp.getContext('2d'); t.save(); clip(t);
    t.globalCompositeOperation = 'copy'; t.drawImage(drag.backup, -drag.dx, -drag.dy);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(cover, 0, 0);
    t.restore();
    c.globalAlpha = drag.opacity; c.drawImage(drag.srcTmp, 0, 0);
  } else if (drag.kind === 'spot') {
    c.globalAlpha = 0.55; c.drawImage(cover, 0, 0);
  } else if (drag.tone) {
    toneRect(c, cover, rx, ry, rw, rh);
  } else if (drag.onMask) {
    // mask' = mask * (1 - a) + lum * a   (white reveals, black hides)
    c.globalAlpha = drag.opacity; c.globalCompositeOperation = 'destination-out'; c.drawImage(cover, 0, 0);
    if (drag.lum > 0) { c.globalAlpha = drag.opacity * drag.lum; c.globalCompositeOperation = 'lighter'; c.drawImage(cover, 0, 0); }
  } else {
    c.globalAlpha = drag.opacity;
    c.globalCompositeOperation = drag.erase ? 'destination-out' : 'source-over';
    c.drawImage(cover, 0, 0);
  }
  c.restore();
  const wasDirty = compDirty;
  touchTarget(l);
  // CPU path: only the stroke's rectangle of the composite needs redrawing
  if (!wasDirty && !gfx.engine && !editingFMask(l)) { compDirty = false; addCompRect(rx + (l.x || 0), ry + (l.y || 0), rw, rh); }
  requestRender();
}

/**
 * Healing brush / spot healing: after the stroke, replace the brushed area
 * (in the worker) with texture whose color is matched to its surroundings.
 */
async function finishHeal(dr) {
  const l = dr.layer, cv = dr.canvas, W = cv.width, H = cv.height, b = dr.bb;
  const pad = dr.kind === 'spot' ? Math.ceil(dr.size * 2.6) + 4 : 3;
  const x0 = Math.max(0, Math.floor(b.x0) - pad), y0 = Math.max(0, Math.floor(b.y0) - pad);
  const x1 = Math.min(W, Math.ceil(b.x1) + pad), y1 = Math.min(H, Math.ceil(b.y1) + pad);
  const c = ctxOf(cv);
  const restoreBackup = () => { c.save(); c.globalCompositeOperation = 'copy'; c.globalAlpha = 1; c.drawImage(dr.backup, 0, 0); c.restore(); };
  if (x1 <= x0 || y1 <= y0) { restoreBackup(); touch(l); requestRender(); return; }
  const w = x1 - x0, h = y1 - y0;
  const ca = ctxOf(dr.cover).getImageData(x0, y0, w, h).data, cover = new Uint8Array(w * h);
  for (let i = 0; i < cover.length; i++) cover[i] = Math.round(ca[i * 4 + 3] * dr.opacity);
  const bctx = ctxOf(dr.backup), dst = bctx.getImageData(x0, y0, w, h);
  setBusy(1);
  try {
    let out;
    if (dr.kind === 'spot') out = (await ops.spot(dst, cover)).img;
    else out = await ops.heal(dst, bctx.getImageData(x0 + Math.round(dr.dx), y0 + Math.round(dr.dy), w, h), cover);
    restoreBackup();
    c.putImageData(out, x0, y0);
    touch(l); requestRender(); commit(dr.kind === 'spot' ? 'Spot healing' : 'Healing brush'); status(dr.kind === 'spot' ? 'Spot healed' : 'Healed');
  } catch (err) { restoreBackup(); touch(l); requestRender(); status(`Healing failed: ${err.message}`); }
  finally { setBusy(-1); }
}

function fillAt(p) {
  const layer = activeLayer(); if (!layer) return;
  const sel = doc().selection;
  const px = Math.floor(p.x), py = Math.floor(p.y);
  if (sel && !(px >= 0 && py >= 0 && px < sel.W && py < sel.H && sel.mask[py * sel.W + px])) return;
  if (!editingMask(layer)) rasterize(layer, 'filling');
  ensureCoversDoc(layer);
  const onMask = editingMask(layer), cv = targetCanvas(layer);
  const c = ctxOf(cv);
  const W = cv.width, H = cv.height;
  const img = c.getImageData(0, 0, W, H);
  const lx = px - layer.x, ly = py - layer.y;
  if (lx < 0 || ly < 0 || lx >= W || ly >= H) return;
  const bounds = opRegion(layer);
  const tol = state.opts.fillTolerance;
  const mask = state.opts.fillContiguous ? floodMask(img, lx, ly, tol, bounds) : similarMask(img, lx, ly, tol, bounds);
  const fill = onMask ? [255, 255, 255, Math.round(luminance(state.fg) * 255)] : [...hexToRgb(state.fg), 255];
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    let k = 1;
    if (sel) {
      const dx = (i % W) + layer.x, dy = ((i / W) | 0) + layer.y;
      k = dx >= 0 && dy >= 0 && dx < sel.W && dy < sel.H ? sel.mask[dy * sel.W + dx] / 255 : 0;
      if (!k) continue;
    }
    const j = i * 4;
    if (onMask) { d[j] = d[j + 1] = d[j + 2] = 255; }
    for (let ch = onMask ? 3 : 0; ch < 4; ch++) d[j + ch] = d[j + ch] + (fill[ch] - d[j + ch]) * k;
  }
  c.putImageData(img, 0, 0);
  touchTarget(layer);
  requestRender(); commit(onMask ? 'Fill mask' : 'Fill'); updateLayersPanel();
}

// --- Gradient, shapes and red-eye ---------------------------------------------------------------------
function snap45(a, p) {
  const dx = p.x - a.x, dy = p.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * r, y: a.y + Math.sin(ang) * r };
}
/** Small deterministic hash noise in [-0.5, 0.5) for dithering. */
const hashNoise = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5; };
/**
 * Gradient from a to b (doc coords) on the active layer or its mask: linear, radial or reflected; foreground →
 * background or foreground → transparent; restricted (softly) by the selection. Computed in floating point and
 * dithered for 8-bit documents; 16-bit documents get a true 16-bit gradient (no banding).
 */
function applyGradient(a, b, o = state.opts) {
  const layer = activeLayer(); if (!layer) return false;
  if (layer.kind === 'adjust' && !editingMask(layer)) { status('Select a pixel layer or a mask for the gradient.'); return false; }
  if (!editingMask(layer)) rasterize(layer, 'the gradient');
  ensureCoversDoc(layer);
  const onMask = editingMask(layer), cv = targetCanvas(layer), W = cv.width, H = cv.height;
  const sel = doc().selection, ox = layer.x, oy = layer.y;
  let c0 = hexToRgb(state.fg).map((v) => v / 255), c1 = o.gradColors === 'fg-bg' ? hexToRgb(state.bg).map((v) => v / 255) : c0.slice();
  let a0 = 1, a1 = o.gradColors === 'fg-bg' ? 1 : 0;
  if (o.gradReverse) { [c0, c1] = [c1, c0]; [a0, a1] = [a1, a0]; }
  const op = (o.gradOpacity ?? 100) / 100, type = o.gradType;
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
  const tAt = (x, y) => { // x, y: doc coords of the pixel centre
    let t = type === 'radial' ? Math.hypot(x - a.x, y - a.y) / len : ((x - a.x) * dx + (y - a.y) * dy) / len2;
    if (type === 'reflected') t = Math.abs(t);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  const selW = (x, y) => { if (!sel) return 1; return x >= 0 && y >= 0 && x < sel.W && y < sel.H ? sel.mask[y * sel.W + x] / 255 : 0; };
  const deep = !onMask && useDeep(layer);
  if (deep) {
    const src = deepOf(layer), out = createDeep(src.width, src.height, new Uint16Array(src.data)), dd = out.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = selW(x + ox, y + oy); if (!k) continue;
      const t = tAt(x + ox + 0.5, y + oy + 0.5), ga = (a0 + (a1 - a0) * t) * op * k, j = (y * W + x) * 4;
      const A = dd[j + 3] / 65535, oa = ga + A * (1 - ga); if (oa <= 0) continue;
      for (let ch = 0; ch < 3; ch++) { const gc = c0[ch] + (c1[ch] - c0[ch]) * t; dd[j + ch] = Math.round(((gc * ga + (dd[j + ch] / 65535) * A * (1 - ga)) / oa) * 65535); }
      dd[j + 3] = Math.round(oa * 65535);
    }
    setDeep(layer, out);
  } else {
    const c = ctxOf(cv), img = c.getImageData(0, 0, W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = selW(x + ox, y + oy); if (!k) continue;
      const t = tAt(x + ox + 0.5, y + oy + 0.5), j = (y * W + x) * 4, n = hashNoise(x, y);
      if (onMask) { // a mask takes the gradient's brightness: black hides, white reveals
        const g = (0.2126 * (c0[0] + (c1[0] - c0[0]) * t) + 0.7152 * (c0[1] + (c1[1] - c0[1]) * t) + 0.0722 * (c0[2] + (c1[2] - c0[2]) * t)) * (a0 + (a1 - a0) * t);
        const ka = op * k; d[j] = d[j + 1] = d[j + 2] = 255;
        d[j + 3] = Math.max(0, Math.min(255, Math.round((d[j + 3] / 255 * (1 - ka) + g * ka) * 255 + n)));
        continue;
      }
      const ga = (a0 + (a1 - a0) * t) * op * k, A = d[j + 3] / 255, oa = ga + A * (1 - ga); if (oa <= 0) continue;
      for (let ch = 0; ch < 3; ch++) { const gc = c0[ch] + (c1[ch] - c0[ch]) * t; d[j + ch] = Math.max(0, Math.min(255, Math.round(((gc * ga + (d[j + ch] / 255) * A * (1 - ga)) / oa) * 255 + n))); }
      d[j + 3] = Math.max(0, Math.min(255, Math.round(oa * 255)));
    }
    c.putImageData(img, 0, 0);
    touchTarget(layer);
  }
  requestRender(); commit(onMask ? 'Gradient mask' : 'Gradient'); updateLayersPanel();
  return true;
}
const SHAPE_NAME = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' };
/** Shape geometry from a drag: Shift = square / circle / 45° line, Ctrl (⌘ on Mac) = from the centre. */
function shapeGeom({ a, b, mods = {} }, o = state.opts) {
  const kind = o.shapeKind;
  if (kind === 'line') { const q = mods.square ? snap45(a, b) : b; return { kind, x1: a.x, y1: a.y, x2: q.x, y2: q.y }; }
  let w = b.x - a.x, h = b.y - a.y;
  if (mods.square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  let x = a.x, y = a.y;
  if (mods.center) { x = a.x - w; y = a.y - h; w *= 2; h *= 2; }
  if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
  return { kind, x, y, w, h };
}
function shapePath(g, o = state.opts) {
  const p = new Path2D();
  if (g.kind === 'line') { p.moveTo(g.x1, g.y1); p.lineTo(g.x2, g.y2); }
  else if (g.kind === 'ellipse') p.ellipse(g.x + g.w / 2, g.y + g.h / 2, g.w / 2, g.h / 2, 0, 0, Math.PI * 2);
  else if (o.shapeRadius > 0) p.roundRect(g.x, g.y, g.w, g.h, Math.min(o.shapeRadius, g.w / 2, g.h / 2));
  else p.rect(g.x, g.y, g.w, g.h);
  return p;
}
/** Draw a shape on a new layer above the active one (fill = foreground; stroke = foreground, or background with "fill + stroke"). */
function addShapeLayer(g, o = state.opts) {
  const d = doc(); if (!d) return null;
  if (state.xf) applyTransform();
  const l = createLayer(SHAPE_NAME[g.kind], d.width, d.height), x = l.canvas.getContext('2d'), path = shapePath(g, o);
  const style = g.kind === 'line' ? 'stroke' : o.shapeStyle;
  if (style !== 'stroke') { x.fillStyle = state.fg; x.fill(path); }
  if (style !== 'fill') {
    x.strokeStyle = style === 'both' ? state.bg : state.fg; x.lineWidth = Math.max(1, o.shapeStroke);
    x.lineJoin = o.shapeRadius > 0 || g.kind !== 'rect' ? 'round' : 'miter'; x.lineCap = g.kind === 'line' ? 'round' : 'butt'; x.stroke(path);
  }
  insertLayer(d, l); d.activeId = l.id;
  touch(l); requestRender(); commit(SHAPE_NAME[g.kind]); updateLayersPanel(); buildOptionsBar();
  return l;
}
/**
 * Red-eye: inside the circle, strongly red pixels lose their red excess (set towards the green/blue mean)
 * and are darkened; weight fades out at the rim and with weaker redness so skin around the eye is kept.
 */
function redEyeAt(p, o = state.opts) {
  const layer = activeLayer(); if (!layer || layer.kind === 'adjust') return 0;
  if (editingMask(layer)) { status('Red eye works on layer pixels. Click the layer thumbnail to target pixels.'); return 0; }
  rasterize(layer, 'red-eye removal');
  const r = Math.max(2, o.redeyeSize / 2), cx = p.x - layer.x, cy = p.y - layer.y, cv = layer.canvas;
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r)), x1 = Math.min(cv.width, Math.ceil(cx + r)), y1 = Math.min(cv.height, Math.ceil(cy + r));
  if (x1 <= x0 || y1 <= y0) return 0;
  const c = ctxOf(cv), img = c.getImageData(x0, y0, x1 - x0, y1 - y0), d = img.data, dark = 1 - (o.redeyeDarken ?? 60) / 100 * 0.6;
  // 16-bit documents: work on the 16-bit data (values scaled to 0..255 floats) and keep full precision
  const deep = useDeep(layer) ? deepOf(layer) : null, out = deep ? cloneDeep(deep) : null, dd = out?.data, W = cv.width;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r; if (dist >= 1) continue;
    const j = ((y - y0) * (x1 - x0) + (x - x0)) * 4, q = (y * W + x) * 4;
    const R = deep ? dd[q] / 257 : d[j], G = deep ? dd[q + 1] / 257 : d[j + 1], B = deep ? dd[q + 2] / 257 : d[j + 2], gb = (G + B) / 2;
    const redness = R > 50 ? (R - Math.max(G, B)) / R : 0; if (redness <= 0.25) continue;
    const k = Math.min(1, (redness - 0.25) / 0.25) * Math.min(1, (1 - dist) / 0.25);
    const nr = R + (gb * dark - R) * k, ng = G + (G * dark - G) * k, nb = B + (B * dark - B) * k;
    if (deep) { dd[q] = Math.round(nr * 257); dd[q + 1] = Math.round(ng * 257); dd[q + 2] = Math.round(nb * 257); d[j] = dd[q] / 257; d[j + 1] = dd[q + 1] / 257; d[j + 2] = dd[q + 2] / 257; }
    else { d[j] = Math.round(nr); d[j + 1] = Math.round(ng); d[j + 2] = Math.round(nb); }
    n++;
  }
  if (!n) { status('No red eye found there. Click the centre of the pupil, or make the tool bigger.'); return 0; }
  c.putImageData(img, x0, y0); touch(layer);
  if (deep) { layer.deep = out; layer.deepRev = layer.rev; layer.deepOX = 0; layer.deepOY = 0; }
  requestRender(); commit('Red eye'); updateLayersPanel();
  return n;
}

// --- Mesh rendering: GPU engine first, CPU reference rasteriser as the fallback ------------------
/** Render `img` (straight ImageData) through a mesh into an outW×outH ImageData whose (0,0) is at (ox, oy). */
async function renderMeshAny(img, outW, outH, m, ox = 0, oy = 0) {
  const e = gfx.engine;
  if (e && !e.lost && e.warpMesh) {
    try { const r = await e.warpMesh(img, outW, outH, m, ox, oy); gfx.lastWarpPath = e.kind === 'webgpu' ? 'webgpu' : 'webgl'; return r; }
    catch (err) { console.warn('GPU mesh warp failed; using the CPU', err); }
  }
  gfx.lastWarpPath = 'cpu';
  return mesh.renderMeshCPU(img, outW, outH, m, ox, oy);
}

// --- Perspective & warp (Edit menu): drag corner / grid handles; Enter applies, Esc cancels -----------
function mxfGrid(n) { const x = state.mxf; if (!x || x.mode !== 'warp' || x.n === n) return; x.n = n; mxfResetPoints(x); mxfPreview(); mxfRender(); buildOptionsBar(); }
const MXF_SAFE = new Set(['mxfApply', 'mxfCancel', 'mxfGuides', 'mxfGuidedApply', 'autoUpright', 'uprightLevel', 'uprightVertical', 'uprightFull', 'uprightEdges_crop', 'uprightEdges_fill', 'uprightEdges_keep', 'mxfGrid3', 'mxfGrid4', 'mxfGrid5', 'mxfReset', 'undo', 'zoomIn', 'zoomOut', 'zoomFit', 'zoom100', 'shortcuts', 'about', 'swapColors', 'resetColors']);
function startMeshXf(mode) {
  const d = doc(), l = activeLayer();
  if (!l || state.mxf) return;
  if (state.xf) applyTransform();
  if (l.kind === 'adjust' || isGroup(l)) { status(`${mode === 'warp' ? 'Warp' : 'Perspective'} needs a pixel layer.`); return; }
  if (!l.visible) { status('The active layer is hidden. Show it first.'); return; }
  if (state.crop) state.crop = null;
  if (l.kind === 'text' || l.kind === 'smart') rasterize(l, mode === 'warp' ? 'the warp' : 'the perspective transform');
  const t = l.mask ? { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height } : alphaBounds(l.canvas);
  if (!t) { status('This layer is empty: nothing to transform.'); return; }
  const src = ctxOf(l.canvas).getImageData(t.x, t.y, t.w, t.h);
  const msrc = l.mask ? ctxOf(l.mask.canvas).getImageData(0, 0, l.mask.canvas.width, l.mask.canvas.height) : null;
  const ox = l.x + t.x, oy = l.y + t.y;
  // low-resolution copy for the live preview while dragging (≤ 640 px on the long side)
  const k = Math.min(1, 640 / Math.max(t.w, t.h)), sw = Math.max(1, Math.round(t.w * k)), sh = Math.max(1, Math.round(t.h * k));
  const sc = makeCanvas(sw, sh), sx = sc.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(l.canvas, t.x, t.y, t.w, t.h, 0, 0, sw, sh);
  const x = {
    mode, layer: l, src, msrc, dsrc: useDeep(l) ? cropDeep(deepOf(l), t) : null, small: sx.getImageData(0, 0, sw, sh), k: sw / t.w, w: t.w, h: t.h, ox, oy, n: 4,
    orig: { canvas: l.canvas, x: l.x, y: l.y, mask: l.mask ? l.mask.canvas : null, deep: l.deep, deepRev: l.deepRev, deepOX: l.deepOX, deepOY: l.deepOY, rev: l.rev },
    pts: null, job: null, seq: 0,
  };
  mxfResetPoints(x);
  state.mxf = x;
  if (d.selection) status(`${mode === 'warp' ? 'Warp' : 'Perspective'} transforms the whole layer (the selection is ignored).`);
  else status(mode === 'warp' ? 'Warp: drag the grid points; Enter applies, Esc cancels.' : 'Perspective: drag the corners; Enter applies, Esc cancels.');
  buildOptionsBar(); requestRender();
}
function mxfResetPoints(x) {
  const { w, h, ox, oy } = x;
  x.pts = x.mode === 'perspective' ? [[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h]] : mesh.gridPoints(x.n, w, h, ox, oy);
  x.uprightHu = null; x.radialK = 0;
}
function mxfMesh(x) {
  if (x.mode !== 'perspective') return mesh.warpMesh(x.pts, x.n, x.w, x.h, 32);
  if (x.uprightHu) return mesh.uprightMeshFromH(x.w, x.h, x.uprightHu, x.radialK || 0, x.ox, x.oy);
  return mesh.perspectiveMesh(x.w, x.h, x.pts);
}
/** Output rectangle of the mesh, limited to 3× the document so a near-degenerate quad cannot explode. */
function mxfBounds(m) {
  const d = doc(), b = mesh.meshBounds(m);
  const x0 = Math.max(b.x, -d.width), y0 = Math.max(b.y, -d.height), x1 = Math.min(b.x + b.w, 2 * d.width), y1 = Math.min(b.y + b.h, 2 * d.height);
  return x1 <= x0 || y1 <= y0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Quick low-resolution preview (CPU) shown while a handle is dragged. */
function mxfPreview() {
  const x = state.mxf; if (!x) return;
  const l = x.layer, m = mxfMesh(x); if (!m) { status('That shape cannot be mapped (the corners must form a convex shape).'); return; }
  const b = mxfBounds(m); if (!b) return;
  const k = x.k, sm = mesh.scaleMesh(m, k, k);
  const ow = Math.max(1, Math.ceil(b.w * k)), oh = Math.max(1, Math.ceil(b.h * k));
  const out = mesh.renderMeshCPU(x.small, ow, oh, sm, b.x * k, b.y * k);
  const cv = makeCanvas(b.w, b.h), c = cv.getContext('2d'); c.imageSmoothingEnabled = true;
  c.drawImage(putInto(null, out), 0, 0, ow, oh, 0, 0, b.w, b.h);
  l.canvas = cv; l.x = b.x; l.y = b.y;
  if (x.msrc) { l.mask.canvas = makeMaskCanvas(b.w, b.h, true); touchMask(l); } // full-quality mask follows on release
  touch(l); requestRender();
}
/** Full-quality render (GPU engine, CPU fallback). Returns a promise; the newest request wins. */
function mxfRender() {
  const x = state.mxf; if (!x) return Promise.resolve(false);
  const seq = ++x.seq, l = x.layer, m = mxfMesh(x); if (!m) return Promise.resolve(false);
  const b = mxfBounds(m); if (!b) return Promise.resolve(false);
  x.job = (async () => {
    const out = await renderMeshAny(x.src, b.w, b.h, m, b.x, b.y);
    let mk = null;
    if (x.msrc) { // the mask is warped with the same mesh (it covers the same rectangle as the source)
      const mm = await renderMeshAny(x.msrc, b.w, b.h, m, b.x, b.y);
      mk = makeMaskCanvas(b.w, b.h, false); ctxOf(mk).putImageData(mm, 0, 0);
    }
    if (state.mxf !== x || seq !== x.seq) return false;
    l.canvas = putInto(null, out); l.x = b.x; l.y = b.y;
    if (mk) { l.mask.canvas = mk; touchMask(l); }
    touch(l); requestRender(); return true;
  })();
  return x.job;
}
async function applyMeshXf() {
  const x = state.mxf; if (!x) return;
  const l = x.layer, moved = x.pts.some((p, i) => { const q = (x.mode === 'perspective' ? [[x.ox, x.oy], [x.ox + x.w, x.oy], [x.ox + x.w, x.oy + x.h], [x.ox, x.oy + x.h]] : mesh.gridPoints(x.n, x.w, x.h, x.ox, x.oy))[i]; return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6; });
  if (!moved) { cancelMeshXf(); return; }
  setBusy(1);
  try { const ok = await mxfRender(); if (!ok && state.mxf === x) { cancelMeshXf(); status('Nothing to apply.'); return; } }
  catch (err) { cancelMeshXf(); status(`Transform failed: ${err.message}`); return; }
  finally { setBusy(-1); }
  if (state.mxf !== x) return;
  state.mxf = null;
  delete l.deep; delete l.deepRev; delete l.deepOX; delete l.deepOY;
  touch(l);
  if (x.dsrc) { // 16-bit: the same mesh, sampled from the 16-bit source on the CPU
    const m = mxfMesh(x), b = m && mxfBounds(m);
    if (b && b.w === l.canvas.width && b.h === l.canvas.height) { l.deep = deepMesh(x.dsrc, b.w, b.h, m, b.x, b.y); l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0; }
  }
  commit(x.upright ? 'Upright' : x.mode === 'warp' ? 'Warp' : 'Perspective');
  status(`${x.upright ? 'Upright' : x.mode === 'warp' ? 'Warp' : 'Perspective'} applied (${gfx.lastWarpPath === 'cpu' ? 'CPU' : gfx.lastWarpPath === 'webgpu' ? 'WebGPU' : 'WebGL2'})`);
  if (x.upright) {
    lastUpright = { ...(lastUpright || {}), H: x.uprightHu || mesh.homography([[x.ox, x.oy], [x.ox + x.w, x.oy], [x.ox + x.w, x.oy + x.h], [x.ox, x.oy + x.h]], x.pts), k: x.radialK || 0, center: [x.ox + x.w / 2, x.oy + x.h / 2], rNorm2: (x.w / 2) ** 2 + (x.h / 2) ** 2, kind: x.upright, crop: null, filled: false };
    const how = state.opts.uprightEdges;
    if (how === 'crop') { const r = cropEmptyEdges({ label: 'Crop empty edges (upright)', quiet: true }); if (r) { lastUpright.crop = r; status(`Upright applied and cropped to ${r.w} × ${r.h} px so no empty corners show.`); } }
    else if (how === 'fill') { if (fillEmptyEdges({ quiet: true })) { lastUpright.filled = true; status('Upright applied; empty corners filled from nearby pixels.'); } }
  }
  buildOptionsBar(); updateLayersPanel(); requestRender();
}
/**
 * Auto upright (v1.8): detect near-vertical straight lines (gradient Hough on the ≤ 640 px preview copy), find where
 * they converge (RANSAC vanishing point) and hand two lines through that point to the same solver Guided upright uses.
 * Lines that are parallel but tilted give a plain rotation instead.
 */
let lastUpright = null, lastUprightKEst = 0;
/**
 * v1.9 modes: 'vertical' (the v1.8 Auto: verticals made upright and parallel, or a rotation when they are parallel
 * already), 'level' (a rotation that levels the horizontals), 'full' (one homography that straightens both families)
 * and 'auto' (vertical; level when no verticals agree).
 */
function autoUprightCmd(req = 'auto') {
  lastUprightKEst = 0;
  if (!doc()) return null;
  if (state.mxf && state.mxf.mode !== 'perspective') { status('Finish the warp first (Enter applies).'); return null; }
  if (!state.mxf) startMeshXf('perspective');
  const x = state.mxf; if (!x || x.mode !== 'perspective') return null;
  mxfResetPoints(x); x.guides = []; x.guideMode = false;
  const img = x.small, k = x.k, t0 = performance.now(), cx = x.ox + x.w / 2, cy = x.oy + x.h / 2;
  const toDoc = ([a, b]) => [x.ox + a / k, x.oy + b / k];
  const toDocH = (v) => [v[0] / k + x.ox * v[2], v[1] / k + x.oy * v[2], v[2]];
  const rotateBy = (deg) => { const t = deg * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t); return x.pts.map(([a, b]) => [cx + (a - cx) * c - (b - cy) * sn, cy + (a - cx) * sn + (b - cy) * c]); };
  const wantV = req !== 'level', wantH = req === 'level' || req === 'full';
  // v1.10: lines are found on the small preview copy, then re-fitted on a sharper copy (≤ 1600 px) of the layer
  let sharp = null;
  const sharpen = (ls, orient) => {
    if (!ls.length || !seg.refineLines) return ls;
    if (!sharp) { const S = Math.min(1, 1600 / Math.max(x.w, x.h)); if (S * x.w < img.width * 1.05) return ls;
      const sw = Math.round(x.w * S), sh = Math.round(x.h * S), c = makeCanvas(sw, sh), cc = c.getContext('2d', { willReadFrequently: true }); cc.imageSmoothingQuality = 'high';
      cc.drawImage(putInto(null, x.src), 0, 0, sw, sh); sharp = cc.getImageData(0, 0, sw, sh); }
    return seg.refineLines(ls, sharp, sharp.width / img.width, orient);
  };
  let lines = wantV ? sharpen(seg.detectLines(img, { orient: 'v' }), 'v') : [];
  let u = wantV ? seg.estimateUpright(lines, img.width, img.height) : { mode: 'none', inliers: [] };
  let hl = [], uh = { mode: 'none', inliers: [] };
  const filterHoriz = () => {
    if (uh.mode === 'none') return;
    const len = uh.inliers.reduce((q, i) => q + hl[i].len, 0), S = Math.max(img.width, img.height);
    const far = !uh.vp || Math.hypot(uh.vp[0] - img.width / 2, uh.vp[1] - img.height / 2) >= 1.5 * S;
    if (uh.inliers.length < 3 || len < 0.5 * img.width || !far) uh = { ...uh, mode: 'none', weak: true };
  };
  const horiz = () => {
    hl = sharpen(seg.detectLines(img, { orient: 'h' }), 'h'); uh = seg.estimateUpright(hl, img.width, img.height);
    // trust the horizontals only with ≥ 3 agreeing lines covering half the width, converging no faster than a vanishing
    // point 1.5 frame-sizes from the centre (closer ones come from two stray edges, e.g. a roof line and a shadow)
    filterHoriz();
    // a lone horizon (sea, plain) is one long line: for a rotation that is enough when it spans 60 % of the width
    if (uh.mode === 'none' && req !== 'full') {
      let b = -1; hl.forEach((l, i) => { if (l.len >= 0.6 * img.width && (b < 0 || l.len > hl[b].len)) b = i; });
      if (b >= 0) { const l = hl[b], d = l.x2 >= l.x1 ? [l.x2 - l.x1, l.y2 - l.y1] : [l.x1 - l.x2, l.y1 - l.y2]; uh = { mode: 'single', inliers: [b], vh: [d[0], d[1], 0], vp: null }; }
    }
  };
  if (wantH || (req === 'auto' && u.mode === 'none')) horiz();
  // v1.12: estimate radial from half-angle gap on long horizontals; undistort lines, re-fit VPs, and apply the
  // same k in the mesh so geometry and warp stay consistent (profile-style correction before Upright).
  let kRad = 0;
  if (req === 'full') {
    if (!sharp && (lines.length || hl.length)) { sharpen(lines.length ? lines : hl, lines.length ? 'v' : 'h'); }
    if (sharp) {
      const sc = sharp.width / img.width;
      const scaled = (ls) => ls.map((l) => ({ ...l, x1: l.x1 * sc, y1: l.y1 * sc, x2: l.x2 * sc, y2: l.y2 * sc, len: l.len * sc }));
      kRad = seg.estimateRadial([...scaled(hl || []), ...scaled(lines || [])], sharp);
    } else kRad = seg.estimateRadial([...(hl || []), ...(lines || [])], img);
    if (kRad > 0.08) kRad = 0; // pincushion hits from trapezoid halves; only barrel has helped real photos
    if (Math.abs(kRad) > 0.16) kRad = Math.sign(kRad) * 0.16;
    // Radial warp is gated: on the library/brick tuning photos, applying the estimated k (with a consistent
    // VP re-fit) raised some edges above the v1.11 result, so the warp is left off until a held-out win is shown.
    // The estimate is still recorded on lastUpright.kEst for diagnosis; kRad stays 0 for the mesh.
    const kEst = kRad; kRad = 0;
    if (kEst) { /* keep lines/uh as detected — no undistort re-fit while the warp is gated */ }
    lastUprightKEst = kEst;
  }
  let next = null, used = req, msg = '', Hu = null;
  const undoc = (a, b) => { // radial undistort of a document point about the layer centre
    if (!kRad) return [a, b];
    const rNorm2 = (x.w / 2) ** 2 + (x.h / 2) ** 2;
    return seg.undistortPoint(a, b, cx, cy, kRad, rNorm2);
  };
  const mapHu = (H, a, b) => { const [u0, v0] = undoc(a, b); return mesh.applyH(H, u0, v0); };
  const level = () => { // rotate so the horizontals are level at the centre of the frame
    if (uh.mode === 'none') return null;
    const a = seg.directionAt(toDocH(uh.vh), cx, cy, 'h');
    if (Math.abs(a) < 0.05 || Math.abs(a) > 15) return null; // > 15° is perspective, not a tilted camera
    msg = `${uh.inliers.length} horizontal line${uh.inliers.length === 1 ? '' : 's'} levelled by rotating ${Math.round(-a * 10) / 10}°`; return rotateBy(-a);
  };
  if (req === 'vertical' || (req === 'auto' && u.mode !== 'none')) {
    used = 'vertical';
    if (u.mode === 'keystone') next = uprightFromGuides(x.pts, seg.guidesFromVP(u.vp, img.width, img.height).map((g) => g.map(toDoc)));
    else if (u.mode === 'rotate') next = rotateBy(u.angle);
    msg = `${u.inliers.length} vertical lines ${u.mode === 'rotate' ? `straightened by rotating ${(Math.round(u.angle * 10) / 10)}°` : 'made parallel'}`;
  } else if (req === 'level' || req === 'auto') { used = 'level'; next = level(); }
  else if (req === 'full') {
    const vv = u.mode === 'none' ? null : toDocH(u.vh);
    const area = (P) => Math.abs(P.reduce((s, p, i) => { const n = P[(i + 1) % P.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
    const tryH = (vh) => {
      const H0 = (vv || vh) && seg.uprightHomography(vv, vh, cx, cy); if (!H0) return null;
      const ws = x.pts.map(([a, b]) => mapHu(H0, a, b)[2]); if (!ws.every((w) => w > 0.2 && w < 5)) return null;
      let q = x.pts.map(([a, b]) => { const p = mapHu(H0, a, b); return [p[0], p[1]]; });
      const f = Math.sqrt(area(x.pts) / Math.max(1e-9, area(q))); // same pixel count as before
      q = q.map(([a, b]) => [cx + (a - cx) * f, cy + (b - cy) * f]);
      // refuse shapes no lens makes: a corner under 50° or over 130°, or opposite sides more than 2.5× apart
      const sideL = (i) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
      const ang = (i) => { const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4], a1 = Math.atan2(p[1] - c[1], p[0] - c[0]), a2 = Math.atan2(n[1] - c[1], n[0] - c[0]); let d = Math.abs(a1 - a2) * 180 / Math.PI; if (d > 180) d = 360 - d; return d; };
      if (vh && [0, 1, 2, 3].some((i) => ang(i) < 50 || ang(i) > 130)) return null; // (verticals alone: as trusted as Vertical)
      if (vh && (Math.max(sideL(0), sideL(2)) > 2.5 * Math.min(sideL(0), sideL(2)) || Math.max(sideL(1), sideL(3)) > 2.5 * Math.min(sideL(1), sideL(3)))) return null;
      // Hu maps undistorted document points → upright (including the scale-about-centre)
      const Hu2 = mesh.homography(x.pts.map(([a, b]) => undoc(a, b)), q); if (!Hu2) return null;
      return { q, Hu: Hu2 };
    };
    // mean |tilt| of detected horizontals (even weak ones) after a candidate map — used to refuse a "correction" that makes them worse
    // when the main detector found no horizontals (strong vertical textures steal the top-12% budget), try a
    // weaker pass just for the do-no-harm check so Full cannot silently worsen a facade like geneva.jpg
    let harmLines = hl.filter((l) => Math.abs(l.angle) <= 12);
    if (!harmLines.length) {
      harmLines = sharpen(seg.detectLines(img, { orient: 'h', maxDeg: 15, minLenFrac: 0.08, maxLines: 25, thrFrac: 0.72 }), 'h')
        .filter((l) => Math.abs(l.angle) <= 12 && l.len >= 0.1 * img.width);
    }
    const meanAbsH = (mapPt) => {
      const src = harmLines.length ? harmLines : [];
      if (!src.length) return null;
      let s = 0, n = 0;
      for (const l of src) {
        if (l.len < 0.12 * img.width) continue;
        const a = toDoc([l.x1, l.y1]), b = toDoc([l.x2, l.y2]);
        const a2 = mapPt(a[0], a[1]), b2 = mapPt(b[0], b[1]);
        if (!a2 || !b2) continue;
        let ang = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) * 180 / Math.PI;
        while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;
        s += Math.abs(ang); n++;
      }
      return n ? s / n : null;
    };
    const idMap = (a, b) => [a, b];
    const beforeH = meanAbsH(idMap);
    let hUsed = uh.mode !== 'none';
    // Both V and H far (rotate) with tiny angles: photo is already nearly upright. A combined Full
    // homography still shears (hongkong facade: seed horizontals rose from ~0.2° to ~1.5°). Refuse.
    const dualTinyRotate = u.mode === 'rotate' && uh.mode === 'rotate'
      && Math.abs(u.angle || 0) < 2 && Math.abs(uh.angle || 0) < 2;
    // score a candidate: lower is better. Prefer not raising horizontal tilt vs the uncorrected photo.
    const scoreCand = (c) => {
      if (!c) return Infinity;
      if (beforeH == null) return 0;
      const after = meanAbsH((a, b) => { const p = mapHu(c.Hu, a, b); return [p[0], p[1]]; });
      if (after == null) return 0;
      return after - beforeH; // positive = harm
    };
    let cand = hUsed && !dualTinyRotate ? tryH(toDocH(uh.vh)) : null;
    if (cand && scoreCand(cand) > 0.05) { cand = null; hUsed = false; uh = { ...uh, mode: 'none', weak: true, harm: true }; }
    // also refuse when any horizontal inlier's |tilt| rises (mean can look fine while a long ledge worsens)
    if (cand && uh.inliers?.length) {
      const tilt = (mapPt) => {
        let worst = 0;
        for (const i of uh.inliers) {
          const l = hl[i], a = toDoc([l.x1, l.y1]), b = toDoc([l.x2, l.y2]);
          const a2 = mapPt(a[0], a[1]), b2 = mapPt(b[0], b[1]);
          let ang = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) * 180 / Math.PI;
          while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;
          worst = Math.max(worst, Math.abs(ang));
        }
        return worst;
      };
      const before = tilt((a, b) => [a, b]);
      const after = tilt((a, b) => { const p = mapHu(cand.Hu, a, b); return [p[0], p[1]]; });
      if (after > before + 0.15) { cand = null; hUsed = false; uh = { ...uh, mode: 'none', weak: true, harm: true }; }
    }
    if (dualTinyRotate) { cand = null; hUsed = false; uh = { ...uh, mode: 'none', weak: true, harm: true }; }
    if (cand) {
      next = cand.q;
      Hu = kRad ? cand.Hu : null; // classic perspectiveMesh(pts) when no radial
    } else if (vv && !dualTinyRotate) {
      // Vertical fallback must match the Vertical mode path (guides / rotate), not uprightHomography alone —
      // the two differ enough to crop a measured edge on the church photo (job 22).
      if (hUsed) uh = { ...uh, mode: 'none', weak: true }; hUsed = false;
      let vnext = u.mode === 'keystone'
        ? uprightFromGuides(x.pts, seg.guidesFromVP(u.vp, img.width, img.height).map((g) => g.map(toDoc)))
        : rotateBy(u.angle);
      if (vnext && beforeH != null) {
        const Hv = mesh.homography(x.pts, vnext);
        const after = meanAbsH((a, b) => { const p = mesh.applyH(Hv, a, b); return [p[0], p[1]]; });
        // refuse only a clear worsening (geneva: ~0.4° → ~0.9°). Tiny bumps from weak false horizontals
        // must not abort Full on photos like the church (job 22).
        if (after != null && after > beforeH + 0.2 && after > 0.65) vnext = null;
      }
      // no horizontals found at all: a tiny rotate with many near-vertical votes is often diagonal facade
      // texture (geneva fins), not a tilted camera — refuse rather than double the hidden horizontals' tilt
      if (vnext && beforeH == null && u.mode === 'rotate' && Math.abs(u.angle) < 1.2 && lines.length >= 12) vnext = null;
      if (vnext) next = vnext;
      else uh = { ...uh, mode: 'none', weak: true, harm: true };
    }

    // if still nothing and we have horizontals to protect, refuse rather than make them worse
    msg = hUsed ? `${vv ? `${u.inliers.length} vertical and ` : ''}${uh.inliers.length} horizontal lines straightened${vv ? '' : ' (no vertical lines found)'}`
      : `${u.inliers.length} vertical lines straightened (${uh.harm ? 'using the horizontals would have made them worse' : uh.weak ? 'the horizontal lines were too few or too uncertain to use' : 'no horizontal lines found'})`;
    if (kRad) msg += `; lens ${kRad > 0 ? '+' : ''}${kRad.toFixed(2)}`;
  }
  lastUpright = { req, mode: next ? used : 'none', vkind: u.mode, vp: u.vp ? toDoc(u.vp) : null, angle: u.angle ?? null, lines: (u.inliers || []).length, found: lines.length,
    hkind: uh.mode, hweak: !!uh.weak, hvp: uh.vp ? toDoc(uh.vp) : null, hangle: uh.angle ?? null, hlines: uh.mode === 'none' ? 0 : (uh.inliers || []).length, hfound: hl.length, k: kRad, kEst: lastUprightKEst || 0, ms: Math.round(performance.now() - t0) };
  { const D = (l) => [...toDoc([l.x1, l.y1]), ...toDoc([l.x2, l.y2])].map((t) => Math.round(t * 10) / 10); lastUpright.debug = { v: lines.map(D), vin: [...(u.inliers || [])], h: hl.map(D), hin: uh.mode === 'none' ? [] : [...(uh.inliers || [])] }; } // detected lines (document pixels), for diagnosis
  if (used === 'vertical' && next) lastUpright.mode = u.mode; // 'keystone' | 'rotate' (v1.8 values)
  x.uprightHu = Hu; x.radialK = kRad || 0;
  const meshOk = next && (Hu ? mesh.uprightMeshFromH(x.w, x.h, Hu, kRad || 0, x.ox, x.oy) : mesh.perspectiveMesh(x.w, x.h, next));
  if (!next || !meshOk || !mxfBounds(mxfMesh({ ...x, pts: next, uprightHu: Hu, radialK: kRad || 0 }))) {
    lastUpright.mode = 'none'; x.uprightHu = null; x.radialK = 0;
    const what = req === 'level' ? 'horizontal' : req === 'full' ? 'vertical or horizontal' : 'vertical';
    const none = req === 'level' ? hl.length < 2 : req === 'full' ? lines.length < 2 && hl.length < 2 : lines.length < 2 && (req !== 'auto' || hl.length < 2);
    status(none ? `Auto upright found no long straight ${what} lines. Try Guides and draw two edges yourself.` : `Auto upright: the ${what} lines already look straight (or disagree). Try Guides.`);
    buildOptionsBar(); requestRender(); return lastUpright;
  }
  x.pts = next; x.upright = 'auto';
  mxfPreview();
  // v1.13: Auto / Level / Vertical / Full apply at once (crop / fill / keep from the options bar), so the job is one
  // menu choice like Lightroom's Upright — no extra Enter. Esc is unavailable after apply; Undo reverts.
  status(`Upright (${used}): ${msg}`);
  buildOptionsBar();
  void applyMeshXf();
  return lastUpright;
}
/** Downscaled alpha of the composite (≤ 800 px) for finding the empty corners. */
function compositeAlpha(maxSide = 800) {
  const d = doc(); freshComp();
  const k = Math.min(1, maxSide / Math.max(d.width, d.height)), w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
  const c = makeCanvas(w, h), cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(comp, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h); for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  return { a, w, h, k };
}
/** The largest rectangle (at the document's aspect ratio unless `ratio` is false) with no transparent pixels. */
function innerOpaqueRect({ keepRatio = true } = {}) {
  const d = doc(), { a, w, h, k } = compositeAlpha();
  if (a.every((v) => v >= 250)) return { x: 0, y: 0, w: d.width, h: d.height, full: true };
  const r = seg.largestInnerRect(a, w, h, { ratio: keepRatio ? d.width / d.height : 0 }); if (!r) return null;
  // back to full resolution, pulled in by one preview pixel on every side so no soft edge survives
  const pad = 1 / k + 1;
  let x0 = r.x / k + pad, y0 = r.y / k + pad, rw = r.w / k - 2 * pad, rh = r.h / k - 2 * pad;
  if (keepRatio) { const t = d.width / d.height; if (rw / rh > t) { const nw = rh * t; x0 += (rw - nw) / 2; rw = nw; } else { const nh = rw / t; y0 += (rh - nh) / 2; rh = nh; } }
  const out = { x: Math.ceil(x0), y: Math.ceil(y0), w: Math.floor(rw), h: Math.floor(rh) };
  return out.w >= 8 && out.h >= 8 ? out : null;
}
function cropEmptyEdges({ label = 'Crop empty edges', quiet = false, keepRatio = true } = {}) {
  const r = innerOpaqueRect({ keepRatio });
  if (!r) { if (!quiet) status('No large enough area without empty edges.'); return null; }
  if (r.full) { if (!quiet) status('There are no empty edges to crop.'); return null; }
  cropTo(r, label); if (!quiet) status(`Cropped to ${r.w} × ${r.h} px: no empty corners.`);
  return r;
}
/** Fill the transparent parts of the active layer (inside the canvas) with a smooth extension of nearby pixels. */
function fillEmptyEdges({ quiet = false } = {}) {
  const d = doc(), l = activeLayer();
  if (!l || l.kind === 'adjust' || l.kind === 'text' || l.kind === 'smart' || isGroup(l)) { if (!quiet) status('Fill empty edges needs a pixel layer.'); return false; }
  if (useDeep(l)) return fillEmptyEdgesDeep(l, { quiet });
  const W = d.width, H = d.height, full = makeCanvas(W, H), fx = full.getContext('2d', { willReadFrequently: true });
  fx.drawImage(l.canvas, l.x, l.y);
  const k = Math.min(1, 1024 / Math.max(W, H)), sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
  const sm = makeCanvas(sw, sh), sx = sm.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high'; sx.drawImage(full, 0, 0, sw, sh);
  const img = sx.getImageData(0, 0, sw, sh); let empty = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) empty++;
  if (!empty) { if (!quiet) status('There are no empty edges to fill.'); return false; }
  // v1.13: mirror nearest opaque (keeps texture) and blend with a push-pull of the *original* gaps (softens seams).
  const wasEmpty = new Uint8Array(sw * sh), id0 = img.data;
  for (let i = 0; i < wasEmpty.length; i++) if (id0[i * 4 + 3] < 255) wasEmpty[i] = 1;
  const soft = { width: sw, height: sh, data: new Uint8ClampedArray(id0) };
  seg.pushPullFill(soft);
  seg.edgeCloneFill(img);
  const id = img.data, sd = soft.data;
  for (let i = 0; i < wasEmpty.length; i++) if (wasEmpty[i]) {
    const j = i * 4;
    id[j] = (id[j] * 0.65 + sd[j] * 0.35 + 0.5) | 0;
    id[j + 1] = (id[j + 1] * 0.65 + sd[j + 1] * 0.35 + 0.5) | 0;
    id[j + 2] = (id[j + 2] * 0.65 + sd[j + 2] * 0.35 + 0.5) | 0;
  }
  sx.putImageData(img, 0, 0);
  const out = makeCanvas(W, H), ox = out.getContext('2d'); ox.imageSmoothingQuality = 'high';
  ox.drawImage(sm, 0, 0, W, H); ox.drawImage(full, 0, 0); // the original pixels stay on top; only the gaps take the fill
  l.canvas = out; l.x = 0; l.y = 0; touch(l); compDirty = true;
  commit('Fill empty edges'); if (!quiet) status('Empty edges filled from nearby pixels (mirror + smooth; best for sky, walls and plain areas).');
  updateLayersPanel(); requestRender(); return true;
}
/**
 * 16-bit Fill empty edges (v1.9): the same push-pull fill as the 8-bit path, at 16 bits per channel. The gaps are
 * filled on a ≤ 1024 px copy (area-averaged in premultiplied 16-bit) and sampled back bilinearly; the original pixels
 * stay on top (partly transparent edge pixels are blended over the fill, like the 8-bit source-over).
 */
function fillEmptyEdgesDeep(l, { quiet = false } = {}) {
  const d = doc(), W = d.width, H = d.height, src = deepOf(l), full = createDeep(W, H), F = full.data, S = src.data;
  for (let y = 0; y < src.height; y++) { const Y = y + l.y; if (Y < 0 || Y >= H) continue; for (let x = 0; x < src.width; x++) { const X = x + l.x; if (X < 0 || X >= W) continue; const i = (y * src.width + x) * 4, o = (Y * W + X) * 4; F[o] = S[i]; F[o + 1] = S[i + 1]; F[o + 2] = S[i + 2]; F[o + 3] = S[i + 3]; } }
  let empty = 0; for (let i = 3; i < F.length; i += 4) if (F[i] < 65535) { empty++; break; }
  if (!empty) { if (!quiet) status('There are no empty edges to fill.'); return false; }
  const k = Math.min(1, 1024 / Math.max(W, H)), sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
  const acc = new Float64Array(sw * sh * 5);
  for (let y = 0; y < H; y++) { const sy = Math.min(sh - 1, Math.floor(y * sh / H)); for (let x = 0; x < W; x++) { const sx = Math.min(sw - 1, Math.floor(x * sw / W)), i = (y * W + x) * 4, o = (sy * sw + sx) * 5, a = F[i + 3]; acc[o] += F[i] * a; acc[o + 1] += F[i + 1] * a; acc[o + 2] += F[i + 2] * a; acc[o + 3] += a; acc[o + 4]++; } }
  const small = { width: sw, height: sh, data: new Uint16Array(sw * sh * 4) };
  for (let j = 0; j < sw * sh; j++) { const o = j * 5, a = acc[o + 3]; if (a > 0) { small.data[j * 4] = Math.round(acc[o] / a); small.data[j * 4 + 1] = Math.round(acc[o + 1] / a); small.data[j * 4 + 2] = Math.round(acc[o + 2] / a); } small.data[j * 4 + 3] = acc[o + 4] ? Math.round(a / acc[o + 4]) : 0; }
  // v1.13: mirror + push-pull blend on the ≤1024 preview (same idea as 8-bit)
  const wasEmpty16 = new Uint8Array(sw * sh), S0 = small.data;
  for (let i = 0; i < wasEmpty16.length; i++) if (S0[i * 4 + 3] < 65535) wasEmpty16[i] = 1;
  const soft16 = { width: sw, height: sh, data: new Uint16Array(S0) };
  seg.pushPullFill(soft16, { max: 65535 });
  seg.edgeCloneFill(small, { max: 65535 });
  const T = small.data, Sd = soft16.data;
  for (let i = 0; i < wasEmpty16.length; i++) if (wasEmpty16[i]) {
    const j = i * 4;
    T[j] = (T[j] * 0.65 + Sd[j] * 0.35 + 0.5) | 0;
    T[j + 1] = (T[j + 1] * 0.65 + Sd[j + 1] * 0.35 + 0.5) | 0;
    T[j + 2] = (T[j + 2] * 0.65 + Sd[j + 2] * 0.35 + 0.5) | 0;
  }
  for (let y = 0; y < H; y++) {
    const gy = (y + 0.5) * sh / H - 0.5, y0 = Math.max(0, Math.floor(gy)), y1 = Math.min(sh - 1, y0 + 1), fy = Math.min(1, Math.max(0, gy - y0));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, a = F[i + 3]; if (a === 65535) continue;
      const gx = (x + 0.5) * sw / W - 0.5, x0 = Math.max(0, Math.floor(gx)), x1 = Math.min(sw - 1, x0 + 1), fx = Math.min(1, Math.max(0, gx - x0)), t = a / 65535;
      for (let ch = 0; ch < 3; ch++) {
        const v = (T[(y0 * sw + x0) * 4 + ch] * (1 - fx) + T[(y0 * sw + x1) * 4 + ch] * fx) * (1 - fy) + (T[(y1 * sw + x0) * 4 + ch] * (1 - fx) + T[(y1 * sw + x1) * 4 + ch] * fx) * fy;
        F[i + ch] = Math.round(F[i + ch] * t + v * (1 - t));
      }
      F[i + 3] = 65535;
    }
  }
  l.x = 0; l.y = 0; setDeep(l, full); compDirty = true;
  commit('Fill empty edges'); if (!quiet) status('Empty edges filled from nearby pixels at 16 bits (best for sky, walls and other plain areas).');
  updateLayersPanel(); requestRender(); return true;
}
/** renderMeshCPU on a 16-bit DImage (same triangles and sampling as the 8-bit path). */
function deepMesh(src, w, h, m, ox, oy, region = null, into = null) {
  const out = into || createDeep(w, h);
  mesh.renderMeshCPU(src, w, h, m, ox, oy, out, region);
  return out;
}
function cancelMeshXf() {
  const x = state.mxf; if (!x) return;
  state.mxf = null; x.seq++;
  const l = x.layer, o = x.orig;
  l.canvas = o.canvas; l.x = o.x; l.y = o.y;
  if (o.mask && l.mask) { l.mask.canvas = o.mask; touchMask(l); }
  touch(l);
  if (o.deep) { l.deep = o.deep; l.deepRev = l.rev; l.deepOX = o.deepOX; l.deepOY = o.deepOY; }
  buildOptionsBar(); requestRender(); status('Transform cancelled');
}
function mxfBarParts() {
  const x = state.mxf, warp = x.mode === 'warp';
  return [`<span class="tool-title">${warp ? 'Warp' : 'Perspective'}</span>`,
    warp ? '' : `<span class="seg" title="Upright from the photo's straight lines">${[['autoUpright', 'auto', 'Auto', 'Make the vertical lines upright (levels from the horizontals when there are no verticals)'], ['uprightLevel', 'level', 'Level', 'Rotate so the horizontal lines are level'], ['uprightVertical', 'vertical', 'Vertical', 'Make the vertical lines upright and parallel'], ['uprightFull', 'full', 'Full', 'Straighten the verticals and the horizontals together']].map(([c, m, n, t]) => `<button data-cmd="${c}" class="${x.upright === 'auto' && lastUpright?.req === m ? 'on' : ''}" title="${t}">${n}</button>`).join('')}</span>`,
    warp ? '' : `<button data-cmd="mxfGuides" class="${x.guideMode ? 'on' : ''}" title="Draw 2–4 lines along edges that should be vertical or horizontal">Guides</button>`,
    warp ? '' : `<span class="seg" title="After an upright correction: crop away the empty corners, fill them from nearby pixels, or leave them transparent">${[['crop', 'Crop edges'], ['fill', 'Fill edges'], ['keep', 'Keep']].map(([k, n]) => `<button data-cmd="uprightEdges_${k}" class="${state.opts.uprightEdges === k ? 'on' : ''}">${n}</button>`).join('')}</span>`,
    warp ? `<span class="seg">${[3, 4, 5].map((n) => `<button data-cmd="mxfGrid${n}" class="${x.n === n ? 'on' : ''}" title="${n}×${n} control points">${n}×${n}</button>`).join('')}</span>` : '',
    `<span class="muted">${warp ? 'Drag grid points to bend the layer' : x.guideMode ? `Guided: ${(x.guides || []).length}/4 guides${(x.guides || []).length >= 2 ? ' · Enter applies' : ' · draw along edges'}` : 'Drag the corners'} · Enter applies · Esc cancels</span>`,
    (x.guideMode && (x.guides || []).length >= 2 ? `<button data-cmd="mxfGuidedApply" class="primary">Apply guides</button>` : ''),
    `<button data-cmd="mxfReset">Reset</button>`, `<button data-cmd="mxfApply" class="primary">Apply</button>`, `<button data-cmd="mxfCancel">Cancel</button>`];
}
function drawMeshBox(toS) {
  const x = state.mxf, warp = x.mode === 'warp';
  vctx.save();
  const line = (pts) => { vctx.beginPath(); pts.forEach(([a, b], i) => { const [sx, sy] = toS(a, b); if (i) vctx.lineTo(sx, sy); else vctx.moveTo(sx, sy); }); };
  const strokeTwice = () => { vctx.lineWidth = 3; vctx.strokeStyle = '#000a'; vctx.stroke(); vctx.lineWidth = 1; vctx.strokeStyle = '#fff'; vctx.stroke(); };
  if (warp) { // grid curves through the control points (the same surface the warp uses)
    const N = 24, n = x.n;
    for (let j = 0; j < n; j++) { const t = j / (n - 1), pts = []; for (let i = 0; i <= N; i++) pts.push(mesh.warpEval(x.pts, n, i / N, t)); line(pts); strokeTwice(); }
    for (let i = 0; i < n; i++) { const s = i / (n - 1), pts = []; for (let j = 0; j <= N; j++) pts.push(mesh.warpEval(x.pts, n, s, j / N)); line(pts); strokeTwice(); }
  } else { line([...x.pts, x.pts[0]]); strokeTwice(); }
  for (const g of [...(x.guides || []), ...(x.guideDraft ? [x.guideDraft] : [])]) { // guided upright lines
    line(g); vctx.lineWidth = 3; vctx.strokeStyle = '#000a'; vctx.stroke(); vctx.lineWidth = 1.5; vctx.strokeStyle = '#3ad1ff'; vctx.stroke();
  }
  const hs = IS_TOUCH ? 7 : 4.5;
  for (const [px, py] of x.pts) {
    const [hx, hy] = toS(px, py);
    vctx.beginPath(); vctx.arc(hx, hy, hs, 0, Math.PI * 2); vctx.fillStyle = warp ? '#7a5cff' : '#fff'; vctx.fill(); vctx.lineWidth = 1.5; vctx.strokeStyle = '#1b1c20'; vctx.stroke();
  }
  vctx.restore();
}
/**
 * Guided upright (v1.16: 2–4 guides). Two guides still use a 4-point homography (each line straightened
 * about its midpoint). Three or four guides classify as vertical / horizontal; two or more of a family
 * vote for a vanishing point, then uprightHomography builds the correction so verticals and horizontals
 * can be fixed in one pass.
 */
function uprightFromGuides(pts, guides, layerW, layerH) {
  if (guides.length < 2) return null;
  const W = layerW || 1, Hgt = layerH || 1;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const toLine = ([[ax, ay], [bx, by]]) => {
    const len = Math.hypot(bx - ax, by - ay);
    return { x1: ax, y1: ay, x2: bx, y2: by, len, angle: Math.atan2(bx - ax, by - ay) * 180 / Math.PI, vert: Math.abs(by - ay) >= Math.abs(bx - ax) };
  };
  const lines = guides.map(toLine);
  const verts = lines.filter((l) => l.vert), hors = lines.filter((l) => !l.vert);
  const mapPts = (Hu) => {
    const out = pts.map(([px, py]) => { const [X, Y, w] = mesh.applyH(Hu, px, py); return w > 0 ? [X, Y] : null; });
    return out.some((q) => !q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) ? null : out;
  };
  if (verts.length >= 2 || hors.length >= 2) {
    let vv = null, vh = null;
    if (verts.length >= 2) {
      const u = seg.estimateUpright(verts, W, Hgt);
      if (u.mode !== 'none' && u.vh) vv = u.vh;
    }
    if (hors.length >= 2) {
      const swapped = hors.map((l) => ({ x1: l.y1, y1: l.x1, x2: l.y2, y2: l.x2, len: l.len, angle: Math.atan2(l.x2 - l.x1, l.y2 - l.y1) * 180 / Math.PI }));
      const u = seg.estimateUpright(swapped, Hgt, W);
      if (u.mode !== 'none' && u.vh) vh = [u.vh[1], u.vh[0], u.vh[2]];
    }
    if (vv || vh) {
      const Hu = seg.uprightHomography(vv, vh, cx, cy);
      if (Hu) { const out = mapPts(Hu); if (out) return out; }
    }
  }
  const use = guides.length === 2 ? guides : guides.slice(0, 2);
  const src = [], dst = [];
  for (const [[ax, ay], [bx, by]] of use) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2, vert = Math.abs(by - ay) >= Math.abs(bx - ax);
    src.push([ax, ay], [bx, by]);
    dst.push(vert ? [mx, ay] : [ax, my], vert ? [mx, by] : [bx, my]);
  }
  const Hm = mesh.homography(src, dst); if (!Hm) return null;
  return mapPts(Hm);
}
function previewGuidedUpright(x) {
  if (!x || (x.guides || []).length < 2) return false;
  const base = x.pts0 || x.pts;
  const next = uprightFromGuides(base, x.guides, x.w, x.h);
  if (!next || !mesh.perspectiveMesh(x.w, x.h, next)) return false;
  const m = mxfBounds(mxfMesh({ ...x, pts: next }));
  if (!m) return false;
  x.pts = next;
  mxfPreview();
  return true;
}
function finishGuidedUpright(x) {
  if (!x || (x.guides || []).length < 2) { status('Guided upright: draw at least two lines.'); return; }
  if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
  x.pts = x.pts0.map((p) => [...p]);
  const n = x.guides.length;
  const ok = previewGuidedUpright(x);
  x.guides = [];
  x.guideMode = false;
  x.pts0 = null;
  if (!ok) { status('Those guides cannot be straightened together: try longer edges or fewer lines.'); buildOptionsBar(); requestRender(); return; }
  x.upright = 'guided';
  status(`Guided upright: ${n} guide${n === 1 ? '' : 's'} straightened.`);
  buildOptionsBar();
  void applyMeshXf();
}
function addUprightGuide(x, g) {
  if (Math.hypot(g[1][0] - g[0][0], g[1][1] - g[0][1]) * state.zoom < 12) { status('Drag a longer line along an edge that should be straight.'); return; }
  if (!x.pts0) x.pts0 = x.pts.map((p) => [...p]);
  x.guides = [...(x.guides || []), g];
  const n = x.guides.length;
  if (n < 2) { status('Guided upright: now draw a second line (up to four).'); buildOptionsBar(); requestRender(); return; }
  const saved = x.pts;
  x.pts = x.pts0.map((p) => [...p]);
  if (!previewGuidedUpright(x)) {
    x.pts = saved;
    x.guides.pop();
    status('That line cannot be combined with the others: try a longer edge.');
    buildOptionsBar(); requestRender(); return;
  }
  if (n >= 4) { finishGuidedUpright(x); return; }
  status(`Guided upright: ${n} of 4 guides · Enter applies · draw more for verticals and horizontals`);
  buildOptionsBar();
}

const mxfHandler = {
  down(p, e) {
    const x = state.mxf, tol = (e.pointerType === 'touch' ? 22 : 10) / state.zoom;
    if (x.guideMode) { x.guideDraft = [[p.x, p.y], [p.x, p.y]]; drag = { guide: true }; requestRender(); return; }
    let best = -1, bd = tol;
    x.pts.forEach(([a, b], i) => { const dd = Math.hypot(p.x - a, p.y - b); if (dd <= bd) { bd = dd; best = i; } });
    if (best < 0) { drag = null; return; }
    drag = { mxf: best, start: [...x.pts[best]], p0: p };
  },
  move(p) {
    const x = state.mxf;
    if (drag && drag.guide && x && x.guideDraft) { x.guideDraft[1] = [p.x, p.y]; requestRender(); return; }
    if (!drag || drag.mxf == null || !x) return;
    x.pts[drag.mxf] = [drag.start[0] + p.x - drag.p0.x, drag.start[1] + p.y - drag.p0.y];
    mxfPreview();
  },
  up() {
    const x = state.mxf;
    if (drag && drag.guide && x) { const g = x.guideDraft; x.guideDraft = null; drag = null; if (g) addUprightGuide(x, g); return; }
    if (!drag || drag.mxf == null) return;
    mxfRender().catch((err) => status(`Preview failed: ${err.message}`));
  },
};

// --- Liquify tool (K): push / bloat / pinch / restore through a displacement mesh ----------------------
// Each stroke builds a displacement field over the layer (4 px cells). While dragging only the touched
// region is re-rendered on the CPU; on release the stroke's bounding box is rendered by the GPU engine (CPU fallback).
const liquifyTool = {
  down(p) {
    const l = activeLayer(); if (!l) return;
    if (l.kind === 'adjust') { status('Liquify needs a pixel layer.'); return; }
    if (!l.visible) { status('The active layer is hidden. Show it to liquify.'); return; }
    if (editingMask(l)) { status('Liquify works on layer pixels. Click the layer thumbnail to target pixels.'); return; }
    rasterize(l, 'liquify');
    const cv = l.canvas, o = state.opts;
    drag = {
      liquify: true, layer: l, src: ctxOf(cv).getImageData(0, 0, cv.width, cv.height), dsrc: useDeep(l) ? deepOf(l) : null, field: mesh.createField(cv.width, cv.height, 4),
      mode: o.liquifyMode, r: Math.max(2, o.liquifySize / 2), s: Math.max(0.01, o.liquifyStrength / 100), last: p, bb: null, timer: null,
    };
    if (drag.mode !== 'push') { // bloat / pinch / restore keep working while the button is held still
      const dr = drag; dr.timer = setInterval(() => { if (drag === dr) liquifyDab(dr.last, 0, 0); }, 40);
      liquifyDab(p, 0, 0);
    }
  },
  move(p) {
    if (!drag?.liquify) return;
    const dr = drag, dx = p.x - dr.last.x, dy = p.y - dr.last.y, dist = Math.hypot(dx, dy);
    if (dr.mode === 'push') {
      const step = Math.max(1, dr.r * 0.2), n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i++) liquifyDab({ x: dr.last.x + (dx * i) / n, y: dr.last.y + (dy * i) / n }, dx / n, dy / n, false);
      liquifyPreview(dr.pending); dr.pending = null;
    } else liquifyDab(p, 0, 0);
    dr.last = p;
  },
  async up() {
    const dr = drag; if (!dr?.liquify) return;
    clearInterval(dr.timer); drag = null;
    if (!dr.bb || mesh.fieldIsIdentity(dr.field)) { liquifyRestore(dr); return; }
    const b = dr.bb, w = b.x1 - b.x, h = b.y1 - b.y;
    setBusy(1);
    try {
      const out = await renderMeshAny(dr.src, w, h, mesh.fieldMesh(dr.field, b), b.x, b.y);
      ctxOf(dr.layer.canvas).putImageData(out, b.x, b.y);
      gfx.lastLiquify = { field: dr.field, bb: b, src: dr.src }; // kept for diagnostics / tests
      touch(dr.layer);
      if (dr.dsrc && dr.dsrc.width === dr.layer.canvas.width && dr.dsrc.height === dr.layer.canvas.height) { // 16-bit: re-sample the stroke area from the 16-bit source
        const full = cloneDeep(dr.dsrc), part = deepMesh(dr.dsrc, w, h, mesh.fieldMesh(dr.field, b), b.x, b.y);
        for (let y = 0; y < h; y++) full.data.set(part.data.subarray(y * w * 4, (y + 1) * w * 4), ((b.y + y) * full.width + b.x) * 4);
        const l = dr.layer; l.deep = full; l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0;
      }
      requestRender(); commit('Liquify'); updateLayersPanel();
    } catch (err) { liquifyRestore(dr); status(`Liquify failed: ${err.message}`); }
    finally { setBusy(-1); }
  },
};
function liquifyRestore(dr) { ctxOf(dr.layer.canvas).putImageData(dr.src, 0, 0); touch(dr.layer); requestRender(); }
/** One dab at doc point p (push: brush movement dx, dy). Grows the stroke bbox; previews unless `show` is false. */
function liquifyDab(p, dx, dy, show = true) {
  const dr = drag, l = dr.layer;
  const r = mesh.liquifyDab(dr.field, dr.mode, p.x - l.x, p.y - l.y, dr.r, dr.s, dx, dy);
  if (r.x1 <= r.x || r.y1 <= r.y) return;
  const u = (a, b) => (a ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });
  dr.bb = u(dr.bb, r); dr.pending = u(dr.pending, r);
  if (show) { liquifyPreview(dr.pending); dr.pending = null; }
}
function liquifyPreview(r) {
  const dr = drag; if (!r || !dr) return;
  const w = r.x1 - r.x, h = r.y1 - r.y; if (w <= 0 || h <= 0) return;
  const out = mesh.renderMeshCPU(dr.src, w, h, mesh.fieldMesh(dr.field, r), r.x, r.y);
  ctxOf(dr.layer.canvas).putImageData(out, r.x, r.y);
  touch(dr.layer); requestRender();
}

// --- Help ▸ Run performance benchmark -----------------------------------------------------------------
// Runs the same operations on every available engine with synthetic images. Engines are created one at a
// time (a WebGPU device can invalidate existing WebGL contexts), so the app's own engine is shut down first
// and started again afterwards.
let benchRunning = false;
function openBenchmarkDialog() {
  if (benchRunning) { status('The benchmark is already running.'); return; }
  const body = document.createElement('div');
  body.className = 'bench';
  body.innerHTML = `<p class="muted">Times the same operations — Gaussian blur, curves, a 10-layer composite, a mesh warp and the RAW develop (preview updates while you drag a slider or paint a mask, and a full-resolution 16-bit develop with masks) — on each available engine (CPU, WebGL2, WebGPU) with synthetic test images. Your open documents are not touched. Large sizes take a while; the app is busy meanwhile.</p>
    <div class="field two"><span>Sizes</span><span><label><input type="checkbox" id="bench1"/> 1 MP (quick check)</label> <label><input type="checkbox" id="bench12" checked/> 12 MP (4000×3000)</label> <label><input type="checkbox" id="bench24" checked/> 24 MP (6000×4000)</label></span></div>
    <div class="field two"><span>Engines</span><span><label><input type="checkbox" id="benchcpu" checked/> CPU</label> <label><input type="checkbox" id="benchwebgl" checked/> WebGL2</label> <label><input type="checkbox" id="benchwebgpu" checked/> WebGPU</label></span></div>
    <div class="field two"><span>RAW develop</span><span><label><input type="checkbox" id="benchdev" checked/> include the RAW develop tests</label></span></div>
    <div class="bench-actions"><button id="benchRun" class="primary">Run benchmark</button> <button id="benchCopy" disabled>Copy results</button> <span id="benchProgress" class="muted" role="status"></span></div>
    <div id="benchOut" class="bench-out"></div>`;
  let last = null;
  const run1 = async () => {
    const sizes = [1, 12, 24].filter((s) => body.querySelector(`#bench${s}`).checked);
    const engines = ['cpu', 'webgl', 'webgpu'].filter((k) => body.querySelector(`#bench${k}`).checked);
    if (!sizes.length || !engines.length) { body.querySelector('#benchProgress').textContent = 'Pick at least one size and one engine.'; return; }
    body.querySelector('#benchRun').disabled = true; body.querySelector('#benchCopy').disabled = true;
    last = await runBenchmarkInApp({ sizes, engines, develop: body.querySelector('#benchdev').checked, onProgress: (t) => { body.querySelector('#benchProgress').textContent = t; } });
    body.querySelector('#benchRun').disabled = false;
    if (!last) return;
    body.querySelector('#benchCopy').disabled = false;
    body.querySelector('#benchProgress').textContent = `Done in ${((Date.parse(last.finished) - Date.parse(last.started)) / 1000).toFixed(1)} s`;
    body.querySelector('#benchOut').innerHTML = benchTableHTML(last);
  };
  body.querySelector('#benchRun').addEventListener('click', () => { run1().catch((err) => { body.querySelector('#benchProgress').textContent = `Benchmark failed: ${err.message}`; body.querySelector('#benchRun').disabled = false; }); });
  body.querySelector('#benchCopy').addEventListener('click', async () => {
    const text = benchText(last, APP_VERSION);
    const ok = await copyText(text);
    body.querySelector('#benchProgress').textContent = ok ? 'Results copied to the clipboard.' : 'Copy failed: select the text below and copy it.';
    if (!ok) { const ta = document.createElement('textarea'); ta.className = 'bench-text'; ta.value = text; ta.readOnly = true; body.querySelector('#benchOut').append(ta); ta.select(); }
  });
  showModal({ title: 'Performance benchmark', body, okLabel: 'Close', hideCancel: true, ok: () => (benchRunning ? (status('Wait for the benchmark to finish.'), false) : true) });
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
/** Tear the app engine down, run the benchmark, then start the preferred engine again. */
async function runBenchmarkInApp({ sizes = [12, 24], engines = ['cpu', 'webgl', 'webgpu'], develop = true, developDims = null, onProgress = () => {} } = {}) {
  if (benchRunning) return null;
  benchRunning = true; setBusy(1);
  try {
    await gfx.ready?.catch?.(() => {});
    await compositeSettled(); // let an in-flight GPU frame finish before the engine is torn down
    engineGen++; // cancels any pending engine start
    if (gfx.engine) { try { gfx.engine.destroy(); } catch { /* gone */ } }
    gfx.engine = null; ops.setAccelerator(null); gfx.path = 'cpu'; gfx.reason = 'benchmark running'; updateDocInfo();
    const curves = defaultAdjParams('curves'); curves.rgb = [[0, 0], [64, 110], [190, 200], [255, 255]];
    const avail = engines.filter((k) => k !== 'webgpu' || webgpuAvailable());
    const res = await runBenchmark({ engines: avail, sizes, curves, onProgress, budgetMB: Math.min(GPU_BUDGET_MB, 2048), develop: develop ? developBenchmark : null, developDims });
    for (const k of engines) if (!avail.includes(k)) res.engines[k] = { error: 'WebGPU is not available in this browser' };
    gfx.lastBench = res;
    return res;
  } finally {
    benchRunning = false; setBusy(-1);
    initEngine(); smartCache.clear(); compDirty = true; requestRender();
  }
}
function benchTableHTML(res) {
  const NM = { cpu: 'CPU', webgl: 'WebGL2', webgpu: 'WebGPU' };
  const kinds = benchKinds(res);
  const devInfo = res.develop?.error ? `<li><b>RAW develop</b>: failed — ${escapeHtml(res.develop.error)}</li>` : Object.entries(res.develop || {}).map(([k, v]) => `<li><b>RAW develop on ${NM[k]}</b>: ${v.error ? `unavailable — ${escapeHtml(v.error)}` : escapeHtml(v.renderer)}${v.software ? ' <span class="warn">software — not representative of a hardware GPU</span>' : ''}</li>`).join('');
  const info = Object.entries(res.engines).map(([k, v]) => `<li><b>${NM[k]}</b>: ${v.error ? `unavailable — ${escapeHtml(v.error)}` : escapeHtml(k === 'webgpu' ? [v.vendor, v.architecture, v.device, v.description].filter(Boolean).join(' · ') || v.renderer : v.renderer || 'Canvas 2D + worker')}${v.software ? ' <span class="warn">software adapter — not representative of a hardware GPU</span>' : ''}</li>`).join('');
  const sizes = [...new Set(res.rows.map((r) => r.mp))].sort((a, b) => a - b);
  let rows = '';
  for (const mp of sizes) for (const [op, label] of BENCH_OPS) {
    const cells = kinds.map((k) => res.rows.find((x) => x.mp === mp && x.op === op && x.kind === k));
    if (cells.every((c) => !c)) continue;
    const best = Math.min(...cells.filter((c) => c?.ms != null).map((c) => c.ms));
    rows += `<tr><td>${escapeHtml(label)}</td><td>${mp}</td>${cells.map((c) => `<td class="${c?.ms === best ? 'best' : ''}" title="${escapeHtml(c?.error || '')}">${!c ? '—' : c.ms == null ? 'error' : `${c.ms} ms`}</td>`).join('')}</tr>`;
  }
  return `<ul class="bench-info">${info}${devInfo}</ul><table class="bench-table"><thead><tr><th>Operation</th><th>MP</th>${kinds.map((k) => `<th>${NM[k]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function pickColor(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  let px;
  if (state.opts.sampleAll) {
    if (x < 0 || y < 0 || x >= doc().width || y >= doc().height) return;
    freshComp();
    px = compCtx.getImageData(x, y, 1, 1).data;
  } else {
    const l = activeLayer(); const lx = x - l.x, ly = y - l.y;
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) return;
    px = ctxOf(l.canvas).getImageData(lx, ly, 1, 1).data;
  }
  if (px[3] === 0) return;
  setFg(rgbToHex(px[0], px[1], px[2]));
}

// ---------------------------------------------------------------------------
// Pointer & keyboard input
// ---------------------------------------------------------------------------
// Touch model: one finger runs the active tool; two fingers pinch-zoom and pan (and cancel a
// stroke that just started); a still long-press acts as Alt (clone/heal source, color pick,
// subtract selection); a quick two-finger tap undoes. The on-screen Shift/Alt toggles latch.
const mods = { shift: false, alt: false };
const pointers = new Map();
let gesture = null, pendingTouch = null, lastTap = null;
const LONG_PRESS_MS = 450, TAP_SLOP = 9;
function toolEvent(e, extra = {}) {
  return {
    shiftKey: !!(e.shiftKey || mods.shift), altKey: !!(e.altKey || mods.alt || extra.alt), ctrlKey: e.ctrlKey, metaKey: e.metaKey,
    detail: extra.detail ?? e.detail, clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType, buttons: e.buttons,
  };
}
function setMod(name, on) {
  mods[name] = on;
  document.querySelectorAll(`[data-mod="${name}"]`).forEach((b) => b.classList.toggle('on', on));
}
/** Abandon the in-progress tool drag, restoring pixels/position (used when a pinch starts). */
function cancelDrag() {
  if (pendingTouch) { clearTimeout(pendingTouch.timer); pendingTouch = null; }
  if (!drag) return;
  if (drag.xf) { Object.assign(state.xf, drag.s0); previewTransform(); drag = null; requestRender(); return; }
  if (drag.liquify) { clearInterval(drag.timer); liquifyRestore(drag); drag = null; return; }
  if (drag.mxf != null && state.mxf) { state.mxf.pts[drag.mxf] = drag.start; drag = null; mxfRender(); return; }
  if (drag.float) { const f = drag.float, c = ctxOf(targetCanvas(f.layer)); c.save(); c.globalCompositeOperation = 'copy'; c.drawImage(f.original, 0, 0); c.restore(); touchTarget(f.layer); }
  if (drag.backup && drag.canvas) {
    const c = drag.canvas.getContext('2d'); c.save(); c.globalCompositeOperation = 'copy'; c.globalAlpha = 1; c.drawImage(drag.backup, 0, 0); c.restore();
    if (drag.layer) touchTarget(drag.layer);
  }
  if (drag.layer && drag.ox !== undefined) { drag.layer.x = drag.ox; drag.layer.y = drag.oy; touch(drag.layer); }
  if (state.tool === 'polylasso' && state.poly && state.poly.pts.length === 1) state.poly = null;
  state.selPreview = null; drag = null; compDirty = true; requestRender();
}
function twoPointers() { const [a, b] = [...pointers.values()]; return { a, b, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; }
function startGesture() {
  const g = twoPointers();
  gesture = { d0: g.d, mx0: g.mx, my0: g.my, zoom0: state.zoom, panX0: state.panX, panY0: state.panY, t0: performance.now(), moved: false };
  // during a free transform two fingers scale / rotate / move the piece instead of the view
  if (state.xf) gesture.xf = { ...xfParams(state.xf), a0: Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x), m0: screenToDoc({ clientX: g.mx, clientY: g.my }) };
}
function updateGesture() {
  if (pointers.size < 2) return;
  const g = twoPointers(), r = view.getBoundingClientRect();
  if (Math.abs(g.d - gesture.d0) > 10 || Math.hypot(g.mx - gesture.mx0, g.my - gesture.my0) > 10) gesture.moved = true;
  if (gesture.xf && state.xf) {
    const s0 = gesture.xf, x = state.xf, k = g.d / gesture.d0;
    let da = Math.atan2(g.b.y - g.a.y, g.b.x - g.a.x) - s0.a0;
    if (mods.shift) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
    if (Math.abs(da) > 0.05) gesture.moved = true;
    const m1 = screenToDoc({ clientX: g.mx, clientY: g.my }), vx = s0.cx - s0.m0.x, vy = s0.cy - s0.m0.y, c = Math.cos(da), sn = Math.sin(da);
    x.cx = m1.x + k * (c * vx - sn * vy); x.cy = m1.y + k * (sn * vx + c * vy);
    x.sx = s0.sx * k; x.sy = s0.sy * k; x.rot = s0.rot + da;
    previewTransform(); updateXfFields(); requestRender();
    return;
  }
  const nz = Math.min(64, Math.max(0.02, gesture.zoom0 * g.d / gesture.d0));
  const docX = (gesture.mx0 - r.left - gesture.panX0) / gesture.zoom0, docY = (gesture.my0 - r.top - gesture.panY0) / gesture.zoom0;
  state.zoom = nz; state.panX = g.mx - r.left - docX * nz; state.panY = g.my - r.top - docY * nz;
  updateZoomLabel(); requestRender();
}
function firePending(alt) {
  const pt = pendingTouch; if (!pt) return; clearTimeout(pt.timer); pendingTouch = null;
  const now = performance.now();
  const dbl = lastTap && now - lastTap.t < 320 && Math.hypot(pt.e.clientX - lastTap.x, pt.e.clientY - lastTap.y) < 24;
  lastTap = { t: now, x: pt.e.clientX, y: pt.e.clientY };
  if (state.busy) { status('Still processing… one moment.'); return; }
  handler()?.down?.(pt.p, toolEvent(pt.e, { alt, detail: dbl ? 2 : 1 }));
}
view.addEventListener('pointerdown', (e) => {
  if (!doc()) return;
  if (e.button === 2 && e.pointerType === 'mouse') return; // right button: context menu (see 'contextmenu')
  closeContextMenu();
  if (document.body.dataset.sheet) { closeSheet(); if (e.pointerType === 'touch') return; }
  viewport.focus({ preventScroll: true });
  try { view.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (pointers.size === 2 && [...pointers.values()].every((q) => q.type === 'touch')) {
    const hadStroke = !!drag && !drag.pan; cancelDrag(); drag = null; startGesture(); gesture.cancelledStroke = hadStroke; return;
  }
  if (pointers.size > 1 || gesture) return;
  const p = screenToDoc(e);
  if (e.button === 1 || spaceDown || state.tool === 'hand') {
    drag = { pan: true, sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    view.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
  if (state.busy) { status('Still processing… one moment.'); return; }
  if (e.pointerType === 'touch') {
    // Wait briefly to tell a tap, a drag, a long-press and the start of a pinch apart.
    pendingTouch = { p, e, timer: setTimeout(() => {
      if (!pendingTouch) return;
      navigator.vibrate?.(12);
      toast(state.tool === 'clone' || state.tool === 'heal' ? 'Source set (long-press)' : 'Long-press: Alt');
      firePending(true);
    }, LONG_PRESS_MS) };
    return;
  }
  handler()?.down?.(p, toolEvent(e));
});
view.addEventListener('pointermove', (e) => {
  if (!doc()) return;
  const pt = pointers.get(e.pointerId); if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
  if (gesture) { updateGesture(); return; }
  const p = screenToDoc(e);
  state.hover = p;
  $('#cursorPos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
  if (drag?.pan) {
    state.panX = drag.px + e.clientX - drag.sx; state.panY = drag.py + e.clientY - drag.sy; requestRender(); return;
  }
  if (pendingTouch && pendingTouch.e.pointerId === e.pointerId) {
    if (Math.hypot(e.clientX - pendingTouch.e.clientX, e.clientY - pendingTouch.e.clientY) < TAP_SLOP) return;
    firePending(false);
  }
  if (drag && (e.buttons & 1 || (e.pointerType === 'touch' && pt))) handler()?.move?.(p, toolEvent(e));
  if (PAINT_TOOLS.includes(state.tool) || state.tool === 'polylasso') requestRender();
});
function endPointer(e, cancelled) {
  const had = pointers.delete(e.pointerId);
  if (gesture) {
    if (!pointers.size) {
      const quick = !gesture.moved && !gesture.cancelledStroke && performance.now() - gesture.t0 < 300;
      gesture = null;
      if (quick && !cancelled) { run('undo'); toast('Undo (two-finger tap)'); }
    }
    return;
  }
  if (!had && e.pointerType === 'touch') return;
  if (pendingTouch && pendingTouch.e.pointerId === e.pointerId) { if (cancelled) { cancelDrag(); return; } firePending(false); }
  if (drag?.pan) { drag = null; setTool(state.tool); return; }
  if (cancelled) { cancelDrag(); return; }
  if (drag) handler()?.up?.(screenToDoc(e), toolEvent(e));
  drag = null;
  if (e.pointerType === 'touch') { state.hover = null; requestRender(); }
}
view.addEventListener('pointerup', (e) => endPointer(e, false));
view.addEventListener('pointercancel', (e) => endPointer(e, true));
view.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') { state.hover = null; requestRender(); } });
// iOS Safari: block its own pinch/double-tap page zoom and long-press callouts on the canvas.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
view.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
view.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
view.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!doc() || e.pointerType === 'touch' || drag) return;
  const sel = !!doc().selection;
  showContextMenu(e.clientX, e.clientY, [
    ['Undo', 'undo'], ['Redo', 'redo'], '-',
    ...(sel ? [['Deselect', 'deselect'], ['Invert selection', 'invertSelection'], ['Feather…', 'feather'], ['Refine edge…', 'refineEdge'], ['Fill with color', 'fillSelection'], ['Clear', 'clear'], '-',
      ['Copy', 'copy'], ['Cut', 'cut'], ['Crop to selection', 'cropToSelection'], ['Add mask from selection', 'addMaskFromSelection']]
      : [['Select all', 'selectAll'], ['Select layer pixels', 'selectLayerPixels']]), '-',
    ['Copy merged', 'copyMerged'], ['Paste as layer', 'paste'], ['Free transform', 'freeTransform'], '-',
    ['New layer', 'layerNew'], ['Fit on screen', 'zoomFit'], ['Actual pixels (100%)', 'zoom100'],
  ]);
});
// --- context menus (canvas and Layers panel) ----------------------------------------------------------
const MENU_SPECS = new Map();
function menuSpecs() { if (!MENU_SPECS.size) for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[2]) MENU_SPECS.set(it[1], it[2]); return MENU_SPECS; }
function closeContextMenu() { document.querySelector('#ctxMenu')?.remove(); }
/** items: [label, command] | [label, fn] | '-'. Opens at client (x, y), kept inside the window. */
function showContextMenu(x, y, items) {
  closeContextMenu(); closeMenus();
  const m = document.createElement('div'); m.id = 'ctxMenu'; m.className = 'ctx-menu'; m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(document.createElement('hr')); continue; }
    const [label, act, disabled] = it, b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.dataset.item = typeof act === 'string' ? act : label; // not data-cmd: the global [data-cmd] click handler would run it twice
    const spec = typeof act === 'string' ? menuSpecs().get(act) : '';
    b.innerHTML = `<span>${escapeHtml(label)}</span>${spec ? `<kbd>${escapeHtml(shortcutLabel(act, spec))}</kbd>` : ''}`;
    if (disabled) b.disabled = true;
    b.addEventListener('click', () => { closeContextMenu(); if (typeof act === 'string') run(act); else act(); });
    m.append(b);
  }
  if (m.lastChild?.tagName === 'HR') m.lastChild.remove();
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`; m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  m.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContextMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
  });
}
window.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('#ctxMenu')) closeContextMenu(); }, true);
window.addEventListener('blur', closeContextMenu);
$('#layerList').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  e.preventDefault();
  const d = doc(), l = d?.layers.find((x) => String(x.id) === li.dataset.id); if (!l) return;
  if (state.xf) applyTransform();
  d.activeId = l.id; updateLayersPanel(); buildOptionsBar();
  const idx = d.layers.indexOf(l);
  showContextMenu(e.clientX, e.clientY, [
    ['Duplicate layer', 'layerDuplicate'], ['Delete layer', 'layerDelete', d.layers.length < 2], ['Merge down', 'layerMergeDown', idx === 0], '-',
    [l.visible ? 'Hide layer' : 'Show layer', () => { l.visible = !l.visible; compDirty = true; requestRender(); commit(l.visible ? 'Show layer' : 'Hide layer'); }],
    ['Rename…', () => renameLayer(l)],
    ...(l.kind ? [['Edit layer settings…', 'editLayer'], ['Convert to pixels', 'rasterizeLayer']] : [...(l.raw ? [['Re-develop RAW…', 'redevelopRaw'], ...(l.raw.link ? [['Embed linked RAW file', 'embedRaw']] : [])] : []), ['Convert to live layer', 'convertSmart']]), '-',
    ...(l.mask ? [['Enable / disable mask', 'toggleMask'], ['Invert mask', 'invertMask'], ['Apply mask', 'applyMask'], ['Delete mask', 'deleteMask']]
      : [['Add layer mask', 'addMask'], ['Add mask from selection', 'addMaskFromSelection', !d.selection]]), '-',
    ['Select layer pixels', 'selectLayerPixels'], ['Move up', 'layerUp', idx === d.layers.length - 1], ['Move down', 'layerDown', idx === 0], ['Flatten image', 'flatten'],
  ]);
});
function renameLayer(l) {
  const body = document.createElement('div');
  body.innerHTML = `<label class="field two"><span>Name</span><input type="text" id="renameInput" maxlength="80" /></label>`;
  const inp = body.querySelector('input'); inp.value = l.name;
  showModal({ title: 'Rename layer', body, okLabel: 'Rename', ok: () => { const v = inp.value.trim(); if (v && v !== l.name) { l.name = v; commit('Rename layer'); updateLayersPanel(); } } });
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}
view.addEventListener('wheel', (e) => {
  if (!doc()) return;
  e.preventDefault();
  const r = view.getBoundingClientRect();
  if (e.shiftKey && !(e.ctrlKey || e.metaKey)) { state.panX -= e.deltaY; requestRender(); }
  else zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
window.addEventListener('resize', requestRender);
new ResizeObserver(requestRender).observe(viewport);

function isTyping(e) {
  const t = e.target;
  return !!t && ((t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
window.addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') { e.preventDefault(); $('#modalCancel').click(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); $('#modalOk').click(); }
    return;
  }
  if (isTyping(e)) return;
  if (state.poly) {
    if (e.key === 'Enter') { e.preventDefault(); finishPolygon(); return; }
    if (e.key === 'Escape') { e.preventDefault(); state.poly = null; requestRender(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); state.poly.pts.pop(); if (!state.poly.pts.length) state.poly = null; requestRender(); return; }
  }
  if (state.objSel && state.tool === 'objsel') {
    if (e.key === 'Enter') { e.preventDefault(); objSelDone(); return; }
    if (e.key === 'Escape') { e.preventDefault(); objSelCancel(); return; }
  }
  if (state.mxf) {
    if (e.key === 'Enter') { e.preventDefault(); if (state.mxf.guideMode && (state.mxf.guides || []).length >= 2) finishGuidedUpright(state.mxf); else run('mxfApply'); return; }
    if (e.key === 'Escape') { e.preventDefault(); run('mxfCancel'); return; }
  }
  if (state.xf) {
    if (e.key === 'Enter') { e.preventDefault(); run('xfApply'); return; }
    if (e.key === 'Escape') { e.preventDefault(); run('xfCancel'); return; }
    if (e.key.startsWith('Arrow') && !primaryMod(e)) {
      const st = e.shiftKey ? 10 : 1, x = state.xf;
      if (e.key === 'ArrowLeft') x.cx -= st; if (e.key === 'ArrowRight') x.cx += st;
      if (e.key === 'ArrowUp') x.cy -= st; if (e.key === 'ArrowDown') x.cy += st;
      e.preventDefault(); previewTransform(); requestRender(); return;
    }
  }
  if (state.tool === 'move' && e.key.startsWith('Arrow') && !primaryMod(e) && !e.altKey && doc() && !doc().selection) {
    const st = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
    e.preventDefault(); nudgeLayers(pickedLayers(doc()), dx, dy); clearTimeout(nudgeTimer); nudgeTimer = setTimeout(() => commit('Nudge'), 400); return;
  }
  const mod = primaryMod(e) || (IS_MAC && e.ctrlKey);
  const key = e.key.toLowerCase();
  const combo = comboOf(e);
  const cmd = SHORTCUTS[combo];
  if (cmd) { e.preventDefault(); run(cmd); return; }
  if (key === ' ') { if (!spaceDown) { spaceDown = true; view.style.cursor = 'grab'; } e.preventDefault(); return; }
  if (!mod && !e.altKey) {
    // tools that share a letter cycle when it is pressed again (G: gradient ↔ fill, O, J…)
    const same = TOOLS.filter((tt) => tt.key && tt.key.toLowerCase() === key);
    if (same.length) { const i = same.findIndex((tt) => tt.id === state.tool); setTool(same[(i + 1) % same.length].id); return; }
    if (key === '[' || key === ']') { adjustBrushSize(key === ']' ? 1 : -1); return; }
    if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) { adjustBrushHardness(e.code === 'BracketRight' ? 1 : -1); return; }
    if (key === 'enter' && state.crop) { run('cropApply'); return; }
    if (key === 'escape') { if (state.crop) { state.crop = null; buildOptionsBar(); requestRender(); } return; }
    if (state.tool === 'move' && key.startsWith('arrow') && activeLayer()) {
      const s = e.shiftKey ? 10 : 1, l = activeLayer();
      for (const m of isGroup(l) ? [l, ...descendantsOf(doc(), l)] : [l]) {
        if (key === 'arrowleft') m.x -= s; if (key === 'arrowright') m.x += s;
        if (key === 'arrowup') m.y -= s; if (key === 'arrowdown') m.y += s;
      }
      compDirty = true; requestRender(); commitDebounced('Nudge layer'); e.preventDefault();
    }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; setTool(state.tool); } });

let commitTimer = null;
function commitDebounced(label) { clearTimeout(commitTimer); commitTimer = setTimeout(() => commit(label), 350); }

function adjustBrushHardness(dir) {
  const k = PAINT_TOOLS.includes(state.tool) ? `${state.tool}Hardness` : 'brushHardness';
  state.opts[k] = Math.max(0, Math.min(100, (state.opts[k] ?? 70) + dir * 10));
  buildOptionsBar(); requestRender(); status(`Hardness ${state.opts[k]}%`);
}
function adjustBrushSize(dir) {
  const k = PAINT_TOOLS.includes(state.tool) ? `${state.tool}Size` : 'brushSize';
  const v = state.opts[k];
  state.opts[k] = Math.max(1, Math.min(1000, Math.round(v + dir * Math.max(1, v * 0.1))));
  buildOptionsBar(); requestRender();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const needDoc = (fn) => (...a) => { if (!doc()) { status('Open an image or create a canvas first.'); return; } return fn(...a); };

const cmds = {
  new: () => openNewDialog(),
  open: () => { if (fsaSupported) openWithPicker(); else { fileMode = 'open'; $('#fileInput').click(); } },
  openRecent: () => openRecentDialog(),
  saveAs: needDoc(() => saveProjectAs()),
  place: needDoc(() => { fileMode = 'place'; $('#fileInput').click(); }),
  saveProject: needDoc(() => saveProject()),
  export: needDoc(() => openExportDialog()),
  exportPSD: needDoc(() => exportImage(PSD_TYPE, 1, (doc().name || 'image').replace(/\.[^.]+$/, ''))),
  mode8: needDoc(() => setDepth(8)),
  mode16: needDoc(() => setDepth(16)),
  engine: () => openEngineDialog(),
  proofOff: () => setProof(null), proofLast: () => { try { const j = JSON.parse(localStorage.getItem(PROOF_LAST_KEY) || 'null'); if (j?.mode && PROOF_PAPERS[j.mode]) { setProof(j.mode); if (j.warn) setProofWarn(true); } else status('No remembered proof yet: pick a paper under View ▸ Proof.'); } catch { status('No remembered proof yet.'); } }, proofGlossy: () => setProof('glossy'), proofMatte: () => setProof('matte'), proofRag: () => setProof('rag'), proofNews: () => setProof('newsprint'), proofCmy: () => setProof('cmy'), proofWarnOn: () => setProofWarn(true), proofWarnOff: () => setProofWarn(false),
  benchmark: () => openBenchmarkDialog(),
  userGuide: () => openUserGuide(),
  perspective: needDoc(() => startMeshXf('perspective')),
  warp: needDoc(() => startMeshXf('warp')),
  mxfApply: () => applyMeshXf(),
  mxfCancel: () => cancelMeshXf(),
  mxfReset: () => { const x = state.mxf; if (!x) return; mxfResetPoints(x); x.guides = []; mxfPreview(); mxfRender(); },
  mxfGuides: () => { const x = state.mxf; if (!x || x.mode !== 'perspective') return; if (x.guideMode && x.pts0) { x.pts = x.pts0.map((p) => [...p]); x.pts0 = null; mxfPreview(); } x.guideMode = !x.guideMode; x.guides = []; if (!x.guideMode) x.pts0 = null; buildOptionsBar(); requestRender(); if (x.guideMode) status('Guided upright: drag along 2–4 edges that should be vertical or horizontal.'); },
  mxfGuidedApply: () => { const x = state.mxf; if (x) finishGuidedUpright(x); },
  guidedUpright: needDoc(() => { if (!state.mxf) startMeshXf('perspective'); const x = state.mxf; if (!x || x.mode !== 'perspective') return; x.guideMode = true; x.guides = []; x.pts0 = null; buildOptionsBar(); requestRender(); status('Guided upright: drag along 2–4 edges that should be vertical or horizontal (Enter applies after two).'); }),
  mxfGrid3: () => mxfGrid(3), mxfGrid4: () => mxfGrid(4), mxfGrid5: () => mxfGrid(5),
  camera: () => { fileMode = 'open'; $('#cameraInput').click(); },
  closePolygon: () => finishPolygon(),
  editLayer: needDoc(() => editLayer()),
  recoverAutosave: () => checkRecovery(true),
  adjLayerMenu: needDoc(() => {
    const body = document.createElement('div'); body.className = 'choice-list';
    for (const [t, n] of Object.entries(ADJ_LAYER)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = n; b.dataset.adjType = t;
      b.addEventListener('click', () => { closeModal(); newAdjustmentLayer(t); });
      body.append(b);
    }
    showModal({ title: 'New adjustment layer', body, hideCancel: true, okLabel: 'Close' });
  }),
  rasterizeLayer: needDoc(() => { const l = activeLayer(); if (l.kind !== 'text' && l.kind !== 'smart') { status('Only text and live filter layers need converting to pixels.'); return; } const k = l.kind; rasterize(l); touch(l); updateLayersPanel(); commit(k === 'text' ? 'Convert text to pixels' : 'Convert live layer to pixels'); }),
  convertSmart: needDoc(() => convertToSmart()),
  freeTransform: needDoc(() => startTransform()),
  autoEnhance: needDoc(() => autoEnhanceCmd()),
  autoWhiteBalance: needDoc(() => autoWhiteBalanceCmd()),
  autoStraighten: needDoc(() => autoStraightenCmd()),
  autoUpright: needDoc(() => autoUprightCmd('auto')), uprightLevel: needDoc(() => autoUprightCmd('level')), uprightVertical: needDoc(() => autoUprightCmd('vertical')), uprightFull: needDoc(() => autoUprightCmd('full')),
  uprightEdges_crop: () => { state.opts.uprightEdges = 'crop'; buildOptionsBar(); }, uprightEdges_fill: () => { state.opts.uprightEdges = 'fill'; buildOptionsBar(); }, uprightEdges_keep: () => { state.opts.uprightEdges = 'keep'; buildOptionsBar(); },
  cropEmptyEdges: needDoc(() => cropEmptyEdges()), fillEmptyEdges: needDoc(() => fillEmptyEdges()),
  cropFitInside: needDoc(() => { const a = cropAspect(), r0 = innerOpaqueRect({ keepRatio: false }); if (!r0) { status('No area without empty edges.'); return; }
    let r = r0; if (a) { const t = a.w / a.h; r = r0.w / r0.h > t ? { x: Math.round(r0.x + (r0.w - r0.h * t) / 2), y: r0.y, w: Math.floor(r0.h * t), h: r0.h } : { x: r0.x, y: Math.round(r0.y + (r0.h - r0.w / t) / 2), w: r0.w, h: Math.floor(r0.w / t) }; }
    if (state.tool !== 'crop') setTool('crop'); state.crop = { x: r.x, y: r.y, w: r.w, h: r.h }; buildOptionsBar(); requestRender(); status(`Crop fitted inside the image: ${r.w} × ${r.h} px · Enter applies.`); }),
  objectSelectTool: needDoc(() => { setTool('objsel'); status('Object select: drag a box around the subject.'); }),
  objSelDone: () => objSelDone(), objSelDoneFeather: () => { void objSelDoneFeather(); }, objSelUndo: () => objSelUndoStroke(),
  straightenTool: needDoc(() => setTool('straighten')),
  wbPicker: needDoc(() => setTool('wbpick')),
  whiteBalance: needDoc(() => openAdjust(ADJ.whiteBalance)),
  alignLeft: needDoc(() => alignLayers('left')), alignHCenter: needDoc(() => alignLayers('hcenter')), alignRight: needDoc(() => alignLayers('right')),
  alignTop: needDoc(() => alignLayers('top')), alignVCenter: needDoc(() => alignLayers('vcenter')), alignBottom: needDoc(() => alignLayers('bottom')),
  distributeH: needDoc(() => alignLayers('distH')), distributeV: needDoc(() => alignLayers('distV')),
  lutImport: needDoc(async () => { const f = await pickFile('.cube'); if (!f) return; try { await importCubeText(await f.text(), f.name); } catch (err) { toast(`Could not load that LUT: ${err.message}`, 5000); } }),
  lookSave: needDoc(() => { const n = prompt('Name for this look', 'My look'); if (n) saveLookFromSelection(n.trim() || 'My look'); }),
  lookExport: () => { if (!userLooks().length) { toast('You have no saved looks yet: build one, select its group and choose Save look.'); return; } download(new Blob([exportLooksJSON()], { type: 'application/json' }), 'tintwork-looks.json'); status('Exported your looks to tintwork-looks.json'); },
  lookImport: async () => { const f = await pickFile('.json,application/json'); if (!f) return; try { const n = importLooksJSON(await f.text()); status(`Imported ${n} look${n === 1 ? '' : 's'}.`); } catch (err) { toast(`Could not import looks: ${err.message}`, 5000); } },
  xfApply: () => applyTransform(),
  xfCancel: () => cancelTransform(),
  colorRange: needDoc(() => openColorRangeDialog()),
  refineEdge: needDoc(() => openRefineDialog()),
  ...Object.fromEntries(Object.keys(ADJ_LAYER).map((t) => [`adjLayer_${t}`, needDoc(() => newAdjustmentLayer(t))])),
  curves: needDoc(() => openAdjust(ADJ.curves)),
  cancelPolygon: () => { state.poly = null; buildOptionsBar(); requestRender(); },
  undo, redo,
  selectAll: needDoc(() => { const d = doc(); setSelection(makeSelection(d.width, d.height, rectMask(d.width, d.height, { x: 0, y: 0, w: d.width, h: d.height })), 'Select all'); }),
  deselect: needDoc(() => { state.poly = null; if (doc().selection) setSelection(null, 'Deselect'); }),
  invertSelection: needDoc(() => { const d = doc(); setSelection(invertSelection(d.selection, d.width, d.height), 'Invert selection'); }),
  feather: needDoc(() => openFeatherDialog()),
  selectLayerPixels: needDoc(() => {
    const d = doc(), l = activeLayer(), c = makeCanvas(d.width, d.height);
    c.getContext('2d').drawImage(renderSource(l), l.x, l.y);
    const a = ctxOf(c).getImageData(0, 0, d.width, d.height).data, m = new Uint8Array(d.width * d.height);
    for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
    setSelection(makeSelection(d.width, d.height, m), 'Select layer pixels');
  }),
  clear: needDoc(() => {
    const l = activeLayer(), r = opRegion(l); if (!r) return;
    if (!editingMask(l)) rasterize(l, 'clearing');
    const c = ctxOf(targetCanvas(l)), sel = doc().selection;
    if (sel) { c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(selectionCanvas(sel), -l.x, -l.y); c.restore(); }
    else c.clearRect(r.x, r.y, r.w, r.h);
    touchTarget(l); requestRender(); commit(editingMask(l) ? 'Clear mask' : 'Clear'); updateLayersPanel();
  }),
  fillSelection: needDoc(() => {
    const l = activeLayer(); if (!editingMask(l)) rasterize(l, 'filling'); ensureCoversDoc(l); if (!opRegion(l)) return;
    const cv = targetCanvas(l), onMask = editingMask(l);
    const t = makeCanvas(cv.width, cv.height), tx = t.getContext('2d');
    tx.fillStyle = onMask ? '#fff' : state.fg; tx.fillRect(0, 0, t.width, t.height); maskBySelection(tx, l);
    const c = ctxOf(cv); c.save();
    if (onMask) {
      c.globalCompositeOperation = 'destination-out'; c.drawImage(t, 0, 0);
      const L = luminance(state.fg); if (L > 0) { c.globalAlpha = L; c.globalCompositeOperation = 'lighter'; c.drawImage(t, 0, 0); }
    } else c.drawImage(t, 0, 0);
    c.restore(); touchTarget(l); requestRender(); commit(onMask ? 'Fill mask' : 'Fill selection'); updateLayersPanel();
  }),
  addMask: needDoc(() => addMask(false)),
  addMaskFromSelection: needDoc(() => addMask(true)),
  toggleMask: needDoc(() => { const l = activeLayer(); if (!l.mask) return status('This layer has no mask.'); l.mask.enabled = !l.mask.enabled; touchMask(l); requestRender(); commit(l.mask.enabled ? 'Enable layer mask' : 'Disable layer mask'); }),
  editMaskToggle: needDoc(() => { const l = activeLayer(); if (!l.mask) return status('This layer has no mask.'); setMaskTarget(l, !l.editMask); }),
  invertMask: needDoc(() => {
    const l = activeLayer(); if (editingFMask(l)) { invertFilterMask(l); return; }
    if (!l.mask) return status('This layer has no mask.');
    const m = makeMaskCanvas(l.canvas.width, l.canvas.height), x = m.getContext('2d');
    x.globalCompositeOperation = 'destination-out'; x.drawImage(l.mask.canvas, 0, 0);
    l.mask.canvas = m; touchMask(l); requestRender(); commit('Invert layer mask');
  }),
  applyMask: needDoc(() => {
    const l = activeLayer(); if (!l.mask) return status('This layer has no mask.');
    l.canvas = bakeMask(l); l.mask = null; l.editMask = false; touch(l); requestRender(); commit('Apply layer mask');
  }),
  deleteMask: needDoc(() => { const l = activeLayer(); if (!l.mask) return status('This layer has no mask.'); l.mask = null; l.editMask = false; touch(l); requestRender(); commit('Delete layer mask'); }),
  copy: needDoc(() => copySelection(false)),
  copyMerged: needDoc(() => copySelection(true)),
  cut: needDoc(() => { copySelection(false); cmds.clear(); }),
  paste: needDoc(() => pasteInternal()),
  layerNew: needDoc(() => addLayer(createLayer(`Layer ${nextLayerId}`, doc().width, doc().height), 'New layer')),
  layerDuplicate: needDoc(() => duplicateActive()),
  redevelopRaw: needDoc(() => redevelopRaw()),
  embedRaw: needDoc(() => embedLinkedRaw()),
  layerDelete: needDoc(() => deleteActive()),
  layerUp: needDoc(() => layerStep(1)),
  layerDown: needDoc(() => layerStep(-1)),
  groupNew: needDoc(() => newGroup(false)),
  groupLayers: needDoc(() => newGroup(true)),
  ungroup: needDoc(() => ungroup()),
  clipToggle: needDoc(() => clipToggle()),
  mergeGroup: needDoc(() => { const l = activeLayer(); if (!isGroup(l)) return status('Select a group to merge.'); mergeGroup(l); }),
  layerStyles: needDoc(() => openStylesDialog()),
  stylesToggle: needDoc(() => {
    const l = activeLayer(); if (!l.styles?.length) return status('This layer has no layer styles.');
    const on = !l.styles.some((x) => x.enabled); l.styles = l.styles.map((x) => ({ ...x, enabled: on })); compDirty = true; requestRender(); commit(on ? 'Show layer styles' : 'Hide layer styles');
  }),
  stylesClear: needDoc(() => { const l = activeLayer(); if (!l.styles) return status('This layer has no layer styles.'); l.styles = null; compDirty = true; requestRender(); commit('Clear layer style'); }),
  layerMergeDown: needDoc(() => mergeDown()),
  flatten: needDoc(() => {
    const d = doc(); const flat = createLayer('Background', d.width, d.height);
    if (is16()) setDeep(flat, compositeDeepDoc()); else composite(flat.canvas, { sync: true });
    d.layers = [flat]; d.activeId = flat.id; compDirty = true; requestRender(); commit('Flatten image');
  }),
  rotateCW: needDoc(() => transformDoc('cw', 'Rotate 90° clockwise')),
  rotateCCW: needDoc(() => transformDoc('ccw', 'Rotate 90° counter-clockwise')),
  rotate180: needDoc(() => transformDoc('180', 'Rotate 180°')),
  flipH: needDoc(() => transformDoc('fh', 'Flip horizontal')),
  flipV: needDoc(() => transformDoc('fv', 'Flip vertical')),
  flipLayerH: needDoc(() => transformLayer('fh', 'Flip layer horizontal')),
  flipLayerV: needDoc(() => transformLayer('fv', 'Flip layer vertical')),
  imageSize: needDoc(() => openImageSizeDialog()),
  canvasSize: needDoc(() => openCanvasSizeDialog()),
  cropToSelection: needDoc(() => { const s = doc().selection; if (!s) { status('Make a selection first.'); return; } cropTo({ x: s.x, y: s.y, w: s.w, h: s.h }); }),
  cropApply: needDoc(() => { if (state.crop) applyCropTool(); }),
  // v0.9
  docNext: () => cycleTab(1), docPrev: () => cycleTab(-1), docClose: () => { if (tabs.length) closeTab(); },
  layerToDoc: needDoc(() => openLayerToDocDialog()),
  resizePresets: needDoc(() => openResizePresetDialog()),
  cropPresetTool: needDoc(() => { setTool('crop'); if (!state.opts.cropPreset) setCropPreset('sq'); else setCropPreset(state.opts.cropPreset); }),
  exportMulti: needDoc(() => openExportVariantsDialog()),
  exportLastPreset: needDoc(() => exportWithLastPreset()), watermarkSettings: () => openWatermarkDialog(),
  batch: () => openBatchDialog(), batchAgain: () => batchAgain(),
  actions: () => openActionsDialog(),
  actionRecord: () => startRecording(),
  actionStop: () => stopRecording(),
  autoEnhanceOptions: () => openAutoOptionsDialog('enhance'),
  autoWBOptions: () => openAutoOptionsDialog('wb'),
  cropCancel: () => { state.crop = null; buildOptionsBar(); requestRender(); },
  zoomIn: needDoc(() => zoomAt(1.25)), zoomOut: needDoc(() => zoomAt(0.8)),
  zoomFit: needDoc(() => fitToScreen()), zoom100: needDoc(() => setZoom(1)),
  shortcuts: () => openShortcutsDialog(),
  about: () => openInfo(`About ${APP}`, `<p>${APP} ${APP_VERSION} is an original, browser-based layered image editor (WebGPU and WebGL2 GPU engines with a CPU fallback, 8- and 16-bit documents, layer groups, clipping masks and layer styles).</p><p class="muted">Everything runs locally in your browser; images never leave your device.</p>`),
  brightnessContrast: needDoc(() => openAdjust(ADJ.brightnessContrast)),
  hueSaturation: needDoc(() => openAdjust(ADJ.hueSaturation)),
  exposure: needDoc(() => openAdjust(ADJ.exposure)),
  levels: needDoc(() => openAdjust(ADJ.levels)),
  sepia: needDoc(() => openAdjust(ADJ.sepia)),
  invert: needDoc(() => (editingMask() ? cmds.invertMask() : applyInstant('Invert', 'invert'))),
  grayscale: needDoc(() => applyInstant('Grayscale', 'grayscale')),
  autoLevels: needDoc(() => applyInstant('Auto levels', 'autoLevels')),
  gaussianBlur: needDoc(() => filterCmd('gaussianBlur')),
  sharpen: needDoc(() => filterCmd('sharpen')),
  noise: needDoc(() => filterCmd('noise')),
  vignette: needDoc(() => filterCmd('vignette')),
  swapColors: () => { const f = state.fg; setFg(state.bg); setBg(f); },
  resetColors: () => { setFg('#000000'); setBg('#ffffff'); },
};
// commands that may run while a free transform is open; anything else applies it first
const XF_SAFE = new Set(['xfApply', 'xfCancel', 'undo', 'redo', 'zoomIn', 'zoomOut', 'zoomFit', 'zoom100', 'shortcuts', 'about', 'freeTransform', 'swapColors', 'resetColors']);
/** Commands that need pixels of the active layer: a selected group has none (only a mask). */
const GROUP_BLOCKED = new Set(['brightnessContrast', 'hueSaturation', 'exposure', 'levels', 'curves', 'autoLevels', 'invert', 'grayscale', 'sepia',
  'gaussianBlur', 'sharpen', 'noise', 'vignette', 'convertSmart', 'rasterizeLayer', 'clear', 'cut', 'copy', 'fillSelection', 'flipLayerH', 'flipLayerV',
  'freeTransform', 'perspective', 'guidedUpright', 'autoUpright', 'uprightLevel', 'uprightVertical', 'uprightFull', 'fillEmptyEdges', 'warp', 'applyMask', 'selectLayerPixels', 'editLayer']);
function run(name) {
  closeMenus();
  if (isGroup(activeLayer()) && GROUP_BLOCKED.has(name)) {
    if (name === 'editLayer') { openStylesDialog(); return; }
    status('That command works on layer pixels: select a layer inside the group (or Merge group first).'); return;
  }
  if (state.xf && !XF_SAFE.has(name)) applyTransform();
  if (state.mxf && !MXF_SAFE.has(name)) { status(`Finish the ${state.mxf.mode === 'warp' ? 'warp' : 'perspective transform'} first: Enter applies, Esc cancels.`); return; }
  if (REC_CMDS.has(name) && doc()) recordStep({ t: 'cmd', name });
  return cmds[name]?.();
}

// Ctrl+V is handled by the paste event (so system-clipboard images work too).
const SHORTCUTS = {
  'mod+n': 'new', 'mod+o': 'open', 'mod+shift+o': 'place', 'mod+s': 'saveProject', 'mod+shift+s': 'saveAs', 'mod+shift+e': 'export', 'mod+shift+alt+e': 'exportLastPreset', 'mod+shift+alt+b': 'batchAgain',
  'mod+z': 'undo', 'mod+shift+z': 'redo', 'mod+y': 'redo',
  'mod+a': 'selectAll', 'mod+d': 'deselect', 'mod+shift+i': 'invertSelection', 'mod+alt+d': 'feather', 'shift+f6': 'feather', '\\': 'editMaskToggle', 'delete': 'clear', 'backspace': 'clear', 'alt+backspace': 'fillSelection',
  'mod+c': 'copy', 'mod+shift+c': 'copyMerged', 'mod+x': 'cut',
  'mod+shift+n': 'layerNew', 'mod+j': 'layerDuplicate', 'mod+e': 'layerMergeDown', 'mod+]': 'layerUp', 'mod+[': 'layerDown',
  'mod+=': 'zoomIn', 'mod++': 'zoomIn', 'mod+shift+=': 'zoomIn', 'mod+shift++': 'zoomIn', 'mod+-': 'zoomOut', 'mod+0': 'zoomFit', 'mod+1': 'zoom100',
  'mod+b': 'brightnessContrast', 'mod+u': 'hueSaturation', 'mod+l': 'levels', 'mod+m': 'curves', 'mod+i': 'invert', 'mod+shift+u': 'grayscale',
  'mod+t': 'freeTransform', 'mod+alt+r': 'refineEdge',
  'mod+shift+l': 'autoEnhance',
  'mod+tab': 'docNext', 'mod+shift+tab': 'docPrev', 'mod+f6': 'docNext', 'mod+shift+f6': 'docPrev', 'mod+alt+w': 'docClose',
  'mod+g': 'groupLayers', 'mod+shift+g': 'ungroup', 'mod+alt+g': 'clipToggle',
  // Alternates for combos the browser or OS keeps (see RESERVED in platform.js); the menus show these where needed.
  'mod+alt+n': 'new', 'mod+shift+alt+n': 'layerNew', 'mod+alt+t': 'freeTransform', 'mod+shift+m': 'curves',
  'shift+f7': 'invertSelection', 'mod+shift+alt+c': 'copyMerged', 'mod+alt+0': 'zoom100',
  'f1': 'userGuide', 'x': 'swapColors', 'd': 'resetColors', '?': 'shortcuts', 'shift+?': 'shortcuts',
};
/** Neutral spec ('Ctrl+Shift+N') → combo ('mod+shift+n'), in comboOf()'s modifier order. */
function specCombo(spec) {
  const parts = spec.split('+'), key = parts.pop().toLowerCase();
  return (parts.includes('Ctrl') ? 'mod+' : '') + (parts.includes('Shift') ? 'shift+' : '') + (parts.includes('Alt') ? 'alt+' : '') + key;
}
const ALTERNATE_KEYS = { new: 'Ctrl+Alt+N', layerNew: 'Ctrl+Alt+Shift+N', freeTransform: 'Ctrl+Alt+T', curves: 'Ctrl+Shift+M',
  docNext: 'Ctrl+F6', docPrev: 'Ctrl+Shift+F6', invertSelection: 'Shift+F7', copyMerged: 'Ctrl+Alt+Shift+C', zoom100: 'Ctrl+Alt+0', feather: 'Shift+F6' };
/** The shortcut to show for a command: its usual combo, or the alternate when this browser/OS reserves the usual one. */
function shortcutFor(cmd, spec) {
  if (!spec) return '';
  if (spec.includes('+') && RESERVED.has(specCombo(spec)) && ALTERNATE_KEYS[cmd]) return ALTERNATE_KEYS[cmd];
  return spec;
}
const shortcutLabel = (cmd, spec) => keyLabel(shortcutFor(cmd, spec));

const MENUS = [
  ['File', [['New canvas…', 'new', 'Ctrl+N'], ['Open…', 'open', 'Ctrl+O'], ['Take photo (camera)…', 'camera'], ['Place image as layer…', 'place', 'Ctrl+Shift+O'], '-',
    ['Open recent…', 'openRecent'], '-', ['Save', 'saveProject', 'Ctrl+S'], ['Save as…', 'saveAs', 'Ctrl+Shift+S'], ['Recover autosave…', 'recoverAutosave'], ['Export image…', 'export', 'Ctrl+Shift+E'], ['Export with last preset', 'exportLastPreset', 'Ctrl+Alt+Shift+E'], ['Export watermark…', 'watermarkSettings'], ['Export layered PSD…', 'exportPSD'], ['Export multiple sizes…', 'exportMulti'], ['Batch process…', 'batch'], ['Batch again (last settings)', 'batchAgain', 'Ctrl+Alt+Shift+B'], '-',
    ['Next document', 'docNext', 'Ctrl+Tab'], ['Previous document', 'docPrev', 'Ctrl+Shift+Tab'], ['Close document', 'docClose', 'Ctrl+Alt+W']]],
  ['Edit', [['Undo', 'undo', 'Ctrl+Z'], ['Redo', 'redo', 'Ctrl+Shift+Z'], '-', ['Cut', 'cut', 'Ctrl+X'], ['Copy', 'copy', 'Ctrl+C'],
    ['Copy merged', 'copyMerged', 'Ctrl+Shift+C'], ['Paste as layer', 'paste', 'Ctrl+V'], '-',
    ['Clear', 'clear', 'Del'], ['Fill with color', 'fillSelection', 'Alt+⌫'], '-', ['Free transform', 'freeTransform', 'Ctrl+T'], ['Perspective', 'perspective'], ['Warp', 'warp']]],
  ['Image', [['Image size…', 'imageSize'], ['Resize to preset…', 'resizePresets'], ['Canvas size…', 'canvasSize'], ['Crop to selection', 'cropToSelection'], ['Crop with preset', 'cropPresetTool'], '-',
    ['Rotate 90° clockwise', 'rotateCW'], ['Rotate 90° counter-clockwise', 'rotateCCW'], ['Rotate 180°', 'rotate180'],
    ['Flip horizontal', 'flipH'], ['Flip vertical', 'flipV'], '-', ['Auto enhance', 'autoEnhance', 'Ctrl+Shift+L'], ['Auto enhance options…', 'autoEnhanceOptions'], ['Auto white balance', 'autoWhiteBalance'], ['Auto white balance options…', 'autoWBOptions'],
    ['Auto straighten', 'autoStraighten'], ['Straighten tool', 'straightenTool'], ['Auto upright', 'autoUpright'], ['Upright: level (horizontals)', 'uprightLevel'], ['Upright: vertical', 'uprightVertical'], ['Upright: full (verticals + horizontals)', 'uprightFull'], ['Guided upright', 'guidedUpright'], ['Crop away empty edges', 'cropEmptyEdges'], ['Fill empty edges', 'fillEmptyEdges'], '-', ['Mode: 8 bits/channel', 'mode8'], ['Mode: 16 bits/channel', 'mode16'], '-', ['Flatten', 'flatten']]],
  ['Select', [['All', 'selectAll', 'Ctrl+A'], ['Deselect', 'deselect', 'Ctrl+D'], ['Invert selection', 'invertSelection', 'Ctrl+Shift+I'], '-',
    ['Object select (drag a box)', 'objectSelectTool'], ['Color range…', 'colorRange'], ['Refine edge…', 'refineEdge', 'Ctrl+Alt+R'], ['Feather…', 'feather', 'Shift+F6'], ['Select layer pixels', 'selectLayerPixels'], '-', ['Crop to selection', 'cropToSelection']]],
  ['Layer', [['New layer', 'layerNew', 'Ctrl+Shift+N'], ['New adjustment layer: Curves…', 'adjLayer_curves'], ['New adjustment layer: Levels…', 'adjLayer_levels'],
    ['New adjustment layer: Brightness / contrast…', 'adjLayer_brightnessContrast'], ['New adjustment layer: Hue / saturation…', 'adjLayer_hueSaturation'],
    ['New adjustment layer: Exposure…', 'adjLayer_exposure'], ['New adjustment layer: White balance…', 'adjLayer_whiteBalance'], ['New adjustment layer: Invert', 'adjLayer_invert'], ['New adjustment layer: Grayscale', 'adjLayer_grayscale'],
    ['New adjustment layer: 3D LUT from .cube file…', 'lutImport'],
    ['Edit layer settings…', 'editLayer'], ['Re-develop RAW…', 'redevelopRaw'], ['Embed linked RAW file', 'embedRaw'], ['Convert to live layer (editable filters)', 'convertSmart'], ['Convert text / live layer to pixels', 'rasterizeLayer'], '-', ['Duplicate layer', 'layerDuplicate', 'Ctrl+J'], ['Duplicate to document…', 'layerToDoc'], ['Delete layer', 'layerDelete'], '-',
    ['Move up', 'layerUp', 'Ctrl+]'], ['Move down', 'layerDown', 'Ctrl+['], ['Merge down / merge group', 'layerMergeDown', 'Ctrl+E'], '-',
    ['New group', 'groupNew'], ['Group layer', 'groupLayers', 'Ctrl+G'], ['Ungroup', 'ungroup', 'Ctrl+Shift+G'], ['Create / release clipping mask', 'clipToggle', 'Ctrl+Alt+G'], '-',
    ['Align left edges', 'alignLeft'], ['Align horizontal centers', 'alignHCenter'], ['Align right edges', 'alignRight'],
    ['Align top edges', 'alignTop'], ['Align vertical centers', 'alignVCenter'], ['Align bottom edges', 'alignBottom'],
    ['Distribute horizontally', 'distributeH'], ['Distribute vertically', 'distributeV'], '-',
    ['Layer style…', 'layerStyles'], ['Show / hide layer styles', 'stylesToggle'], ['Clear layer style', 'stylesClear'], '-',
    ['Flip layer horizontal', 'flipLayerH'], ['Flip layer vertical', 'flipLayerV'], '-',
    ['Add layer mask (reveal all)', 'addMask'], ['Add mask from selection', 'addMaskFromSelection'], ['Edit mask / pixels', 'editMaskToggle', '\\'],
    ['Enable / disable mask', 'toggleMask'], ['Invert mask', 'invertMask'], ['Apply mask', 'applyMask'], ['Delete mask', 'deleteMask']]],
  ['Adjust', [['Brightness / contrast…', 'brightnessContrast', 'Ctrl+B'], ['Hue / saturation / lightness…', 'hueSaturation', 'Ctrl+U'],
    ['Exposure…', 'exposure'], ['Levels…', 'levels', 'Ctrl+L'], ['Curves…', 'curves', 'Ctrl+M'], ['White balance (temperature / tint)…', 'whiteBalance'], ['Auto levels', 'autoLevels'], '-',
    ['Auto enhance (adds editable layers)', 'autoEnhance'], ['Auto white balance (adds a layer)', 'autoWhiteBalance'], ['White balance picker', 'wbPicker'], '-',
    ['Invert', 'invert', 'Ctrl+I'], ['Grayscale', 'grayscale', 'Ctrl+Shift+U'], ['Sepia tone…', 'sepia']]],
  ['Filter', [['Convert to live layer', 'convertSmart'], '-', ['Gaussian blur…', 'gaussianBlur'], ['Sharpen (unsharp)…', 'sharpen'], ['Add noise…', 'noise'], ['Vignette…', 'vignette']]],
  ['Actions', [['Actions…', 'actions'], ['Start recording', 'actionRecord'], ['Stop recording and save…', 'actionStop'], '-', ['Batch process…', 'batch']]],
  ['View', [['Zoom in', 'zoomIn', 'Ctrl++'], ['Zoom out', 'zoomOut', 'Ctrl+-'], ['Fit on screen', 'zoomFit', 'Ctrl+0'], ['Actual pixels', 'zoom100', 'Ctrl+1'], '-', ['Proof: off', 'proofOff'], ['Proof: last used', 'proofLast'], ['Proof: glossy paper', 'proofGlossy'], ['Proof: matte paper', 'proofMatte'], ['Proof: photo rag', 'proofRag'], ['Proof: newsprint', 'proofNews'], ['Proof: approximate CMY', 'proofCmy'], ['Proof: ink warning on', 'proofWarnOn'], ['Proof: ink warning off', 'proofWarnOff'], '-', ['Rendering engine…', 'engine']]],
  ['Help', [['Keyboard shortcuts', 'shortcuts', '?'], ['User guide', 'userGuide', 'F1'], ['Run performance benchmark…', 'benchmark'], [`About ${APP}`, 'about']]],
];

// ---------------------------------------------------------------------------
// Layer & document operations
// ---------------------------------------------------------------------------
function bakeMask(l) {
  const c = cloneCanvas(l.canvas);
  if (l.mask) { const x = c.getContext('2d'); x.globalCompositeOperation = 'destination-in'; x.drawImage(l.mask.canvas, 0, 0); }
  return c;
}
function setMaskTarget(l, onMask) {
  l.editMask = !!(onMask && l.mask); l.editFMask = false;
  status(l.editMask ? 'Editing the layer mask: paint black to hide, white to reveal.' : 'Editing layer pixels.');
  updateLayersPanel(); buildOptionsBar();
}
function addMask(fromSelection) {
  const l = activeLayer();
  if (l.mask) { status('This layer already has a mask.'); return; }
  const sel = doc().selection;
  if (fromSelection && !sel) { status('Make a selection first.'); return; }
  if (isGroup(l)) { l.x = 0; l.y = 0; l.canvas = makeCanvas(1, 1); }
  const gw = isGroup(l) ? doc().width : l.canvas.width, gh = isGroup(l) ? doc().height : l.canvas.height;
  const m = makeMaskCanvas(gw, gh, !fromSelection);
  if (fromSelection) m.getContext('2d').drawImage(selectionCanvas(sel), -l.x, -l.y);
  l.mask = { canvas: m, enabled: true, rev: ++globalRev }; l.editMask = true;
  compDirty = true; requestRender(); commit(fromSelection ? 'Add mask from selection' : 'Add layer mask');
  // masks are painted in greys: switch coloured swatches to black/white (D) so the first stroke does what it looks like
  const grey = (h) => /^#?([0-9a-f]{2})\1\1$/i.test(String(h || ''));
  if (!grey(state.fg) || !grey(state.bg)) { setFg('#000000'); setBg('#ffffff'); status('Layer mask added: colours set to black (hide) / white (reveal). X swaps them.'); }
}
function addLayer(layer, label) {
  const d = doc(); insertLayer(d, layer); d.activeId = layer.id;
  compDirty = true; requestRender(); commit(label);
}
/** Array-index move (kept for scripts): l goes next to the layer currently at `to`, joining its group. */
function moveLayer(from, to) {
  const d = doc(); if (to < 0 || to >= d.layers.length || from === to) return;
  if (placeLayer(d, d.layers[from], d.layers[to], to > from ? 'above' : 'below')) { compDirty = true; requestRender(); commit('Reorder layers'); }
}
/** Ctrl+] / Ctrl+[: swap with the next sibling; at the edge of a group, step out of it. */
function layerStep(dir) {
  const d = doc(), l = activeLayer(), sib = childrenOf(d, parentId(l)), j = sib.indexOf(l) + dir;
  let ok = false;
  if (j >= 0 && j < sib.length) ok = placeLayer(d, l, sib[j], dir > 0 ? 'above' : 'below');
  else if (parentId(l) != null) ok = placeLayer(d, l, layerById(d, parentId(l)), dir > 0 ? 'above' : 'below');
  if (!ok) { status(dir > 0 ? 'Already at the top.' : 'Already at the bottom.'); return; }
  compDirty = true; requestRender(); commit(dir > 0 ? 'Move layer up' : 'Move layer down');
}
function cloneLayerObj(l) {
  return { ...l, id: nextLayerId++, canvas: cloneCanvas(l.canvas), mask: cloneMask(l.mask), rev: ++globalRev, ...(l.kind === 'smart' ? { fmask: cloneMask(l.fmask) } : {}) };
}
function duplicateActive() {
  const d = doc(), l = activeLayer(), block = blockOf(d, l), ids = new Map();
  const copies = block.map((x) => { const c = cloneLayerObj(x); ids.set(x.id, c.id); return c; });
  for (const c of copies) if (ids.has(c.parent)) c.parent = ids.get(c.parent);
  const top = copies[copies.length - 1]; top.name = `${l.name} copy`;
  d.layers.splice(d.layers.indexOf(l) + 1, 0, ...copies); normalizeTree(d); d.activeId = top.id;
  compDirty = true; requestRender(); commit(isGroup(l) ? 'Duplicate group' : 'Duplicate layer');
}
// --- multi-layer selection: Ctrl/Cmd+click toggles, Shift+click picks a range in the Layers panel -------------
/** Selected layers (the active one plus Ctrl/Shift-picked ones), top-level only (a picked group covers its
 * contents), bottom → top. */
function pickedLayers(d = doc()) {
  if (!d) return [];
  const ids = new Set([...(d.picked || [])].filter((id) => layerById(d, id))); if (d.activeId != null) ids.add(d.activeId);
  return d.layers.filter((l) => ids.has(l.id) && !ancestorsOf(d, l).some((g) => ids.has(g.id)));
}
function clearPicked(d = doc()) { if (d) d.picked = new Set(); }
function pickLayer(l, e) {
  const d = doc(); d.picked ||= new Set();
  if (primaryMod(e) || (IS_MAC && e.metaKey)) {
    if (l.id === d.activeId) { // toggling the active layer off: another picked layer becomes active
      const rest = [...d.picked].filter((id) => id !== l.id && layerById(d, id));
      if (rest.length) { d.picked.delete(l.id); d.activeId = rest[rest.length - 1]; }
    } else if (d.picked.has(l.id)) d.picked.delete(l.id);
    else { if (d.activeId != null) d.picked.add(d.activeId); d.picked.add(l.id); d.activeId = l.id; }
  } else if (e.shiftKey && d.activeId != null) {
    const vis = d.layers.filter((x) => !ancestorsOf(d, x).some((g) => g.collapsed)), a = vis.findIndex((x) => x.id === d.activeId), b = vis.indexOf(l);
    if (a >= 0 && b >= 0) { d.picked = new Set(vis.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)); d.activeId = l.id; }
  } else { d.picked = new Set(); d.activeId = l.id; }
  d.picked.delete(d.activeId); if (d.picked.size) d.picked.add(d.activeId);
}
/** Move layers by (dx, dy) (groups move their contents). */
function nudgeLayers(list, dx, dy) {
  const d = doc(), seen = new Set();
  for (const r of list) for (const l of blockOf(d, r)) if (!seen.has(l)) { seen.add(l); l.x += dx; l.y += dy; }
  compDirty = true; requestRender();
}
/** Bounds of a layer's (or group's) visible pixels in document space, or null. */
function layerBounds(d, l) {
  let r = null;
  for (const m of blockOf(d, l)) {
    if (isGroup(m) || m.kind === 'adjust') continue;
    const t = alphaBounds(m.kind === 'smart' ? renderSource(m) : m.canvas); if (!t) continue;
    const b = { x: m.x + t.x, y: m.y + t.y, w: t.w, h: t.h };
    r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), w: Math.max(r.x + r.w, b.x + b.w) - Math.min(r.x, b.x), h: Math.max(r.y + r.h, b.y + b.h) - Math.min(r.y, b.y) } : b;
  }
  return r;
}
/** Layer ▸ Align / Distribute. One layer aligns to the selection (or the canvas); several align to each other. */
function alignLayers(how) {
  const d = doc(), list = pickedLayers(d).filter((l) => l.kind !== 'adjust'), items = list.map((l) => ({ l, b: layerBounds(d, l) })).filter((o) => o.b);
  if (!items.length) { status('Nothing to align: select layers with pixels.'); return; }
  if (how.startsWith('dist')) {
    if (items.length < 3) { status('Distribute needs three or more selected layers.'); return; }
    const hz = how === 'distH', c = (o) => (hz ? o.b.x + o.b.w / 2 : o.b.y + o.b.h / 2);
    items.sort((p, q) => c(p) - c(q));
    const first = c(items[0]), step = (c(items[items.length - 1]) - first) / (items.length - 1);
    items.forEach((o, i) => { const dv = Math.round(first + step * i - c(o)); if (dv) nudgeLayers([o.l], hz ? dv : 0, hz ? 0 : dv); });
    commit(hz ? 'Distribute horizontal centers' : 'Distribute vertical centers'); return;
  }
  let R;
  if (items.length === 1) { const s = d.selection; R = s ? { x: s.x, y: s.y, w: s.w, h: s.h } : { x: 0, y: 0, w: d.width, h: d.height }; }
  else { const x0 = Math.min(...items.map((o) => o.b.x)), y0 = Math.min(...items.map((o) => o.b.y)); R = { x: x0, y: y0, w: Math.max(...items.map((o) => o.b.x + o.b.w)) - x0, h: Math.max(...items.map((o) => o.b.y + o.b.h)) - y0 }; }
  for (const { l, b } of items) {
    const dx = how === 'left' ? R.x - b.x : how === 'right' ? R.x + R.w - (b.x + b.w) : how === 'hcenter' ? Math.round(R.x + R.w / 2 - (b.x + b.w / 2)) : 0;
    const dy = how === 'top' ? R.y - b.y : how === 'bottom' ? R.y + R.h - (b.y + b.h) : how === 'vcenter' ? Math.round(R.y + R.h / 2 - (b.y + b.h / 2)) : 0;
    if (dx || dy) nudgeLayers([l], dx, dy);
  }
  const names = { left: 'left edges', right: 'right edges', hcenter: 'horizontal centers', top: 'top edges', bottom: 'bottom edges', vcenter: 'vertical centers' };
  commit(`Align ${names[how]}`);
}
function deleteActive() {
  const dd = doc(), many = pickedLayers(dd);
  if (many.length > 1) {
    const gone = new Set(many.flatMap((l) => blockOf(dd, l)));
    if (dd.layers.length - gone.size < 1) { status('A document needs at least one layer.'); return; }
    const i = dd.layers.indexOf(dd.layers.find((x) => gone.has(x)));
    dd.layers = dd.layers.filter((x) => !gone.has(x)); clearPicked(dd);
    dd.activeId = (dd.layers[Math.max(0, i - 1)] || dd.layers[0]).id;
    compDirty = true; requestRender(); commit(`Delete ${many.length} layers`); return;
  }
  const d = doc(), l = activeLayer(), block = blockOf(d, l), gone = new Set(block);
  if (d.layers.length - gone.size < 1) { status('A document needs at least one layer.'); return; }
  const i = d.layers.indexOf(block[0]);
  d.layers = d.layers.filter((x) => !gone.has(x));
  d.activeId = (d.layers[Math.max(0, i - 1)] || d.layers[0]).id;
  compDirty = true; requestRender(); commit(isGroup(l) ? 'Delete group' : 'Delete layer');
}
/** Layer ▸ New group (empty, above the active layer) or Group layer (Ctrl+G: the active layer goes inside). */
function newGroup(withActive) {
  const d = doc(), a = activeLayer(), many = withActive ? pickedLayers(d) : [];
  const g = createLayer(`Group ${d.layers.filter(isGroup).length + 1}`, 1, 1, { kind: 'group', blend: 'pass-through', collapsed: false, editMask: true });
  if (many.length > 1) { // the selected layers (top-level ones) move into one new group where the topmost was
    const top = many[many.length - 1];
    g.parent = parentId(top); d.layers.splice(d.layers.indexOf(top) + 1, 0, g);
    for (const l of many) { l.parent = g.id; if (l.clip) l.clip = false; }
    normalizeTree(d); clearPicked(d);
    d.activeId = g.id; compDirty = true; requestRender(); commit(`Group ${many.length} layers`); return;
  }
  if (withActive && a) { g.parent = parentId(a); d.layers.splice(d.layers.indexOf(a) + 1, 0, g); a.parent = g.id; if (a.clip) a.clip = false; normalizeTree(d); }
  else insertLayer(d, g);
  d.activeId = g.id; compDirty = true; requestRender(); commit(withActive ? 'Group layer' : 'New group');
}
function ungroup() {
  const d = doc(), g = activeLayer(); if (!isGroup(g)) { status('Select a group to ungroup.'); return; }
  const kids = childrenOf(d, g.id); if (!kids.length && d.layers.length <= 1) { status('A document needs at least one layer.'); return; }
  for (const k of kids) k.parent = parentId(g);
  d.layers.splice(d.layers.indexOf(g), 1); normalizeTree(d);
  d.activeId = (kids[kids.length - 1] || d.layers[d.layers.length - 1]).id;
  compDirty = true; requestRender(); commit('Ungroup');
}
function clipToggle() {
  const d = doc(), l = activeLayer(), sib = childrenOf(d, parentId(l));
  if (!l.clip && sib.indexOf(l) === 0) { status('There is no layer below this one (in its group) to clip to.'); return; }
  l.clip = !l.clip; compDirty = true; requestRender(); commit(l.clip ? 'Create clipping mask' : 'Release clipping mask');
}
/** Merge a group into one pixel layer (its contents, mask and styles), keeping the group's opacity / blend. */
function mergeGroup(g) {
  const d = doc();
  const flat = createLayer(g.name, d.width, d.height, { parent: g.parent ?? null, opacity: g.opacity, blend: g.blend === 'pass-through' ? 'source-over' : g.blend, clip: !!g.clip, visible: g.visible });
  const it = leafItem(d, { ...g, opacity: 1 });
  if (it) {
    const x0 = Math.min(0, it.x), y0 = Math.min(0, it.y), x1 = Math.max(d.width, it.x + it.src.width), y1 = Math.max(d.height, it.y + it.src.height);
    flat.canvas = makeCanvas(x1 - x0, y1 - y0); flat.x = x0; flat.y = y0;
    flat.canvas.getContext('2d').drawImage(it.mask ? maskedCopy(it.src, it.x, it.y, it.mask) : it.src, it.x - x0, it.y - y0);
  }
  const gone = new Set(blockOf(d, g)); d.layers.splice(d.layers.indexOf(g), 1, flat); d.layers = d.layers.filter((x) => !gone.has(x));
  normalizeTree(d); d.activeId = flat.id; compDirty = true; requestRender(); commit('Merge group');
}
/** Bake a layer's styles into its pixels (before merging). */
function flattenStyles(l) {
  if (!hasActiveStyles(l.styles)) { l.styles = null; return; }
  const r = renderStyled(renderSource(l), l.styles); l.styles = null;
  if (!r) return;
  l.canvas = r.canvas; l.x += r.x; l.y += r.y; l.mask = null; l.editMask = false; delete l.deep; delete l.deepRev; touch(l);
}
function mergeDown() {
  const d = doc(), upper = activeLayer();
  if (isGroup(upper)) { mergeGroup(upper); return; }
  const sib = childrenOf(d, parentId(upper)), lower = sib[sib.indexOf(upper) - 1];
  if (!lower) { status('No layer below to merge into.'); return; }
  if (isGroup(lower)) { status('Cannot merge into a group: select the group and press Ctrl+E to merge it first.'); return; }
  if (lower.kind === 'adjust') { status('Cannot merge into an adjustment layer. Move the layer or merge the adjustment down first.'); return; }
  const i = d.layers.indexOf(upper);
  rasterize(lower);
  if (upper.kind === 'adjust') { bakeAdjustment(upper, lower); d.layers.splice(i, 1); d.activeId = lower.id; compDirty = true; requestRender(); commit('Merge adjustment down'); return; }
  const clipBase = upper.clip && !lower.clip; // upper shows only where lower has pixels
  const styled = !!(upper.styles || lower.styles);
  flattenStyles(lower); if (styled) flattenStyles(upper);
  const x0 = Math.min(0, lower.x, upper.x), y0 = Math.min(0, lower.y, upper.y);
  const x1 = Math.max(d.width, lower.x + lower.canvas.width, upper.x + upper.canvas.width);
  const y1 = Math.max(d.height, lower.y + lower.canvas.height, upper.y + upper.canvas.height);
  if (is16() && !styled && !clipBase) { // float composite of the two layers keeps 16-bit precision
    const W2 = x1 - x0, H2 = y1 - y0, list = [{ kind: 'pixels', img: deepOf(lower), x: lower.x - x0, y: lower.y - y0, opacity: 1, mode: 0, mask: maskDesc(lower, -x0, -y0) }];
    if (upper.visible) list.push({ kind: 'pixels', img: deepOf(upper), x: upper.x - x0, y: upper.y - y0, opacity: upper.opacity, mode: blendIndex(upper.blend), mask: maskDesc(upper, -x0, -y0) });
    const nd = accToDeep(compositeDeep(W2, H2, list), W2, H2);
    lower.x = x0; lower.y = y0; lower.mask = null; lower.editMask = false; setDeep(lower, nd);
    d.layers.splice(d.layers.indexOf(upper), 1); d.activeId = lower.id;
    compDirty = true; requestRender(); commit('Merge down'); return;
  }
  const c = makeCanvas(x1 - x0, y1 - y0), x = c.getContext('2d');
  const lowSrc = renderSource(lower);
  x.drawImage(lowSrc, lower.x - x0, lower.y - y0);
  if (upper.visible) {
    let up = renderSource(upper);
    if (clipBase) { up = cloneCanvas(up); const ux = up.getContext('2d'); ux.globalCompositeOperation = 'destination-in'; ux.drawImage(lowSrc, lower.x - upper.x, lower.y - upper.y); }
    x.globalAlpha = upper.opacity; x.globalCompositeOperation = upper.blend; x.drawImage(up, upper.x - x0, upper.y - y0);
  }
  lower.canvas = c; lower.x = x0; lower.y = y0; lower.mask = null; lower.editMask = false; touch(lower);
  d.layers.splice(d.layers.indexOf(upper), 1); d.activeId = lower.id;
  compDirty = true; requestRender(); commit('Merge down');
}
/** Layer ▸ Layer style…: every effect with its own on/off switch, previewed live; Cancel restores. */
function openStylesDialog(l = activeLayer(), focus = null) {
  if (!l) return;
  if (l.kind === 'adjust') { status('Adjustment layers cannot have layer styles.'); return; }
  const before = l.styles || null, cur = new Map((before || []).map((x) => [x.type, { ...x }]));
  const work = FX_ORDER.map((t) => cur.get(t) || { ...defaultEffect(t), enabled: false });
  const apply = () => { const list = work.filter((x) => x.enabled || cur.has(x.type)).map((x) => ({ ...x })); l.styles = list.length ? list : null; compDirty = true; requestRender(); };
  const body = document.createElement('div'); body.className = 'fx-dialog';
  for (const fx of work) {
    const def = FX_TYPES[fx.type], box = document.createElement('fieldset'); box.className = 'fx-box' + (fx.enabled ? '' : ' off'); box.dataset.fx = fx.type;
    const head = document.createElement('legend');
    head.innerHTML = `<label><input type="checkbox" data-fx-on="${fx.type}" ${fx.enabled ? 'checked' : ''}/> ${def.title}</label>`;
    head.querySelector('input').addEventListener('change', (e) => { fx.enabled = e.target.checked; box.classList.toggle('off', !fx.enabled); apply(); });
    box.append(head);
    for (const q of def.params) {
      if (!q.type) { box.append(paramField({ ...q, value: fx[q.key] }, fx, () => { if (!fx.enabled) { fx.enabled = true; box.classList.remove('off'); head.querySelector('input').checked = true; } apply(); }, q.value)); continue; }
      const row = document.createElement('label'); row.className = 'field two';
      const opts = q.type === 'blend' ? BLEND_MODES : q.options;
      row.innerHTML = `<span>${q.label}</span>` + (q.type === 'color' ? `<input type="color" value="${fx[q.key]}" />` : `<select>${opts.map(([v, n]) => `<option value="${v}" ${v === fx[q.key] ? 'selected' : ''}>${n}</option>`).join('')}</select>`);
      const inp = row.querySelector('input,select'); inp.dataset.key = q.key;
      inp.addEventListener(q.type === 'color' ? 'input' : 'change', () => { fx[q.key] = inp.value; if (!fx.enabled) { fx.enabled = true; box.classList.remove('off'); head.querySelector('input').checked = true; } apply(); });
      box.append(row);
    }
    body.append(box);
  }
  showModal({
    title: `Layer style — ${l.name}`, body, passive: true, okLabel: 'OK',
    ok: () => { apply(); if (JSON.stringify(before) !== JSON.stringify(l.styles)) commit('Layer style'); else updateLayersPanel(); },
    cancel: () => { l.styles = before; compDirty = true; requestRender(); },
  });
  if (focus) body.querySelector(`[data-fx="${focus}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Permanently apply an adjustment layer's effect (through its mask and opacity) to one layer. */
function bakeAdjustment(adj, target) {
  if (!adj.visible || adj.opacity <= 0) return;
  if (adj.blend && adj.blend !== 'source-over') { bakeAdjustmentBlended(adj, target); return; }
  if (is16() && !target.kind) { bakeAdjustmentDeep(adj, target); return; }
  const w = target.canvas.width, h = target.canvas.height, c = ctxOf(target.canvas);
  const img = c.getImageData(0, 0, w, h), orig = new Uint8ClampedArray(img.data);
  runOp(adj.adj.type, img, adj.adj.params || {});
  const m = makeCanvas(w, h), mx = ctxOf(m);
  if (adj.mask && adj.mask.enabled) mx.drawImage(adj.mask.canvas, adj.x - target.x, adj.y - target.y); else { mx.fillStyle = '#fff'; mx.fillRect(0, 0, w, h); }
  const md = mx.getImageData(0, 0, w, h).data, o = img.data;
  for (let i = 0; i < o.length; i += 4) {
    const k = (md[i + 3] / 255) * adj.opacity;
    if (k >= 1) continue; if (k <= 0) { o[i] = orig[i]; o[i + 1] = orig[i + 1]; o[i + 2] = orig[i + 2]; continue; }
    for (let j = 0; j < 3; j++) o[i + j] = orig[i + j] + (o[i + j] - orig[i + j]) * k;
  }
  c.putImageData(img, 0, 0); touch(target);
}
/** 16-bit version of bakeAdjustment (normal blend): the adjustment runs on the layer's 16-bit data. */
function bakeAdjustmentDeep(adj, target) {
  const src = deepOf(target), w = src.width, h = src.height, res = runDeep(adj.adj.type, cloneDeep(src), adj.adj.params || {});
  const m = makeCanvas(w, h), mx = ctxOf(m);
  if (adj.mask && adj.mask.enabled) mx.drawImage(adj.mask.canvas, adj.x - target.x, adj.y - target.y); else { mx.fillStyle = '#fff'; mx.fillRect(0, 0, w, h); }
  const md = mx.getImageData(0, 0, w, h).data, o = res.data, s = src.data;
  for (let i = 0; i < o.length; i += 4) {
    const k = (md[i + 3] / 255) * adj.opacity;
    if (k >= 1) continue;
    for (let j = 0; j < 3; j++) o[i + j] = k <= 0 ? s[i + j] : Math.round(s[i + j] + (o[i + j] - s[i + j]) * k);
  }
  setDeep(target, res);
}
/** Blend-mode adjustment: blend the adjusted copy over the layer (like the live composite), keep the layer's alpha. */
function bakeAdjustmentBlended(adj, target) {
  const w = target.canvas.width, h = target.canvas.height;
  const orig = ctxOf(target.canvas).getImageData(0, 0, w, h);
  const img = new ImageData(new Uint8ClampedArray(orig.data), w, h);
  runOp(adj.adj.type, img, adj.adj.params || {});
  const top = putInto(null, img), tx = top.getContext('2d');
  if (adj.mask && adj.mask.enabled) { tx.globalCompositeOperation = 'destination-in'; tx.drawImage(adj.mask.canvas, adj.x - target.x, adj.y - target.y); }
  const out = cloneCanvas(target.canvas), ox = ctxOf(out);
  ox.globalAlpha = adj.opacity; ox.globalCompositeOperation = adj.blend; ox.drawImage(top, 0, 0);
  const res = ox.getImageData(0, 0, w, h), r = res.data, o = orig.data;
  for (let i = 3; i < r.length; i += 4) r[i] = o[i]; // the adjustment never changes coverage
  ctxOf(target.canvas).putImageData(res, 0, 0); touch(target);
}
/**
 * RAW layers keep a map from layer pixels to developed pixels (l.raw.m, continuous coordinates), updated by crops,
 * image resizes, rotations, flips and free transforms, so re-developing can resample a fresh develop into the
 * layer exactly as it is now. rawMapOf: older files stored only the crop offset (cx, cy).
 */
const rawMapOf = (raw) => raw.m || { a: 1, b: 0, c: 0, d: 1, e: raw.cx || 0, f: raw.cy || 0 };
/** t maps the layer's new pixel positions to its old ones; sameRaw = the pixels matched the develop before the change. */
function trackRaw(l, t, sameRaw) {
  if (!l.raw) return;
  const m = affineCompose(rawMapOf(l.raw), t), shift = Math.abs(m.a - 1) < 1e-12 && Math.abs(m.d - 1) < 1e-12 && !m.b && !m.c;
  l.raw = { ...l.raw, m, cx: shift ? m.e : null, cy: shift ? m.f : null, cw: l.canvas.width, ch: l.canvas.height };
  if (sameRaw) l.raw.rev = l.rev;
}
/** Map from new to old pixel positions of rotatedCanvas(kind) on a w × h canvas. */
function rotateMap(kind, w, h) {
  switch (kind) {
    case 'cw': return { a: 0, b: -1, c: 1, d: 0, e: 0, f: h };
    case 'ccw': return { a: 0, b: 1, c: -1, d: 0, e: w, f: 0 };
    case '180': return { a: -1, b: 0, c: 0, d: -1, e: w, f: h };
    case 'fh': return { a: -1, b: 0, c: 0, d: 1, e: w, f: 0 };
    case 'fv': return { a: 1, b: 0, c: 0, d: -1, e: 0, f: h };
    default: return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
}
function rotatedCanvas(src, kind) {
  const w = src.width, h = src.height, swap = kind === 'cw' || kind === 'ccw';
  const c = makeCanvas(swap ? h : w, swap ? w : h), x = c.getContext('2d');
  if (kind === 'cw') { x.translate(h, 0); x.rotate(Math.PI / 2); }
  else if (kind === 'ccw') { x.translate(0, w); x.rotate(-Math.PI / 2); }
  else if (kind === '180') { x.translate(w, h); x.rotate(Math.PI); }
  else if (kind === 'fh') { x.translate(w, 0); x.scale(-1, 1); }
  else if (kind === 'fv') { x.translate(0, h); x.scale(1, -1); }
  x.drawImage(src, 0, 0);
  return c;
}
function transformDoc(kind, label) {
  const d = doc(); const W = d.width, H = d.height;
  if (d.layers.some((l) => l.kind === 'text')) { d.layers.forEach((l) => rasterize(l)); toast('Text layers were converted to pixels for the rotation/flip.'); }
  for (const l of d.layers) {
    const g = geomCanvas(l), w = g.width, h = g.height; let { x, y } = l;
    if (kind === 'cw') [x, y] = [H - (l.y + h), l.x];
    else if (kind === 'ccw') [x, y] = [l.y, W - (l.x + w)];
    else if (kind === '180') [x, y] = [W - (l.x + w), H - (l.y + h)];
    else if (kind === 'fh') x = W - (l.x + w);
    else if (kind === 'fv') y = H - (l.y + h);
    const sameRaw = l.raw && l.raw.rev === l.rev, cw0 = l.canvas.width, ch0 = l.canvas.height;
    if (l.kind === 'smart') smartGeom(l, (c) => rotatedCanvas(c, kind));
    else if (l.kind !== 'adjust') l.canvas = rotatedCanvas(l.canvas, kind);
    l.x = x; l.y = y; touch(l);
    if (l.raw) trackRaw(l, rotateMap(kind, cw0, ch0), sameRaw);
    if (l.mask) { l.mask.canvas = rotatedCanvas(l.mask.canvas, kind); touchMask(l); }
  }
  if (kind === 'cw' || kind === 'ccw') { d.width = H; d.height = W; }
  d.selection = null;
  compDirty = true; fitToScreen(); commit(label);
}
function transformLayer(kind, label) {
  const l = activeLayer(); if (l.kind === 'text') rasterize(l, 'the transform');
  const sameRaw = l.raw && l.raw.rev === l.rev, cw0 = l.canvas.width, ch0 = l.canvas.height;
  if (l.kind === 'smart') smartGeom(l, (c) => rotatedCanvas(c, kind));
  else if (l.kind !== 'adjust') l.canvas = rotatedCanvas(l.canvas, kind);
  touch(l);
  if (l.raw) trackRaw(l, rotateMap(kind, cw0, ch0), sameRaw);
  if (l.mask) { l.mask.canvas = rotatedCanvas(l.mask.canvas, kind); touchMask(l); }
  requestRender(); commit(label);
}
function resizeImage(nw, nh) {
  if (nw * nh > MAX_PIXELS) { const f = fitPixels(nw, nh); toast(`That size exceeds this device's canvas limit; using ${f.w}×${f.h}.`); nw = f.w; nh = f.h; }
  const d = doc(); const sx = nw / d.width, sy = nh / d.height;
  const scale = (srcC) => {
    const c = makeCanvas(srcC.width * sx, srcC.height * sy), x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    let src = srcC; // step down in halves for better quality on big reductions
    while (src.width * 0.5 > c.width && src.height * 0.5 > c.height) {
      const half = makeCanvas(src.width / 2, src.height / 2), hx = half.getContext('2d');
      hx.imageSmoothingQuality = 'high'; hx.drawImage(src, 0, 0, half.width, half.height); src = half;
    }
    x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };
  for (const l of d.layers) {
    if (l.kind === 'text') rasterize(l);
    const sameRaw = l.raw && l.raw.rev === l.rev, cw0 = l.canvas.width, ch0 = l.canvas.height;
    if (l.kind === 'smart') smartGeom(l, scale);
    else if (l.kind !== 'adjust') l.canvas = scale(l.canvas);
    l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy); touch(l);
    if (l.raw) trackRaw(l, { a: cw0 / l.canvas.width, b: 0, c: 0, d: ch0 / l.canvas.height, e: 0, f: 0 }, sameRaw);
    if (l.mask) { l.mask.canvas = scale(l.mask.canvas); touchMask(l); }
  }
  d.width = nw; d.height = nh; d.selection = null;
  compDirty = true; fitToScreen(); commit(`Image size ${nw}×${nh}`);
}
function resizeCanvas(nw, nh, ax, ay) {
  if (nw * nh > MAX_PIXELS) { const f = fitPixels(nw, nh); toast(`That size exceeds this device's canvas limit; using ${f.w}×${f.h}.`); nw = f.w; nh = f.h; }
  const d = doc(); const dx = Math.round((nw - d.width) * ax), dy = Math.round((nh - d.height) * ay);
  for (const l of d.layers) {
    l.x += dx; l.y += dy; touch(l);
    if (l.kind === 'adjust' || (isGroup(l) && l.mask)) { // grow the adjustment's / group's mask over the new area (revealed), keep its painted part
      const m = makeMaskCanvas(nw, nh, true), mx = m.getContext('2d'), old = l.mask.canvas;
      mx.clearRect(l.x, l.y, old.width, old.height); mx.drawImage(old, l.x, l.y);
      l.mask.canvas = m; l.x = 0; l.y = 0; touchMask(l);
    }
  }
  d.width = nw; d.height = nh; d.selection = null;
  compDirty = true; fitToScreen(); commit(`Canvas size ${nw}×${nh}`);
}
function cropTo(r, label = null) {
  const d = doc();
  r = rectIntersect(r, { x: 0, y: 0, w: d.width, h: d.height }); if (!r) return;
  for (const l of d.layers) {
    if (l.kind === 'text') { l.x -= r.x; l.y -= r.y; touch(l); continue; } // stays editable; just shifts
    if (l.kind === 'smart') { // crop the original too (blur near the new edge then sees transparency, as after any crop)
      smartGeom(l, (src) => { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(src, l.x - r.x, l.y - r.y); return m; });
      if (l.mask) { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(l.mask.canvas, l.x - r.x, l.y - r.y); l.mask.canvas = m; touchMask(l); }
      l.x = 0; l.y = 0; touch(l); continue;
    }
    const noPix = l.kind === 'adjust' || isGroup(l), c = noPix ? l.canvas : makeCanvas(r.w, r.h);
    if (!noPix) c.getContext('2d').drawImage(l.canvas, l.x - r.x, l.y - r.y);
    if (l.mask) { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(l.mask.canvas, l.x - r.x, l.y - r.y); l.mask.canvas = m; touchMask(l); }
    if (l.deep && l.kind !== 'adjust') { l.deepOX = (l.deepOX || 0) + l.x - r.x; l.deepOY = (l.deepOY || 0) + l.y - r.y; }
    const sameRaw = l.raw && l.raw.rev === l.rev, ox = r.x - l.x, oy = r.y - l.y; // a crop keeps the layer re-developable
    l.canvas = c; l.x = 0; l.y = 0; touch(l);
    if (l.raw) trackRaw(l, { a: 1, b: 0, c: 0, d: 1, e: ox, f: oy }, sameRaw);
  }
  d.width = r.w; d.height = r.h; d.selection = null; state.crop = null;
  compDirty = true; fitToScreen(); buildOptionsBar(); commit(label ? `${label} (crop ${r.w}×${r.h})` : `Crop ${r.w}×${r.h}`);
}

function copySelection(merged) {
  const d = doc(); const sel = d.selection || { x: 0, y: 0, w: d.width, h: d.height };
  const c = makeCanvas(sel.w, sel.h), x = c.getContext('2d');
  if (merged) { freshComp(); x.drawImage(comp, -sel.x, -sel.y); }
  else { const l = activeLayer(); x.drawImage(renderSource(l), l.x - sel.x, l.y - sel.y); }
  if (d.selection) { x.globalCompositeOperation = 'destination-in'; x.drawImage(selectionCanvas(d.selection), -sel.x, -sel.y); }
  clipboard = { canvas: c, x: sel.x, y: sel.y };
  status(`Copied ${sel.w}×${sel.h}`);
}
function pasteInternal() {
  if (!clipboard) return;
  const l = createLayer('Pasted', 1, 1, { canvas: cloneCanvas(clipboard.canvas), x: clipboard.x, y: clipboard.y });
  addLayer(l, 'Paste');
}
document.addEventListener('paste', async (e) => {
  if (isTyping(e)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    const img = await loadImage(URL.createObjectURL(item.getAsFile()));
    if (!doc()) documentFromImage(img, 'Pasted image');
    else placeImage(img, 'Pasted image');
  } else if (doc() && clipboard) { e.preventDefault(); pasteInternal(); }
});

// ---------------------------------------------------------------------------
// Adjustments & filters (live preview, then apply or cancel)
// ---------------------------------------------------------------------------
const ADJ = {
  brightnessContrast: { title: 'Brightness / contrast', params: [
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, value: 0 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, value: 0 }], op: 'brightnessContrast' },
  hueSaturation: { title: 'Hue / saturation / lightness', params: [
    { key: 'hue', label: 'Hue', min: -180, max: 180, value: 0, unit: '°' },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, value: 0 },
    { key: 'lightness', label: 'Lightness', min: -100, max: 100, value: 0 }], op: 'hueSaturation' },
  exposure: { title: 'Exposure', params: [
    { key: 'exposure', label: 'Exposure (EV)', min: -3, max: 3, step: 0.05, value: 0 },
    { key: 'offset', label: 'Offset', min: -0.5, max: 0.5, step: 0.01, value: 0 },
    { key: 'gamma', label: 'Gamma', min: 0.1, max: 3, step: 0.01, value: 1 }], op: 'exposure' },
  levels: { title: 'Levels', histogram: true, params: [
    { key: 'inBlack', label: 'Input black', min: 0, max: 254, value: 0 },
    { key: 'gamma', label: 'Midtones (γ)', min: 0.1, max: 4, step: 0.01, value: 1 },
    { key: 'inWhite', label: 'Input white', min: 1, max: 255, value: 255 },
    { key: 'outBlack', label: 'Output black', min: 0, max: 255, value: 0 },
    { key: 'outWhite', label: 'Output white', min: 0, max: 255, value: 255 }], op: 'levels' },
  curves: { title: 'Curves', params: [], op: 'curves', curves: true },
  whiteBalance: { title: 'White balance', params: [
    { key: 'temperature', label: 'Temperature (cool ↔ warm)', min: -100, max: 100, value: 0 },
    { key: 'tint', label: 'Tint (green ↔ magenta)', min: -100, max: 100, value: 0 }], op: 'whiteBalance' },
  lut3d: { title: 'Color lookup (3D LUT)', params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, value: 100, unit: '%' }], op: 'lut3d', layerOnly: true },
  sepia: { title: 'Sepia tone', params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, value: 80, unit: '%' }], op: 'sepia' },
  gaussianBlur: { title: 'Gaussian blur', params: [{ key: 'radius', label: 'Radius', min: 0, max: 100, step: 0.5, value: 4, unit: 'px' }], op: 'gaussianBlur', maskOk: true },
  sharpen: { title: 'Sharpen (unsharp mask)', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 300, value: 80, unit: '%' },
    { key: 'radius', label: 'Radius', min: 0.5, max: 20, step: 0.1, value: 1.5, unit: 'px' },
    { key: 'threshold', label: 'Threshold', min: 0, max: 64, value: 2 }], op: 'sharpen' },
  noise: { title: 'Add noise', params: [
    { key: 'amount', label: 'Amount', min: 0, max: 100, value: 12, unit: '%' },
    { key: 'monochrome', label: 'Monochrome', type: 'checkbox', value: true }], op: 'noise', extra: { seed: 1234 } },
  vignette: { title: 'Vignette', params: [
    { key: 'amount', label: 'Amount', min: -100, max: 100, value: 50 },
    { key: 'size', label: 'Clear centre', min: 0, max: 100, value: 45, unit: '%' },
    { key: 'feather', label: 'Feather', min: 1, max: 100, value: 60, unit: '%' }],
    op: 'vignette' },
};

function regionInfo(layer, r) {
  return { docW: doc().width, docH: doc().height, offX: layer.x + r.x, offY: layer.y + r.y };
}
function setBusy(delta) {
  state.busy = Math.max(0, state.busy + delta);
  document.body.classList.toggle('busy', state.busy > 0);
  if (state.busy > 0) status('Processing…');
}
/** Selection mask for a layer-space region, or null when nothing is selected. */
function regionMask(l, r) {
  const sel = doc().selection;
  return sel ? maskRegion(sel, l.x + r.x, l.y + r.y, r.w, r.h) : null;
}
function canAdjust(l, def) {
  if (editingMask(l) && !(def && def.maskOk)) {
    status('This command works on layer pixels. Click the layer thumbnail to target pixels (masks support blur and invert).');
    return false;
  }
  return true;
}
/** One-shot operation (runs in the pixel worker). */
async function applyInstant(label, op) {
  const l = activeLayer(); if (!canAdjust(l)) return;
  if (!editingMask(l)) rasterize(l, label);
  const r = opRegion(l); if (!r) return;
  const c = ctxOf(l.canvas); const img = c.getImageData(r.x, r.y, r.w, r.h);
  const deepSrc = useDeep(l) && DEEP_OPS.includes(op) ? deepOf(l) : null;
  setBusy(1);
  try {
    if (deepSrc) await deepOp(l, deepSrc, r, op, {}, regionInfo(l, r), regionMask(l, r));
    else { const out = await ops.process(op, img, {}, regionInfo(l, r), regionMask(l, r)); c.putImageData(out, r.x, r.y); touch(l); }
    requestRender(); commit(label); status(label);
  } catch (err) { status(`${label} failed: ${err.message}`); } finally { setBusy(-1); }
}

function openAdjust(def, presetValues = {}) {
  const l = activeLayer(); if (!canAdjust(l, def)) return;
  if (!editingMask(l)) rasterize(l, def.title);
  if (!editingMask(l) && (def.op === 'gaussianBlur' || def.op === 'sharpen')) ensureCoversDoc(l); // let blur spread past tight layer edges
  const r = opRegion(l);
  if (!r) { status('The selection does not overlap the active layer.'); return; }
  const onMask = editingMask(l), cv = targetCanvas(l);
  const c = ctxOf(cv);
  const original = c.getImageData(r.x, r.y, r.w, r.h);
  const deepSrc = !onMask && useDeep(l) && DEEP_OPS.includes(def.op) ? deepOf(l) : null; // 16-bit source, taken before previews touch the canvas
  const values = Object.fromEntries(def.params.map((p) => [p.key, presetValues[p.key] ?? p.value]));
  const info = regionInfo(l, r), selMask = regionMask(l, r);
  const params = () => ({ ...values, ...(def.extra || {}) });
  const touchIt = () => touchTarget(l);
  // Previews run in the worker; while one is running only the latest request is kept.
  let closed = false, running = false, dirty = false;
  const pump = async () => {
    running = true;
    while (dirty && !closed) {
      dirty = false;
      if (!$('#modalPreview').checked) { c.putImageData(original, r.x, r.y); touchIt(); requestRender(); continue; }
      setBusy(1);
      let out = null;
      try { out = await ops.process(def.op, original, params(), info, selMask); } catch (err) { status(err.message); }
      setBusy(-1);
      if (closed || !out) continue;
      c.putImageData(out, r.x, r.y); touchIt(); requestRender();
      if (!state.busy) status(`${def.title}: preview`);
    }
    running = false;
  };
  const preview = () => { dirty = true; if (!running) pump(); };
  const body = document.createElement('div');
  if (def.histogram) {
    const hc = document.createElement('canvas'); hc.width = 300; hc.height = 70; hc.style.cssText = 'width:100%;height:70px;background:#16171b;border-radius:4px';
    drawHistogram(hc, histogram(original)); body.append(hc);
  }
  if (def.curves) { Object.assign(values, identityCurves()); body.append(createCurvesEditor(values, preview, channelHistograms(original))); }
  for (const p of def.params) body.append(paramField({ ...p, value: values[p.key] }, values, preview, p.value));
  showModal({
    title: def.title, body, preview: true, passive: true,
    onPreviewToggle: preview,
    ok: async () => {
      closed = true; setBusy(1);
      try {
        if (deepSrc) await deepOp(l, deepSrc, r, def.op, params(), info, selMask);
        else { const out = await ops.process(def.op, original, params(), info, selMask); c.putImageData(out, r.x, r.y); touchIt(); }
        requestRender(); commit(def.title); status(def.title); updateLayersPanel(); recordStep({ t: 'adjust', op: def.op, params: params() });
      } catch (err) { c.putImageData(original, r.x, r.y); compDirty = true; requestRender(); status(`${def.title} failed: ${err.message}`); }
      finally { setBusy(-1); }
    },
    cancel: () => { closed = true; c.putImageData(original, r.x, r.y); touchIt(); if (deepSrc && l.deep === deepSrc) l.deepRev = l.rev; requestRender(); },
  });
  preview();
}
// --- Select ▸ Color range… and Refine edge… ---------------------------------------------------
const CR_MODES = [['sampled', 'Sampled color'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'],
  ['highlights', 'Highlights'], ['midtones', 'Midtones'], ['shadows', 'Shadows']];
const hexArr = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const arrHex = (c) => rgbToHex(c[0], c[1], c[2]);
/** Bring the on-screen composite up to date (full redraw, or just the pending dirty rectangle). */
function freshComp() {
  if (compDirty) { composite(); compDirty = false; compRect = null; }
  else if (compRect) { const r = compRect; compRect = null; composite(comp, { rect: r }); }
}
function fullComposite() { freshComp(); return comp; }
function openColorRangeDialog() {
  const d = doc(), o = state.opts, src = fullComposite();
  const k = Math.min(1, 220 / Math.max(d.width, d.height)), pw = Math.max(1, Math.round(d.width * k)), ph = Math.max(1, Math.round(d.height * k));
  const small = makeCanvas(pw, ph), sx = ctxOf(small); sx.imageSmoothingQuality = 'high'; sx.drawImage(src, 0, 0, pw, ph);
  const smallImg = sx.getImageData(0, 0, pw, ph);
  let color = o.crColor || hexArr(state.fg);
  const body = document.createElement('div'); body.className = 'cr-dialog';
  body.innerHTML = formHTML([
    { label: 'Select', html: `<select id="crMode">${CR_MODES.map(([v, n]) => `<option value="${v}" ${o.crMode === v ? 'selected' : ''}>${n}</option>`).join('')}</select>` },
    { label: 'Color', html: `<span><input type="color" id="crColor" value="${arrHex(color)}" /> <span class="muted">or click the preview / canvas</span></span>` },
  ]) + `<label class="field"><span>Fuzziness</span><input type="range" id="crFuzz" min="1" max="200" value="${o.crFuzziness}" /><output id="crFuzzOut">${o.crFuzziness}</output></label>` +
    `<div class="cr-preview-wrap"><canvas id="crPreview" width="${pw}" height="${ph}" title="Click to sample a color"></canvas></div>` +
    `<div class="seg cr-view"><button type="button" data-crview="sel" class="on">Selection</button><button type="button" data-crview="img">Image</button></div>` +
    `<p class="muted">Result combines with the current selection using the ${o.selMode} mode.</p>`;
  const pv = body.querySelector('#crPreview'), px = pv.getContext('2d');
  let view = 'sel';
  const params = () => ({ mode: body.querySelector('#crMode').value, color, fuzziness: +body.querySelector('#crFuzz').value });
  const draw = () => {
    const pr = params(); body.querySelector('#crColor').closest('.field').classList.toggle('dim', pr.mode !== 'sampled');
    body.querySelector('#crFuzzOut').textContent = pr.fuzziness;
    if (view === 'img') { px.putImageData(smallImg, 0, 0); return; }
    const m = colorRangeMask(smallImg, pr), out = px.createImageData(pw, ph);
    for (let i = 0; i < m.length; i++) { const j = i * 4; out.data[j] = out.data[j + 1] = out.data[j + 2] = m[i]; out.data[j + 3] = 255; }
    px.putImageData(out, 0, 0);
  };
  const sampleAt = (x, y) => {
    const p = ctxOf(src).getImageData(Math.max(0, Math.min(d.width - 1, Math.floor(x))), Math.max(0, Math.min(d.height - 1, Math.floor(y))), 1, 1).data;
    color = [p[0], p[1], p[2]]; body.querySelector('#crColor').value = arrHex(color); body.querySelector('#crMode').value = 'sampled'; draw();
  };
  pv.addEventListener('click', (e) => { const r = pv.getBoundingClientRect(); sampleAt(((e.clientX - r.left) / r.width) * d.width, ((e.clientY - r.top) / r.height) * d.height); });
  body.querySelector('#crColor').addEventListener('input', (e) => { color = hexArr(e.target.value); body.querySelector('#crMode').value = 'sampled'; draw(); });
  body.querySelectorAll('[data-crview]').forEach((b) => b.addEventListener('click', () => { view = b.dataset.crview; body.querySelectorAll('[data-crview]').forEach((q) => q.classList.toggle('on', q === b)); draw(); }));
  body.querySelector('#crMode').addEventListener('change', draw);
  body.querySelector('#crFuzz').addEventListener('input', draw);
  colorRangeSampler = sampleAt; // while open, clicking the canvas samples (passive modal)
  draw();
  showModal({
    title: 'Color range', body, passive: true,
    ok: async () => {
      colorRangeSampler = null;
      const pr = params(); Object.assign(o, { crMode: pr.mode, crColor: color, crFuzziness: pr.fuzziness });
      setBusy(1);
      try {
        const img = ctxOf(fullComposite()).getImageData(0, 0, d.width, d.height);
        const m = await ops.colorRange(img, pr);
        if (doc() === d) applyShape(m, o.selMode, 'Color range');
        status(d.selection ? `Color range: ${d.selection.w} × ${d.selection.h} px selected` : 'Color range: nothing matched');
      } finally { setBusy(-1); }
    },
    cancel: () => { colorRangeSampler = null; },
  });
}
let colorRangeSampler = null;
function openRefineDialog() {
  const d = doc(), sel0 = d.selection, o = state.opts;
  if (!sel0) { status('Make a selection first.'); return; }
  const values = { smooth: o.refineSmooth, feather: o.refineFeather, shift: o.refineShift };
  const body = document.createElement('div');
  body.innerHTML = `<p class="muted">Edges preview on the canvas. Shift edge: negative contracts, positive expands.</p>`;
  const fields = [
    { key: 'smooth', label: 'Smooth', min: 0, max: 20, value: 0, unit: 'px' },
    { key: 'feather', label: 'Feather', min: 0, max: 50, value: 0, step: 0.5, unit: 'px' },
    { key: 'shift', label: 'Shift edge', min: -50, max: 50, value: 0, unit: 'px' },
  ];
  let closed = false, running = false, dirty = false;
  const compute = (p) => ops.refine(sel0.mask, sel0.W, sel0.H, p);
  const pump = async () => {
    running = true;
    while (dirty && !closed) {
      dirty = false; const p = { ...values };
      try { const m = await compute(p); if (!closed && doc() === d) { d.selection = makeSelection(sel0.W, sel0.H, m); requestRender(); } } catch (err) { status(err.message); }
    }
    running = false;
  };
  const preview = () => { dirty = true; if (!running) pump(); };
  for (const f of fields) body.append(paramField({ ...f, value: values[f.key] }, values, preview, f.value));
  showModal({
    title: 'Refine edge', body, passive: true,
    ok: async () => {
      closed = true; Object.assign(o, { refineSmooth: values.smooth, refineFeather: values.feather, refineShift: values.shift });
      setBusy(1);
      try { const m = await compute({ ...values }); if (doc() === d) { d.selection = sel0; setSelection(makeSelection(sel0.W, sel0.H, m), 'Refine edge'); } }
      finally { setBusy(-1); }
      status(d.selection ? `Refined edge: ${d.selection.w} × ${d.selection.h} px` : 'Refine edge removed the whole selection');
    },
    cancel: () => { closed = true; if (doc() === d) { d.selection = sel0; requestRender(); } },
  });
  if (values.smooth || values.feather || values.shift) preview();
}

function openFeatherDialog() {
  const d = doc();
  if (!d.selection) { status('Make a selection first.'); return; }
  const body = document.createElement('div');
  body.innerHTML = formHTML([{ label: 'Feather radius', html: `<input id="fRadius" type="number" min="0.5" max="250" step="0.5" value="${state.opts.featherRadius}" /> px` }]);
  showModal({
    title: 'Feather selection', body,
    ok: async () => {
      const radius = Math.max(0.5, Math.min(250, +$('#fRadius').value || 1));
      state.opts.featherRadius = radius;
      const sel = d.selection; setBusy(1);
      try {
        const m = await ops.featherMask(sel.mask, sel.W, sel.H, radius);
        if (doc() === d && d.selection === sel) setSelection(makeSelection(sel.W, sel.H, m), `Feather ${radius}px`);
      } finally { setBusy(-1); status(`Feathered selection by ${radius}px`); }
    },
  });
}
function paramField(p, values, onChange, defaultValue) {
  const row = document.createElement('label'); row.className = 'field';
  if (p.type === 'checkbox') {
    row.classList.add('two');
    row.innerHTML = `<span>${p.label}</span><input type="checkbox" ${p.value ? 'checked' : ''} />`;
    row.querySelector('input').addEventListener('change', (e) => { values[p.key] = e.target.checked; onChange(); });
    return row;
  }
  // v1.7: the value is a number field as well as a slider, so an exact value can be typed (Tab / arrows work too)
  row.innerHTML = `<span>${p.label}</span><input type="range" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${p.value}" /><span class="num-out"><input type="number" class="pf-num" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${p.value}" />${p.unit ? `<span class="unit">${p.unit}</span>` : ''}</span>`;
  const input = row.querySelector('input[type=range]'), num = row.querySelector('input.pf-num');
  input.dataset.key = p.key; num.dataset.numKey = p.key; num.setAttribute('aria-label', `${p.label}${p.unit ? ` (${p.unit})` : ''}`);
  input.title = 'Double-click to reset';
  input.addEventListener('input', () => { values[p.key] = +input.value; num.value = input.value; onChange(); });
  input.addEventListener('dblclick', () => { input.value = defaultValue; input.dispatchEvent(new Event('input')); });
  const fromNum = (final) => {
    if (num.value === '' || !Number.isFinite(+num.value)) { if (final) num.value = input.value; return; }
    const v = Math.min(+p.max, Math.max(+p.min, +num.value)); input.value = v; if (final) num.value = input.value;
    if (+input.value !== values[p.key]) { values[p.key] = +input.value; onChange(); }
  };
  num.addEventListener('input', () => fromNum(false));
  num.addEventListener('change', () => fromNum(true));
  return row;
}

// ---------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------
let modalHandlers = null;
function showModal({ title, body, ok, cancel, okLabel = 'OK', cancelLabel = 'Cancel', preview = false, passive = false, onPreviewToggle, hideCancel = false, onClose }) {
  closeSheet(); if (modalHandlers) { const h = modalHandlers; modalHandlers = null; h.onClose?.(); }
  $('#modalTitle').textContent = title;
  const mb = $('#modalBody'); mb.innerHTML = '';
  if (typeof body === 'string') mb.innerHTML = body; else mb.append(body);
  $('#modalOk').textContent = okLabel;
  $('#modalCancel').classList.toggle('hidden', hideCancel); $('#modalCancel').textContent = cancelLabel;
  $('#previewWrap').classList.toggle('hidden', !preview);
  $('#modalPreview').checked = true;
  $('#modalPreview').onchange = onPreviewToggle || null;
  $('#modal').classList.toggle('passive', passive);
  $('#modal').classList.remove('hidden');
  modalHandlers = { ok, cancel, onClose };
  if (!IS_TOUCH) setTimeout(() => mb.querySelector('textarea, input[type=number], input[type=text], select')?.focus(), 0);
}
function closeModal() { $('#modal').classList.add('hidden'); const h = modalHandlers; modalHandlers = null; h?.onClose?.(); viewport.focus(); }
$('#modalOk').addEventListener('click', () => { const h = modalHandlers; if (h?.ok?.() === false) return; closeModal(); });
$('#modalCancel').addEventListener('click', () => { const h = modalHandlers; h?.cancel?.(); closeModal(); });
function openInfo(title, html) { showModal({ title, body: html, hideCancel: true, okLabel: 'Close' }); }
const formHTML = (fields) => fields.map((f) => `<label class="field two${f.cls ? ` ${f.cls}` : ''}"><span>${f.label}</span>${f.html}</label>`).join('');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openNewDialog() {
  const body = document.createElement('div');
  body.innerHTML = formHTML([
    { label: 'Preset', html: `<select id="nPreset"><option value="">Custom</option><option>1920x1080</option><option>1080x1080</option><option>1080x1350</option><option>1280x720</option><option>2480x3508</option><option>800x600</option></select>` },
    { label: 'Width (px)', html: `<input type="number" id="nW" min="1" max="16384" value="1280" />` },
    { label: 'Height (px)', html: `<input type="number" id="nH" min="1" max="16384" value="800" />` },
    { label: 'Background', html: `<select id="nBg"><option value="white">White</option><option value="bg">Background color</option><option value="transparent">Transparent</option></select>` },
  ]);
  body.querySelector('#nPreset').addEventListener('change', (e) => {
    if (!e.target.value) return; const [w, h] = e.target.value.split('x'); body.querySelector('#nW').value = w; body.querySelector('#nH').value = h;
  });
  showModal({ title: 'New canvas', body, okLabel: 'Create', ok: () => {
    const w = Math.min(16384, Math.max(1, +body.querySelector('#nW').value | 0)), h = Math.min(16384, Math.max(1, +body.querySelector('#nH').value | 0));
    const g = guardSize(w, h, 1); if (g.level === 'refuse') { toast(g.msg, 6000); return false; }
    if (g.level === 'warn') toast(g.msg, 6000);
    newDocument(w, h, body.querySelector('#nBg').value);
  } });
}

function openImageSizeDialog() {
  const d = doc(); const ratio = d.width / d.height;
  const body = document.createElement('div');
  body.innerHTML = formHTML([
    { label: 'Width (px)', html: `<input type="number" id="iW" value="${d.width}" min="1" max="16384" />` },
    { label: 'Height (px)', html: `<input type="number" id="iH" value="${d.height}" min="1" max="16384" />` },
    { label: 'Scale (%)', html: `<input type="number" id="iP" value="100" min="1" max="1000" />` },
    { label: 'Keep proportions', html: `<input type="checkbox" id="iLock" checked />` },
  ]);
  const W = body.querySelector('#iW'), H = body.querySelector('#iH'), P = body.querySelector('#iP'), L = body.querySelector('#iLock');
  W.addEventListener('input', () => { if (L.checked) H.value = Math.max(1, Math.round(W.value / ratio)); P.value = Math.round((W.value / d.width) * 100); });
  H.addEventListener('input', () => { if (L.checked) W.value = Math.max(1, Math.round(H.value * ratio)); P.value = Math.round((H.value / d.height) * 100); });
  P.addEventListener('input', () => { W.value = Math.max(1, Math.round((d.width * P.value) / 100)); H.value = Math.max(1, Math.round((d.height * P.value) / 100)); });
  showModal({ title: 'Image size', body, ok: () => {
    const w = Math.min(16384, Math.max(1, +W.value | 0)), h = Math.min(16384, Math.max(1, +H.value | 0));
    const g = guardSize(w, h, d.layers.length, d.depth === 16); if (g.level === 'refuse') { toast(g.msg, 6000); return false; }
    if (g.level === 'warn') toast(g.msg, 6000);
    if (w !== d.width || h !== d.height) { resizeImage(w, h); recordStep({ t: 'resize', w, h }); }
  } });
}
function openCanvasSizeDialog() {
  const d = doc(); const body = document.createElement('div');
  body.innerHTML = formHTML([
    { label: 'Width (px)', html: `<input type="number" id="cW" value="${d.width}" min="1" max="16384" />` },
    { label: 'Height (px)', html: `<input type="number" id="cH" value="${d.height}" min="1" max="16384" />` },
    { label: 'Anchor', html: `<div id="anchor" style="display:grid;grid-template-columns:repeat(3,26px);gap:3px">${
      [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => `<button type="button" data-ax="${c / 2}" data-ay="${r / 2}" style="padding:0;height:22px">${r === 1 && c === 1 ? '●' : '·'}</button>`)).join('')}</div>` },
  ]);
  let ax = 0.5, ay = 0.5;
  body.querySelectorAll('#anchor button').forEach((b) => b.addEventListener('click', () => {
    ax = +b.dataset.ax; ay = +b.dataset.ay; body.querySelectorAll('#anchor button').forEach((o) => (o.textContent = '·')); b.textContent = '●';
  }));
  showModal({ title: 'Canvas size', body, ok: () => {
    const w = Math.min(16384, Math.max(1, +body.querySelector('#cW').value | 0)), h = Math.min(16384, Math.max(1, +body.querySelector('#cH').value | 0));
    if (w !== d.width || h !== d.height) resizeCanvas(w, h, ax, ay);
  } });
}

function openTextDialog(p, existing = null) {
  const d = doc(), o = state.opts;
  const t0 = existing ? existing.text : { text: 'Hello', font: o.textFont, size: o.textSize, bold: o.textBold, italic: o.textItalic, color: state.fg, align: o.textAlign, ox: 0, oy: 0 };
  const layer = existing || createLayer('Text', 1, 1, { kind: 'text', text: t0, x: Math.round(p.x), y: Math.round(p.y) });
  const restore = existing ? { text: existing.text, canvas: existing.canvas, x: existing.x, y: existing.y, name: existing.name, rev: existing.rev } : null;
  const body = document.createElement('div');
  body.innerHTML = `<textarea id="tText" placeholder="Type your text">${escapeHtml(t0.text)}</textarea>` + formHTML([
    { label: 'Font', html: `<select id="tFont">${TEXT_FONTS.map((f) => `<option ${f === t0.font ? 'selected' : ''} style="font-family:${escapeHtml(fontFamilyCSS(f))}">${f}</option>`).join('')}</select>` },
    { label: 'Size (px)', html: `<input type="number" id="tSize" value="${t0.size}" min="4" max="2000" />` },
    { label: 'Style', html: `<span><label><input type="checkbox" id="tBold" ${t0.bold ? 'checked' : ''}/> Bold</label> <label><input type="checkbox" id="tItalic" ${t0.italic ? 'checked' : ''}/> Italic</label></span>` },
    { label: 'Align', html: `<span class="seg" id="tAlign">${['left', 'center', 'right'].map((a) => `<button type="button" data-align="${a}" class="${t0.align === a ? 'on' : ''}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</span>` },
    { label: 'Color', html: `<input type="color" id="tColor" value="${t0.color}" />` },
  ]);
  if (!existing) insertLayer(d, layer);
  let align = t0.align;
  const read = () => ({
    ...layer.text, text: body.querySelector('#tText').value, font: body.querySelector('#tFont').value,
    size: Math.max(4, Math.min(2000, +body.querySelector('#tSize').value || 64)), bold: body.querySelector('#tBold').checked,
    italic: body.querySelector('#tItalic').checked, color: body.querySelector('#tColor').value, align,
  });
  const draw = () => {
    const t = read();
    // changing alignment keeps the text block in place: move the anchor to the new edge
    if (t.align !== layer.text.align && layer.canvas.width > 1) {
      const w = layer.canvas.width - 2 * layer.text.oy; // oy is the padding around the text
      const left = layer.x + layer.text.oy, edge = { left, center: left + w / 2, right: left + w }[t.align];
      t.ox = edge - layer.x;
    }
    layer.text = t; renderTextLayer(layer); compDirty = true; requestRender();
    if (!fontReady(t)) loadFont(t).then(() => { if (!closedText && layer.text.font === t.font) { renderTextLayer(layer); compDirty = true; requestRender(); } });
  };
  let closedText = false;
  body.querySelectorAll('[data-align]').forEach((b) => b.addEventListener('click', () => {
    align = b.dataset.align; body.querySelectorAll('[data-align]').forEach((q) => q.classList.toggle('on', q === b)); draw();
  }));
  body.addEventListener('input', draw);
  if (!existing) { layer.text = { ...read(), ox: 0, oy: 0 }; renderTextLayer(layer); } // anchor = the clicked point
  compDirty = true; requestRender();
  showModal({ title: existing ? 'Edit text' : 'Add text', body, passive: true, okLabel: existing ? 'Done' : 'Add text',
    ok: () => {
      closedText = true;
      const t = read(); Object.assign(o, { textFont: t.font, textSize: t.size, textBold: t.bold, textItalic: t.italic, textAlign: t.align });
      const finish = () => { renderTextLayer(layer); compDirty = true; requestRender(); d.activeId = layer.id; touch(layer); commit(existing ? 'Edit text' : 'Text'); };
      if (fontReady(t)) finish(); else loadFont(t).then(finish); // a bundled font is still downloading: render with it, not the fallback
    },
    cancel: () => {
      closedText = true;
      if (existing) { Object.assign(existing, restore); compDirty = true; }
      else d.layers.splice(d.layers.indexOf(layer), 1);
      compDirty = true; requestRender(); updateLayersPanel();
    } });
}

function openExportDialog() {
  const body = document.createElement('div');
  const base = (doc().name || 'image').replace(/\.[^.]+$/, '');
  body.innerHTML = formHTML([
    { label: 'Preset', html: `<span><select id="ePreset" title="Saved export settings"></select> <button type="button" id="ePresetSave" title="Save the current settings as a preset">Save…</button> <button type="button" id="ePresetDel" title="Delete this preset">Delete</button></span>` },
    { label: 'File name', html: `<input type="text" id="eName" value="${escapeHtml(base)}" />` },
    { label: 'Format', html: `<select id="eFmt"><option value="image/png">PNG (lossless)</option><option value="image/png16">PNG 16-bit</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option><option value="${PSD_TYPE}">PSD (layers)</option></select>` },
    { label: 'Quality', html: `<span><input type="range" id="eQ" min="1" max="100" value="90" disabled /> <output id="eQv">90</output></span>` },
    { label: 'Size', html: `<span class="ex-size"><select id="eSize" title="Export at the document size or resized"><option value="original">Original (${doc().width} × ${doc().height} px)</option><option value="long">Long edge (px)</option><option value="width">Width (px)</option><option value="scale">Scale (%)</option></select> <input type="number" id="eSizeV" min="1" max="30000" value="${Math.max(doc().width, doc().height)}" class="hidden" aria-label="New size" style="width:84px"/> <span id="eSizeOut" class="muted"></span></span>` },
    { label: 'Resolution', html: `<span><input type="number" id="eDpi" min="1" max="2400" value="${doc().dpi || 72}" style="width:72px" aria-label="Resolution in pixels per inch"/> ppi <span class="muted" id="eDpiInfo"></span></span>` },
    { label: 'Watermark', html: watermarkFieldHTML('eWm') },
    { label: 'Output sharpening', html: `<select id="eSharp" title="Sharpen after resize for screen or print (approximate; not a printer profile)">${exportSharpOptionsHTML('off')}</select>` },
  ]);
  const fmt = body.querySelector('#eFmt'), q = body.querySelector('#eQ');
  // navigator.share needs a fresh user gesture, so the file is rendered ahead of time and the
  // Share button hands it over synchronously (iOS Safari is strict about this).
  let ready = null, prepTimer = 0;
  let exportOpts = () => ({});
  const key = () => `${fmt.value}|${q.value}|${body.querySelector('#eName').value}|${JSON.stringify(exportOpts())}`;
  const prepare = () => {
    clearTimeout(prepTimer);
    prepTimer = setTimeout(async () => {
      const k = key(); const blob = await renderExportWith(fmt.value, q.value / 100, exportOpts());
      const name = `${body.querySelector('#eName').value || 'image'}.${EXPORT_EXT[fmt.value]}`;
      ready = { k, file: new File([blob], name, { type: blob.type || 'image/png' }) };
      const sb = body.querySelector('#eShare'); if (sb) { sb.disabled = false; sb.textContent = 'Share…'; }
    }, 120);
  };
  const canShareFiles = !!(navigator.canShare && navigator.share && (() => { try { return navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] }); } catch { return false; } })());
  if (canShareFiles) {
    const row = document.createElement('div'); row.className = 'field two';
    row.innerHTML = `<span>Share</span><span><button id="eShare" disabled>Preparing…</button> <span class="muted">Save to Photos, Files or another app</span></span>`;
    body.append(row);
    row.querySelector('#eShare').addEventListener('click', () => {
      if (!ready || ready.k !== key()) { status('Preparing the file… tap Share again in a moment.'); prepare(); return; }
      const file = ready.file;
      navigator.share({ files: [file], title: file.name }).then(() => { status(`Shared ${file.name}`); closeModal(); })
        .catch((err) => { if (err.name !== 'AbortError') { download(file, file.name); status(`Share unavailable (${err.name}); downloaded ${file.name} instead`); } });
    });
    prepare();
  }
  // v1.7: resize and print resolution right in the export (no separate Image size step)
  const sizeSel = body.querySelector('#eSize'), sizeV = body.querySelector('#eSizeV'), dpiIn = body.querySelector('#eDpi');
  const sizeOpts = () => { const m = sizeSel.value; if (m === 'original') return null; const n = Math.max(1, +sizeV.value || 1); return m === 'long' ? { mode: 'long', long: n } : m === 'width' ? { mode: 'width', w: n } : { mode: 'scale', pct: n }; };
  const sizeInfo = () => {
    const v = sizeOpts(), { w, h } = v ? variantSize(doc().width, doc().height, v) : { w: doc().width, h: doc().height }, dpi = +dpiIn.value || 72;
    body.querySelector('#eSizeOut').textContent = v ? `→ ${w} × ${h} px` : '';
    body.querySelector('#eDpiInfo').textContent = `prints at ${(w / dpi).toFixed(2)} × ${(h / dpi).toFixed(2)} in`;
  };
  sizeSel.addEventListener('change', () => {
    const m = sizeSel.value; sizeV.classList.toggle('hidden', m === 'original');
    sizeV.value = m === 'long' ? Math.max(doc().width, doc().height) : m === 'width' ? doc().width : 100; sizeInfo(); if (canShareFiles) prepare();
  });
  sizeV.addEventListener('input', () => { sizeInfo(); if (canShareFiles) prepare(); });
  dpiIn.addEventListener('input', sizeInfo); sizeInfo();
  const wmBox = body.querySelector('#eWm'); wireWatermarkField(body, 'eWm', () => { if (canShareFiles) prepare(); });
  const sharpSel = body.querySelector('#eSharp');
  exportOpts = () => { const dpi = Math.max(1, Math.min(2400, Math.round(+dpiIn.value || 0))) || null; return { size: sizeOpts(), dpi: dpi === 72 && !doc().dpi ? null : dpi, watermark: wmBox.checked ? watermarkSettings() : null, sharpen: sharpSel.value || 'off' }; };
  sharpSel.addEventListener('change', () => { if (canShareFiles) prepare(); });
  // v1.8: saved presets (format, quality, size, ppi, watermark); the last one used is selected next time
  const pSel = body.querySelector('#ePreset');
  const fillPresets = (sel) => { pSel.innerHTML = `<option value="">(current settings)</option>${allExportPresets().map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}`; pSel.value = sel || ''; body.querySelector('#ePresetDel').disabled = !pSel.value || !!BUILTIN_EXPORT_PRESETS.find((b) => b.id === pSel.value); };
  const applyPreset = (p) => {
    fmt.value = p.type; fmt.dispatchEvent(new Event('change'));
    q.value = p.quality ?? 90; body.querySelector('#eQv').textContent = q.value;
    const sz = p.size; sizeSel.value = sz ? sz.mode : 'original'; sizeV.classList.toggle('hidden', !sz);
    if (sz) sizeV.value = sz.mode === 'long' ? sz.long : sz.mode === 'width' ? sz.w : sz.pct;
    dpiIn.value = p.dpi || doc().dpi || 72; wmBox.checked = !!p.watermark;
    if (p.watermark && typeof p.watermark === 'object') { const nw = saveWatermark(watermarkOfPreset(p)); body.querySelectorAll('[data-wmtext]').forEach((el) => { el.textContent = watermarkLabel(nw); }); } // the preset's own watermark becomes the current one
    sharpSel.value = (p.sharpen && EXPORT_SHARP_PRESETS[p.sharpen] !== undefined) ? p.sharpen : 'off';
    sizeInfo(); if (canShareFiles) prepare();
  };
  const presetFromForm = (name) => { const o = exportOpts(); return { name, type: fmt.value, quality: +q.value, size: o.size, dpi: +dpiIn.value || null, watermark: wmBox.checked ? watermarkSettings() : false, sharpen: o.sharpen || 'off' }; };
  pSel.addEventListener('change', () => { const p = allExportPresets().find((x) => x.id === pSel.value); if (p) applyPreset(p); fillPresets(pSel.value); });
  body.querySelector('#ePresetSave').addEventListener('click', () => {
    const name = (prompt('Preset name', allExportPresets().find((x) => x.id === pSel.value)?.name || 'My export') || '').trim(); if (!name) return;
    const p = saveExportPreset(presetFromForm(name)); fillPresets(p.id); status(`Saved export preset “${name}”.`);
  });
  body.querySelector('#ePresetDel').addEventListener('click', () => { const id = pSel.value; if (!id) return; deleteExportPreset(id); fillPresets(''); status('Export preset deleted.'); });
  const last = allExportPresets().find((x) => x.id === localStorage.getItem(LAST_EXPORT_PRESET_KEY));
  fillPresets(last ? last.id : ''); if (last) applyPreset(last);
  // v1.15: a 16-bit document defaults to PNG 16-bit so Export does not silently dither to 8-bit
  else if (is16()) { fmt.value = 'image/png16'; }
  fmt.addEventListener('change', () => {
    q.disabled = fmt.value.startsWith('image/png') || fmt.value === PSD_TYPE;
    const noSize = fmt.value === 'image/png16' || fmt.value === PSD_TYPE; sizeSel.disabled = noSize; if (noSize && sizeSel.value !== 'original') { sizeSel.value = 'original'; sizeSel.dispatchEvent(new Event('change')); }
    dpiIn.disabled = fmt.value === 'image/webp' || fmt.value === PSD_TYPE;
    // Output sharpening is an 8-bit unsharp mask (JPEG / WebP / PNG 8-bit)
    sharpSel.disabled = fmt.value === 'image/png16' || fmt.value === PSD_TYPE;
    if (sharpSel.disabled) sharpSel.title = 'Output sharpening applies to 8-bit exports (JPEG, WebP, PNG)';
    else sharpSel.title = 'Sharpen after resize for screen or print (approximate; not a printer profile)';
    if (canShareFiles) prepare();
  });
  fmt.dispatchEvent(new Event('change'));
  q.addEventListener('input', () => { body.querySelector('#eQv').textContent = q.value; if (canShareFiles) prepare(); });
  body.querySelector('#eName').addEventListener('input', () => { if (canShareFiles) prepare(); });
  showModal({ title: 'Export image', body, okLabel: canShareFiles ? 'Download' : 'Export', ok: () => {
    try { localStorage.setItem(LAST_EXPORT_PRESET_KEY, pSel.value || ''); } catch { /* ignore */ }
    exportImage(fmt.value, q.value / 100, body.querySelector('#eName').value || 'image', exportOpts());
  } });
}
/** renderExport plus the export dialog's options: an optional resize ({ mode, long | w | pct }) and the ppi written
 * into the file (JPEG JFIF density / PNG pHYs). */
async function renderExportWith(type, quality, { size = null, dpi = null, watermark = null, sharpen = 'off' } = {}) {
  let blob; await readyWatermark(watermark);
  if (size && type !== 'image/png16' && type !== PSD_TYPE) { blob = (await renderVariant({ ...size, type, quality: Math.round(quality * 100), watermark, sharpen })).blob; lastExportNotes = []; }
  else blob = await renderExport(type, quality, { watermark, sharpen });
  if (dpi && (blob.type === 'image/jpeg' || blob.type === 'image/png')) blob = await withDpi(blob, dpi);
  if (blob.type === 'image/jpeg') blob = await withSrgbIcc(blob);
  if (blob.type === 'image/png') blob = await withPngSrgb(blob);
  return blob;
}
const EXPORT_EXT = { 'image/png': 'png', 'image/png16': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', [PSD_TYPE]: 'psd' };
let lastExportNotes = [];
/**
 * 'image/png16' writes a 16-bit PNG (png.js). 16-bit documents are composited in float (deep.js) and
 * dithered down for 8-bit formats so smooth gradients don't band.
 */
async function renderExport(type, quality, { watermark = null, sharpen = 'off' } = {}) {
  const d = doc(), bg = type === 'image/jpeg' ? '#ffffff' : null;
  if (type === PSD_TYPE) { const r = await documentToPSD(d); lastExportNotes = r.notes; if (watermark) lastExportNotes = [...lastExportNotes, 'The watermark is not added to layered PSD files.']; return r.blob; }
  lastExportNotes = [];
  if (type === 'image/png16' || is16()) {
    const deep = compositeDeepDoc({ background: bg });
    if (type === 'image/png16') {
      if (sharpen && sharpen !== 'off') lastExportNotes.push('Output sharpening is skipped for 16-bit PNG (8-bit exports only).');
      if (watermark) watermarkDeep(deep, watermark);
      return new Blob([encodePNG({ width: deep.width, height: deep.height, data: deep.data, depth: 16 })], { type: 'image/png' });
    }
    const out = makeCanvas(d.width, d.height); ctxOf(out).putImageData(deepToImageData(deep, { dither: true }), 0, 0);
    if (sharpen && sharpen !== 'off') applyExportSharpen(out, sharpen);
    if (watermark) drawWatermark(out, watermark);
    return new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, type, quality));
  }
  const out = makeCanvas(doc().width, doc().height);
  // JPEG has no alpha channel: flatten onto white so transparent areas don't turn black
  composite(out, { background: type === 'image/jpeg' ? '#ffffff' : null, sync: true });
  if (sharpen && sharpen !== 'off') applyExportSharpen(out, sharpen);
  if (watermark) drawWatermark(out, watermark);
  return new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, type, quality));
}
/** File ▸ Export with last preset: one step, straight to the save dialog. */
function exportWithLastPreset() {
  const p = allExportPresets().find((x) => x.id === localStorage.getItem(LAST_EXPORT_PRESET_KEY));
  if (!p) { status('No export preset used yet: choose one in the Export dialog first.'); openExportDialog(); return null; }
  const name = (doc().name || 'image').replace(/\.[^.]+$/, '');
  status(`Exporting with “${p.name}”…`);
  return exportImage(p.type, (p.quality ?? 90) / 100, name, { size: p.type === 'image/png16' || p.type === PSD_TYPE ? null : p.size || null, dpi: p.dpi || null, watermark: watermarkOfPreset(p), sharpen: p.sharpen || 'off' });
}
async function exportImage(type, quality, name, opts = {}) {
  if (opts.dpi == null && doc().dpi) opts = { ...opts, dpi: doc().dpi }; // a print crop's ppi goes into the file
  const ext = EXPORT_EXT[type];
  let handle = null;
  if (fsaSupported && EXPORT_TYPES[type]) {
    try { handle = await pickSave(`${name}.${ext}`, EXPORT_TYPES[type]); } catch (err) { status(`Export: ${err.message}`); }
    if (!handle) { status('Export cancelled.'); return; }
  }
  let blob;
  try { blob = await renderExportWith(type, quality, opts); } catch (err) { reportError('Export failed', err); return; }
  if (lastExportNotes.length) toast(lastExportNotes.join(' '), 8000);
  if (handle) {
    try { await writeFile(handle, blob); addRecent(handle, 'image'); status(`Exported ${handle.name} (${(blob.size / 1024).toFixed(0)} KB)`); return; }
    catch (err) { toast(`Could not write ${handle.name} (${err.message}) — downloading instead.`, 5000); }
  }
  download(blob, `${name}.${ext}`);
  status(`Exported ${name}.${ext} (${(blob.size / 1024).toFixed(0)} KB)`);
}
function download(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openShortcutsDialog() {
  const K = (cmd, spec) => keyLabel(shortcutFor(cmd, spec));
  const rows = [
    ['V / M / C', 'Move / Rectangle select / Crop'], ['L / P / W', 'Lasso / Polygonal lasso / Magic wand'], ['W again', 'Object select (box, then +Subject / −Background; Done + feather softens)'], ['B / E / S', 'Brush / Eraser / Clone stamp'], ['G (again: Fill) / U', 'Gradient / Shapes'], ['O again / J again', 'Dodge-burn / Red eye'], ['T / I', 'Text / Color picker'],
    [platformText('Shift / Alt / Shift+Alt (selecting)'), 'Add / subtract / intersect'], [`${K('invertSelection', 'Ctrl+Shift+I')}, ${keyLabel('Shift+F6')}`, 'Invert selection / feather'], ['Enter, double-click / Esc', 'Close / cancel polygon'],
    ['R / J', 'Healing brush / Spot healing'], [platformText('Alt+click (clone, healing)'), 'Set source point'], ['\\', 'Toggle editing mask / pixels'],
    ['H, hold Space', 'Pan'], ['Z, mouse wheel', platformText('Zoom (Shift+wheel pans)')], ['[ and ]', 'Brush size'], [platformText('Shift+click'), 'Straight brush line'], [platformText('Alt+click (brush)'), 'Pick color'],
    ['X / D', 'Swap / default colors'], [`${K('undo', 'Ctrl+Z')}, ${K('redo', 'Ctrl+Shift+Z')}`, 'Undo / redo'], [`${K('selectAll', 'Ctrl+A')} / ${K('deselect', 'Ctrl+D')}`, 'Select all / deselect'],
    [`${IS_MAC ? '⌦ / ⌫' : 'Del'}, ${keyLabel('Alt+Backspace')}`, 'Clear / fill selection'], [`${K('copy', 'Ctrl+C')} / ${K('cut', 'Ctrl+X')} / ${K('paste', 'Ctrl+V')}`, 'Copy / cut / paste as layer'], [`${K('layerDuplicate', 'Ctrl+J')} / ${K('layerMergeDown', 'Ctrl+E')}`, 'Duplicate layer / merge down'],
    [`${K('new', 'Ctrl+N')} / ${K('layerNew', 'Ctrl+Shift+N')}`, 'New canvas / new layer'], [K('freeTransform', 'Ctrl+T'), 'Free transform'],
    [`${K('brightnessContrast', 'Ctrl+B')} / ${K('hueSaturation', 'Ctrl+U')} / ${K('levels', 'Ctrl+L')} / ${K('curves', 'Ctrl+M')} / ${K('invert', 'Ctrl+I')}`, 'Brightness-contrast / Hue-sat / Levels / Curves / Invert'],
    [`${K('zoomFit', 'Ctrl+0')} / ${K('zoom100', 'Ctrl+1')}`, 'Fit / 100%'], ['Enter / Esc', 'Apply / cancel crop'],
    ['Arrows (Move tool)', platformText('Nudge layer (Shift = 10px)')], [`${K('saveProject', 'Ctrl+S')} / ${K('saveAs', 'Ctrl+Shift+S')} / ${K('export', 'Ctrl+Shift+E')}`, 'Save / save as / export'], [K('exportLastPreset', 'Ctrl+Alt+Shift+E'), 'Export with last preset'], [K('batchAgain', 'Ctrl+Alt+Shift+B'), 'Batch again with the last settings and folders'],
  ];
  const note = `<p class="muted" id="kbNote">${IS_MAC ? 'Mac keyboard: ⌘ Command · ⌥ Option · ⇧ Shift.' : 'Ctrl / Alt / Shift keyboard (Windows, Linux, ChromeOS).'} ` +
    `Some combinations are kept by the browser or system (${(IS_MAC ? ['Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+M', 'Ctrl+Shift+N'] : ['Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+N', 'Ctrl+Shift+I', 'Ctrl+Shift+C']).map(keyLabel).join(', ')}), so Tintwork shows an alternate for those. ` +
    'The usual combination still works where the browser passes it on, e.g. in an installed app window.</p>';
  openInfo('Keyboard shortcuts', `<table id="kbTable" style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 8px 3px 0;white-space:nowrap"><b>${k}</b></td><td class="muted">${v}</td></tr>`).join('')}</table>${note}`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------
let fileMode = 'open';
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not decode image')); i.src = src; });
}
function placeImage(img, name) {
  const d = doc(); const ow = img.naturalWidth || img.width, oh = img.naturalHeight || img.height;
  const { w, h, scaled } = fitPixels(ow, oh, Math.min(MAX_PIXELS, WARN_PIXELS));
  if (scaled) toast(`Placed image scaled to ${w}×${h} to save memory.`);
  const l = createLayer(name, w, h, { x: Math.round((d.width - w) / 2), y: Math.round((d.height - h) / 2) });
  l.canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  addLayer(l, 'Place image');
}
async function openFile(file, mode = 'open', { interactive = true, rawSettings = null } = {}) {
  try {
    if (/\.(json|tintwork)$/i.test(file.name) || file.type === 'application/json') {
      await loadProject(JSON.parse(await file.text()), file.name);
      return;
    }
    // layered PSD and camera RAW always open as a document (placing them would flatten the layers / skip develop)
    if (isPsdName(file.name) || file.type === PSD_TYPE) { if (mode === 'place' && doc()) toast('PSD files open as a new document so their layers are kept.', 4000); await openPSD(file, interactive); return; }
    if (isRawName(file.name)) { if (mode === 'place' && doc()) toast('Camera RAW files open as a new document.', 4000); await openRAW(file, interactive, rawSettings, fileHandleOf.get(file) || null); return; }
    if (!file.type.startsWith('image/') && !/\.png$/i.test(file.name)) { status(`Unsupported file: ${file.name}`); return; }
    if (mode !== 'place' || !doc()) {
      if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
        const buf = new Uint8Array(await file.arrayBuffer()), info = pngInfo(buf);
        if (info && info.bitDepth === 16 && documentFromDeepPNG(buf, file.name, info)) return;
      }
    }
    const url = URL.createObjectURL(file);
    let img;
    try { img = await loadImage(url); } catch { URL.revokeObjectURL(url); toast(`${file.name} could not be read. The file may be damaged or in a format this browser cannot decode.`, 6000); return; }
    URL.revokeObjectURL(url);
    const g = guardSize(img.naturalWidth, img.naturalHeight, (doc()?.layers.length || 0) + 1, doc()?.depth === 16);
    if (g.level === 'refuse') {
      if (!(await confirmAsync(`${file.name} is ${img.naturalWidth}×${img.naturalHeight} (${g.mp} MP). ${g.msg} Open it scaled down to fit?`, 'Scale down'))) { status('Open cancelled.'); return; }
      img = downscaleToFit(img, g.maxPixels);
    } else if (g.level === 'warn') toast(g.msg, 6000);
    if (mode === 'place' && doc()) placeImage(img, file.name.replace(/\.[^.]+$/, ''));
    else documentFromImage(img, file.name);
    status(`${mode === 'place' && doc() ? 'Placed' : 'Opened'} ${file.name} (${img.naturalWidth || img.width}×${img.naturalHeight || img.height})`);
  } catch (err) { reportError(`${file.name} could not be opened`, err); }
}
// ---------------------------------------------------------------------------
// v1.1: layered PSD / PSB import and export, camera RAW develop (decoding runs in codec-worker.js)
// ---------------------------------------------------------------------------
const OPEN_ACCEPT = ['image/*', ...PSD_EXTS.map((e) => `.${e}`), ...RAW_EXTS.map((e) => `.${e}`)].join(',');
const RAW_LAST_KEY = 'tintwork.rawLast';
const rawLastSettings = () => { try { return cleanRawSettings(JSON.parse(localStorage.getItem(RAW_LAST_KEY) || '{}')); } catch { return { ...RAW_DEFAULTS }; } };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Can this document be 16 bits/channel with `layers` full-size pixel layers? */
const deepFits = (w, h, layers = 1) => w * h * 8 * Math.max(1, layers) <= (DEEP_LIMIT_MB * 1048576) / 2;
/** Mask canvas (white, alpha = value) of size w × h at (x, y) from PSD mask data. */
function psdMaskCanvas(m, x, y, w, h) {
  const c = makeCanvas(w, h), cx = ctxOf(c), img = cx.createImageData(c.width, c.height), a = img.data, def = m.defaultColor ?? 0;
  for (let i = 0; i < a.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = 255; a[i + 3] = def; }
  if (m.data && m.width && m.height) {
    const ox = m.left - x, oy = m.top - y;
    for (let yy = Math.max(0, oy); yy < Math.min(c.height, oy + m.height); yy++) {
      for (let xx = Math.max(0, ox); xx < Math.min(c.width, ox + m.width); xx++) a[(yy * c.width + xx) * 4 + 3] = m.data[(yy - oy) * m.width + (xx - ox)];
    }
  }
  cx.putImageData(img, 0, 0);
  return { canvas: c, enabled: !m.disabled, rev: ++globalRev };
}
/** Build a document from readPSD() output. Returns the notes about what was approximated or flattened. */
function documentFromPSD(psd, name) {
  const W = psd.width, H = psd.height, notes = [...(psd.warnings || [])];
  const flat = { text: [], smart: [], fill: [], shape: [], effects: [] }, blends = [], dropped = [], approxAdj = [];
  let layers = [];
  const pixelCount = (psd.layers || []).filter((r) => r.pixels).length;
  let deep = psd.depth > 8;
  if (deep && !deepFits(W, H, Math.max(1, pixelCount))) { deep = false; notes.push(`The file is ${psd.depth} bits/channel but too large to edit at 16 bits/channel on this device; it was opened as 8-bit.`); }
  const setPixels = (l, r) => {
    const w = r.width, h = r.height;
    if (!(w && h && r.pixels)) return;
    if (psd.depth > 8) {
      const d = createDeep(w, h, r.pixels);
      if (deep) { setDeep(l, d); return; }
      ctxOf(l.canvas).putImageData(deepToImageData(d), 0, 0); return;
    }
    ctxOf(l.canvas).putImageData(new ImageData(new Uint8ClampedArray(r.pixels.buffer, r.pixels.byteOffset, w * h * 4), w, h), 0, 0);
  };
  const useful = (psd.layers || []).some((r) => (r.pixels && r.width && r.height) || r.kind === 'adjust' || r.section);
  if (useful) {
    const stack = [], top = () => stack[stack.length - 1]?.id ?? null;
    const blendOf = (key, l) => {
      const b = blendFromKey(key);
      if (b.blend === 'pass-through' && !isGroup(l)) return 'source-over';
      if (b.approx) blends.push(`${l.name} (${b.name} → ${BLEND_MODES.find((m) => m[0] === b.blend)?.[1] || b.blend})`);
      return b.blend;
    };
    for (const r of psd.layers) {
      if (r.section === 3) { // end-of-group marker: the group's contents follow, the group record closes it
        const g = createLayer('Group', 1, 1, { kind: 'group', blend: 'pass-through', collapsed: false, editMask: true, parent: top() });
        stack.push(g); continue;
      }
      if (r.section === 1 || r.section === 2) {
        const g = stack.pop() || createLayer('Group', 1, 1, { kind: 'group', blend: 'pass-through', collapsed: false, editMask: true, parent: top() });
        Object.assign(g, { name: r.name || 'Group', opacity: r.opacity, visible: r.visible, collapsed: r.section === 2 });
        g.blend = blendOf(r.sectionBlend || r.blendKey, g);
        if (r.mask && r.mask.data) g.mask = psdMaskCanvas(r.mask, 0, 0, W, H);
        if (r.clipping) g.clip = true;
        if (r.effects) flat.effects.push(g.name);
        layers.push(g); continue;
      }
      const parent = top();
      if (r.kind === 'adjust') {
        const a = decodeAdjustment(r.adjKey, r.adjData);
        if (!a) { dropped.push(`${r.name} (${PSD_ADJ_NAMES[r.adjKey] || r.adjKey})`); continue; }
        if (a.approx) approxAdj.push(r.name);
        const l = createLayer(r.name || ADJ_LAYER[a.type], 1, 1, { kind: 'adjust', adj: { type: a.type, params: a.params }, editMask: true, parent, opacity: r.opacity, visible: r.visible });
        l.blend = blendOf(r.blendKey, l);
        l.mask = r.mask && r.mask.data ? psdMaskCanvas(r.mask, 0, 0, W, H) : { canvas: makeMaskCanvas(W, H, true), enabled: true, rev: ++globalRev };
        if (r.clipping) l.clip = true;
        layers.push(l); continue;
      }
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      const l = createLayer(r.name || 'Layer', w, h, { x: r.left, y: r.top, parent, opacity: r.opacity * (r.effects ? 1 : r.fillOpacity), visible: r.visible });
      l.blend = blendOf(r.blendKey, l);
      if (r.fillOpacity < 1 && r.effects) notes.push(`${r.name}: fill opacity ${Math.round(r.fillOpacity * 100)}% was ignored (the layer has effects, which were flattened).`);
      setPixels(l, r);
      if (r.mask && r.mask.data) l.mask = psdMaskCanvas(r.mask, l.x, l.y, l.canvas.width, l.canvas.height);
      if (r.clipping) l.clip = true;
      if (flat[r.kind]) flat[r.kind].push(l.name);
      if (r.effects) flat.effects.push(l.name);
      layers.push(l);
    }
    while (stack.length) layers.push(stack.pop()); // unbalanced file: close the open groups
  }
  if (!layers.length) { // no readable layers: the flattened image
    if (!psd.composite) throw new Error('The PSD file has no readable layers and no flattened image');
    const l = createLayer('Background', W, H);
    setPixels(l, { width: W, height: H, pixels: psd.composite.data });
    layers = [l];
    if (psd.layers == null && !notes.some((t) => /flattened/i.test(t))) notes.push('Opened the flattened image (the layers could not be read).');
  }
  const d = { width: W, height: H, layers, activeId: layers[layers.length - 1].id, selection: null, name, ...(deep ? { depth: 16 } : {}), ...(psd.dpi ? { dpi: psd.dpi } : {}) };
  normalizeTree(d);
  state.doc = d;
  const list = (title, a) => (a.length ? [`${title}: ${a.slice(0, 12).join(', ')}${a.length > 12 ? `, and ${a.length - 12} more` : ''}.`] : []);
  notes.push(...list('Text layers opened as pixels (from the stored layer image)', flat.text), ...list('Smart objects opened as pixels', flat.smart),
    ...list('Fill layers opened as pixels', flat.fill), ...list('Shape / vector layers opened as pixels', flat.shape),
    ...list('Layer effects not imported (pixels only, effects dropped)', flat.effects), ...list('Blend modes approximated', blends),
    ...list('Adjustment layers with no Tintwork equivalent (left out; the layers below are unaffected)', dropped),
    ...list('Adjustments approximated (Tintwork uses its own formulas or only the master channel)', approxAdj));
  d.importNotes = notes;
  afterDocChange('Open PSD');
  return notes;
}
const PSD_ADJ_NAMES = ADJ_KEYS;
async function openPSD(file, interactive = true) {
  const t0 = performance.now(); status(`Reading ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPsdBytes(bytes)) { toast(`${file.name} is not a PSD file.`, 5000); return; }
  const psd = await readPSDAsync(bytes);
  const g = guardSize(psd.width, psd.height, Math.max(1, (psd.layers || []).filter((r) => r.pixels).length), psd.depth > 8);
  if (g.level === 'refuse') {
    if (psd.layers && psd.composite && guardSize(psd.width, psd.height, 1).level !== 'refuse') { psd.layers = null; psd.warnings.push(`Too many layers for this device's memory (${g.msg}); opened the flattened image instead.`); }
    else { toast(`${file.name}: ${g.msg}`, 6500); return; }
  } else if (g.level === 'warn') toast(g.msg, 6000);
  const notes = documentFromPSD(psd, file.name);
  const d = doc(), n = d.layers.length;
  lastImport = { kind: 'psd', ms: Math.round(performance.now() - t0), notes };
  status(`Opened ${file.name} (${d.width}×${d.height}, ${plural(n, 'layer')}, ${d.depth === 16 ? 16 : 8} bits/channel)${notes.length ? ` · ${plural(notes.length, 'note')}` : ''}`);
  if (notes.length && interactive) openInfo(`Opened ${file.name}`, `<p>Some parts of the file were converted:</p><ul class="import-notes">${notes.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`);
}
let lastImport = null;
/** Layered PSD of the open document (groups, masks, blend modes, opacity, clipping, adjustments + composite). */
async function documentToPSD(d = doc()) {
  const W = d.width, H = d.height, deep16 = d.depth === 16, warn = { styles: [], adj: [], approx: [], groupFx: [] }, out = [];
  const mask8 = (m) => { const a = ctxOf(m.canvas).getImageData(0, 0, m.canvas.width, m.canvas.height).data, o = new Uint8Array(m.canvas.width * m.canvas.height); for (let i = 0; i < o.length; i++) o[i] = a[i * 4 + 3]; return o; };
  const maskRec = (l, x, y) => (l.mask ? { top: y, left: x, width: l.mask.canvas.width, height: l.mask.canvas.height, data: mask8(l.mask), defaultColor: 0, disabled: !l.mask.enabled } : null);
  const keyOf = (b) => (BLEND_TO_PSD[b] || 'norm');
  const pixelsOf = (l, canvas) => {
    if (deep16 && !l.kind && canvas === l.canvas) return new Uint16Array(deepOf(l).data);
    const a = ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
    if (!deep16) return new Uint8Array(a.buffer);
    const o = new Uint16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * 257; return o;
  };
  const emit = (pid) => {
    for (const l of childrenOf(d, pid)) {
      const base = { name: l.name, opacity: l.opacity, visible: l.visible !== false, clipping: !!l.clip, id: l.id };
      if (isGroup(l)) {
        out.push({ name: '</Layer group>', section: 3, opacity: 1, visible: true, blendKey: 'norm' });
        emit(l.id);
        if (hasActiveStyles(l.styles)) warn.groupFx.push(l.name);
        const bk = l.blend === 'pass-through' ? 'pass' : keyOf(l.blend);
        out.push({ ...base, section: l.collapsed ? 2 : 1, blendKey: bk, sectionBlend: bk, mask: maskRec(l, l.x, l.y) });
      } else if (l.kind === 'adjust') {
        const type = l.adj.type, enc = encodeAdjustment(type, l.adj.params);
        if (!enc) { warn.adj.push(`${l.name} (${ADJ_LAYER[type] || type})`); continue; }
        if (type === 'grayscale' || type === 'brightnessContrast') warn.approx.push(l.name);
        out.push({ ...base, blendKey: keyOf(l.blend), adjKey: enc[0], adjData: enc[1], mask: maskRec(l, l.x, l.y) });
      } else {
        let canvas = l.canvas, x = l.x, y = l.y, mask = maskRec(l, l.x, l.y);
        if (hasActiveStyles(l.styles)) { // effects are baked into the pixels (the mask is applied first, as Tintwork draws it)
          const r = renderStyled(renderSource(l), l.styles);
          if (r) { canvas = r.canvas; x = l.x + r.x; y = l.y + r.y; mask = null; }
          warn.styles.push(l.name);
        }
        out.push({ ...base, blendKey: keyOf(l.blend), top: y, left: x, width: canvas.width, height: canvas.height, pixels: pixelsOf(l, canvas), mask });
      }
    }
  };
  emit(null);
  let flatData;
  if (deep16) flatData = new Uint16Array(compositeDeepDoc().data);
  else { const c = makeCanvas(W, H); composite(c, { sync: true }); flatData = new Uint8Array(ctxOf(c).getImageData(0, 0, W, H).data.buffer); c.width = 0; }
  const { bytes } = await writePSDAsync({ width: W, height: H, depth: deep16 ? 16 : 8, dpi: d.dpi || 72, layers: out, composite: flatData });
  const notes = [];
  if (warn.styles.length) notes.push(`Layer styles baked into the pixels: ${warn.styles.join(', ')}.`);
  if (warn.groupFx.length) notes.push(`Group styles left out (the composite keeps them): ${warn.groupFx.join(', ')}.`);
  if (warn.adj.length) notes.push(`Adjustment layers with no PSD equivalent left out of the layers (the composite keeps them): ${warn.adj.join(', ')}.`);
  if (warn.approx.length) notes.push(`Adjustments that other apps compute slightly differently: ${warn.approx.join(', ')}.`);
  if (d.layers.some((l) => l.kind === 'text' || l.kind === 'smart')) notes.push('Text and live-filter layers are saved as pixels.');
  return { blob: new Blob([bytes], { type: PSD_TYPE }), notes };
}
/** Flattened single-layer PSD from a canvas (batch outputs at another size). */
async function flatPSD(canvas) {
  const data = new Uint8Array(ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height).data.buffer);
  const { bytes } = await writePSDAsync({ width: canvas.width, height: canvas.height, depth: 8, layers: [{ name: 'Background', top: 0, left: 0, width: canvas.width, height: canvas.height, opacity: 1, visible: true, blendKey: 'norm', pixels: data.slice() }], composite: data });
  return new Blob([bytes], { type: PSD_TYPE });
}

// ---- camera RAW ----
let rawUI = null; // open develop dialog (tests read it through window.tintwork)
/** File → FileSystemFileHandle it was read from (picker, recent files, OS launch, drag and drop): RAW files can be linked. */
const fileHandleOf = new WeakMap();
/** In-memory link id → handle (IndexedDB keeps them across reloads, see files.js putLink). */
const linkHandles = new Map();
const RAW_LINK_KEY = 'tintwork.rawLink'; // '1' = the user last chose "Link to the file"
let relinkPicker = null; // test hook: replaces the file picker of the relink prompt
const lastRelink = { name: null, why: null, open: false, count: 0 }; // the relink prompt (tests)
let lastDecoder = null; // { threads, reason, binary, isolated } of the RAW decoder build in use
let lastDevelopProgress = null; // { halfBands } of the develop in progress (or the last one)
/** Open a camera RAW file: develop dialog (or the last settings in batch), then a 16 bits/channel document. */
async function openRAW(file, interactive = true, rawSettings = null, handle = null) {
  const t0 = performance.now(); status(`Decoding ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer()), tRead = performance.now();
  const settings = interactive ? { ...RAW_DEFAULTS } : cleanRawSettings(rawSettings || rawLastSettings());
  let sess;
  try { sess = await openRawSession(bytes, settings); }
  catch (err) { toast(`${file.name} could not be read as a camera RAW file (${err.message}).`, 7000); console.error(err); return; }
  const timing = { read: Math.round(tRead - t0), decode: sess.decodeMs, kind: 'raw', format: sess.info.format, decodeThreads: sess.info.decoder?.threads || 0 };
  lastDecoder = sess.info.decoder || null;
  try {
    if (!sess.decoded) {
      if (!sess.info.jpeg) { toast(`${file.name}: Tintwork cannot decode this ${sess.info.format} file (${sess.reason}) and it has no embedded preview.`, 8000); return; }
      await openRawJpeg(file, sess, `Tintwork cannot decode the sensor data of this ${sess.info.format} file (${sess.reason}).`, interactive);
      return;
    }
    if (!interactive) { // batch: the photo's own lens profile wins over the distortion in the chosen settings
      const k = lensDistortionFor(sess.info); if (k != null) { settings.distortion = k; timing.lensProfile = k; }
      await developToDocument(file, sess, settings, timing, t0); return;
    }
    status(`${file.name} decoded in ${(sess.decodeMs / 1000).toFixed(2)} s`);
    await rawDialog(file, sess, timing, t0, { handle });
  } finally { sess.close(); }
}
async function openRawJpeg(file, sess, why, interactive) {
  const j = await sess.jpeg();
  const blob = new Blob([j.bytes], { type: j.mimeType || 'image/jpeg' });
  let img; try { img = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { img = await loadImage(URL.createObjectURL(blob)); }
  const w = img.width, h = img.height, fit = fitPixels(w, h), l = createLayer('Camera JPEG', fit.w, fit.h);
  const cx = ctxOf(l.canvas); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, fit.w, fit.h); img.close?.();
  state.doc = { width: fit.w, height: fit.h, layers: [l], activeId: l.id, selection: null, name: file.name, rawPreview: true };
  afterDocChange('Open camera JPEG');
  const msg = `${why} Opened the camera’s embedded JPEG instead: ${fit.w}×${fit.h}, 8 bits/channel, with the camera’s own processing. RAW develop settings do not apply to it.`;
  doc().importNotes = [msg]; lastImport = { kind: 'raw-jpeg', notes: [msg] };
  status(`Opened the embedded JPEG of ${file.name} (${fit.w}×${fit.h}, 8-bit)`);
  if (interactive) openInfo('Opened the camera JPEG', `<p>${escapeHtml(msg)}</p>`); else toast(msg, 7000);
}
/**
 * Progressive placeholder over the canvas area while a RAW develops: the dialog preview at once, then the
 * half-resolution bands as the workers finish them, until the full-resolution document replaces it.
 */
function developOverlay(first) {
  const vp = $('#viewport'), box = document.createElement('div'); box.className = 'dev-overlay';
  const cv = document.createElement('canvas'); cv.setAttribute('aria-label', 'Developing preview');
  const badge = document.createElement('div'); badge.className = 'dev-badge'; badge.textContent = 'Developing full resolution…';
  box.append(cv, badge); vp.append(box);
  if (first) { cv.width = first.width; cv.height = first.height; cv.getContext('2d').drawImage(first, 0, 0); }
  let sized = false;
  return {
    band(b) {
      if (!sized) { // switch to the half-resolution frame, scaling up what is already shown
        const old = cv.width ? (() => { const c = makeCanvas(cv.width, cv.height); c.getContext('2d').drawImage(cv, 0, 0); return c; })() : null;
        cv.width = b.width; cv.height = b.height; sized = true;
        const x = cv.getContext('2d'); if (old) { x.imageSmoothingQuality = 'high'; x.drawImage(old, 0, 0, b.width, b.height); }
      }
      const rows = b.rows[1] - b.rows[0]; if (rows > 0) cv.getContext('2d').putImageData(new ImageData(b.data, b.width, rows), 0, b.rows[0]);
    },
    remove() { box.remove(); },
  };
}
async function developToDocument(file, sess, settings, timing, t0, { overlayFrom = null, remember = false, link = null } = {}) {
  const maxPixels = Math.min(MAX_PIXELS, Math.floor((DEEP_LIMIT_MB * 1048576) / 2 / 8));
  const tDev = performance.now(), ov = overlayFrom !== null ? developOverlay(overlayFrom) : null;
  let halfBands = 0, tHalfFirst = 0, tHalf = 0, bandsN = 0;
  lastDevelopProgress = { halfBands: 0, file: file.name };
  try {
    const r = await sess.develop(settings, maxPixels, ov ? (b) => { ov.band(b); lastDevelopProgress.halfBands = ++halfBands; tHalfFirst ||= performance.now(); tHalf = performance.now(); } : null);
    bandsN = r.bands || 1;
    const tBuild = performance.now();
    const l = createLayer('Background', r.width, r.height);
    ctxOf(l.canvas).putImageData(new ImageData(r.data8, r.width, r.height), 0, 0); touch(l);
    l.deep = createDeep(r.width, r.height, r.data16); l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0;
    l.raw = rawSource(file, sess.info.format, settings, r.width, r.height, l.rev);
    if (link) l.raw = { ...l.raw, file: null, ...(await linkRaw(link, file)) }; // the bytes stay on disk, not in memory
    state.doc = { width: r.width, height: r.height, layers: [l], activeId: l.id, selection: null, name: file.name, depth: 16, raw: { format: sess.info.format, settings: { ...settings } } };
    afterDocChange('Open RAW');
    if (remember) try { localStorage.setItem(RAW_LAST_KEY, JSON.stringify(settings)); } catch { /* private mode */ } // batch runs leave "last used" alone
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); // first frame on screen
    const now = performance.now();
    Object.assign(timing, { develop: Math.round(tBuild - tDev), worker: r.ms, bands: bandsN, workers: r.workers, build: Math.round(now - tBuild), total: Math.round(now - t0), width: r.width, height: r.height, mp: +(r.width * r.height / 1e6).toFixed(1) });
    if (ov) Object.assign(timing, { halfFirst: Math.round(tHalfFirst - tDev), half: halfBands ? Math.round(tHalf - tDev) : null, halfBands, full: Math.round(now - tDev) });
    lastImport = { ...timing, notes: r.scaled ? [`Developed at ${r.width}×${r.height} to fit this device's memory.`] : [] };
    if (r.scaled) toast(`Developed at ${r.width}×${r.height} to stay within this device's memory.`, 6000);
    status(`Opened ${file.name} (${sess.info.format}, ${r.width}×${r.height}, 16 bits/channel) in ${(timing.total / 1000).toFixed(1)} s`);
  } finally { ov?.remove(); }
}
/**
 * RAW source of a developed layer: the original file (a Blob, so it costs no memory for files from disk), the develop
 * settings, and the crop window into the developed frame (cx, cy, cw × ch). `rev` is the layer revision the pixels
 * match: when the layer is painted or transformed afterwards, re-developing asks before replacing those edits.
 */
function rawSource(file, format, settings, width, height, rev, about = null) {
  const f = file || about || {};
  return { file, name: f.name, size: f.size, type: f.type || '', format, settings: cleanRawSettings(settings), width, height, m: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, cx: 0, cy: 0, cw: width, ch: height, rev };
}
/** Link a RAW layer to its file on disk: the handle goes to IndexedDB (and memory) under a new link id. */
async function linkRaw(handle, file) {
  const id = newLinkId(), link = { id, name: file.name, size: file.size, lastModified: file.lastModified || 0 };
  linkHandles.set(id, handle);
  try { await putLink(id, handle, link); } catch (err) { console.warn('The file link could not be stored', err); }
  return { link, handle };
}
/**
 * The RAW file of a layer, as a File. Embedded: the stored copy. Linked: read through the file handle (asking for
 * permission if needed); when the handle is gone, the file was moved or deleted, or access is refused, the relink
 * prompt asks the user to locate it. Returns null when the user cancels.
 */
async function rawFileOf(l) {
  const raw = l.raw;
  if (!raw.link) return raw.file || null;
  const id = raw.link.id;
  let h = linkHandles.get(id) || raw.handle || null, why = 'missing';
  if (!h) { const rec = await getLink(id); h = rec?.handle || null; if (h) linkHandles.set(id, h); }
  if (h) {
    try {
      if (!(await ensurePermission(h, 'read'))) why = 'permission';
      else {
        const f = await h.getFile();
        if (raw.link.size && f.size !== raw.link.size && !(await confirmAsync(`${f.name} has changed since it was developed (${fmtBytes(raw.link.size)} then, ${fmtBytes(f.size)} now). Re-develop from the file as it is now?`, 'Re-develop'))) return null;
        return f;
      }
    } catch (err) { why = err?.name === 'NotFoundError' ? 'moved' : 'unreadable'; console.warn('linked RAW', err); }
  }
  return relinkPrompt(l, why, h);
}
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** "Locate the linked file" prompt. Resolves to the chosen File (the link now points to it) or null. */
function relinkPrompt(l, why, oldHandle) {
  const raw = l.raw, name = raw.link.name || raw.name;
  const reason = { missing: 'Tintwork has no access to it in this browser (the project may have been made on another computer or in another browser).',
    moved: 'it was moved, renamed or deleted.', permission: 'access to it was not allowed.', unreadable: 'it could not be read.' }[why] || '';
  const canAsk = why === 'permission' && oldHandle;
  return new Promise((resolve) => {
    const body = document.createElement('div'); body.className = 'relink';
    body.innerHTML = `<p>This layer is linked to the camera RAW file <b>${escapeHtml(name)}</b>${raw.link.size ? ` (${fmtBytes(raw.link.size)})` : ''}, but ${escapeHtml(reason)}</p>
      <p>${canAsk ? 'Allow access again, or locate the file' : 'Locate the file'} to re-develop the layer. The layer itself is not affected.</p>${!fsaSupported && !relinkPicker ? '<p class="muted small">Locating files needs Chrome or Edge.</p>' : ''}
      ${canAsk ? '<p><button type="button" id="relinkOther">Locate a different file…</button></p>' : ''}`;
    let done = false, busyRelink = false;
    const finish = (v) => { if (!done) { done = true; lastRelink.open = false; resolve(v); } };
    const locate = async () => {
      let h;
      try { h = relinkPicker ? await relinkPicker() : await pickRaw(); } catch (err) { toast(`The file could not be chosen (${err.message}).`, 6000); return finish(null); }
      if (!h) { status('Relink cancelled.'); return finish(null); }
      let f; try { f = await h.getFile(); } catch (err) { toast(`${h.name} could not be read (${err.message}).`, 6000); return finish(null); }
      if (f.name.toLowerCase() !== String(name).toLowerCase() && !(await confirmAsync(`You chose ${f.name}, but the layer was developed from ${name}. Use ${f.name} anyway?`, 'Use it'))) return finish(null);
      if (raw.link.size && f.size !== raw.link.size && !(await confirmAsync(`${f.name} is ${fmtBytes(f.size)}; the file the layer was developed from was ${fmtBytes(raw.link.size)}. It may be a different photo. Use it anyway?`, 'Use it'))) return finish(null);
      linkHandles.set(raw.link.id, h);
      try { await putLink(raw.link.id, h, { ...raw.link, name: f.name, size: f.size, lastModified: f.lastModified || 0 }); } catch { /* memory only */ }
      status(`Relinked ${name} to ${f.name}.`);
      finish(f);
    };
    showModal({
      title: 'Linked RAW file not found', body, okLabel: canAsk ? 'Allow access' : 'Locate file…',
      ok: () => {
        busyRelink = true;
        if (canAsk) { ensurePermission(oldHandle, 'read').then(async (ok) => { if (!ok) { toast('Access was not allowed.'); return finish(null); } try { finish(await oldHandle.getFile()); } catch { finish(null); } }); return; }
        locate(); // runs inside the click, so the file picker may open
      },
      onClose: () => setTimeout(() => { if (!done && !busyRelink) finish(null); }, 0),
    });
    body.querySelector('#relinkOther')?.addEventListener('click', () => { busyRelink = true; closeModal(); locate(); });
    Object.assign(lastRelink, { name, why, open: true, count: lastRelink.count + 1 });
  });
}
/** Layer ▸ Re-develop RAW… (or double-click a RAW layer): reopen the develop dialog with the layer's settings. */
async function redevelopRaw(l = activeLayer()) {
  if (!l?.raw) { status('This layer was not developed from a RAW file in Tintwork, so it has no RAW settings to re-open.'); return; }
  const id = l.id, d = doc();
  if (l.raw.untracked || l.canvas.width !== l.raw.cw || l.canvas.height !== l.raw.ch) {
    toast(`This layer was changed in a way Tintwork cannot follow (${l.raw.untracked || 'its size changed outside crop, resize, rotate, flip, straighten and free transform'}), so it cannot be re-developed in place. Open ${l.raw.name} again to develop it as a new image.`, 8000); return;
  }
  if (l.rev !== l.raw.rev && !(await confirmAsync('This layer was edited after it was developed (painting, filters or other pixel changes). Re-developing replaces those edits with a fresh develop of the RAW file. Continue?', 'Re-develop'))) return;
  const file = await rawFileOf(l); if (!file) return;
  const raw = l.raw, t0 = performance.now(); status(`Decoding ${raw.name}…`);
  let sess;
  try { sess = await openRawSession(new Uint8Array(await file.arrayBuffer()), raw.settings); }
  catch (err) {
    if (raw.link && err?.name === 'NotReadableError') { toast(`${raw.name} changed on disk while it was open; try again.`, 7000); linkHandles.delete(raw.link.id); return; }
    toast(`${raw.name} could not be read again (${err.message}).`, 7000); return;
  }
  try {
    if (!sess.decoded) { toast(`${raw.name} cannot be decoded here (${sess.reason}).`, 7000); return; }
    const timing = { decode: sess.decodeMs, kind: 'raw-redevelop', format: sess.info.format };
    status(`${raw.name} decoded in ${(sess.decodeMs / 1000).toFixed(2)} s`);
    await rawDialog({ name: raw.name }, sess, timing, t0, {
      initial: raw.settings, title: `Re-develop ${raw.name}`, okLabel: 'Apply', linked: !!raw.link,
      onApply: async (settings) => {
        if (doc() !== d) { toast('The document changed tabs; re-develop cancelled.'); return; }
        await applyRedevelop(id, sess, settings, timing, t0);
      },
    });
  } finally { sess.close(); }
}
const isIdentityMap = (m) => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
async function applyRedevelop(id, sess, settings, timing, t0) {
  const d = doc(), l = d.layers.find((x) => x.id === id); if (!l?.raw) return;
  const raw = l.raw, maxPixels = Math.min(MAX_PIXELS, Math.floor((DEEP_LIMIT_MB * 1048576) / 2 / 8)), m = rawMapOf(raw);
  const plain = isIdentityMap(m) && raw.cw === raw.width && raw.ch === raw.height;
  setBusy(1); status(`Re-developing ${raw.name}…`);
  try {
    // the develop is resampled in the worker into the layer as it is now (crop, size, rotation, flips, transforms)
    const tDev = performance.now(), r = await sess.develop(settings, maxPixels, null, plain ? null : { m, w: raw.cw, h: raw.ch, fullW: raw.width, fullH: raw.height });
    const dev = r.developed || [r.width, r.height];
    if (dev[0] !== raw.width || dev[1] !== raw.height) throw new Error(`the develop came out at ${dev[0]}×${dev[1]} instead of ${raw.width}×${raw.height}`);
    const c = makeCanvas(raw.cw, raw.ch);
    c.getContext('2d').putImageData(new ImageData(r.data8, r.width, r.height), 0, 0);
    l.canvas = c; touch(l);
    if (d.depth === 16) { l.deep = createDeep(r.width, r.height, r.data16); l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0; }
    else { l.deep = null; }
    l.raw = { ...raw, settings: cleanRawSettings(settings), rev: l.rev };
    if (d.raw) d.raw = { ...d.raw, settings: { ...l.raw.settings } };
    compDirty = true; requestRender(); commit('Re-develop RAW');
    const now = performance.now();
    lastImport = { ...timing, develop: Math.round(now - tDev), total: Math.round(now - t0), workers: r.workers, bands: r.bands, width: r.width, height: r.height, xformMs: r.ms?.xform ?? null, notes: [] };
    status(`Re-developed ${raw.name} (${raw.cw}×${raw.ch}${plain ? '' : `, fitted to the layer from ${raw.width}×${raw.height}`}) in ${((now - tDev) / 1000).toFixed(1)} s`);
  } catch (err) { reportError(`${raw.name} could not be re-developed`, err); }
  finally { setBusy(-1); }
}
/** Layer ▸ Embed linked RAW file: copy the linked file into the project so it no longer depends on the file on disk. */
async function embedLinkedRaw(l = activeLayer()) {
  if (!l?.raw?.link) { status('This layer has no linked RAW file.'); return false; }
  const f = await rawFileOf(l); if (!f) return false;
  const file = new File([await f.arrayBuffer()], f.name, { type: f.type || '' });
  const same = l.raw.rev === l.rev, { link, handle, ...rest } = l.raw; // eslint-disable-line no-unused-vars
  l.raw = { ...rest, file, size: file.size }; touch(l); if (same) l.raw.rev = l.rev;
  commit('Embed RAW file'); updateLayersPanel(); status(`${file.name} is now embedded in the project (${fmtBytes(file.size)}).`);
  return true;
}
const TEMP_MIN = 2000, TEMP_MAX = 50000;
const tempToPos = (T) => Math.round(((500 - 1e6 / Math.min(TEMP_MAX, Math.max(TEMP_MIN, T))) / 480) * 1000); // mired scale: even steps for the eye
const posToTemp = (p) => Math.round(1e6 / (500 - (p / 1000) * 480) / 10) * 10;
/** Develop settings presets (localStorage). */
const RAW_PRESETS_KEY = 'tintwork.rawPresets';
function rawPresets() {
  try { const a = JSON.parse(localStorage.getItem(RAW_PRESETS_KEY) || '[]'); return Array.isArray(a) ? a.filter((p) => p && typeof p.name === 'string' && p.name.trim()).map((p) => ({ name: p.name.trim(), settings: cleanRawSettings(p.settings) })) : []; }
  catch { return []; }
}
function saveRawPreset(name, settings) {
  name = String(name || '').trim().slice(0, 60); if (!name) return false;
  const list = rawPresets().filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  list.push({ name, settings: cleanRawSettings(settings) }); list.sort((a, b) => a.name.localeCompare(b.name));
  try { localStorage.setItem(RAW_PRESETS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
function deleteRawPreset(name) {
  const list = rawPresets().filter((p) => p.name !== name);
  try { localStorage.setItem(RAW_PRESETS_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
/** Merge presets (from a file) into the saved list; same names (case-insensitive) are replaced. Returns the count. */
function importRawPresets(list) {
  const keep = rawPresets().filter((p) => !list.some((q) => q.name.toLowerCase() === p.name.toLowerCase()));
  const all = [...keep, ...list.map((p) => ({ name: p.name, settings: cleanRawSettings(p.settings) }))].sort((a, b) => a.name.localeCompare(b.name));
  localStorage.setItem(RAW_PRESETS_KEY, JSON.stringify(all));
  return list.length;
}
function exportRawPresets(only = null) {
  const list = only ? rawPresets().filter((p) => p.name === only) : rawPresets();
  if (!list.length) { toast('There are no saved presets to export yet. Save one first.'); return false; }
  const name = only ? `${only.replace(/[\\/:*?"<>|]+/g, '_')}.json` : 'tintwork-develop-presets.json';
  download(new Blob([JSON.stringify(rawPresetFile(list), null, 2)], { type: 'application/json' }), name);
  status(`Exported ${list.length} develop preset${list.length === 1 ? '' : 's'} to ${name}`);
  return true;
}
/**
 * User lens profiles (localStorage): lens name → [{ focal (mm, 0 = unknown), k (Distortion slider value) }].
 * Made by the user with "Save for this lens" — no third-party lens database is shipped or copied.
 */
const LENS_PROFILES_KEY = 'tintwork.lensProfiles';
const lensKeyOf = (info) => (info?.lensModel ? String(info.lensModel).trim() : info?.camera ? `${info.camera} (built-in or unrecorded lens)` : null) || null;
function lensProfiles() {
  try { const o = JSON.parse(localStorage.getItem(LENS_PROFILES_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
function saveLensProfile(key, focal, k) {
  const all = lensProfiles(), f = Number.isFinite(+focal) ? Math.round(+focal * 10) / 10 : 0;
  const list = (Array.isArray(all[key]) ? all[key] : []).filter((p) => Math.abs((+p.focal || 0) - f) > 0.5);
  list.push({ focal: f, k: Math.max(-100, Math.min(100, +k || 0)) }); list.sort((a, b) => a.focal - b.focal);
  all[key] = list; try { localStorage.setItem(LENS_PROFILES_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}
function forgetLensProfile(key) { const all = lensProfiles(); delete all[key]; try { localStorage.setItem(LENS_PROFILES_KEY, JSON.stringify(all)); } catch { /* private mode */ } }
/** Distortion from the user's profile for the lens of a decoded file, or null. */
const lensDistortionFor = (info) => { const key = lensKeyOf(info); return key ? profileDistortion(lensProfiles()[key], info.focal) : null; };
const hasRawLast = () => { try { return !!localStorage.getItem(RAW_LAST_KEY); } catch { return false; } };
/** Settings for a batch / preset choice: 'last', 'default' or 'preset:<name>'. */
function rawSettingsFor(choice) {
  if (choice === 'default') return { ...RAW_DEFAULTS };
  if (choice?.startsWith('preset:')) { const p = rawPresets().find((q) => q.name === choice.slice(7)); if (p) return { ...p.settings }; }
  return rawLastSettings();
}
const rawPresetOptions = (withNone) => `${withNone ? '<option value="">Choose…</option>' : ''}${hasRawLast() ? '<option value="last">Last used settings</option>' : ''}<option value="default">Default settings</option>${rawPresets().map((p) => `<option value="preset:${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('')}`;
/** Local adjustment sliders: key, label, min, max, step, tooltip. */
const LOCAL_SLIDERS = [
  ['exposure', 'Exposure (EV)', -4, 4, 0.05], ['contrast', 'Contrast', -100, 100, 1], ['highlights', 'Highlights', -100, 100, 1, 'Pull down (−) or brighten (+) the bright tones'],
  ['shadows', 'Shadows', -100, 100, 1, 'Lift (+) or deepen (−) the dark tones'], ['whites', 'Whites', -100, 100, 1, 'Brighten (+) or hold back (−) the brightest tones'],
  ['blacks', 'Blacks', -100, 100, 1, 'Lift (+) or deepen (−) the darkest tones'], ['dehaze', 'Dehaze', -100, 100, 1, 'Cut through haze and mist (+), or add a soft haze (−)'],
  ['temp', 'Temperature', -100, 100, 1], ['tint', 'Tint', -100, 100, 1, 'Green (−) or magenta (+)'],
  ['saturation', 'Saturation', -100, 100, 1], ['hue', 'Hue shift (°)', -180, 180, 1, 'Turn the colours inside the mask around the colour wheel, keeping their brightness'], ['clarity', 'Clarity', -100, 100, 1, 'Mid-size local contrast (about 12 px at full size): adds punch, or softens with negative values'],
  ['texture', 'Texture', -100, 100, 1, 'Fine detail such as skin, foliage or fabric (about 3 px); negative values smooth it'], ['sharpness', 'Sharpness', -100, 100, 1, 'Edge sharpening (+) or a slight blur (−)'],
  ['noise', 'Noise reduction', 0, 100, 1, 'Extra luminance noise reduction inside the mask'], ['feather', 'Feather', 0, 100, 1],
];
const RAW_BRUSH_KEY = 'tintwork.rawBrush';
const DEV_ENGINE_NAMES = { cpu: 'CPU', webgpu: 'WebGPU', webgl2: 'WebGL2' };
const DRAFT_OVER_MS = 45, DRAFT_SETTLE_MS = 180;
const LIVE_PAINT_MS = 16; // at most one preview request per frame while a brush stroke is in progress
const rawBrushPrefs = () => { const d = { size: 5, feather: 50, flow: 100, smooth: 50, auto: false }; try { return { ...d, ...JSON.parse(localStorage.getItem(RAW_BRUSH_KEY) || '{}') }; } catch { return d; } };
/**
 * RAW develop dialog. opt (re-develop): { initial: settings to start from (also the "before" view), title, okLabel,
 * onApply(settings) } — without opt, Open develops the file into a new document.
 */
function rawDialog(file, sess, timing, t0, opt = {}) {
  return new Promise((resolve) => {
    const info = sess.info, s = opt.initial ? { ...cleanRawSettings(opt.initial) } : { ...RAW_DEFAULTS, temp: info.asShot.temp, tint: info.asShot.tint };
    const lensKey = lensKeyOf(info), lensProf = () => (lensKey ? profileDistortion(lensProfiles()[lensKey], info.focal) : null);
    let lensFromProfile = false;
    const applyLensProfile = () => { const k = lensProf(); lensFromProfile = k != null; if (lensFromProfile) s.distortion = k; };
    if (!opt.initial) applyLensProfile();
    let localSel = -1, picking = false, showGrid = false;
    const beforeSettings = opt.initial ? { ...s } : { ...RAW_DEFAULTS };
    const body = document.createElement('div'); body.className = 'raw-dev';
    const slider = (key, label, min, max, step, val, title = '') =>
      `<label class="field"${title ? ` title="${escapeHtml(title)}"` : ''}><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${label}" /><output data-o="${key}">${fmtK(key, val)}</output></label>`;
    const fmtK = (k, v) => (k === 'exposure' ? `${v > 0 ? '+' : ''}${(+v).toFixed(2)}` : k === 'sharpRadius' ? (+v).toFixed(1) : v);
    const beforeWhat = opt.initial ? 'the settings it was developed with' : 'the default settings';
    body.innerHTML = `<div class="raw-view"><div class="raw-canvas-wrap" id="rawWrap"><canvas id="rawCanvas" aria-label="Develop preview"></canvas><canvas id="rawOverlay" class="raw-overlay" aria-hidden="true"></canvas><span class="raw-ba hidden" id="rawBaTag">Before</span><span class="raw-ba raw-ba-r hidden" id="rawAfterTag">After</span>
          <div class="raw-split hidden" id="rawSplit" role="slider" tabindex="0" aria-label="Before / after divider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" title="Drag to compare before (left) and after (right)"><span class="raw-split-grip"></span></div></div>
        <div class="raw-viewbar"><span class="raw-meta muted small">${escapeHtml(info.describe || info.format)}</span><span class="spacer"></span><button type="button" id="rawSplitBtn" aria-pressed="false" title="Split view: click to cycle left/right then top/bottom (Y key); drag the divider">Split</button><button type="button" id="rawBefore" aria-pressed="false" title="Show the image with ${beforeWhat} (\\ key)">Before / after</button></div></div>
      <div class="raw-controls">
        <div class="raw-sec">Presets</div>
        <label class="field two"><span>Apply</span><select id="rawPreset" aria-label="Apply develop preset">${rawPresetOptions(true)}</select></label>
        <div class="raw-preset-save"><input type="text" id="rawPresetName" placeholder="Preset name" aria-label="Preset name" maxlength="60" /><button type="button" id="rawPresetSave">Save preset</button><button type="button" id="rawPresetDel" title="Delete the chosen preset" disabled>Delete</button></div>
        <div class="raw-preset-save"><button type="button" id="rawPresetExport" title="Save your presets to a .json file to back them up or use them on another computer">Export presets…</button><button type="button" id="rawPresetImport" title="Add presets from a .json file (presets with the same name are replaced)">Import presets…</button><input type="file" id="rawPresetFile" accept=".json,application/json" class="hidden" /></div>
        <div class="raw-sec">White balance</div>
        <label class="field two"><span>Preset</span><select id="rawWb"><option value="as-shot">As shot</option><option value="auto">Auto</option><option value="custom">Custom</option></select></label>
        <label class="field"><span>Temperature</span><input type="range" id="rawTempR" min="0" max="1000" step="1" value="${tempToPos(s.temp)}" aria-label="Temperature" /><input type="number" id="rawTemp" min="${TEMP_MIN}" max="${TEMP_MAX}" step="50" value="${s.temp}" aria-label="Temperature in kelvin" /></label>
        ${slider('tint', 'Tint', -150, 150, 1, s.tint)}
        <div class="raw-sec">Tone</div>
        ${slider('exposure', 'Exposure (EV)', -5, 5, 0.05, s.exposure)}
        ${slider('highlights', 'Highlight recovery', 0, 100, 1, s.highlights)}
        ${slider('shadows', 'Shadows', -100, 100, 1, s.shadows)}
        ${slider('contrast', 'Contrast', -100, 100, 1, s.contrast)}
        <details class="raw-curve" id="rawCurveBox"><summary>Tone curve <span class="muted small" id="rawCurveState">straight</span></summary><div id="rawCurveHost"></div></details>
        <div class="raw-sec">Color</div>
        ${slider('vibrance', 'Vibrance', -100, 100, 1, s.vibrance, 'Boosts muted colours more than ones that are already strong')}
        ${slider('saturation', 'Saturation', -100, 100, 1, s.saturation)}
        <div class="raw-sec">Sharpening</div>
        ${slider('sharpen', 'Amount', 0, 150, 1, s.sharpen)}
        ${slider('sharpRadius', 'Radius', 0.5, 3, 0.1, s.sharpRadius, 'Size of the edges that are sharpened, in pixels')}
        ${slider('sharpDetail', 'Detail', 0, 100, 1, s.sharpDetail, 'Low values hold back halos on strong edges; high values sharpen fine texture fully')}
        ${slider('sharpMask', 'Masking', 0, 100, 1, s.sharpMask, 'Higher values sharpen only edges and leave smooth areas such as skin and sky alone')}
        <div class="raw-sec">Noise reduction</div>
        ${slider('nrLuma', 'Luminance', 0, 100, 1, s.nrLuma)}
        ${slider('nrColor', 'Color', 0, 100, 1, s.nrColor)}
        <div class="raw-sec">Lens</div>
        <label class="field two"><span>Corrections</span><span><input type="checkbox" id="rawLens" ${info.lens ? 'checked' : 'disabled'} /> <span class="muted small">${info.lens ? `From the file: ${[info.lens.distortion && 'distortion', info.lens.vignette && 'vignetting'].filter(Boolean).join(' and ')}` : 'No lens correction data in this file'}</span></span></label>
        <label class="field two"><span>Lens</span><span class="muted small" id="rawLensName">${escapeHtml(info.lensModel || (info.camera ? `${info.camera} (lens not recorded)` : 'Not recorded in the file'))}${info.focal ? ` · ${+info.focal.toFixed(1)} mm` : ''}</span></label>
        ${slider('distortion', 'Distortion', -100, 100, 1, s.distortion, 'Positive values straighten lines that bow outward (barrel distortion, common at wide angles); negative values straighten lines that bow inward (pincushion, common at long zoom settings)')}
        <label class="field two"><span>Grid</span><span><input type="checkbox" id="rawGrid" /> <span class="muted small">Show a grid to line up straight edges (G)</span></span></label>
        <div class="raw-preset-save"><button type="button" id="rawLensSave" ${lensKey ? '' : 'disabled'} title="${lensKey ? `Remember this distortion for ${escapeHtml(lensKey)} at ${info.focal ? `${+info.focal.toFixed(1)} mm` : 'this focal length'}: it is applied to new photos from this lens (between saved focal lengths it is interpolated)` : 'The file does not say which lens was used'}">Save for this lens</button><button type="button" id="rawLensForget" title="Forget the saved distortion for this lens" ${lensProf() != null ? '' : 'disabled'}>Forget</button></div>
        <p class="muted small" id="rawLensProf"></p>
        ${slider('vignette', 'Vignette fix', -100, 100, 1, s.vignette)}
        <label class="field two"><span>Color fringes</span><span><input type="checkbox" id="rawCaAuto" /> <span class="muted small">Remove chromatic aberration (automatic)</span> <span class="muted small" id="rawCaEst"></span></span></label>
        ${slider('caRed', 'Red / cyan', -100, 100, 1, s.caRed, 'Scales the red channel against green: removes red or cyan edges toward the corners')}
        ${slider('caBlue', 'Blue / yellow', -100, 100, 1, s.caBlue, 'Scales the blue channel against green: removes blue or yellow edges toward the corners')}
        <div class="raw-sec">Defringe</div>
        ${slider('fringePurple', 'Purple amount', 0, 100, 1, s.fringePurple, 'Removes purple or magenta fringes along high-contrast edges (axial chromatic aberration), anywhere in the frame')}
        ${slider('fringePurpleLo', 'Purple hue from', 200, 340, 1, s.fringePurpleLo, 'Hue range treated as purple fringe, in degrees')}
        ${slider('fringePurpleHi', 'Purple hue to', 200, 340, 1, s.fringePurpleHi, 'Hue range treated as purple fringe, in degrees')}
        ${slider('fringeGreen', 'Green amount', 0, 100, 1, s.fringeGreen, 'Removes green fringes along high-contrast edges (often behind the focus plane)')}
        ${slider('fringeGreenLo', 'Green hue from', 40, 190, 1, s.fringeGreenLo, 'Hue range treated as green fringe, in degrees')}
        ${slider('fringeGreenHi', 'Green hue to', 40, 190, 1, s.fringeGreenHi, 'Hue range treated as green fringe, in degrees')}
        <div class="raw-preset-save"><button type="button" id="rawFringePick" aria-pressed="false" title="Then click a coloured fringe in the preview: its hue range and amount are set for you (I)">Pick fringe colour</button><label class="raw-check"><input type="checkbox" id="rawFringeMask" /> Show affected areas</label></div>
        <div class="raw-sec">Local adjustments</div>
        <div class="raw-preset-save"><button type="button" id="rawAddLinear" title="A graduated filter: full effect on one side of a line, fading out to the other (for skies and foregrounds)">Add graduated</button><button type="button" id="rawAddRadial" title="A radial filter: an ellipse with a soft edge, affecting its inside or outside">Add radial</button><button type="button" id="rawAddBrush" title="A brush mask: paint where the adjustment applies (hold Alt to erase)">Add brush</button></div>
        <div id="rawMaskList" class="raw-masks" role="listbox" aria-label="Masks"></div>
        <div class="raw-preset-save" id="rawMaskActs"><button type="button" id="rawMaskRename" title="Rename the selected mask (or double-click it)">Rename</button><button type="button" id="rawMaskDup" title="Copy the selected mask with its settings">Duplicate</button><button type="button" id="rawMaskInv" aria-pressed="false" title="Apply the adjustment everywhere except the mask">Invert</button><button type="button" id="rawLocalDel" title="Delete the selected mask (Delete key)">Delete</button></div>
        <label class="raw-check" title="Tint the area the selected mask affects red (O)"><input type="checkbox" id="rawMaskOv" /> Show mask overlay (O)</label>
        <div id="rawLocalBox" class="hidden">
          ${LOCAL_SLIDERS.map(([k, label, lo, hi, st, tip]) => `<label class="field" data-lrow="${k}"${tip ? ` title="${escapeHtml(tip)}"` : ''}><span>${label}</span><input type="range" data-l="${k}" min="${lo}" max="${hi}" step="${st}" value="0" aria-label="Local ${label}" /><output data-lo="${k}">0</output></label>`).join('')}
          <div class="raw-sub">Shapes <span class="muted small">(combine shapes: add, subtract or intersect)</span></div>
          <div id="rawParts" class="raw-parts" role="listbox" aria-label="Mask shapes"></div>
          <div class="raw-preset-save"><button type="button" id="rawPartLinear" title="Add a graduated shape to this mask (it subtracts at first: change it to add or intersect)">+ Graduated</button><button type="button" id="rawPartRadial" title="Add a radial shape to this mask (it subtracts at first: change it to add or intersect)">+ Radial</button></div>
          <div id="rawBrushBox"><div class="raw-sub">Brush <span class="muted small">(adds to the mask; Alt erases)</span></div>
          <div class="raw-preset-save"><button type="button" id="rawBrushBtn" aria-pressed="false" title="Paint the mask with the mouse; hold Alt to erase (B)">Paint</button><button type="button" id="rawEraseBtn" aria-pressed="false" title="Erase from the mask (or hold Alt while painting)">Erase</button><button type="button" id="rawBrushClear" title="Remove every brush stroke from this mask">Clear strokes</button></div>
          ${[['size', 'Size', 0.5, 30, 0.5, 'Brush radius as a share of the long side of the photo ([ and ] keys)'], ['feather', 'Feather', 0, 100, 1, 'How soft the brush edge is'], ['flow', 'Flow', 5, 100, 1, 'How much each stroke adds; overlapping strokes build up'], ['smooth', 'Smoothing', 0, 100, 1, 'Steadies mouse strokes (the brush trails the pointer a little)']].map(([k, label, lo, hi, st, tip]) => `<label class="field" title="${escapeHtml(tip)}"><span>${label}</span><input type="range" data-b="${k}" min="${lo}" max="${hi}" step="${st}" value="0" aria-label="Brush ${label}" /><output data-bo="${k}">0</output></label>`).join('')}
          <label class="raw-check" title="Paint stays on areas with a colour and brightness like the spot under the brush, and stops at edges"><input type="checkbox" id="rawAutoMask" /> Auto mask (stop at edges)</label></div>
          <div class="raw-sub">Range masks <span class="muted small">(narrow the mask down)</span></div>
          <div class="raw-preset-save"><label class="raw-check"><input type="checkbox" id="rawLumOn" /> Luminance range</label><button type="button" id="rawLumPick" title="Click a tone in the preview to centre the range on it">Pick</button></div>
          ${[['lumLo', 'From', 0, 100], ['lumHi', 'To', 0, 100], ['lumSoft', 'Smoothness', 0, 50]].map(([k, label, lo, hi]) => `<label class="field" data-rrow="lum"><span>${label}</span><input type="range" data-r="${k}" min="${lo}" max="${hi}" step="1" value="0" aria-label="Luminance ${label}" /><output data-ro="${k}">0</output></label>`).join('')}
          <div class="raw-preset-save"><label class="raw-check"><input type="checkbox" id="rawColOn" /> Color range</label><button type="button" id="rawColPick" title="Click a colour in the preview to select similar colours">Pick</button></div>
          ${[['colHue', 'Hue', 0, 359], ['colRange', 'Range', 2, 90], ['colSoft', 'Smoothness', 0, 90]].map(([k, label, lo, hi]) => `<label class="field" data-rrow="color"><span>${label}</span><input type="range" data-r="${k}" min="${lo}" max="${hi}" step="1" value="0" aria-label="Color ${label}" /><output data-ro="${k}">0</output></label>`).join('')}
          <p class="muted small" id="rawMaskHint">Drag the handles in the preview.</p>
        </div>
        ${opt.onApply ? `<p class="muted small" id="rawSrcNote">RAW file: ${opt.linked ? 'linked to the file on disk' : 'embedded in the project'}.</p>` : `<label class="field two" title="Embed keeps a copy of the RAW file inside the project (the project is self-contained but larger). Link keeps only a reference to the file on this computer (small projects; the file must stay where it is).">
          <span>RAW file</span><select id="rawStore" aria-label="RAW file in the project"><option value="embed">Embed in the project</option><option value="link" ${opt.handle ? '' : 'disabled'}>Link to the file on disk</option></select></label>${opt.handle ? '' : '<p class="muted small" id="rawStoreNote">Linking needs Chrome or Edge and a file opened with File ▸ Open, from recent files or by drag and drop.</p>'}`}
        <p class="muted small" id="rawOut">Opens as ${info.width} × ${info.height} px, 16 bits/channel.${info.knownCamera ? '' : ' Camera colour data unknown: colours are approximate.'}${info.incomplete ? ' Some sensor data was missing and is shown black.' : ''}</p>
        <div class="raw-buttons"><button type="button" id="rawReset">Reset</button>${info.jpeg && !opt.onApply ? `<button type="button" id="rawJpeg" title="Open the camera's own ${info.jpeg.width}×${info.jpeg.height} JPEG rendering instead (8-bit)">Use camera JPEG</button>` : ''}<span class="muted small" id="rawMs"></span></div>
      </div>`;
    const cv = body.querySelector('#rawCanvas'), $q = (sel) => body.querySelector(sel);
    // view: 'after' (current settings), 'before' (beforeSettings) or 'split' (before left of the divider, after right)
    let last = null, before = null, view = 'after', splitF = 0.5, lastImg = null, beforeImg = null;
    const imgOf = (p) => { const im = new ImageData(p.data, p.width, p.height); if (p.draft) im.draft = true; return im; };
    let scratch = null;
    const paintImg = (img) => {
      if (img.draft && cv.width > img.width && Math.abs(cv.width / cv.height - img.width / img.height) < 0.02) { // a live draft: scaled up into the full-size canvas
        scratch ||= document.createElement('canvas'); scratch.width = img.width; scratch.height = img.height; scratch.getContext('2d').putImageData(img, 0, 0);
        const g = cv.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'low'; g.drawImage(scratch, 0, 0, cv.width, cv.height); return;
      }
      if (cv.width !== img.width || cv.height !== img.height) { cv.width = img.width; cv.height = img.height; }
      cv.getContext('2d').putImageData(img, 0, 0);
    };
    const paint = (p) => paintImg(imgOf(p));
    const wrap = $q('#rawWrap'), divider = $q('#rawSplit');
    const contentRect = () => { // the canvas uses object-fit: contain
      const W = cv.clientWidth, H = cv.clientHeight, k = Math.min(W / (cv.width || 1), H / (cv.height || 1));
      const w = cv.width * k, h = cv.height * k; return { x: cv.offsetLeft + (W - w) / 2, y: cv.offsetTop + (H - h) / 2, w, h };
    };
    const placeDivider = () => {
      const on = view === 'split' || view === 'splitH';
      divider.classList.toggle('hidden', !on);
      divider.classList.toggle('horiz', view === 'splitH');
      $q('#rawAfterTag').classList.toggle('hidden', !on);
      $q('#rawBaTag').classList.toggle('hidden', view === 'after');
      if (!on) return;
      const r = contentRect();
      if (view === 'splitH') {
        divider.style.left = `${r.x}px`; divider.style.top = `${r.y + r.h * splitF}px`;
        divider.style.width = `${r.w}px`; divider.style.height = '0';
        divider.setAttribute('aria-orientation', 'horizontal');
        divider.title = 'Drag to compare before (top) and after (bottom)';
      } else {
        divider.style.left = `${r.x + r.w * splitF}px`; divider.style.top = `${r.y}px`;
        divider.style.width = ''; divider.style.height = `${r.h}px`;
        divider.setAttribute('aria-orientation', 'vertical');
        divider.title = 'Drag to compare before (left) and after (right)';
      }
      divider.setAttribute('aria-valuenow', String(Math.round(splitF * 100)));
    };
    const compose = () => { // synchronous: used while dragging
      if (view === 'after' || !beforeImg) { if (lastImg) paintImg(lastImg); }
      else if (view === 'before') paintImg(beforeImg);
      else if (lastImg) {
        paintImg(lastImg);
        if (beforeImg.width === cv.width && beforeImg.height === cv.height) {
          const g = cv.getContext('2d');
          if (view === 'splitH') {
            const sy = Math.round(splitF * cv.height); if (sy > 0) g.putImageData(beforeImg, 0, 0, 0, 0, cv.width, sy);
          } else {
            const sx = Math.round(splitF * cv.width); if (sx > 0) g.putImageData(beforeImg, 0, 0, 0, 0, sx, cv.height);
          }
        }
      }
      placeDivider(); drawOverlay();
    };
    const render = async () => {
      if (view !== 'after' && !beforeImg) { if (!before) before = sess.preview({ ...beforeSettings }); const b = await before; if (done) return; beforeImg = imgOf(b); }
      compose();
    };
    const draw = (p) => {
      last = p; lastImg = imgOf(p); render();
      if (s.wb !== 'custom') { s.temp = p.temp; s.tint = p.tint; $q('#rawTemp').value = p.temp; $q('#rawTempR').value = tempToPos(p.temp); $q('[data-k=tint]').value = p.tint; $q('[data-o=tint]').textContent = p.tint; }
      $q('#rawCaEst').textContent = s.caAuto && p.ca ? `(found red ${p.ca.red > 0 ? '+' : ''}${p.ca.red.toFixed(0)}, blue ${p.ca.blue > 0 ? '+' : ''}${p.ca.blue.toFixed(0)})` : '';
      $q('#rawMs').textContent = `${p.draft ? 'draft' : 'preview'} ${p.ms} ms · ${DEV_ENGINE_NAMES[p.engine] || 'CPU'}`; $q('#rawMs').title = `RAW develop engine: ${DEV_ENGINE_NAMES[p.engine] || 'CPU'} (View › Rendering engine to change it)`;
      ui.previews++;
    };
    let busy = false, again = false, done = false;
    // live updates: while a slider, handle or brush is moving and the full preview is slow (CPU or a software GPU),
    // a half-size draft is shown; the full preview follows once the input rests for DRAFT_SETTLE_MS
    let draftNext = false, wasDraft = false, lastFullMs = 0, settleT = 0;
    const refresh = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false; const d = draftNext; draftNext = false;
          const p = await sess.preview(maskOn && s.local?.[localSel] ? { ...s, maskShow: localSel } : { ...s }, { draft: d }); if (done) return;
          if (!d) lastFullMs = p.ms; wasDraft = d; if (d) ui.drafts = (ui.drafts || 0) + 1; draw(p);
        } while (again);
      } catch (err) { if (!done) $q('#rawMs').textContent = `Preview failed: ${err.message}`; }
      finally { busy = false; ui.idle = !again && !wasDraft; }
    };
    const live = () => {
      ui.idle = false;
      if (ui.allowDrafts && lastFullMs > DRAFT_OVER_MS) draftNext = true;
      clearTimeout(settleT);
      settleT = setTimeout(() => { if (done) return; if (wasDraft || draftNext) { draftNext = false; refresh(); } }, DRAFT_SETTLE_MS);
      refresh();
    };
    const setView = async (v) => {
      view = v;
      const splitOn = v === 'split' || v === 'splitH';
      for (const [id, on] of [['#rawBefore', v === 'before'], ['#rawSplitBtn', splitOn]]) { $q(id).setAttribute('aria-pressed', String(on)); $q(id).classList.toggle('on', on); }
      $q('#rawSplitBtn').textContent = v === 'splitH' ? 'Split ⊟' : v === 'split' ? 'Split ⊞' : 'Split';
      await render();
      if (view === v) { ui.beforeShown = v === 'before'; ui.view = v; }
    };
    const cycleSplit = () => { // after → left/right → top/bottom → after
      if (view === 'after' || view === 'before') setView('split');
      else if (view === 'split') setView('splitH');
      else setView('after');
    };
    const setBefore = (on) => setView(on ? 'before' : 'after');
    const setSplit = (f) => { splitF = Math.min(1, Math.max(0, f)); ui.split = splitF; compose(); };
    const ui = rawUI = { settings: s, info, previews: 0, idle: true, body, allowDrafts: true, get lastFullMs() { return lastFullMs; }, refresh: () => { ui.idle = false; refresh(); }, beforeShown: false, view: 'after', split: 0.5, setBefore, setView, setSplit, applyPreset: (v) => applyChoice(v), redevelop: !!opt.onApply,
      addLocal: (t) => addLocal(t), setLocal: (i, p) => setLocal(i, p), selectLocal: (i) => selectLocal(i), deleteLocal: (i) => deleteLocal(i),
      addPart: (t, op, i) => addPart(t, op, i), setPart: (j, p, i) => setPart(j, p, i), deletePart: (j, i) => deletePart(j, i), selectPart: (j) => selectPart(j), get partSel() { return partSel; },
      get lastPreview() { return last; },
      duplicateLocal: (i) => duplicateLocal(i), renameLocal: (i, n) => renameLocal(i, n), invertLocal: (i) => invertLocal(i), setMaskOn: (on) => setMaskOn(on), maskOn: false,
      setBrushMode: (on) => setBrushMode(on), get brushMode() { return brushMode; }, brush: () => ({ ...brush }), setBrush: (p) => { Object.assign(brush, p); saveBrush(); syncLocal(); },
      rangeAt: (k, u, v) => rangeAt(k, u, v), setRangePick: (k) => setRangePick(k), get rangePick() { return rangePick; },
      pickAt: (u, v) => pickAt(u, v), setPicking: (on) => setPicking(on), get localSel() { return localSel; }, get picking() { return picking; }, get showGrid() { return showGrid; },
      lensKey, get lensFromProfile() { return lensFromProfile; }, overlay: () => ov };
    const changed = () => { ui.idle = false; refresh(); };
    // tone curve editor (same editor as the Curves adjustment)
    let curveVals = null;
    const mountCurve = () => {
      curveVals = s.curve ? JSON.parse(JSON.stringify(s.curve)) : {};
      const host = $q('#rawCurveHost'); host.replaceChildren(createCurvesEditor(curveVals, (v) => {
        s.curve = curveIsIdentity(v) ? null : JSON.parse(JSON.stringify(v)); $q('#rawCurveState').textContent = s.curve ? 'adjusted' : 'straight'; changed();
      }));
      $q('#rawCurveState').textContent = s.curve ? 'adjusted' : 'straight';
    };
    mountCurve();
    // ---- overlay: grid, local adjustment handles, eyedropper -----------------------------------------------
    const ov = $q('#rawOverlay');
    const locals = () => (s.local ||= []);
    const activeOverlay = () => picking || localSel >= 0 || !!rangePick;
    const drawOverlay = () => {
      const r = contentRect(), dpr = window.devicePixelRatio || 1;
      Object.assign(ov.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      const W = Math.max(1, Math.round(r.w * dpr)), H = Math.max(1, Math.round(r.h * dpr));
      if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
      ov.classList.toggle('active', activeOverlay()); ov.classList.toggle('picking', picking || !!rangePick);
      const g = ov.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.scale(dpr, dpr);
      const w = r.w, h = r.h, P = (u, v) => [u * w, v * h];
      if (showGrid) {
        const step = Math.max(12, Math.min(w, h) / 8); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.45)'; g.beginPath();
        for (let x = (w % step) / 2; x <= w; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); }
        for (let y = (h % step) / 2; y <= h; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); }
        g.stroke(); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.translate(1, 1); g.stroke(); g.translate(-1, -1);
      }
      if (view !== 'after') return; // handles only over the current settings
      (s.local || []).forEach((a, i) => {
        const on = i === localSel;
        g.lineWidth = on ? 1.5 : 1; g.strokeStyle = on ? '#fff' : 'rgba(255,255,255,0.6)'; g.shadowColor = '#000'; g.shadowBlur = 2;
        if (a.type === 'brush') {
          if (on && (a.strokes || []).length && (!maskOn || stroke)) { // stroke outlines (the overlay shows the real mask)
            const L = Math.max(w, h);
            for (const st of a.strokes) {
              const p = st.pts; g.lineCap = g.lineJoin = 'round'; g.lineWidth = Math.max(1, st.size * L * 2); g.strokeStyle = st.erase ? 'rgba(90,170,255,0.28)' : 'rgba(255,90,90,0.28)';
              g.beginPath(); g.moveTo(p[0] * w, p[1] * h); for (let j = 2; j < p.length; j += 2) g.lineTo(p[j] * w, p[j + 1] * h); if (p.length === 2) g.lineTo(p[0] * w + 0.01, p[1] * h); g.stroke();
            }
            g.lineWidth = 1;
          }
          if (on && brushMode && hover) { // brush cursor: outer = size, inner = where the feather starts
            const R = brushR() * Math.max(w, h), [hx, hy] = P(hover.u, hover.v);
            g.strokeStyle = hover.erase ? '#9cf' : '#fff'; g.beginPath(); g.arc(hx, hy, R, 0, Math.PI * 2); g.stroke();
            g.setLineDash([3, 3]); g.beginPath(); g.arc(hx, hy, R * (1 - brush.feather / 100 * 0.999), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
            if (hover.erase) { g.beginPath(); g.moveTo(hx - 4, hy); g.lineTo(hx + 4, hy); g.stroke(); }
            else { g.beginPath(); g.moveTo(hx - 4, hy); g.lineTo(hx + 4, hy); g.moveTo(hx, hy - 4); g.lineTo(hx, hy + 4); g.stroke(); }
          }
        } else drawShape(g, a, on && partSel < 0, P, w, h);
        if (on) (a.parts || []).forEach((q, j) => { // the other shapes of the selected mask, coloured by how they combine
          g.strokeStyle = { add: '#8f8', subtract: '#f88', intersect: '#ff8' }[q.op] || '#fff'; g.lineWidth = partSel === j ? 1.5 : 1;
          if (partSel !== j) g.setLineDash([2, 3]); drawShape(g, q, partSel === j, P, w, h, true); g.setLineDash([]);
        });
        g.shadowBlur = 0;
      });
    };
    const drawShape = (g, a, on, P, w, h, keep = false) => {
        if (a.type === 'linear') {
          const [ax, ay] = P(a.x0, a.y0), [bx, by] = P(a.x1, a.y1), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = -dy / L * (w + h), ny = dx / L * (w + h);
          if (keep && !on) { g.beginPath(); g.moveTo(ax - nx, ay - ny); g.lineTo(ax + nx, ay + ny); g.stroke(); return; }
          if (on) {
            g.beginPath(); for (const [px, py, dash] of [[ax, ay, []], [bx, by, []], [(ax + bx) / 2, (ay + by) / 2, [4, 4]]]) { g.setLineDash(dash); g.beginPath(); g.moveTo(px - nx, py - ny); g.lineTo(px + nx, py + ny); g.stroke(); }
            g.setLineDash([]); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
            for (const [px, py] of [[ax, ay], [bx, by]]) { g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); }
            g.beginPath(); g.arc((ax + bx) / 2, (ay + by) / 2, 6, 0, Math.PI * 2); g.stroke();
          } else { g.beginPath(); g.arc((ax + bx) / 2, (ay + by) / 2, 5, 0, Math.PI * 2); g.stroke(); }
        } else {
          const [cx, cy] = P(a.cx, a.cy), rx = a.rx * w, ry = a.ry * h;
          if (on) {
            g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.stroke();
            if (a.feather > 0.02) { g.setLineDash([4, 4]); g.beginPath(); g.ellipse(cx, cy, rx * (1 - a.feather), ry * (1 - a.feather), 0, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
            for (const [px, py] of [[cx + rx, cy], [cx, cy + ry]]) { g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); }
            g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.stroke();
          } else if (keep) { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.stroke(); }
          else { g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke(); }
        }
    };
    const LDEF = { linear: { exposure: -0.7, x0: 0.5, y0: 0, x1: 0.5, y1: 0.45 }, radial: { exposure: 0.5, cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, feather: 0.5, invert: false }, brush: { exposure: 0.5, strokes: [] } };
    const TYPE_NAME = { linear: 'Graduated', radial: 'Radial', brush: 'Brush' };
    // shapes combined into a mask (a.parts): selecting one makes its handles the ones you drag
    const PDEF = { linear: { x0: 0.5, y0: 1, x1: 0.5, y1: 0.6 }, radial: { cx: 0.5, cy: 0.5, rx: 0.15, ry: 0.15, feather: 0.5 } };
    const OP_NAME = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };
    let partSel = -1;
    const partsHTML = (a) => {
      const own = a.type === 'brush' ? 'Brush strokes' : `${TYPE_NAME[a.type]} (base shape)`;
      const rows = [`<div class="raw-part-item${partSel < 0 ? ' on' : ''}" role="option" tabindex="0" data-pi="-1" aria-selected="${partSel < 0}"><span>${escapeHtml(own)}</span></div>`];
      (a.parts || []).forEach((q, j) => rows.push(`<div class="raw-part-item${partSel === j ? ' on' : ''}" role="option" tabindex="0" data-pi="${j}" aria-selected="${partSel === j}"><select data-pop="${j}" aria-label="How shape ${j + 2} combines">${MASK_OPS.map((o) => `<option value="${o}"${q.op === o ? ' selected' : ''}>${OP_NAME[o]}</option>`).join('')}</select><span>${TYPE_NAME[q.type]}</span><label class="raw-check" title="Use the outside of this shape"><input type="checkbox" data-pinv="${j}"${q.invert ? ' checked' : ''}/> Invert</label><button type="button" data-pdel="${j}" title="Remove this shape" aria-label="Remove shape ${j + 2}">✕</button></div>`));
      return rows.join('');
    };
    const syncParts = (a) => {
      const host = $q('#rawParts'); if (!a) { host.innerHTML = ''; return; }
      if (partSel >= (a.parts?.length || 0)) partSel = -1;
      const html = partsHTML(a); if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
      $q('#rawPartLinear').disabled = $q('#rawPartRadial').disabled = (a.parts?.length || 0) >= MAX_PARTS;
    };
    const addPart = (type, op = 'subtract', i = localSel) => {
      const a = s.local?.[i]; if (!a || (a.parts ||= []).length >= MAX_PARTS) return -1;
      const base = a.type === 'radial' ? { cx: a.cx, cy: a.cy, rx: a.rx * 0.5, ry: a.ry * 0.5, feather: 0.5 } : {};
      a.parts.push({ op, type, ...JSON.parse(JSON.stringify(PDEF[type])), ...(type === 'radial' ? base : {}), invert: false });
      if (i === localSel) partSel = a.parts.length - 1; if (brushMode) setBrushMode(false);
      syncLocal(); changed(); return a.parts.length - 1;
    };
    const setPart = (j, patch, i = localSel) => { const q = s.local?.[i]?.parts?.[j]; if (!q) return; Object.assign(q, patch); syncLocal(); changed(); };
    const deletePart = (j, i = localSel) => { const a = s.local?.[i]; if (!a?.parts?.[j]) return; a.parts.splice(j, 1); if (!a.parts.length) delete a.parts; partSel = -1; syncLocal(); changed(); };
    const selectPart = (j) => { partSel = j; syncLocal(); };
    const localName = (a, i) => a.name || `${TYPE_NAME[a.type] || 'Mask'} ${i + 1}`;
    const localSummary = (a) => {
      const bits = LOCAL_SLIDERS.filter(([k]) => k !== 'feather' && a[k]).slice(0, 3).map(([k, label]) => `${label.replace(/ \((EV|°)\)/, '')} ${a[k] > 0 ? '+' : ''}${k === 'exposure' ? (+a[k]).toFixed(2) : k === 'hue' ? `${a[k]}°` : a[k]}`);
      if (a.parts?.length) bits.push(`${a.parts.length + (a.type === 'brush' ? 0 : 1)} shapes`);
      if (a.lum) bits.push('lum'); if (a.color) bits.push('color'); if (a.invert) bits.push('inverted');
      return bits.join(', ') || 'no effect yet';
    };
    const brush = rawBrushPrefs();
    let maskOn = false, brushMode = false, eraseMode = false, rangePick = null, stroke = null, hover = null, renaming = -1;
    const saveBrush = () => { try { localStorage.setItem(RAW_BRUSH_KEY, JSON.stringify(brush)); } catch { /* private mode */ } };
    const setBrushMode = (on) => {
      brushMode = !!on && s.local?.[localSel]?.type === 'brush'; stroke = null;
      const b = $q('#rawBrushBtn'); b.setAttribute('aria-pressed', String(brushMode)); b.classList.toggle('on', brushMode);
      if (brushMode) { setPicking(false); setRangePick(null); } else ov.style.cursor = '';
      drawOverlay();
    };
    const setErase = (on) => { eraseMode = !!on; const b = $q('#rawEraseBtn'); b.setAttribute('aria-pressed', String(eraseMode)); b.classList.toggle('on', eraseMode); };
    const setRangePick = (kind) => {
      rangePick = kind && s.local?.[localSel] ? kind : null;
      for (const [id, k] of [['#rawLumPick', 'lum'], ['#rawColPick', 'color']]) { $q(id).setAttribute('aria-pressed', String(rangePick === k)); $q(id).classList.toggle('on', rangePick === k); }
      if (rangePick) { brushMode = false; $q('#rawBrushBtn').setAttribute('aria-pressed', 'false'); $q('#rawBrushBtn').classList.remove('on'); }
      ov.style.cursor = rangePick ? 'crosshair' : ''; drawOverlay();
    };
    const setMaskOn = (on) => { maskOn = !!on; $q('#rawMaskOv').checked = maskOn; ui.maskOn = maskOn; if (s.local?.length) changed(); };
    const fmtL = (k, v) => (k === 'exposure' ? `${v > 0 ? '+' : ''}${(+v).toFixed(2)}` : k === 'hue' ? `${v}°` : String(v));
    const syncLocal = () => {
      const list = s.local || [];
      if (localSel >= list.length) localSel = list.length - 1;
      if (renaming >= list.length) renaming = -1;
      const host = $q('#rawMaskList');
      const html = list.length ? list.map((a, i) => `<div class="raw-mask-item" role="option" tabindex="0" data-mi="${i}" aria-selected="false" title="Click to select, double-click to rename">${i === renaming ? `<input type="text" class="raw-mask-rename" maxlength="40" value="${escapeHtml(localName(a, i))}" aria-label="Mask name" />` : `<span class="raw-mask-name">${escapeHtml(localName(a, i))}</span>`}<span class="muted small">${escapeHtml(localSummary(a))}</span></div>`).join('') : '<p class="muted small">No masks yet: add a graduated, radial or brush mask.</p>';
      if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; } // rebuilt only when it changes, so a double-click survives selecting
      for (const it of host.querySelectorAll('[data-mi]')) { const on = +it.dataset.mi === localSel; it.classList.toggle('on', on); it.setAttribute('aria-selected', String(on)); }
      if (renaming >= 0) { const inp = host.querySelector('.raw-mask-rename'); inp?.focus(); inp?.select(); }
      const a = list[localSel]; $q('#rawLocalBox').classList.toggle('hidden', !a); syncParts(a);
      for (const id of ['#rawMaskRename', '#rawMaskDup', '#rawMaskInv', '#rawLocalDel']) $q(id).disabled = !a;
      $q('#rawMaskDup').disabled = !a || list.length >= MAX_LOCALS;
      $q('#rawAddLinear').disabled = $q('#rawAddRadial').disabled = $q('#rawAddBrush').disabled = list.length >= MAX_LOCALS;
      $q('#rawMaskInv').setAttribute('aria-pressed', String(!!a?.invert)); $q('#rawMaskInv').classList.toggle('on', !!a?.invert);
      if (a) {
        for (const [k] of LOCAL_SLIDERS) {
          const v = k === 'feather' ? Math.round((a.feather ?? 0) * 100) : (a[k] || 0), el = $q(`[data-l=${k}]`); if (el) { el.value = v; $q(`[data-lo=${k}]`).textContent = fmtL(k, v); }
        }
        $q('[data-lrow=feather]').classList.toggle('hidden', a.type !== 'radial');
        $q('#rawBrushBox').classList.toggle('hidden', a.type !== 'brush');
        for (const k of ['size', 'feather', 'flow', 'smooth']) { $q(`[data-b=${k}]`).value = brush[k]; $q(`[data-bo=${k}]`).textContent = k === 'size' ? `${brush[k]}%` : brush[k]; }
        $q('#rawAutoMask').checked = !!brush.auto;
        const L = a.lum || { lo: 50, hi: 100, soft: 10 }, C = a.color || { hue: 30, range: 25, soft: 20 };
        $q('#rawLumOn').checked = !!a.lum; $q('#rawColOn').checked = !!a.color;
        for (const [k, v] of [['lumLo', L.lo], ['lumHi', L.hi], ['lumSoft', L.soft], ['colHue', C.hue], ['colRange', C.range], ['colSoft', C.soft]]) { $q(`[data-r=${k}]`).value = v; $q(`[data-ro=${k}]`).textContent = k === 'colHue' ? `${v}°` : v; }
        for (const row of body.querySelectorAll('[data-rrow=lum]')) row.classList.toggle('disabled-row', !a.lum);
        for (const row of body.querySelectorAll('[data-rrow=color]')) row.classList.toggle('disabled-row', !a.color);
        $q('#rawMaskHint').textContent = a.type === 'brush' ? `Paint in the preview (B toggles the brush, Alt erases, [ and ] change the size). ${(a.strokes || []).length} stroke${(a.strokes || []).length === 1 ? '' : 's'}.` : 'Drag the handles in the preview.';
      }
      if (!a || a.type !== 'brush') { if (brushMode) { brushMode = false; $q('#rawBrushBtn').setAttribute('aria-pressed', 'false'); $q('#rawBrushBtn').classList.remove('on'); } }
      if (!a && rangePick) setRangePick(null);
      drawOverlay();
    };
    const selectLocal = (i) => { const prev = localSel; localSel = i; renaming = -1; if (prev !== i) partSel = -1; if (i >= 0) setPicking(false); syncLocal(); if (maskOn && prev !== localSel) changed(); };
    const addLocal = (type) => {
      const list = locals(); if (list.length >= MAX_LOCALS) return -1;
      list.push({ type, ...JSON.parse(JSON.stringify(LDEF[type])) }); localSel = list.length - 1; partSel = -1; picking = false; setPicking(false);
      if (view === 'before') setView('after');
      syncLocal(); if (type === 'brush') setBrushMode(true); changed(); return localSel;
    };
    const setLocal = (i, patch) => { const a = s.local?.[i]; if (!a) return; Object.assign(a, patch); for (const k of Object.keys(patch)) if (patch[k] === null || patch[k] === undefined) delete a[k]; syncLocal(); changed(); };
    const deleteLocal = (i = localSel) => { if (!s.local?.[i]) return; s.local.splice(i, 1); if (!s.local.length) s.local = null; localSel = -1; renaming = -1; setBrushMode(false); syncLocal(); changed(); };
    const duplicateLocal = (i = localSel) => {
      const list = s.local, a = list?.[i]; if (!a || list.length >= MAX_LOCALS) return -1;
      const c = JSON.parse(JSON.stringify(a)); c.name = `${localName(a, i)} copy`.slice(0, 40);
      list.splice(i + 1, 0, c); localSel = i + 1; syncLocal(); changed(); return localSel;
    };
    const renameLocal = (i, name) => { const a = s.local?.[i]; if (!a) return; const n = String(name ?? '').trim().slice(0, 40); if (n && n !== `${TYPE_NAME[a.type]} ${i + 1}`) a.name = n; else delete a.name; renaming = -1; syncLocal(); };
    const invertLocal = (i = localSel) => { const a = s.local?.[i]; if (!a) return; a.invert = !a.invert; syncLocal(); changed(); };
    const host = $q('#rawMaskList');
    host.addEventListener('click', (e) => { if (e.target.closest('.raw-mask-rename')) return; const it = e.target.closest('[data-mi]'); if (it) selectLocal(+it.dataset.mi); });
    host.addEventListener('dblclick', (e) => { const it = e.target.closest('[data-mi]'); if (!it) return; localSel = +it.dataset.mi; renaming = localSel; syncLocal(); });
    host.addEventListener('keydown', (e) => {
      const inp = e.target.closest('.raw-mask-rename');
      if (inp) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); renameLocal(renaming, inp.value); } else if (e.key === 'Escape') { e.preventDefault(); renaming = -1; syncLocal(); } return; }
      const it = e.target.closest('[data-mi]'); if (!it) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLocal(+it.dataset.mi); }
      else if (e.key === 'F2') { e.preventDefault(); localSel = +it.dataset.mi; renaming = localSel; syncLocal(); }
    });
    host.addEventListener('focusout', (e) => { const inp = e.target.closest?.('.raw-mask-rename'); if (inp && renaming >= 0) renameLocal(renaming, inp.value); });
    $q('#rawMaskRename').onclick = () => { if (localSel < 0) return; renaming = localSel; syncLocal(); };
    $q('#rawMaskDup').onclick = () => duplicateLocal();
    $q('#rawMaskInv').onclick = () => invertLocal();
    body.addEventListener('input', (e) => {
      const t = e.target, a = s.local?.[localSel];
      if (t.dataset?.b) { const k = t.dataset.b; brush[k] = +t.value; $q(`[data-bo=${k}]`).textContent = k === 'size' ? `${brush[k]}%` : brush[k]; saveBrush(); drawOverlay(); return; }
      if (!a) return;
      if (t.dataset?.r) {
        const k = t.dataset.r, v = +t.value; $q(`[data-ro=${k}]`).textContent = k === 'colHue' ? `${v}°` : v;
        if (k.startsWith('lum')) { const L = a.lum || { lo: 50, hi: 100, soft: 10 }; L[{ lumLo: 'lo', lumHi: 'hi', lumSoft: 'soft' }[k]] = v; a.lum = L; $q('#rawLumOn').checked = true; }
        else { const C = a.color || { hue: 30, range: 25, soft: 20 }; C[{ colHue: 'hue', colRange: 'range', colSoft: 'soft' }[k]] = v; a.color = C; $q('#rawColOn').checked = true; }
        for (const row of body.querySelectorAll('[data-rrow]')) row.classList.toggle('disabled-row', !a[row.dataset.rrow]);
        live(); return;
      }
      const k = t.dataset?.l; if (!k) return;
      const v = +t.value; a[k] = k === 'feather' ? v / 100 : v;
      $q(`[data-lo=${k}]`).textContent = fmtL(k, v);
      const it = host.querySelector(`[data-mi="${localSel}"] .small`); if (it) it.textContent = localSummary(a);
      drawOverlay(); live();
    });
    body.addEventListener('change', (e) => {
      const t = e.target, a = s.local?.[localSel];
      if (t.id === 'rawMaskOv') setMaskOn(t.checked);
      else if (t.id === 'rawAutoMask') { brush.auto = t.checked; saveBrush(); }
      else if (a && t.id === 'rawLumOn') { if (t.checked) a.lum = { lo: +$q('[data-r=lumLo]').value, hi: +$q('[data-r=lumHi]').value, soft: +$q('[data-r=lumSoft]').value }; else delete a.lum; syncLocal(); changed(); }
      else if (a && t.id === 'rawColOn') { if (t.checked) a.color = { hue: +$q('[data-r=colHue]').value, range: +$q('[data-r=colRange]').value, soft: +$q('[data-r=colSoft]').value }; else delete a.color; syncLocal(); changed(); }
    });
    $q('#rawPartLinear').onclick = () => addPart('linear');
    $q('#rawPartRadial').onclick = () => addPart('radial');
    const partsHost = $q('#rawParts');
    partsHost.addEventListener('click', (e) => {
      const del = e.target.closest('[data-pdel]'); if (del) { deletePart(+del.dataset.pdel); return; }
      if (e.target.closest('select, input, label')) return;
      const it = e.target.closest('[data-pi]'); if (it) selectPart(+it.dataset.pi);
    });
    partsHost.addEventListener('keydown', (e) => { const it = e.target.closest('[data-pi]'); if (it && e.target === it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectPart(+it.dataset.pi); } });
    partsHost.addEventListener('change', (e) => {
      e.stopPropagation(); const t = e.target;
      if (t.dataset.pop) setPart(+t.dataset.pop, { op: t.value });
      else if (t.dataset.pinv) setPart(+t.dataset.pinv, { invert: t.checked });
    });
    $q('#rawAddLinear').onclick = () => addLocal('linear');
    $q('#rawAddRadial').onclick = () => addLocal('radial');
    $q('#rawAddBrush').onclick = () => addLocal('brush');
    $q('#rawLocalDel').onclick = () => deleteLocal();
    $q('#rawBrushBtn').onclick = () => { if (view === 'before') setView('after'); setBrushMode(!brushMode); };
    $q('#rawEraseBtn').onclick = () => { setErase(!eraseMode); if (!brushMode) setBrushMode(true); };
    $q('#rawBrushClear').onclick = () => { const a = s.local?.[localSel]; if (a?.type !== 'brush' || !a.strokes?.length) return; a.strokes = []; syncLocal(); changed(); };
    $q('#rawLumPick').onclick = () => { if (view === 'before') setView('after'); setRangePick(rangePick === 'lum' ? null : 'lum'); };
    $q('#rawColPick').onclick = () => { if (view === 'before') setView('after'); setRangePick(rangePick === 'color' ? null : 'color'); };
    const rangeAt = async (kind, u, v) => {
      const a = s.local?.[localSel]; setRangePick(null); if (!a) return null;
      let r; try { r = await sess.range({ ...s }, u, v); } catch (err) { toast(`The colour could not be read (${err.message}).`); return null; }
      if (done) return r;
      ui.lastRange = r;
      if (kind === 'lum') { a.lum = { lo: Math.max(0, r.lum - 15), hi: Math.min(100, r.lum + 15), soft: a.lum?.soft ?? 10 }; status(`Luminance range set around ${r.lum} (${a.lum.lo}–${a.lum.hi}).`); }
      else if (r.hue < 0 || r.sat < 0.04) { toast('That spot is almost grey: pick a coloured area for a color range (or use a luminance range).', 5000); return r; }
      else { a.color = { hue: r.hue, range: a.color?.range ?? 25, soft: a.color?.soft ?? 20 }; status(`Color range set around hue ${r.hue}°.`); }
      syncLocal(); changed(); return r;
    };
    // eyedropper
    const setPicking = (on) => { picking = on; const b = $q('#rawFringePick'); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); drawOverlay(); };
    const pickAt = async (u, v) => {
      setPicking(false);
      let r; try { r = await sess.pick({ ...s, fringeMask: false }, u, v); } catch (err) { toast(`The colour could not be read (${err.message}).`); return null; }
      if (done) return r;
      if (!r.kind) { toast(r.why === 'hue' ? `That colour (hue ${r.hue}°) is not a purple or green fringe: pick the coloured edge itself.` : 'That spot is too neutral to be a fringe: click right on the coloured edge (zoom the window larger if needed).', 5000); ui.lastPick = r; return r; }
      const K = r.kind === 'purple' ? 'Purple' : 'Green';
      s[`fringe${K}Lo`] = r.lo; s[`fringe${K}Hi`] = r.hi; if (!s[`fringe${K}`]) s[`fringe${K}`] = 50;
      sync(); changed(); status(`Picked a ${r.kind} fringe at ${r.hue}°: ${r.kind} hue range set to ${r.lo}–${r.hi}°.`); ui.lastPick = r;
      return r;
    };
    $q('#rawFringePick').onclick = () => { if (view === 'before') setView('after'); setPicking(!picking); if (picking) { localSel = -1; setRangePick(null); syncLocal(); } };
    // brush strokes: points in output fractions; the brush trails the pointer by the smoothing amount
    const brushR = () => brush.size / 100;
    const addPt = (u, v, force) => {
      const st = stroke, r = ov.getBoundingClientRect(), L = Math.max(r.width, r.height) || 1, k = 1 - 0.9 * (brush.smooth / 100);
      st.su += (u - st.su) * k; st.sv += (v - st.sv) * k;
      const p = st.s.pts, n = p.length, du = (st.su - p[n - 2]) * r.width / L, dv = (st.sv - p[n - 1]) * r.height / L;
      if (force || Math.hypot(du, dv) >= Math.max(0.002, st.s.size * 0.12)) { if (n / 2 < 4000) { p.push(+st.su.toFixed(5), +st.sv.toFixed(5)); livePaint(); } }
    };
    // live preview while painting: the newest stroke is rasterised on top of the cached earlier ones (raw.js
    // cachedRaster) and refresh() keeps only the latest request, so updates never queue up behind the pointer
    let liveT = 0;
    const livePaint = () => { const t = performance.now(); if (t - liveT < LIVE_PAINT_MS) return; liveT = t; ui.livePaints = (ui.livePaints || 0) + 1; live(); };
    const startStroke = (u, v, erase) => {
      const a = s.local?.[localSel]; if (a?.type !== 'brush') return false;
      if ((a.strokes ||= []).length >= 400) { toast('This mask has the most strokes it can hold: duplicate it or clear some strokes.'); return false; }
      const st = { size: brushR(), feather: brush.feather / 100, flow: brush.flow / 100, pts: [+u.toFixed(5), +v.toFixed(5)] };
      if (erase) st.erase = true; else if (brush.auto) st.auto = true;
      stroke = { s: st, su: u, sv: v }; a.strokes.push(st); drawOverlay(); return true;
    };
    const endStroke = () => { if (!stroke) return; stroke = null; ui.strokes = (ui.strokes || 0) + 1; syncLocal(); changed(); };
    // pointer: eyedroppers, brush, or drag the selected local adjustment's handles
    let ldrag = null;
    const uvOf = (e) => { const b = ov.getBoundingClientRect(); return [(e.clientX - b.left) / (b.width || 1), (e.clientY - b.top) / (b.height || 1)]; };
    const handleAt = (a, u, v) => {
      if (a.type === 'brush') return null;
      const r = ov.getBoundingClientRect(), near = (pu, pv, rad = 9) => Math.hypot((pu - u) * r.width, (pv - v) * r.height) <= rad;
      if (a.type === 'linear') { if (near(a.x0, a.y0)) return 'a'; if (near(a.x1, a.y1)) return 'b'; if (near((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, 11)) return 'move'; return null; }
      if (near(a.cx + a.rx, a.cy)) return 'rx'; if (near(a.cx, a.cy + a.ry)) return 'ry'; if (near(a.cx, a.cy, 11)) return 'move';
      const d = Math.hypot((u - a.cx) / a.rx, (v - a.cy) / a.ry); return d < 1 ? 'move' : null;
    };
    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.stopPropagation(); e.preventDefault();
      const [u, v] = uvOf(e);
      if (picking) { pickAt(u, v); return; }
      if (rangePick) { rangeAt(rangePick, u, v); return; }
      if (brushMode) { if (startStroke(u, v, eraseMode || e.altKey)) ov.setPointerCapture(e.pointerId); return; }
      const list = s.local || []; let a = list[localSel], tgt = a && partSel >= 0 ? a.parts?.[partSel] : a, h = tgt && handleAt(tgt, u, v);
      if (!h && a) { // another shape of the selected mask (handles first, then its inside), then the mask's own shape
        const ps = a.parts || [], j = [...ps.keys()].find((k) => k !== partSel && handleAt(ps[k], u, v) && handleAt(ps[k], u, v) !== 'move') ?? [...ps.keys()].find((k) => k !== partSel && handleAt(ps[k], u, v) === 'move');
        if (j != null) { selectPart(j); tgt = ps[j]; h = handleAt(tgt, u, v); } else if (partSel >= 0 && handleAt(a, u, v)) { selectPart(-1); tgt = a; h = handleAt(a, u, v); }
      }
      if (!h) { const j = list.findIndex((b, i) => i !== localSel && handleAt(b, u, v) === 'move'); if (j >= 0) { selectLocal(j); a = tgt = list[j]; h = 'move'; } }
      if (!h) return;
      ldrag = { h, u, v, tgt, start: { ...tgt } }; ov.setPointerCapture(e.pointerId);
    });
    ov.addEventListener('pointermove', (e) => {
      if (brushMode) {
        const [u, v] = uvOf(e); hover = { u, v, erase: eraseMode || e.altKey };
        if (stroke) for (const ev of (e.getCoalescedEvents?.() || []).length ? e.getCoalescedEvents() : [e]) { const [cu, cv2] = uvOf(ev); addPt(cu, cv2); }
        ov.style.cursor = 'none'; drawOverlay(); return;
      }
      if (!ldrag) { ov.style.cursor = rangePick || picking ? 'crosshair' : 'default'; const a0 = s.local?.[localSel]; if (a0 && !rangePick) { const [u, v] = uvOf(e), t0 = partSel >= 0 ? a0.parts?.[partSel] : a0, h = (t0 && handleAt(t0, u, v)) || (a0.parts || []).map((q) => handleAt(q, u, v)).find(Boolean) || handleAt(a0, u, v); ov.style.cursor = h === 'move' ? 'move' : h ? 'grab' : 'default'; } return; }
      const [u, v] = uvOf(e), a = ldrag.tgt, o = ldrag.start, du = u - ldrag.u, dv = v - ldrag.v;
      if (a.type === 'linear') {
        if (ldrag.h === 'a') Object.assign(a, { x0: o.x0 + du, y0: o.y0 + dv });
        else if (ldrag.h === 'b') Object.assign(a, { x1: o.x1 + du, y1: o.y1 + dv });
        else Object.assign(a, { x0: o.x0 + du, y0: o.y0 + dv, x1: o.x1 + du, y1: o.y1 + dv });
      } else if (ldrag.h === 'rx') a.rx = Math.max(0.01, Math.abs(u - a.cx));
      else if (ldrag.h === 'ry') a.ry = Math.max(0.01, Math.abs(v - a.cy));
      else Object.assign(a, { cx: o.cx + du, cy: o.cy + dv });
      drawOverlay(); live();
    });
    ov.addEventListener('pointerleave', () => { if (hover) { hover = null; drawOverlay(); } });
    const endL = (e) => { ldrag = null; if (stroke) { if (e?.type === 'pointerup') { const [u, v] = uvOf(e); addPt(u, v, true); } endStroke(); } };
    ov.addEventListener('pointerup', endL); ov.addEventListener('pointercancel', endL);
    $q('#rawLensSave').onclick = () => {
      if (!lensKey) return;
      saveLensProfile(lensKey, info.focal, s.distortion); lensFromProfile = true; $q('#rawLensForget').disabled = false; lensNote();
      status(`Saved distortion ${s.distortion > 0 ? '+' : ''}${s.distortion} for ${lensKey}${info.focal ? ` at ${+info.focal.toFixed(1)} mm` : ''}.`);
    };
    $q('#rawLensForget').onclick = () => { forgetLensProfile(lensKey); lensFromProfile = false; $q('#rawLensForget').disabled = true; lensNote(); status(`Forgot the saved distortion for ${lensKey}.`); };
    const lensNote = () => {
      const p = lensKey ? lensProfiles()[lensKey] : null;
      $q('#rawLensProf').textContent = p?.length ? `Your profile for this lens: ${p.map((q) => `${q.focal ? `${q.focal} mm` : 'any'} → ${q.k > 0 ? '+' : ''}${q.k}`).join(', ')}${lensFromProfile ? ' (applied)' : ''}.` : '';
    };
    lensNote(); syncLocal();
    const sync = () => { // controls ← s
      body.querySelectorAll('[data-k]').forEach((el) => { el.value = s[el.dataset.k]; const o = $q(`[data-o=${el.dataset.k}]`); if (o) o.textContent = fmtK(el.dataset.k, s[el.dataset.k]); });
      $q('#rawWb').value = s.wb; $q('#rawTemp').value = s.temp; $q('#rawTempR').value = tempToPos(s.temp);
      if (info.lens) $q('#rawLens').checked = s.lens !== false;
      $q('#rawCaAuto').checked = !!s.caAuto; mountCurve(); syncLocal();
    };
    const applyChoice = (v) => {
      if (!v) return;
      const p = rawSettingsFor(v), keepWB = p.wb !== 'custom';
      Object.assign(s, p); if (keepWB) { s.temp = info.asShot.temp; s.tint = info.asShot.tint; }
      if (s.local) s.local = JSON.parse(JSON.stringify(s.local)); localSel = -1;
      if (!s.distortion) applyLensProfile(); // a preset without distortion keeps this lens's own correction
      sync(); changed();
      $q('#rawPresetDel').disabled = !v.startsWith('preset:');
      if (v.startsWith('preset:')) $q('#rawPresetName').value = v.slice(7);
    };
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.k) { s[t.dataset.k] = +t.value; const o = $q(`[data-o=${t.dataset.k}]`); if (o) o.textContent = fmtK(t.dataset.k, t.value); if (t.dataset.k === 'tint') { s.wb = 'custom'; $q('#rawWb').value = 'custom'; } }
      else if (t.id === 'rawTempR') { s.temp = posToTemp(+t.value); $q('#rawTemp').value = s.temp; s.wb = 'custom'; $q('#rawWb').value = 'custom'; }
      else if (t.id === 'rawTemp') { s.temp = Math.min(TEMP_MAX, Math.max(TEMP_MIN, +t.value || 5500)); $q('#rawTempR').value = tempToPos(s.temp); s.wb = 'custom'; $q('#rawWb').value = 'custom'; }
      else return;
      if (view === 'before') setView('after');
      if (t.type === 'range') live(); else changed();
    });
    body.addEventListener('change', (e) => {
      if (e.target.id === 'rawWb') { s.wb = e.target.value; changed(); }
      else if (e.target.id === 'rawLens') { s.lens = e.target.checked; changed(); }
      else if (e.target.id === 'rawCaAuto') { s.caAuto = e.target.checked; changed(); }
      else if (e.target.id === 'rawPreset') applyChoice(e.target.value);
      else if (e.target.id === 'rawGrid') { showGrid = e.target.checked; drawOverlay(); }
      else if (e.target.id === 'rawFringeMask') { s.fringeMask = e.target.checked; if (view !== 'after') setView('after'); changed(); }
      else if (e.target.id === 'rawStore') { try { localStorage.setItem(RAW_LINK_KEY, e.target.value === 'link' ? '1' : '0'); } catch { /* private mode */ } }
    });
    if (!opt.onApply && opt.handle) { try { if (localStorage.getItem(RAW_LINK_KEY) === '1') $q('#rawStore').value = 'link'; } catch { /* private mode */ } }
    $q('#rawBefore').onclick = () => setView(view === 'before' ? 'after' : 'before');
    $q('#rawSplitBtn').onclick = () => cycleSplit();
    body.addEventListener('keyup', (e) => { if (e.key === 'Alt') { e.preventDefault(); if (hover) { hover.erase = eraseMode; drawOverlay(); } } });
    body.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' && /text|number/.test(e.target.type)) return;
      if (e.key === '\\') { e.preventDefault(); setView(view === 'before' ? 'after' : 'before'); }
      else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); cycleSplit(); }
      else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); showGrid = !showGrid; $q('#rawGrid').checked = showGrid; drawOverlay(); }
      else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); $q('#rawFringePick').click(); }
      else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setMaskOn(!maskOn); }
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); if (view === 'before') setView('after'); if (s.local?.[localSel]?.type === 'brush') setBrushMode(!brushMode); else if (addLocal('brush') < 0) toast(`There can be at most ${MAX_LOCALS} masks.`); }
      else if ((e.key === '[' || e.key === ']') && brushMode) { e.preventDefault(); brush.size = Math.min(30, Math.max(0.5, Math.round(brush.size * (e.key === ']' ? 1.2 : 1 / 1.2) * 2) / 2)); saveBrush(); syncLocal(); }
      else if (e.key === 'Alt') { e.preventDefault(); if (hover) { hover.erase = true; drawOverlay(); } }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && localSel >= 0 && e.target.tagName !== 'SELECT') { e.preventDefault(); deleteLocal(); }
      else if (e.key === 'Escape' && (picking || rangePick || brushMode || localSel >= 0)) { e.preventDefault(); e.stopPropagation(); setPicking(false); if (rangePick) setRangePick(null); else if (brushMode) setBrushMode(false); else { localSel = -1; syncLocal(); if (maskOn) changed(); } }
      else if (e.target === divider && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && view === 'split') { e.preventDefault(); setSplit(splitF + (e.key === 'ArrowLeft' ? -0.02 : 0.02)); }
      else if (e.target === divider && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && view === 'splitH') { e.preventDefault(); setSplit(splitF + (e.key === 'ArrowUp' ? -0.02 : 0.02)); }
    });
    // drag the divider (or click anywhere on the image) in split view
    let dragging = false;
    const toFrac = (e) => {
      const r = contentRect(), b = wrap.getBoundingClientRect();
      if (view === 'splitH') return (e.clientY - b.top - r.y) / (r.h || 1);
      return (e.clientX - b.left - r.x) / (r.w || 1);
    };
    wrap.addEventListener('pointerdown', (e) => { if ((view !== 'split' && view !== 'splitH') || e.button !== 0) return; dragging = true; wrap.setPointerCapture(e.pointerId); setSplit(toFrac(e)); e.preventDefault(); });
    wrap.addEventListener('pointermove', (e) => { if (dragging) setSplit(toFrac(e)); });
    const endDrag = () => { dragging = false; };
    wrap.addEventListener('pointerup', endDrag); wrap.addEventListener('pointercancel', endDrag);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { placeDivider(); drawOverlay(); }) : null; ro?.observe(cv);
    $q('#rawPresetExport').onclick = () => exportRawPresets();
    $q('#rawPresetImport').onclick = () => $q('#rawPresetFile').click();
    $q('#rawPresetFile').addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
      try {
        if (f.size > 4 * 1048576) throw new Error('the file is too large for a preset file');
        const list = parseRawPresetFile(await f.text()), n = importRawPresets(list);
        $q('#rawPreset').innerHTML = rawPresetOptions(true);
        status(`Imported ${n} develop preset${n === 1 ? '' : 's'} from ${f.name}: ${list.map((p) => p.name).join(', ')}`);
        ui.imported = list.map((p) => p.name);
      } catch (err) { toast(`${f.name} could not be imported: ${err.message}.`, 6000); }
    });
    $q('#rawPresetSave').onclick = () => {
      const name = $q('#rawPresetName').value.trim();
      if (!name) { $q('#rawPresetName').focus(); toast('Type a name for the preset first.'); return; }
      if (!saveRawPreset(name, s)) { toast('The preset could not be saved (browser storage is full or disabled).', 5000); return; }
      $q('#rawPreset').innerHTML = rawPresetOptions(true); $q('#rawPreset').value = `preset:${name}`; $q('#rawPresetDel').disabled = false;
      status(`Saved develop preset “${name}”.`);
    };
    $q('#rawPresetDel').onclick = () => {
      const v = $q('#rawPreset').value; if (!v.startsWith('preset:')) return;
      deleteRawPreset(v.slice(7)); $q('#rawPreset').innerHTML = rawPresetOptions(true); $q('#rawPresetDel').disabled = true;
      status(`Deleted develop preset “${v.slice(7)}”.`);
    };
    $q('#rawReset').onclick = () => {
      Object.assign(s, RAW_DEFAULTS, { temp: info.asShot.temp, tint: info.asShot.tint }); if (!info.lens) s.lens = true;
      s.fringeMask = $q('#rawFringeMask').checked; localSel = -1; applyLensProfile(); lensNote();
      $q('#rawPreset').value = ''; sync(); changed();
    };
    const finish = () => { ro?.disconnect(); if (!done) { done = true; rawUI = null; resolve(); } };
    $q('#rawJpeg')?.addEventListener('click', async () => {
      done = true; rawUI = null; closeModal();
      try { await openRawJpeg(file, sess, 'You chose the camera’s own rendering.', false); } catch (err) { reportError('The embedded JPEG could not be opened', err); }
      resolve();
    });
    draw(sess.firstPreview);
    showModal({
      title: opt.title || `Develop ${file.name}`, body, okLabel: opt.okLabel || 'Open',
      ok: () => {
        if (opt.onApply) {
          const chosen = cleanRawSettings(s); done = true; rawUI = null; closeModal();
          (async () => { try { await opt.onApply(chosen); } finally { resolve(); } })();
          return false;
        }
        // close at once: the canvas area shows the preview, then half resolution, while the full develop runs
        const first = makeCanvas(cv.width, cv.height); first.getContext('2d').drawImage(cv, 0, 0);
        if (view !== 'after' && last) { first.getContext('2d').putImageData(new ImageData(last.data, last.width, last.height), 0, 0); }
        done = true; rawUI = null; closeModal(); status(`Developing ${file.name}…`);
        (async () => {
          const link = opt.handle && $q('#rawStore')?.value === 'link' ? opt.handle : null;
          try { await developToDocument(file, sess, cleanRawSettings(s), timing, t0, { overlayFrom: first, remember: true, link }); }
          catch (err) { reportError(`${file.name} could not be developed`, err); }
          finally { resolve(); }
        })();
        return false;
      },
      onClose: () => { if (!done) status(opt.onApply ? 'Re-develop cancelled.' : 'Open cancelled.'); finish(); },
    });
    $('#modal').classList.add('wide');
    const unwide = new MutationObserver(() => { if ($('#modal').classList.contains('hidden')) { $('#modal').classList.remove('wide'); unwide.disconnect(); } });
    unwide.observe($('#modal'), { attributes: true, attributeFilter: ['class'] });
  });
}
for (const id of ['#fileInput', '#cameraInput']) $(id).addEventListener('change', async (e) => { const fs = [...e.target.files]; e.target.value = ''; for (const f of fs) await openFile(f, fileMode); });

/**
 * Project JSON. rawData: Map(Blob → data URL) of RAW source files read beforehand (projectData() does that), so
 * RAW layers stay re-developable after reopening; without it the develop settings are kept but not the file.
 */
function serializeProject(rawData = null) {
  const d = doc();
  return {
    format: PROJECT_FORMAT, version: 8, app: APP, width: d.width, height: d.height, name: d.name, depth: d.depth === 16 ? 16 : 8,
    activeIndex: activeIndex(),
    layers: d.layers.map((l) => ({
      name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, data: l.canvas.toDataURL('image/png'),
      mask: l.mask ? { enabled: l.mask.enabled, data: l.mask.canvas.toDataURL('image/png') } : null,
      ...(l.kind ? { kind: l.kind, adj: l.adj, text: l.text } : {}),
      ...(l.kind === 'adjust' && l.adj.type === 'lut3d' && lutRegistry.has(l.adj.params?.lut) ? { lut: lutEncode(lutRegistry.get(l.adj.params.lut)) } : {}),
      ...(l.look ? { look: l.look } : {}),
      // v6: layer tree (parent = index of the containing group), clipping and layer styles
      parent: l.parent != null ? d.layers.findIndex((g) => g.id === l.parent) : -1, ...(l.clip ? { clip: true } : {}),
      ...(l.styles ? { styles: l.styles } : {}), ...(isGroup(l) ? { collapsed: !!l.collapsed } : {}),
      ...(d.depth === 16 && !l.kind ? { deep: deepDataURL(deepOf(l)) } : {}), // v5: 16-bit pixels; `data` stays as the 8-bit fallback
      ...(l.kind === 'smart' ? { source: l.source.toDataURL('image/png'), filters: l.filters, fmask: l.fmask ? { enabled: l.fmask.enabled, data: l.fmask.canvas.toDataURL('image/png') } : null } : {}),
      // v7: RAW source (original file as a data URL) + develop settings and crop window, for Layer ▸ Re-develop RAW
      // v8: m = layer pixel → developed pixel map (crops, resizes, rotations, flips, transforms); link = linked file
      ...(l.raw ? { raw: { name: l.raw.name, type: l.raw.type, size: l.raw.size, format: l.raw.format, settings: l.raw.settings, width: l.raw.width, height: l.raw.height,
        cx: l.raw.cx, cy: l.raw.cy, cw: l.raw.cw, ch: l.raw.ch, m: rawMapOf(l.raw), edited: l.raw.rev !== l.rev, ...(l.raw.untracked ? { untracked: l.raw.untracked } : {}),
        ...(l.raw.link ? { link: l.raw.link, data: null } : { data: rawData?.get(l.raw.file) || null }) } } : {}),
    })),
  };
}
function deepDataURL(d) {
  const bytes = encodePNG({ width: d.width, height: d.height, data: d.data, depth: 16 });
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}
function deepFromDataURL(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1)), b = new Uint8Array(bin.length);
  for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i);
  const p = decodePNG(b); return createDeep(p.width, p.height, p.data);
}
const blobDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
/** serializeProject with the RAW source files embedded (read asynchronously first). */
async function projectData() {
  const m = new Map();
  for (const l of doc().layers) if (l.raw?.file && !l.raw.link && !m.has(l.raw.file)) m.set(l.raw.file, await blobDataURL(l.raw.file));
  return serializeProject(m);
}
const projectBlob = async () => new Blob([JSON.stringify(await projectData())], { type: 'application/json' });
const baseName = () => (doc().name || 'project').replace(/\.json$/i, '').replace(/\.tintwork$/i, '').replace(/\.[^.]+$/, '');
/**
 * File ▸ Save (Ctrl+S): write back to the project file this document came from or was last saved to.
 * Documents opened from an image (or not saved yet) go through Save As, so an image is never overwritten
 * with a project. Without the File System Access API this downloads a .tintwork file.
 */
async function saveProject() {
  const d = doc();
  if (fsaSupported && d.fileHandle && d.fileKind === 'project') return writeProjectTo(d.fileHandle);
  if (fsaSupported) return saveProjectAs();
  const name = baseName();
  download(await projectBlob(), `${name}.tintwork`);
  status(`Saved project ${name}.tintwork`);
  markSaved();
}
/** File ▸ Save as… (Ctrl+Shift+S). */
async function saveProjectAs() {
  if (!fsaSupported) { const name = baseName(); download(await projectBlob(), `${name}.tintwork`); status(`Saved project ${name}.tintwork`); markSaved(); return; }
  let h;
  try { h = await pickSave(`${baseName()}.tintwork`); } catch (err) { status(`Save as: ${err.message}`); return; }
  if (!h) { status('Save cancelled.'); return; }
  await writeProjectTo(h);
}
async function writeProjectTo(h) {
  const d = doc(), entry = history.entries[history.index];
  try {
    setBusy(1); await writeFile(h, await projectBlob());
    d.fileHandle = h; d.fileKind = 'project'; d.name = h.name;
    addRecent(h, 'project');
    status(`Saved ${h.name}`); markSaved(entry); updateDocInfo();
  } catch (err) {
    toast(`Could not save ${h.name}: ${err.message}. Use Save as… to pick another place.`, 6000);
  } finally { setBusy(-1); }
}
async function openWithPicker() {
  let hs;
  try { hs = await pickOpen(true); } catch (err) { status(`Open: ${err.message}`); return; }
  for (const h of hs || []) await openHandle(h); // several files open as tabs
}
/** Open a FileSystemFileHandle (picker, recent list, or the OS via the installed app's file handler). */
async function openHandle(h, { remember = true } = {}) {
  let file;
  try { if (!(await ensurePermission(h, 'read'))) { status(`Permission to read ${h.name} was denied.`); return false; } file = await h.getFile(); }
  catch (err) { status(`Could not open ${h.name}: ${err.message}`); return false; }
  fileHandleOf.set(file, h); // RAW files can then be linked instead of embedded
  const before = doc();
  await openFile(file, 'open');
  const d = doc(); if (!d || d === before) return false;
  const kind = /\.(tintwork|json)$/i.test(file.name) ? 'project' : 'image';
  d.fileHandle = h; d.fileKind = kind;
  if (remember) addRecent(h, kind);
  return true;
}
async function openRecentDialog() {
  const list = await listRecent();
  const body = document.createElement('div');
  if (!fsaSupported) body.innerHTML = '<p class="muted">Recent files need the File System Access API (Chrome or Edge). Use File ▸ Open… here.</p>';
  else if (!list.length) body.innerHTML = '<p class="muted">No recent files yet. Files you open or save appear here.</p>';
  else {
    body.innerHTML = `<ul id="recentList" class="recent-list">${list.map((r) => `<li><button data-id="${r.id}" class="recent-open"><b>${escapeHtml(r.name)}</b> <span class="muted">${r.kind === 'project' ? 'project' : 'image'} · ${new Date(r.time).toLocaleString()}</span></button><button class="recent-del" data-id="${r.id}" title="Remove from the list" aria-label="Remove ${escapeHtml(r.name)} from the list">×</button></li>`).join('')}</ul><p><button id="recentClear">Clear list</button></p>`;
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'recentClear') { await clearRecent(); closeModal(); status('Recent files cleared.'); return; }
      const r = list.find((x) => x.id === b.dataset.id); if (!r) return;
      if (b.classList.contains('recent-del')) { await removeRecent(r.id); b.closest('li').remove(); return; }
      closeModal();
      if (!(await openHandle(r.handle))) { await removeRecent(r.id); toast(`${r.name} could not be opened (moved, deleted or permission denied) and was removed from the list.`, 5000); }
    });
  }
  showModal({ title: 'Open recent', body, okLabel: 'Close', hideCancel: true, ok: () => {} });
}
function markSaved(entry = history.entries[history.index]) {
  cleanEntry = entry;
  const slot = doc().slot;
  autosaveNow().then(() => markAutosaveClean(slot)).catch(() => {}); // saved: no recovery prompt for this state
}

// ---------------------------------------------------------------------------
// Autosave (IndexedDB) and crash recovery
// ---------------------------------------------------------------------------
const AUTOSAVE_DELAY = 1500;
let autosaveTimer = null, autosaveRunning = null, autosaveWarned = false, lastAutosave = 0;
let cleanEntry = null, writtenEntry = null; // history entries that are saved to a file / already autosaved
function scheduleAutosave() {
  if (!doc() || recoveryPending || history.entries[history.index] === writtenEntry) return;
  clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosaveNow, AUTOSAVE_DELAY);
}
const AUTOSAVE_STEPS = 20; // undo steps kept in each autosave
const AUTOSAVE_DEEP_PX = IS_IOS ? 4e6 : 8e6; // max 16-bit pixels autosaved (current step only)
const AUTOSAVE_RAW_BYTES = 200 * 1048576; // RAW source files larger than this are not autosaved (re-develop needs the project file)
const newSlot = () => `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
/**
 * Autosave record v2: the last AUTOSAVE_STEPS history entries with every canvas stored once
 * (history canvases are immutable and shared between entries, so each image is encoded and written once).
 */
function encodeHistory(d, dirty, hist = history) {
  const images = new Map(), ref = (c) => { const r = imageRef(c); images.set(r.id, r.encode); return r.id; };
  const dref = (dd) => { const r = deepRef(dd); images.set(r.id, r.encode); return r.id; };
  const rref = (b) => { const r = rawRef(b); images.set(r.id, r.encode); return r.id; };
  const n = hist.entries.length;
  // 16-bit data is autosaved for the current step only, and only up to a size cap (it is 8 bytes/pixel)
  const curSnap = hist.entries[hist.index].snap;
  let deepPx = 0; for (const l of curSnap.layers) if (l.deep) deepPx += l.deep.width * l.deep.height;
  const deepOk = curSnap.depth === 16 && deepPx <= AUTOSAVE_DEEP_PX;
  if (curSnap.depth === 16 && !deepOk) gpuNotice('autosave-deep', 'This 16-bit document is too large for 16-bit autosave; crash recovery keeps an 8-bit copy. Save the project to keep 16-bit data.');
  const start = Math.max(0, Math.min(hist.index, n - AUTOSAVE_STEPS)), end = Math.min(n, start + AUTOSAVE_STEPS);
  const entries = hist.entries.slice(start, end).map((e) => {
    const sn = e.snap;
    return {
      label: e.label,
      snap: {
        width: sn.width, height: sn.height, activeId: sn.activeId, depth: sn.depth || 8,
        selection: sn.selection ? ref(selectionCanvas(sn.selection)) : null,
        layers: sn.layers.map((l) => ({
          id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, rev: l.rev, editMask: l.editMask,
          kind: l.kind, adj: l.adj, text: l.text, canvas: ref(l.canvas),
          parent: l.parent ?? null, clip: !!l.clip, styles: l.styles || null, collapsed: !!l.collapsed, look: l.look || null,
          ...(deepOk && sn === curSnap && l.deep ? { deep: dref(l.deep), deepRev: l.deepRev, deepOX: l.deepOX || 0, deepOY: l.deepOY || 0 } : {}),
          // RAW source file: stored once (same Blob in every step), up to AUTOSAVE_RAW_BYTES
          // (linked RAW files: only the link; the file handle itself is kept in IndexedDB under the link id)
          ...(l.raw ? { raw: { ...l.raw, handle: null, file: !l.raw.link && l.raw.file && l.raw.file.size <= AUTOSAVE_RAW_BYTES ? rref(l.raw.file) : null } } : {}),
          mask: l.mask ? { enabled: l.mask.enabled, rev: l.mask.rev, canvas: ref(l.mask.canvas) } : null,
          ...(l.kind === 'smart' ? { source: ref(l.source), filters: l.filters, editFMask: l.editFMask,
            fmask: l.fmask ? { enabled: l.fmask.enabled, rev: l.fmask.rev, canvas: ref(l.fmask.canvas) } : null } : {}),
        })),
      },
    };
  });
  const cur = hist.entries[hist.index].snap;
  const record = {
    format: 'tintwork-autosave', version: 2, app: APP, appVersion: APP_VERSION, slot: d.slot, name: d.name || 'Untitled',
    width: d.width, height: d.height, savedAt: Date.now(), dirty, layerCount: cur.layers.length, steps: entries.length,
    history: { index: hist.index - start, entries }, imageIds: [...images.keys()],
  };
  return { record, images };
}
/** Write the current document to IndexedDB now (serialized: one write at a time). */
async function autosaveNow() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  const d = doc(); if (!d || recoveryPending || history.index < 0) return;
  // capture this document's history now: the user may switch tabs while an earlier write finishes
  const hist = { entries: history.entries.slice(), index: history.index }, entry = hist.entries[hist.index], dirty = entry !== cleanEntry;
  while (autosaveRunning) await autosaveRunning;
  autosaveRunning = (async () => {
    try {
      const { record, images } = encodeHistory(d, dirty, hist);
      await writeAutosave(record, images);
      if (doc() === d) writtenEntry = entry; else { const t = tabs.find((x) => x.doc === d); if (t) t.writtenEntry = entry; }
      lastAutosave = Date.now();
    }
    catch (err) { if (!autosaveWarned) { autosaveWarned = true; toast(`Autosave is unavailable here (${err?.message || err}). Save your project to keep your work.`, 5000); } }
  })();
  try { await autosaveRunning; } finally { autosaveRunning = null; }
}
// flush a pending save when the tab is hidden or closed (best effort)
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && autosaveTimer) autosaveNow(); });
addEventListener('pagehide', () => { if (autosaveTimer) autosaveNow(); });

let recoveryPending = false;
async function restoreAutosave(r) {
  if (r.version !== 2 || !r.history) return restoreLegacyAutosave(r);
  const bufs = await readImages(r), canv = new Map();
  for (const [id, buf] of bufs) {
    if (isDeepId(id)) { const p = decodePNG(buf), dd = createDeep(p.width, p.height, p.data); adoptImage(dd, id); canv.set(id, dd); continue; }
    if (isRawId(id)) { const b = new Blob([buf]); adoptImage(b, id); canv.set(id, b); continue; }
    const img = await decodeImage(buf), c = makeCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0); img.close?.();
    adoptImage(c, id); canv.set(id, c); // re-saving this session reuses the stored bytes
  }
  const get = (id) => { const c = canv.get(id); if (!c) throw new Error(`Missing image ${id}`); return c; };
  const sels = new Map(), selOf = (id, W, H) => {
    if (!id) return null;
    if (!sels.has(id)) {
      const a = ctxOf(get(id)).getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
      for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
      const sel = makeSelection(W, H, m);
      if (sel && !sel._canvas) Object.defineProperty(sel, '_canvas', { value: get(id), enumerable: false }); // same id on the next autosave
      sels.set(id, sel);
    }
    return sels.get(id);
  };
  let maxId = 0, maxRev = 0;
  const entries = r.history.entries.map((e) => ({
    label: e.label,
    snap: {
      width: e.snap.width, height: e.snap.height, depth: e.snap.depth || 8, activeId: e.snap.activeId, selection: selOf(e.snap.selection, e.snap.width, e.snap.height),
      layers: e.snap.layers.map((L) => {
        maxId = Math.max(maxId, L.id); maxRev = Math.max(maxRev, L.rev, L.mask?.rev || 0, L.fmask?.rev || 0);
        const l = { ...L, canvas: get(L.canvas), mask: L.mask ? { ...L.mask, canvas: get(L.mask.canvas) } : null, styles: normalizeStyles(L.styles) };
        if (L.deep) l.deep = get(L.deep); else delete l.deep;
        if (L.raw?.file && canv.has(L.raw.file)) l.raw = { ...L.raw, file: canv.get(L.raw.file) };
        else if (L.raw?.link) l.raw = { ...L.raw, file: null, handle: null };
        else l.raw = null;
        if (L.kind === 'smart') Object.assign(l, { source: get(L.source), fmask: L.fmask ? { ...L.fmask, canvas: get(L.fmask.canvas) } : null });
        return l;
      }),
    },
  }));
  if (!entries.length || !entries[0].snap.layers.length) throw new Error('The autosaved copy has no layers');
  nextLayerId = Math.max(nextLayerId, maxId + 1); globalRev = Math.max(globalRev, maxRev + 1);
  state.doc = { width: r.width, height: r.height, layers: [], activeId: null, selection: null, name: r.name || 'Recovered', slot: r.slot };
  history.entries = entries;
  state.crop = null; state.poly = null; state.selPreview = null; state.cloneSrc = null; state.cloneOffset = null; state.xf = null;
  restore(Math.min(entries.length - 1, Math.max(0, r.history.index)));
  for (const l of state.doc.layers) if (l.kind === 'smart') smartCache.delete(l.id);
  writtenEntry = history.entries[history.index]; cleanEntry = r.dirty ? null : writtenEntry;
  fitToScreen(); $('#welcome').classList.add('hidden'); updateAll(); updateHistoryPanel();
  status(`Recovered ${state.doc.name} with ${entries.length} undo step${entries.length === 1 ? '' : 's'} (autosave of ${new Date(r.savedAt).toLocaleString()}).`);
}
/** v0.3 records: the layers of one state, without history. */
async function restoreLegacyAutosave(r) {
  const layers = [];
  for (const L of r.layers || []) {
    const img = await decodeImage(L.png ?? L.blob);
    const l = createLayer(L.name, img.width, img.height, { visible: L.visible, opacity: L.opacity, blend: L.blend, x: L.x, y: L.y });
    l.canvas.getContext('2d').drawImage(img, 0, 0); img.close?.();
    if (L.mask?.png || L.mask?.blob) {
      const mi = await decodeImage(L.mask.png ?? L.mask.blob), m = makeCanvas(mi.width, mi.height);
      m.getContext('2d').drawImage(mi, 0, 0); mi.close?.();
      l.mask = { canvas: m, enabled: L.mask.enabled !== false, rev: ++globalRev };
    }
    if (L.kind === 'adjust' && L.adj && l.mask) Object.assign(l, { kind: 'adjust', adj: L.adj, editMask: true });
    if (L.kind === 'text' && L.text) Object.assign(l, { kind: 'text', text: L.text });
    layers.push(l);
  }
  if (!layers.length) throw new Error('The autosaved copy has no layers');
  const ai = Math.min(layers.length - 1, Math.max(0, r.activeIndex ?? layers.length - 1));
  state.doc = { width: r.width, height: r.height, layers, activeId: layers[ai].id, selection: null, name: r.name || 'Recovered', slot: r.slot };
  afterDocChange('Recovered from autosave');
  status(`Recovered ${state.doc.name} (${layers.length} layer${layers.length === 1 ? '' : 's'}) from the autosave of ${new Date(r.savedAt).toLocaleString()}.`);
}
const recordLayers = (r) => r.layerCount ?? r.layers?.length ?? 0;
/**
 * On start-up, offer the documents that closed with unsaved changes; File ▸ Recover autosave lists
 * every slot (up to MAX_SLOTS documents, each with its recent undo history).
 */
// Documents open in another Tintwork window are not "closed with unsaved changes": ask the other windows
// which autosave slots they hold (they answer over a BroadcastChannel) and leave those out of the prompt.
const liveChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tintwork.live') : null;
liveChannel?.addEventListener('message', (e) => {
  if (e.data?.type === 'who') liveChannel.postMessage({ type: 'open', slots: tabs.map((t) => t.doc?.slot).filter(Boolean) });
});
function otherWindowSlots(wait = 250) {
  if (!liveChannel) return Promise.resolve(new Set());
  const slots = new Set(), on = (e) => { if (e.data?.type === 'open') e.data.slots.forEach((s) => slots.add(s)); };
  liveChannel.addEventListener('message', on); liveChannel.postMessage({ type: 'who' });
  return new Promise((r) => setTimeout(() => { liveChannel.removeEventListener('message', on); r(slots); }, wait));
}
async function checkRecovery(manual = false) {
  let list; try { list = await listAutosaves(); } catch (err) { if (manual) status(`Autosave unavailable: ${err?.message || err}`); return; }
  const live = await otherWindowSlots(), mine = new Set(tabs.map((t) => t.doc?.slot));
  list = list.filter((r) => recordLayers(r) > 0 && (manual || r.dirty) && !live.has(r.slot) && !(manual && mine.has(r.slot) && r.slot !== doc()?.slot));
  if (!list.length || (!manual && doc())) { if (manual) status('There is no autosaved document.'); return; }
  recoveryPending = true;
  const body = document.createElement('div');
  const row = (r) => `<li class="slot-row" data-slot="${escapeHtml(r.slot)}"><div class="slot-info"><b>${escapeHtml(r.name || 'Untitled')}</b>` +
    `<span class="muted">${r.width} × ${r.height} px · ${recordLayers(r)} layer${recordLayers(r) === 1 ? '' : 's'}${r.steps ? ` · ${r.steps} undo step${r.steps === 1 ? '' : 's'}` : ''} · ${escapeHtml(new Date(r.savedAt).toLocaleString())}${r.dirty ? ' · <em>unsaved</em>' : ''}</span></div>` +
    `<button type="button" data-recover="${escapeHtml(r.slot)}" class="primary">Recover</button><button type="button" data-forget="${escapeHtml(r.slot)}" title="Delete this autosave">✕</button></li>`;
  const draw = () => {
    body.innerHTML = `<p class="recover-info">${manual ? `Autosaved documents (the ${MAX_SLOTS} most recent are kept):` : `${APP} closed with unsaved changes. Autosaved cop${list.length === 1 ? 'y' : 'ies'} found:`}</p>` +
      `<ul class="slot-list">${list.map(row).join('')}</ul>` +
      (manual && doc() ? '<p class="muted">Recovering replaces the open document.</p>' : manual ? '' : '<p class="muted">Discard deletes these autosaved copies.</p>');
  };
  const recover = (r) => { recoveryPending = false; closeModal(); restoreAutosave(r).catch((err) => openInfo('Recovery failed', `<p>${escapeHtml(err.message)}</p>`)); };
  body.addEventListener('click', (e) => {
    const rb = e.target.closest('[data-recover]');
    if (rb) { recover(list.find((r) => r.slot === rb.dataset.recover)); return; }
    const fb = e.target.closest('[data-forget]');
    if (fb) {
      const slot = fb.dataset.forget; list = list.filter((r) => r.slot !== slot); clearAutosave(slot).catch(() => {});
      if (!list.length) { recoveryPending = false; closeModal(); status('Autosave deleted.'); } else draw();
    }
  });
  draw();
  showModal({
    title: manual ? 'Recover autosave' : 'Recover unsaved work?', body,
    okLabel: list.length > 1 ? 'Recover newest' : 'Recover', cancelLabel: manual ? 'Cancel' : 'Discard',
    ok: () => recover(list[0]),
    cancel: () => { recoveryPending = false; if (!manual) for (const r of list) clearAutosave(r.slot).catch(() => {}); },
  });
}
async function loadProject(data, filename) {
  if (data.format !== PROJECT_FORMAT) throw new Error('Not a Tintwork project file');
  const layers = [];
  for (const L of data.layers) {
    const img = await loadImage(L.data);
    const l = createLayer(L.name, img.width, img.height, { visible: L.visible, opacity: L.opacity, blend: L.blend, x: L.x, y: L.y });
    if (L.kind === 'adjust' && L.adj && L.mask?.data) Object.assign(l, { kind: 'adjust', adj: L.adj, editMask: true });
    if (L.kind === 'text' && L.text) Object.assign(l, { kind: 'text', text: L.text });
    if (L.kind === 'group') Object.assign(l, { kind: 'group', collapsed: !!L.collapsed, editMask: true });
    if (L.look) l.look = L.look;
    if (L.lut && L.adj?.type === 'lut3d' && L.adj.params?.lut) { try { lutRegistry.set(L.adj.params.lut, lutDecode(L.lut)); } catch { /* bad LUT data: the layer shows nothing */ } }
    if (L.clip) l.clip = true;
    if (L.styles) l.styles = normalizeStyles(L.styles);
    l.canvas.getContext('2d').drawImage(img, 0, 0);
    if (L.kind === 'smart' && L.source) {
      const si = await loadImage(L.source), src = makeCanvas(si.width, si.height); src.getContext('2d').drawImage(si, 0, 0);
      let fmask = null;
      if (L.fmask?.data) { const fi = await loadImage(L.fmask.data), f = makeCanvas(fi.width, fi.height); f.getContext('2d').drawImage(fi, 0, 0); fmask = { canvas: f, enabled: L.fmask.enabled !== false, rev: ++globalRev }; }
      Object.assign(l, { kind: 'smart', source: src, filters: (L.filters || []).filter((f) => ADJ[f.type]), fmask, editFMask: false });
    }
    if (L.mask?.data) {
      const mi = await loadImage(L.mask.data);
      const m = makeCanvas(mi.width, mi.height); m.getContext('2d').drawImage(mi, 0, 0);
      l.mask = { canvas: m, enabled: L.mask.enabled !== false, rev: ++globalRev };
    }
    if (L.deep && !l.kind && data.depth === 16) {
      const dd = deepFromDataURL(L.deep);
      if (dd.width === l.canvas.width && dd.height === l.canvas.height) setDeep(l, dd);
    }
    if ((L.raw?.data || L.raw?.link) && !l.kind) l.rawPending = L.raw; // attached below, once the layer revisions are final
    layers.push(l);
  }
  if (!layers.length) throw new Error('Project has no layers');
  data.layers.forEach((L, i) => { const g = layers[L.parent]; if (L.parent >= 0 && isGroup(g)) layers[i].parent = g.id; });
  for (const l of layers) if (l.kind === 'smart') renderSmartSync(l);
  const ai = Math.min(layers.length - 1, Math.max(0, data.activeIndex ?? layers.length - 1));
  state.doc = { width: data.width, height: data.height, layers, activeId: layers[ai].id, selection: null, name: filename || data.name || 'Untitled', depth: data.depth === 16 ? 16 : 8 };
  normalizeTree(state.doc);
  for (const l of layers) if (l.rawPending) {
    const R = l.rawPending; delete l.rawPending;
    try {
      let file = null;
      if (R.data) {
        const bin = atob(R.data.slice(R.data.indexOf(',') + 1)), b = new Uint8Array(bin.length);
        for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i);
        file = new File([b], R.name || 'camera.raw', { type: R.type || '' });
      }
      const m = R.m && ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => Number.isFinite(+R.m[k])) ? Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, +R.m[k]])) : null;
      l.raw = { ...rawSource(file, R.format, R.settings, R.width, R.height, R.edited ? -1 : l.rev, { name: R.name, size: R.size, type: R.type }),
        m: m || { a: 1, b: 0, c: 0, d: 1, e: +R.cx || 0, f: +R.cy || 0 }, cx: m ? R.cx ?? null : +R.cx || 0, cy: m ? R.cy ?? null : +R.cy || 0, cw: +R.cw || l.canvas.width, ch: +R.ch || l.canvas.height,
        ...(R.untracked ? { untracked: String(R.untracked) } : {}),
        ...(R.link && typeof R.link.id === 'string' ? { link: { id: R.link.id, name: String(R.link.name || R.name || ''), size: +R.link.size || 0, lastModified: +R.link.lastModified || 0 }, handle: null } : {}) };
    } catch (err) { console.warn('RAW source in the project could not be read', err); }
  }
  afterDocChange('Open project');
  status(`Opened project ${filename} (${layers.length} layers)`);
}

// drag & drop: opens a file when nothing is open, otherwise places it as a new layer (hold Shift to open instead)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (!e.dataTransfer?.types?.includes('Files')) return; dragDepth++; $('#dropzone').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropzone').classList.add('hidden');
  if (batchDrop) { batchDrop(e); return; } // the Batch process dialog is open: dropped files / a folder become its source
  const files = [...(e.dataTransfer?.files || [])];
  // file handles (Chrome / Edge): must be asked for during the drop event; RAW files can then be linked
  const hp = [...(e.dataTransfer?.items || [])].filter((it) => it.kind === 'file').map((it) => (typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle().catch(() => null) : null));
  if (hp.length === files.length) { const hs = await Promise.all(hp); hs.forEach((h, i) => { if (h?.kind === 'file' && h.name === files[i].name) fileHandleOf.set(files[i], h); }); }
  for (let i = 0; i < files.length; i++) {
    const isProject = /\.(json|tintwork)$/i.test(files[i].name);
    await openFile(files[i], doc() && !isProject && !(i === 0 && e.shiftKey) ? 'place' : 'open');
  }
});
window.addEventListener('beforeunload', (e) => { stashTab(); if (tabs.some(tabDirty)) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------------------
// UI building
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v1.0 polish: memory guardrails, global error handling, welcome screen, user guide, accessibility
// ---------------------------------------------------------------------------
/** Rough memory budget for a document: every layer keeps an RGBA canvas (16-bit documents add 8 bytes per pixel),
 *  plus the composite, the adjustment caches and undo snapshots. Returns { level: 'ok' | 'warn' | 'refuse', msg, mp, maxPixels }. */
const MEM_LIMIT_MB = (() => { const lim = performance.memory?.jsHeapSizeLimit; const dev = navigator.deviceMemory; return Math.max(1024, Math.min(lim ? lim / 2 ** 20 : 4096, dev ? dev * 1024 * 0.6 : 4096)); })();
function estimateMB(w, h, layers = 1, deep = false) { return (w * h * (4 * (layers + 3) + (deep ? 8 * layers : 0))) / 2 ** 20; }
function guardSize(w, h, layers = 1, deep = false) {
  const mp = Math.round((w * h) / 1e5) / 10, mb = estimateMB(w, h, layers, deep);
  const perPixel = (4 * (layers + 3) + (deep ? 8 * layers : 0)), maxPixels = Math.floor((MEM_LIMIT_MB * 0.8 * 2 ** 20) / perPixel);
  if (w > 16384 || h > 16384 || w * h > 268_000_000 || mb > MEM_LIMIT_MB * 0.8)
    return { level: 'refuse', mp, maxPixels: Math.min(maxPixels, 268_000_000), msg: `That needs about ${Math.round(mb)} MB, more than this browser can safely use (about ${Math.round(MEM_LIMIT_MB * 0.8)} MB). Try a smaller size or fewer layers.` };
  if (mb > MEM_LIMIT_MB * 0.4) return { level: 'warn', mp, maxPixels, msg: `Large document (${mp} MP, about ${Math.round(mb)} MB). Editing may be slow; save often.` };
  return { level: 'ok', mp, maxPixels, msg: '' };
}
function downscaleToFit(img, maxPixels) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, k = Math.min(1, Math.sqrt(maxPixels / (w * h)), 16384 / w, 16384 / h);
  const c = makeCanvas(Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))), x = ctxOf(c);
  x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
  c.naturalWidth = c.width; c.naturalHeight = c.height; return c;
}
function confirmAsync(text, okLabel = 'OK') {
  return new Promise((res) => {
    const body = document.createElement('div'); body.innerHTML = `<p>${escapeHtml(text)}</p>`;
    showModal({ title: APP, body, okLabel, ok: () => { res(true); }, onClose: () => res(false) });
  });
}
/** Friendly message for a failure the user should hear about; the details go to the console. */
function reportError(what, err) {
  console.error(what, err);
  const m = String(err?.message || err || '');
  const why = /memory|allocation|RangeError|Array buffer/i.test(m) ? 'The browser ran out of memory. Try a smaller image or close other documents.'
    : /quota/i.test(m) ? 'The browser storage is full.' : /permission|NotAllowed/i.test(m) ? 'Permission was denied.' : m ? `(${m.slice(0, 140)})` : '';
  toast(`${what}. ${why}`.trim(), 7000);
}
let errorCount = 0, lastErrorAt = 0;
function onGlobalError(err) {
  const m = String(err?.message || err || '');
  if (/ResizeObserver loop|Script error\.?$/.test(m) || err?.name === 'AbortError') return;
  const now = Date.now(); errorCount++;
  if (now - lastErrorAt > 4000) toast(`Something went wrong${m ? ` (${m.slice(0, 120)})` : ''}. Your work is being saved for recovery; if anything looks wrong, reload and choose Restore.`, 7000);
  lastErrorAt = now; console.error('[Tintwork] unhandled', err);
  try { if (doc()) autosaveNow().catch(() => {}); } catch { /* the autosave itself failed: nothing more to do */ }
}
addEventListener('error', (e) => onGlobalError(e.error || e.message));
addEventListener('unhandledrejection', (e) => onGlobalError(e.reason));

// Welcome screen
async function refreshWelcome() {
  const ul = $('#welcomeRecent'); if (!ul) return;
  const list = fsaSupported ? (await listRecent()).slice(0, 6) : [];
  ul.innerHTML = list.length ? list.map((r) => `<li><button class="recent-open" data-rid="${r.id}"><b>${escapeHtml(r.name)}</b> <span class="muted">${r.kind === 'project' ? 'project' : 'image'} · ${new Date(r.time).toLocaleDateString()}</span></button></li>`).join('')
    : `<li class="muted">${fsaSupported ? 'No recent files yet. Files you open or save appear here.' : 'Recent files need Chrome or Edge.'}</li>`;
  ul.onclick = async (e) => {
    const b = e.target.closest('button[data-rid]'); if (!b) return; const r = list.find((x) => x.id === b.dataset.rid); if (!r) return;
    if (!(await openHandle(r.handle))) { await removeRecent(r.id); toast(`${r.name} could not be opened (moved, deleted or permission denied) and was removed from the list.`, 5000); refreshWelcome(); }
  };
}
$('#welcomePresets')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-preset]'); if (!b) return; const [w, h] = b.dataset.preset.split('x').map(Number);
  newDocument(w, h, 'white');
});
new MutationObserver(() => { if (!$('#welcome').classList.contains('hidden')) refreshWelcome(); }).observe($('#welcome'), { attributes: true, attributeFilter: ['class'] });

// User guide (docs/USER_GUIDE.md rendered with a small Markdown subset)
function mdToHtml(md) {
  const inline = (t) => escapeHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((#[^)]+)\)/g, '<a href="$2">$1</a>');
  const out = []; let list = null, table = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`</${list}>`); list = null; } if (table) { out.push('</table>'); table = null; } };
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd(); let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,3})\s+(.*)/.exec(line))) { flush(); out.push(`<h${m[1].length} id="${slug(m[2])}">${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = /^\s*[-*]\s+(.*)/.exec(line))) { if (para.length) flush(); if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = /^\s*\d+\.\s+(.*)/.exec(line))) { if (para.length) flush(); if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (/^\|/.test(line)) { if (/^\|[\s:|-]+\|$/.test(line)) continue; if (!table) { flush(); out.push('<table>'); table = 1; } out.push(`<tr>${line.slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`); continue; }
    if (list || table) flush();
    para.push(line.trim());
  }
  flush(); return out.join('\n');
}
async function openUserGuide() {
  let md;
  try { md = (await import('./user-guide.js')).default; }
  catch (err) { reportError('The user guide could not be loaded', err); return; }
  const body = document.createElement('div'); body.className = 'help-doc'; body.tabIndex = 0;
  body.innerHTML = platformText(mdToHtml(md));
  const toc = document.createElement('nav'); toc.className = 'help-toc'; toc.setAttribute('aria-label', 'Contents');
  toc.innerHTML = [...body.querySelectorAll('h2')].map((h) => `<a href="#${h.id}">${h.textContent}</a>`).join('');
  body.prepend(toc);
  body.addEventListener('click', (e) => { const a = e.target.closest('a[href^="#"]'); if (!a) return; e.preventDefault(); body.querySelector(a.getAttribute('href'))?.scrollIntoView({ block: 'start' }); });
  showModal({ title: `${APP} user guide`, body, okLabel: 'Close', hideCancel: true, ok: () => {} });
}

// Accessibility: every icon-only control gets an accessible name from its tooltip.
function labelControls(root = document) {
  for (const el of root.querySelectorAll('button, input, select, [role="button"]')) {
    if (el.hasAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
    const txt = (el.textContent || '').trim();
    const t = el.title || el.dataset.tip || el.closest('label')?.textContent?.trim();
    if ((!txt || el.tagName !== 'BUTTON') && t && !el.closest('label')) el.setAttribute('aria-label', t);
  }
}
labelControls(); new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) labelControls(n); }).observe(document.body, { childList: true, subtree: true });

/**
 * Soft proof (v1.10): a view-only preview of how a print compresses the image between the paper's white and the
 * darkest black its ink reaches (an SVG filter on the view, worked in linear light; pixels and exports are unchanged).
 * Approximate typical papers, not a printer profile: no ICC profiles are read or applied.
 */
/**
 * Soft-proof paper list (v1.14): typical stocks only — no ICC. Last paper + ink-warning preference are remembered.
 * `cmy` is an approximate CMY ink-load view (desaturated), not a printer CMYK conversion.
 */
const PROOF_PAPERS = {
  glossy: { name: 'glossy paper', white: [246, 245, 240], black: [22, 22, 24], inkLimit: 2.8 },
  matte: { name: 'matte paper', white: [240, 238, 230], black: [48, 47, 46], inkLimit: 2.4 },
  rag: { name: 'photo rag / fine art', white: [245, 242, 235], black: [42, 40, 38], inkLimit: 2.6 },
  newsprint: { name: 'newsprint', white: [232, 228, 214], black: [55, 52, 48], inkLimit: 2.2 },
  cmy: { name: 'approximate CMY ink load', white: [255, 255, 255], black: [0, 0, 0], inkLimit: 3.0, cmyView: true },
};
const PROOF_LAST_KEY = 'tintwork.proofLast';
let proofMode = null, proofWarn = false;
const srgbToLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function saveProofPrefs() {
  // Remember the last *paper* (and its ink-warning), not "off" — so View ▸ Proof: last used works after turning proof off.
  if (!proofMode) return;
  try { localStorage.setItem(PROOF_LAST_KEY, JSON.stringify({ mode: proofMode, warn: !!proofWarn })); } catch { /* private */ }
}
function loadProofPrefs() {
  try {
    const j = JSON.parse(localStorage.getItem(PROOF_LAST_KEY) || 'null');
    if (!j || !j.mode || !PROOF_PAPERS[j.mode]) return;
    setProof(j.mode, { quiet: true, skipSave: true });
    if (j.warn) setProofWarn(true, { quiet: true, skipSave: true });
  } catch { /* ignore */ }
}
function setProof(mode, { quiet = false, skipSave = false } = {}) {
  proofMode = PROOF_PAPERS[mode] ? mode : null;
  if (!proofMode) proofWarn = false;
  let svg = document.getElementById('twProofSvg');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'twProofSvg'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute'; document.body.append(svg); }
  const viewEl = document.getElementById('view');
  if (!proofMode) {
    viewEl.style.filter = ''; svg.innerHTML = ''; viewEl.classList.remove('tw-cmy-proof');
    if (!quiet) status('Proof off.');
    if (!skipSave) saveProofPrefs();
    requestRender(); return null;
  }
  const p = PROOF_PAPERS[proofMode];
  viewEl.classList.toggle('tw-cmy-proof', !!p.cmyView);
  if (p.cmyView) {
    // Honest approximate CMY: show ink load as grey (C+M+Y), not a fake printer profile.
    svg.innerHTML = '';
    viewEl.style.filter = 'grayscale(1) contrast(1.05)';
    if (!quiet) status(`Proof: ${p.name} (view only — greyscale of approximate CMY ink; not ICC CMYK).${proofWarn ? ' · ink warning on' : ''}`);
  } else {
    const f = (i) => { const w = srgbToLin(p.white[i]), b = srgbToLin(p.black[i]); return `slope="${(w - b).toFixed(5)}" intercept="${b.toFixed(5)}"`; };
    svg.innerHTML = `<filter id="twProof" color-interpolation-filters="linearRGB"><feComponentTransfer><feFuncR type="linear" ${f(0)}/><feFuncG type="linear" ${f(1)}/><feFuncB type="linear" ${f(2)}/></feComponentTransfer></filter>`;
    viewEl.style.filter = 'url(#twProof)';
    if (!quiet) status(`Proof: ${p.name}${proofWarn ? ' · ink warning on' : ''} (paper white and ink black on screen only; no ICC printer profile).`);
  }
  if (!skipSave) saveProofPrefs();
  requestRender();
  return proofMode;
}
/** Toggle a magenta overlay for pixels that would crush to paper white/black or exceed an approximate ink limit (no ICC). */
function setProofWarn(on, { quiet = false, skipSave = false } = {}) {
  proofWarn = !!on && !!proofMode;
  if (on && !proofMode) { if (!quiet) status('Turn on a paper proof first (View ▸ Proof…), then enable the ink warning.'); return false; }
  if (!quiet) status(proofWarn ? `Proof ink warning on (${PROOF_PAPERS[proofMode].name}, ~${Math.round(PROOF_PAPERS[proofMode].inkLimit * 100)}% CMY limit + crushed highlights/shadows).` : 'Proof ink warning off.');
  if (!skipSave) saveProofPrefs();
  requestRender();
  return proofWarn;
}
/**
 * Approximate out-of-range mask for the soft-proof papers (v1.13): no ICC. Flags (1) channels that the paper
 * white/black mapping would crush (detail lost near the ends) and (2) an ink-limit style sum of complementary CMY.
 */
function proofWarnMask(img, paper) {
  const { data, width: w, height: h } = img, out = new Uint8ClampedArray(w * h * 4);
  const wLin = paper.white.map(srgbToLin), bLin = paper.black.map(srgbToLin), lim = paper.inkLimit;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 8) continue;
    const rl = srgbToLin(data[i]), gl = srgbToLin(data[i + 1]), bl = srgbToLin(data[i + 2]);
    // crush: brighter than the paper can print, or darker than its ink black
    const crush = rl > wLin[0] + 1e-4 || gl > wLin[1] + 1e-4 || bl > wLin[2] + 1e-4
      || rl < bLin[0] - 1e-4 || gl < bLin[1] - 1e-4 || bl < bLin[2] - 1e-4;
    // approximate CMY ink load (no undercolour removal — conservative vs a real TAC)
    const ink = (1 - rl) + (1 - gl) + (1 - bl);
    if (crush || ink > lim) { const o = p * 4; out[o] = 255; out[o + 1] = 0; out[o + 2] = 180; out[o + 3] = 140; }
  }
  return out;
}
function status(msg) { $('#status').textContent = platformText(msg); }
let toastTimer = 0, toastUntil = 0;
/** Brief notice. A notice arriving while another is still showing is added below it, so neither is lost. */
function toast(msg, ms = 2200) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  const text = platformText(msg), now = performance.now();
  const prev = now < toastUntil && !t.classList.contains('fade') ? t.textContent.split('\n').filter((x) => x && x !== text).slice(-1) : [];
  t.style.whiteSpace = 'pre-line'; t.textContent = [...prev, text].join('\n'); t.classList.remove('fade'); status(msg);
  ms = Math.max(ms, toastUntil - now); toastUntil = now + ms;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('fade'), ms);
}
function setFg(hex) { state.fg = hex; $('#fgColor').value = hex; $('#colorHex').textContent = hex.toUpperCase(); }
function setBg(hex) { state.bg = hex; $('#bgColor').value = hex; }
$('#fgColor').addEventListener('input', (e) => setFg(e.target.value));
$('#bgColor').addEventListener('input', (e) => setBg(e.target.value));
$('#swapColors').addEventListener('click', () => run('swapColors'));
$('#resetColors').addEventListener('click', () => run('resetColors'));

function buildMenus() {
  const nav = $('#menus');
  for (const [title, items] of MENUS) {
    const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'none');
    const b = document.createElement('button'); b.textContent = title; b.setAttribute('role', 'menuitem'); b.setAttribute('aria-haspopup', 'true'); m.append(b);
    const list = document.createElement('div'); list.className = 'menu-items'; list.setAttribute('role', 'menu'); list.setAttribute('aria-label', title);
    for (const it of items) {
      if (it === '-') { list.append(document.createElement('hr')); continue; }
      const [label, cmd, key] = it;
      const ib = document.createElement('button'); ib.dataset.cmd = cmd; ib.setAttribute('role', 'menuitem');
      const kl = shortcutLabel(cmd, key); if (kl) ib.title = `${label} (${kl})`;
      ib.innerHTML = `<span>${label}</span>${kl ? `<kbd>${kl}</kbd>` : ''}`;
      list.append(ib);
    }
    m.append(list); nav.append(m);
    b.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); });
    b.addEventListener('mouseenter', () => { if (document.querySelector('.menu.open') && !m.classList.contains('open')) { closeMenus(); m.classList.add('open'); } });
  }
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
// v1.7 keyboard access to the menu bar (the Windows convention): Alt on its own or F10 focuses the first menu;
// ←/→ move between menus, ↓/Enter opens one, ↑/↓ move through its items, Esc steps back out.
{
  const nav = $('#menus');
  nav.setAttribute('role', 'menubar');
  const tops = () => [...nav.querySelectorAll('.menu > button')];
  const items = (m) => [...m.querySelectorAll('.menu-items button:not(:disabled)')];
  const openAt = (m, focusFirst) => { closeMenus(); m.classList.add('open'); if (focusFirst) items(m)[0]?.focus(); };
  let altAlone = false;
  const focusBar = () => { const b = tops()[0]; if (b) { b.focus(); status('Menu bar: ←/→ choose a menu, ↓ or Enter opens it, Esc returns to the image.'); } };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.metaKey) { altAlone = !e.repeat; if (!IS_MAC) e.preventDefault(); return; }
    altAlone = false;
    if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && $('#modal').classList.contains('hidden')) {
      e.preventDefault(); if (nav.contains(document.activeElement)) { closeMenus(); document.activeElement.blur(); } else focusBar();
    }
  }, true);
  window.addEventListener('pointerdown', () => { altAlone = false; }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt' || !altAlone || IS_MAC) return; altAlone = false;
    if (!$('#modal').classList.contains('hidden') || !nav.offsetParent) return;
    e.preventDefault();
    if (nav.contains(document.activeElement)) { closeMenus(); document.activeElement.blur(); } else focusBar();
  }, true);
  nav.addEventListener('keydown', (e) => {
    const t = tops(), a = document.activeElement, m = a && a.closest('.menu'); if (!m) return;
    const ti = t.indexOf(m.querySelector(':scope > button')), inItems = a.closest('.menu-items');
    const go = (d) => { const nb = t[(ti + d + t.length) % t.length]; if (m.classList.contains('open')) openAt(nb.parentElement, true); else nb.focus(); };
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (!inItems && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openAt(m, true); }
    else if (inItems && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); const it = items(m), i = it.indexOf(a); it[(i + (e.key === 'ArrowDown' ? 1 : -1) + it.length) % it.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (m.classList.contains('open')) { closeMenus(); t[ti].focus(); } else a.blur(); }
    else if (e.key === 'Tab') { closeMenus(); }
  });
}
// v1.7: keep Tab inside an open dialog (focus trap), like a desktop dialog box
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
  const modal = $('#modal'); if (!modal || modal.classList.contains('hidden')) return;
  const f = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"]), a[href]')].filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex >= 0);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (i < 0) { e.preventDefault(); f[0].focus(); return; }
  if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
}, true);
function openSheet(name) {
  const cur = document.body.dataset.sheet || '';
  document.body.dataset.sheet = cur === name ? '' : name;
  document.querySelectorAll('#mobilebar [data-sheet], #menuBtn').forEach((b) => b.classList.toggle('on', b.dataset.sheet === document.body.dataset.sheet));
  if (document.body.dataset.sheet === 'layers') updateLayersPanel();
}
function closeSheet() { if (document.body.dataset.sheet) openSheet(document.body.dataset.sheet); }
function buildSheets() {
  const group = (title, items) => `<h3>${title}</h3><div class="grid">${items.filter((it) => it !== '-').map(([label, cmd]) => `<button data-cmd="${cmd}">${label}</button>`).join('')}</div>`;
  $('#menuSheet .sheet-groups').innerHTML = MENUS.filter(([t]) => t !== 'Adjust' && t !== 'Filter').map(([t, items]) => group(t, items)).join('');
  $('#adjustSheet .sheet-groups').innerHTML = MENUS.filter(([t]) => t === 'Adjust' || t === 'Filter').map(([t, items]) => group(t, items)).join('');
}
document.addEventListener('click', (e) => {
  const sh = e.target.closest('button[data-sheet]');
  if (sh) { openSheet(sh.dataset.sheet); return; }
  const md = e.target.closest('[data-mod]');
  if (md) { setMod(md.dataset.mod, !mods[md.dataset.mod]); return; }
  const c = e.target.closest('[data-cmd]');
  if (c) { if (c.closest('#menuSheet, #adjustSheet, #mobilebar')) closeSheet(); run(c.dataset.cmd); return; }
  if (!e.target.closest('.menu')) closeMenus();
});

function buildToolbar() {
  const tb = $('#toolbar');
  for (const t of TOOLS) {
    if (t.sep) { const s = document.createElement('div'); s.className = 'sep'; tb.append(s); continue; }
    const b = document.createElement('button'); b.dataset.tool = t.id; b.title = platformText(`${t.name} (${t.key})`);
    b.innerHTML = ICONS[t.id]; b.addEventListener('click', () => setTool(t.id)); tb.append(b);
  }
}

function buildOptionsBar() {
  const bar = $('#optionsbar'); const o = state.opts; const t = TOOLS.find((x) => x.id === state.tool);
  const parts = state.mxf ? mxfBarParts() : state.xf ? xfBarParts() : [`<span class="tool-title">${t.name}</span>`];
  const range = (key, label, min, max, unit = '') => `<label>${label} <input type="range" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" /><input type="number" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" />${unit}</label>`;
  const seg = (key, choices) => `<span class="seg">${choices.map(([v, label]) => `<button data-seg="${key}" data-val="${v}" class="${o[key] === v ? 'on' : ''}">${label}</button>`).join('')}</span>`;
  const d = doc();
  switch (state.xf || state.mxf ? '' : state.tool) {
    case 'brush': parts.push(range('brushSize', 'Size', 1, 1000, 'px'), range('brushHardness', 'Hardness', 0, 100, '%'), range('brushOpacity', 'Opacity', 1, 100, '%'), range('smoothing', 'Smoothing', 0, 100, '%'), `<span class="muted">${platformText('Shift+click: straight line · Alt+click: pick color · [ ] size · Shift+[ ] hardness')}</span>`); break;
    case 'eraser': parts.push(range('eraserSize', 'Size', 1, 1000, 'px'), range('eraserHardness', 'Hardness', 0, 100, '%'), range('eraserOpacity', 'Opacity', 1, 100, '%'), range('smoothing', 'Smoothing', 0, 100, '%')); break;
    case 'clone': parts.push(range('cloneSize', 'Size', 1, 500, 'px'), range('cloneHardness', 'Hardness', 0, 100, '%'), range('cloneOpacity', 'Opacity', 1, 100, '%'),
      `<label><input type="checkbox" data-opt="cloneAligned" ${o.cloneAligned ? 'checked' : ''}/> Aligned</label>`,
      `<span class="muted">${state.cloneSrc ? `Source ${Math.round(state.cloneSrc.x)}, ${Math.round(state.cloneSrc.y)}` : 'Alt+click to set the source'}</span>`); break;
    case 'heal': parts.push(range('healSize', 'Size', 1, 500, 'px'), range('healHardness', 'Hardness', 0, 100, '%'),
      `<label><input type="checkbox" data-opt="cloneAligned" ${o.cloneAligned ? 'checked' : ''}/> Aligned</label>`,
      `<span class="muted">${state.cloneSrc ? `Source ${Math.round(state.cloneSrc.x)}, ${Math.round(state.cloneSrc.y)} · texture is color-matched when you release` : 'Alt+click to set the source'}</span>`); break;
    case 'spot': parts.push(range('spotSize', 'Size', 1, 300, 'px'), range('spotHardness', 'Hardness', 0, 100, '%'),
      `<span class="muted">Paint over a blemish; a matching patch nearby is picked automatically</span>`); break;
    case 'objsel': {
      const s = state.objSel, sl = d?.selection;
      parts.push(`<span class="seg">${['new', 'add', 'subtract', 'intersect'].map((m) => `<button data-selmode="${m}" class="${o.selMode === m ? 'on' : ''}" title="How a new box combines with the current selection">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</span>`,
        `<span class="seg" title="What dragging does once there is an object">${[['box', 'Box'], ['fg', '+ Subject'], ['bg', '− Background']].map(([k, n]) => `<button data-objpaint="${k}" class="${o.objPaint === k ? 'on' : ''}">${n}</button>`).join('')}</span>`,
        range('objBrush', 'Brush', 2, 400, 'px'),
        `<label title="Soften the outline along fine edges such as hair"><input type="checkbox" data-opt="objRefine" ${o.objRefine !== false ? 'checked' : ''}/> Refine edges</label>`,
        `<span class="muted">${s ? platformText(`${s.strokes.length} stroke${s.strokes.length === 1 ? '' : 's'} · +Subject / −Background (or Shift / Alt) · Enter keeps · Esc cancels`) : 'Drag a box around the subject'}${sl ? ` · ${sl.w} × ${sl.h} px` : ''}</span>`);
      if (s) parts.push(`<button data-cmd="objSelUndo" ${s.strokes.length ? '' : 'disabled'}>Undo stroke</button>`, `<button data-cmd="objSelDone" class="primary">Done</button>`, `<button data-cmd="objSelDoneFeather" title="Keep the selection and feather it by the current Feather radius (${o.featherRadius} px)">Done + feather</button>`);
      parts.push(`<button data-cmd="invertSelection">Invert</button>`, `<button data-cmd="deselect">Deselect</button>`);
      break;
    }
    case 'lasso': case 'polylasso': case 'wand': case 'select': case 'ellipse': {
      const s = d?.selection;
      parts.push(`<span class="seg">${['new', 'add', 'subtract', 'intersect'].map((m) => `<button data-selmode="${m}" class="${o.selMode === m ? 'on' : ''}" title="${m === 'new' ? 'New selection' : m === 'add' ? 'Add (Shift)' : m === 'subtract' ? 'Subtract (Alt)' : 'Intersect (Shift+Alt)'}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</span>`);
      if (state.tool === 'wand') parts.push(range('wandTolerance', 'Tolerance', 0, 255), `<label><input type="checkbox" data-opt="wandContiguous" ${o.wandContiguous ? 'checked' : ''}/> Contiguous</label>`, `<label><input type="checkbox" data-opt="wandSampleAll" ${o.wandSampleAll ? 'checked' : ''}/> Sample all layers</label>`);
      const hint = { select: 'Drag a rectangle', lasso: 'Drag a freehand outline', polylasso: 'Click points · double-click, Enter or click the start to close · Esc cancels', wand: 'Click a color' }[state.tool];
      if (state.tool === 'polylasso' && state.poly) parts.push(`<button data-cmd="closePolygon" class="primary poly-close">Close shape</button>`, `<button data-cmd="cancelPolygon">Cancel</button>`);
      parts.push(`<span class="muted">${s ? `${s.w} × ${s.h} px at ${s.x}, ${s.y}` : hint}</span>`, `<button data-cmd="feather">Feather…</button>`, `<button data-cmd="invertSelection">Invert</button>`, `<button data-cmd="deselect">Deselect</button>`);
      break;
    }
    case 'fill': parts.push(range('fillTolerance', 'Tolerance', 0, 255), `<label><input type="checkbox" data-opt="fillContiguous" ${o.fillContiguous ? 'checked' : ''}/> Contiguous</label>`, `<button data-cmd="fillSelection">Fill selection</button>`); break;
    case 'gradient': parts.push(seg('gradType', [['linear', 'Linear'], ['radial', 'Radial'], ['reflected', 'Reflected']]), seg('gradColors', [['fg-bg', 'Foreground → background'], ['fg-transparent', 'Foreground → transparent']]),
      `<label><input type="checkbox" data-opt="gradReverse" ${o.gradReverse ? 'checked' : ''}/> Reverse</label>`, range('gradOpacity', 'Opacity', 1, 100, '%'),
      `<span class="muted">${platformText('Drag to draw · Shift = 45° steps · on a mask: black hides, white reveals')}</span>`); break;
    case 'shape': parts.push(seg('shapeKind', [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line']]),
      o.shapeKind === 'line' ? '' : seg('shapeStyle', [['fill', 'Fill'], ['stroke', 'Stroke'], ['both', 'Fill + stroke']]),
      range('shapeStroke', o.shapeKind === 'line' ? 'Width' : 'Stroke', 1, 200, 'px'), o.shapeKind === 'rect' ? range('shapeRadius', 'Corner radius', 0, 500, 'px') : '',
      `<span class="muted">${platformText('Each shape goes on a new layer · Shift = square / circle / 45° · Ctrl = from the centre')}</span>`); break;
    case 'tone': parts.push(seg('toneMode', [['dodge', 'Dodge (lighten)'], ['burn', 'Burn (darken)']]), seg('toneRange', [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']]),
      range('toneSize', 'Size', 1, 1000, 'px'), range('toneHardness', 'Hardness', 0, 100, '%'), range('toneOpacity', 'Exposure', 1, 100, '%'), range('smoothing', 'Smoothing', 0, 100, '%'),
      `<span class="muted">${platformText('Alt = opposite mode while painting')}</span>`); break;
    case 'liquify': parts.push(seg('liquifyMode', [['push', 'Push'], ['bloat', 'Bloat'], ['pinch', 'Pinch'], ['restore', 'Restore']]),
      range('liquifySize', 'Size', 4, 1000, 'px'), range('liquifyStrength', 'Strength', 1, 100, '%'),
      `<span class="muted">${platformText('Drag to push pixels · hold still to bloat / pinch · [ ] change the size')}</span>`); break;
    case 'redeye': parts.push(range('redeyeSize', 'Pupil size', 4, 400, 'px'), range('redeyeDarken', 'Darken', 0, 100, '%'), `<span class="muted">Click the centre of each red pupil</span>`); break;
    case 'eyedropper': parts.push(`<label><input type="checkbox" data-opt="sampleAll" ${o.sampleAll ? 'checked' : ''}/> Sample all layers</label>`); break;
    case 'straighten': parts.push(`<label><input type="checkbox" data-opt="straightenCrop" ${o.straightenCrop ? 'checked' : ''}/> Crop to fit</label>`,
      `<button data-cmd="autoStraighten" class="primary">Auto straighten</button>`,
      `<span class="muted">${state.strLine ? `${Math.round(Math.atan2(state.strLine.b.y - state.strLine.a.y, state.strLine.b.x - state.strLine.a.x) * 1800 / Math.PI) / 10}°` : 'Drag along a line that should be level or vertical'}</span>`); break;
    case 'wbpick': parts.push(`<span class="muted">Click a spot that should be neutral grey or white · edits the selected white-balance layer, or adds one</span>`, `<button data-cmd="autoWhiteBalance">Auto</button>`, `<button data-cmd="adjLayer_whiteBalance">Temperature / tint layer…</button>`); break;
    case 'crop': {
      const c = state.crop;
      const cp = o.cropPreset && o.cropPreset !== 'orig' ? presetById(o.cropPreset) : null;
      // v1.14: one-click chips for common jobs (Instagram 4:5, square, 16:9, 8×10 print)
      const chips = [['sq', '1:1'], ['portrait45', '4:5'], ['land169', '16:9'], ['p8x10', '8×10'], ['orig', 'Free']];
      parts.push(`<span class="seg" title="Common crop presets">${chips.map(([id, lab]) => `<button type="button" data-cropchip="${id}" class="${o.cropPreset === id ? 'on' : ''}">${lab}</button>`).join('')}</span>`,
        `<label>Ratio <select data-croppreset title="Crop presets: social, banner and print sizes">${presetOptionsHTML(o.cropPreset)}</select></label>`,
        `<button data-cropswap title="Swap orientation" ${cropAspect() ? '' : 'disabled'}>⇄</button>`,
        `<label title="Lock the current crop's aspect ratio"><input type="checkbox" data-croplock ${o.cropLockRatio ? 'checked' : ''} ${c || o.cropLockRatio ? '' : 'disabled'}/> Lock</label>`);
      if (cp && cp.inW != null) parts.push(`<label>DPI <input type="number" data-opt="cropDpi" min="72" max="1200" value="${o.cropDpi}" style="width:60px"/></label>`);
      if (cp && cp.rw == null) parts.push(`<label title="After cropping, resize to the preset's pixel size"><input type="checkbox" data-opt="cropResize" ${o.cropResize ? 'checked' : ''}/> Resize to ${cp.inW != null ? `${Math.round((o.cropOrient === 'landscape' ? cp.inH : cp.inW) * o.cropDpi)}×${Math.round((o.cropOrient === 'landscape' ? cp.inW : cp.inH) * o.cropDpi)}` : `${cp.w}×${cp.h}`}</label>`);
      parts.push(`<span class="muted">${c ? `${c.w} × ${c.h} px` : cropAspect() ? 'Drag a crop rectangle (ratio locked)' : 'Drag a crop rectangle · Shift = square'}</span>`);
      parts.push(`<button data-cmd="cropFitInside" title="Largest crop (at the chosen ratio) with no empty or transparent corners">Fit inside image</button>`);
      if (c) parts.push(`<button data-cmd="cropApply" class="primary">Apply (Enter)</button>`, `<button data-cmd="cropCancel">Cancel (Esc)</button>`);
      break;
    }
    case 'move': { const l = activeLayer(); parts.push(`<span class="muted">${l ? `${escapeHtml(l.name)} · x ${l.x}, y ${l.y} · arrows nudge` : ''}</span>`, `<button data-cmd="flipLayerH">Flip layer H</button>`, `<button data-cmd="flipLayerV">Flip layer V</button>`); break; }
    case 'text': parts.push(`<span class="muted">Click on the canvas to place text on a new layer</span>`); break;
    case 'hand': case 'zoom': parts.push(`<button data-cmd="zoomFit">Fit</button>`, `<button data-cmd="zoom100">100%</button>`, `<button data-cmd="zoomIn">＋</button>`, `<button data-cmd="zoomOut">－</button>`); break;
    default: break;
  }
  const al = activeLayer();
  if (al && editingMask(al) && ['brush', 'eraser', 'fill', 'gradient'].includes(state.tool) && !state.xf) parts.push(`<span class="mask-badge">${editingFMask(al) ? 'Editing filter mask' : 'Editing mask'}</span>`);
  if (!state.xf && !state.mxf && d && ['select', 'lasso', 'polylasso', 'wand', 'ellipse', 'objsel'].includes(state.tool)) parts.push(`<button data-cmd="colorRange">Color range…</button>`, `<button data-cmd="refineEdge" ${d.selection ? '' : 'disabled'}>Refine edge…</button>`);
  if (!state.xf && !state.mxf && d && state.tool === 'move') parts.push(`<button data-cmd="freeTransform">Transform</button>`);
  bar.classList.toggle('xf', !!state.xf);
  bar.innerHTML = platformText(parts.join(''));
  bar.querySelectorAll('[data-xf]').forEach((inp) => inp.addEventListener('change', () => setXfField(inp.dataset.xf, +inp.value)));
  bar.querySelectorAll('[data-selmode]').forEach((b) => b.addEventListener('click', () => { o.selMode = b.dataset.selmode; buildOptionsBar(); }));
  bar.querySelectorAll('[data-objpaint]').forEach((b) => b.addEventListener('click', () => { o.objPaint = b.dataset.objpaint; buildOptionsBar(); }));
  bar.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => { o[b.dataset.seg] = b.dataset.val; buildOptionsBar(); }));
  bar.querySelector('[data-croppreset]')?.addEventListener('change', (e) => setCropPreset(e.target.value));
  bar.querySelectorAll('[data-cropchip]').forEach((b) => b.addEventListener('click', () => setCropPreset(b.dataset.cropchip)));
  bar.querySelector('[data-cropswap]')?.addEventListener('click', () => {
    const d = doc(), a = cropAspect(); if (!a) return;
    if (o.cropLockRatio) o.cropLockRatio = { w: a.h, h: a.w }; else { const land = a.w > a.h; o.cropOrient = land ? 'portrait' : 'landscape'; if (o.cropPreset === 'orig' || presetById(o.cropPreset)?.rw != null) o.cropLockRatio = { w: a.h, h: a.w }; }
    const b = cropAspect(); state.crop = centredRatioRect(d.width, d.height, b.w, b.h); buildOptionsBar(); requestRender();
  });
  bar.querySelector('[data-croplock]')?.addEventListener('change', (e) => { const c = state.crop; o.cropLockRatio = e.target.checked && c ? { w: c.w, h: c.h } : null; buildOptionsBar(); });
  bar.querySelectorAll('[data-opt]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.opt;
      o[k] = inp.type === 'checkbox' ? inp.checked : +inp.value;
      bar.querySelectorAll(`[data-opt="${k}"]`).forEach((other) => { if (other !== inp && other.type !== 'checkbox') other.value = o[k]; });
    });
  });
}

const BLEND_MODES = [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
$('#blendMode').innerHTML = BLEND_MODES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
$('#blendMode').addEventListener('change', (e) => { const l = activeLayer(); if (!l) return; l.blend = e.target.value; compDirty = true; requestRender(); commit('Blend mode'); });
$('#layerOpacity').addEventListener('input', (e) => {
  const l = activeLayer(); if (!l) return; l.opacity = e.target.value / 100; $('#layerOpacityVal').textContent = `${e.target.value}%`;
  compDirty = true; requestRender();
});
$('#layerOpacity').addEventListener('change', () => { if (activeLayer()) commit('Layer opacity'); });

let dragLayerId = null;
/** Layers panel sub-rows under a live layer: its filter mask and each filter (top = applied last). */
function smartRows(l, d, s) {
  const rows = [];
  const sub = (cls) => { const li = document.createElement('li'); li.className = `sub-row ${cls}`; li.dataset.parent = l.id; li.addEventListener('click', (e) => e.stopPropagation()); return li; };
  if (l.fmask) {
    const li = sub('fmask-row' + (editingFMask(l) && l.id === d.activeId ? ' target' : ''));
    const th = makeCanvas(40, 30), x = th.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 40, 30);
    x.save(); x.translate((40 - d.width * s) / 2, (30 - d.height * s) / 2); x.scale(s, s); x.beginPath(); x.rect(0, 0, d.width, d.height); x.clip(); x.drawImage(l.fmask.canvas, l.x, l.y); x.restore();
    if (!l.fmask.enabled) { x.strokeStyle = '#e8453a'; x.lineWidth = 2.5; x.beginPath(); x.moveTo(3, 3); x.lineTo(37, 27); x.moveTo(37, 3); x.lineTo(3, 27); x.stroke(); }
    th.className = 'thumb fmask-thumb'; th.title = 'Filter mask — click to paint it · Shift+click to enable/disable';
    th.addEventListener('click', (e) => {
      e.stopPropagation(); if (state.xf) applyTransform(); d.activeId = l.id;
      if (e.shiftKey) { l.fmask.enabled = !l.fmask.enabled; l.fmask.rev = ++globalRev; updateSmart(l, l.fmask.enabled ? 'Enable filter mask' : 'Disable filter mask'); return; }
      l.editFMask = true; l.editMask = false; status('Editing the filter mask: black hides the filters, white shows them.'); updateLayersPanel(); buildOptionsBar(); requestRender();
    });
    const label = document.createElement('span'); label.className = 'name'; label.textContent = 'Filter mask';
    li.append(th, label); rows.push(li);
  }
  for (let i = l.filters.length - 1; i >= 0; i--) {
    const f = l.filters[i], li = sub('filter-row' + (f.enabled ? '' : ' off')); li.dataset.filter = i;
    const eye = document.createElement('button'); eye.className = 'eye' + (f.enabled ? '' : ' off'); eye.innerHTML = ICONS.eye; eye.title = 'Show / hide this filter';
    eye.addEventListener('click', (e) => { e.stopPropagation(); setSmartFilters(l, l.filters.map((g, j) => (j === i ? { ...g, enabled: !g.enabled } : g)), `${f.enabled ? 'Hide' : 'Show'} live filter`); });
    const name = document.createElement('span'); name.className = 'name'; name.textContent = ADJ[f.type].title; name.title = `${filterSummary(f)} — double-click to edit`;
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); d.activeId = l.id; openSmartFilterDialog(l, i); });
    const edit = document.createElement('button'); edit.className = 'mini'; edit.textContent = '✎'; edit.title = 'Edit filter';
    edit.addEventListener('click', (e) => { e.stopPropagation(); d.activeId = l.id; openSmartFilterDialog(l, i); });
    const del = document.createElement('button'); del.className = 'mini'; del.textContent = '✕'; del.title = 'Remove filter';
    del.addEventListener('click', (e) => { e.stopPropagation(); setSmartFilters(l, l.filters.filter((_, j) => j !== i), 'Delete live filter'); });
    li.append(eye, name, edit, del); rows.push(li);
  }
  return rows;
}
/** Effect rows under a layer with styles: eye toggles one effect, double-click edits, ✕ removes. */
function styleRows(l, d, depth) {
  return l.styles.map((fx, i) => {
    const li = document.createElement('li'); li.className = 'sub-row fx-row' + (fx.enabled ? '' : ' off'); li.dataset.parent = l.id;
    li.style.paddingLeft = `${30 + depth * 16}px`; li.addEventListener('click', (e) => e.stopPropagation());
    const eye = document.createElement('button'); eye.className = 'eye' + (fx.enabled ? '' : ' off'); eye.innerHTML = ICONS.eye; eye.title = 'Show / hide this effect';
    eye.addEventListener('click', (e) => { e.stopPropagation(); l.styles = l.styles.map((g, j) => (j === i ? { ...g, enabled: !g.enabled } : g)); compDirty = true; requestRender(); commit(`${fx.enabled ? 'Hide' : 'Show'} ${FX_TYPES[fx.type].title.toLowerCase()}`); });
    const name = document.createElement('span'); name.className = 'name'; name.textContent = FX_TYPES[fx.type].title; name.title = 'Double-click to edit';
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); d.activeId = l.id; openStylesDialog(l, fx.type); });
    const del = document.createElement('button'); del.className = 'mini'; del.textContent = '✕'; del.title = 'Remove effect';
    del.addEventListener('click', (e) => { e.stopPropagation(); const n = l.styles.filter((_, j) => j !== i); l.styles = n.length ? n : null; compDirty = true; requestRender(); commit('Remove layer effect'); });
    li.append(eye, name, del); return li;
  });
}
let blendForGroup = null;
function fillBlendSelect(group) {
  if (blendForGroup === group) return; blendForGroup = group;
  $('#blendMode').innerHTML = (group ? [['pass-through', 'Pass through'], ...BLEND_MODES] : BLEND_MODES).map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
}
function updateLayersPanel() {
  updateLooksPanel();
  const ul = $('#layerList'); ul.innerHTML = '';
  const d = doc(); if (!d) return;
  fillBlendSelect(isGroup(activeLayer()));
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const l = d.layers[i], anc = ancestorsOf(d, l);
    if (anc.some((g) => g.collapsed)) continue; // inside a collapsed group
    const li = document.createElement('li'); li.draggable = true; li.dataset.id = l.id;
    if (l.id === d.activeId) li.classList.add('active');
    if (anc.length) { li.style.paddingLeft = `${6 + anc.length * 16}px`; li.dataset.depth = anc.length; }
    if (isGroup(l)) li.classList.add('group-row');
    if (l.clip && childrenOf(d, parentId(l))[0] !== l) li.classList.add('clipped');
    if (anc.some((g) => !g.visible)) li.classList.add('hidden-by-group');
    const eye = document.createElement('button'); eye.className = 'eye' + (l.visible ? '' : ' off'); eye.innerHTML = ICONS.eye; eye.title = 'Toggle visibility';
    eye.addEventListener('click', (e) => { e.stopPropagation(); l.visible = !l.visible; compDirty = true; requestRender(); commit(l.visible ? 'Show layer' : 'Hide layer'); });
    const th = makeCanvas(40, 30); const tx = th.getContext('2d');
    const s = Math.min(40 / d.width, 30 / d.height);
    tx.save(); tx.translate((40 - d.width * s) / 2, (30 - d.height * s) / 2); tx.scale(s, s);
    if (l.kind !== 'adjust' && !isGroup(l)) { tx.beginPath(); tx.rect(0, 0, d.width, d.height); tx.clip(); tx.drawImage(l.canvas, l.x, l.y); }
    tx.restore();
    if (isGroup(l)) { // folder badge
      tx.fillStyle = '#2a2c33'; tx.fillRect(0, 0, 40, 30); tx.fillStyle = '#c9a64e';
      tx.beginPath(); tx.moveTo(7, 9); tx.lineTo(16, 9); tx.lineTo(19, 12); tx.lineTo(33, 12); tx.lineTo(33, 24); tx.lineTo(7, 24); tx.closePath(); tx.fill();
    }
    if (l.kind === 'adjust') { // a simple original badge: half-filled circle
      tx.fillStyle = '#2a2c33'; tx.fillRect(0, 0, 40, 30); tx.strokeStyle = tx.fillStyle = '#d9dce2'; tx.lineWidth = 2;
      tx.beginPath(); tx.arc(20, 15, 9, 0, Math.PI * 2); tx.stroke(); tx.beginPath(); tx.arc(20, 15, 9, Math.PI / 2, Math.PI * 1.5); tx.fill();
    } else if (l.kind === 'smart') { // live-filter badge
      tx.fillStyle = '#7a5cffdd'; tx.fillRect(26, 16, 14, 14); tx.fillStyle = '#fff'; tx.font = '700 12px sans-serif'; tx.textAlign = 'center'; tx.textBaseline = 'middle'; tx.fillText('≈', 33, 23);
    } else if (l.raw) { // re-developable RAW badge
      tx.fillStyle = l.raw.link ? '#1d5f8add' : '#1d7a4ddd'; tx.fillRect(22, 18, 18, 12); tx.fillStyle = '#fff'; tx.font = '700 8px sans-serif'; tx.textAlign = 'center'; tx.textBaseline = 'middle'; tx.fillText('RAW', 31, 24.5);
      if (l.raw.link) { tx.strokeStyle = '#1d5f8a'; tx.lineWidth = 2; tx.beginPath(); tx.arc(31, 13, 3, 0, Math.PI * 2); tx.stroke(); } // linked file
    } else if (l.kind === 'text') {
      tx.fillStyle = '#000a'; tx.fillRect(26, 16, 14, 14); tx.fillStyle = '#fff'; tx.font = '700 12px sans-serif'; tx.textAlign = 'center'; tx.textBaseline = 'middle'; tx.fillText('T', 33, 23.5);
    }
    th.className = 'thumb' + (l.id === d.activeId && l.mask && !editingMask(l) ? ' target' : '');
    th.title = isGroup(l) ? `Group (${childrenOf(d, l.id).length} item${childrenOf(d, l.id).length === 1 ? '' : 's'}) — double-click for layer style` : l.kind === 'adjust' ? `${ADJ_LAYER[l.adj.type]} — double-click to edit` : l.kind === 'text' ? 'Text — double-click to edit' : l.kind === 'smart' ? 'Live filter layer — double-click to manage filters' : l.raw ? `Developed from ${l.raw.name}${l.raw.link ? ' (linked file)' : ''} — double-click to re-develop` : 'Layer pixels';
    th.addEventListener('click', (e) => { e.stopPropagation(); if (state.xf) applyTransform(); d.activeId = l.id; l.editFMask = false; if (l.kind !== 'adjust') setMaskTarget(l, false); else updateLayersPanel(); buildOptionsBar(); requestRender(); });
    if (l.kind || l.raw) th.addEventListener('dblclick', (e) => { e.stopPropagation(); d.activeId = l.id; editLayer(l); });
    let mth = null;
    if (l.mask) {
      mth = makeCanvas(40, 30); const mx = mth.getContext('2d');
      mx.fillStyle = '#000'; mx.fillRect(0, 0, 40, 30);
      mx.save(); mx.translate((40 - d.width * s) / 2, (30 - d.height * s) / 2); mx.scale(s, s);
      mx.beginPath(); mx.rect(0, 0, d.width, d.height); mx.clip(); mx.drawImage(l.mask.canvas, l.x, l.y); mx.restore();
      if (!l.mask.enabled) { mx.strokeStyle = '#e8453a'; mx.lineWidth = 2.5; mx.beginPath(); mx.moveTo(3, 3); mx.lineTo(37, 27); mx.moveTo(37, 3); mx.lineTo(3, 27); mx.stroke(); }
      mth.className = 'thumb mask-thumb' + (l.id === d.activeId && editingMask(l) ? ' target' : '');
      mth.title = `Layer mask${l.mask.enabled ? '' : ' (disabled)'} — click to edit · Shift+click to enable/disable`;
      mth.addEventListener('click', (e) => {
        e.stopPropagation(); d.activeId = l.id;
        if (e.shiftKey) { l.mask.enabled = !l.mask.enabled; touchMask(l); requestRender(); commit(l.mask.enabled ? 'Enable layer mask' : 'Disable layer mask'); return; }
        setMaskTarget(l, true); requestRender();
      });
    }
    const name = document.createElement('span'); name.className = 'name'; name.textContent = l.name; name.title = 'Double-click to rename';
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${Math.round(l.opacity * 100)}%${l.blend !== 'source-over' && l.blend !== 'pass-through' ? ' · ' + BLEND_MODES.find((b) => b[0] === l.blend)?.[1] : ''}`;
    if (isGroup(l)) {
      const tw = document.createElement('button'); tw.className = 'twisty'; tw.textContent = l.collapsed ? '▸' : '▾'; tw.title = l.collapsed ? 'Expand group' : 'Collapse group';
      tw.setAttribute('aria-expanded', String(!l.collapsed));
      tw.addEventListener('click', (e) => { e.stopPropagation(); l.collapsed = !l.collapsed; updateLayersPanel(); });
      li.append(tw);
    }
    if (li.classList.contains('clipped')) { const ar = document.createElement('span'); ar.className = 'clip-arrow'; ar.textContent = '↳'; ar.title = 'Clipped to the layer below (Ctrl+Alt+G releases)'; li.append(ar); }
    li.append(eye, th); if (mth) li.append(mth); li.append(name);
    if (l.styles?.length) {
      const fx = document.createElement('button'); fx.className = 'fx-badge' + (hasActiveStyles(l.styles) ? '' : ' off'); fx.textContent = 'fx'; fx.title = 'Layer style — click to edit';
      fx.addEventListener('click', (e) => { e.stopPropagation(); d.activeId = l.id; openStylesDialog(l); });
      li.append(fx);
    }
    li.append(meta);
    if (d.picked?.has(l.id) && l.id !== d.activeId) li.classList.add('picked');
    li.addEventListener('click', (e) => { if (state.xf) applyTransform(); pickLayer(l, e); updateLayersPanel(); buildOptionsBar(); requestRender(); });
    li.addEventListener('dblclick', () => {
      const input = document.createElement('input'); input.type = 'text'; input.value = l.name; input.style.flex = '1'; input.style.minWidth = '0';
      name.replaceWith(input); input.focus(); input.select();
      const done = () => { const v = input.value.trim(); if (v && v !== l.name) { l.name = v; commit('Rename layer'); } else updateLayersPanel(); };
      input.addEventListener('blur', done); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = l.name; input.blur(); } });
    });
    li.addEventListener('dragstart', (e) => { dragLayerId = l.id; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('application/x-tintwork-layer', String(l.id)); });
    const clearDrop = () => li.classList.remove('dragover', 'dragbelow', 'drop-into');
    li.addEventListener('dragover', (e) => {
      if (dragLayerId == null) return; e.preventDefault(); e.stopPropagation();
      const r = li.getBoundingClientRect(), f = (e.clientY - r.top) / Math.max(1, r.height);
      const zone = isGroup(l) && f > 0.25 && f < 0.75 ? 'into' : f < 0.5 ? 'above' : 'below';
      li.dataset.zone = zone; clearDrop(); li.classList.add(zone === 'into' ? 'drop-into' : zone === 'above' ? 'dragover' : 'dragbelow');
    });
    li.addEventListener('dragleave', clearDrop);
    li.addEventListener('drop', (e) => {
      if (dragLayerId == null) return;
      e.preventDefault(); e.stopPropagation(); clearDrop();
      const src = layerById(d, dragLayerId); dragLayerId = null;
      let zone = li.dataset.zone || 'above';
      if (zone === 'below' && isGroup(l) && !l.collapsed && childrenOf(d, l.id).length) zone = 'into'; // the next row is the group's top item
      if (src && src !== l && placeLayer(d, src, l, zone)) { compDirty = true; requestRender(); commit(zone === 'into' ? 'Move into group' : 'Reorder layers'); }
    });
    li.addEventListener('dragend', () => { dragLayerId = null; });
    ul.append(li);
    if (l.kind === 'smart') ul.append(...smartRows(l, d, s));
    if (l.styles?.length) ul.append(...styleRows(l, d, anc.length));
  }
  const al = activeLayer();
  document.querySelector('#layersPanel [data-cmd="addMask"]')?.classList.toggle('on', !!al.mask);
  $('#blendMode').value = al.blend;
  $('#layerOpacity').value = Math.round(al.opacity * 100);
  $('#layerOpacityVal').textContent = `${Math.round(al.opacity * 100)}%`;
}

function updateHistoryPanel() {
  scheduleAutosave();
  const ol = $('#historyList'); ol.innerHTML = '';
  history.entries.forEach((e, i) => {
    const li = document.createElement('li'); li.textContent = e.label;
    if (i === history.index) li.classList.add('current'); if (i > history.index) li.classList.add('future');
    li.addEventListener('click', () => restore(i));
    ol.append(li);
  });
  ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function drawHistogram(canvas, hist) {
  const x = canvas.getContext('2d'); const w = canvas.width, h = canvas.height;
  x.clearRect(0, 0, w, h);
  let max = 0; for (let i = 2; i < 254; i++) max = Math.max(max, hist[i]);
  if (!max) max = 1;
  x.fillStyle = '#a7adb8';
  for (let i = 0; i < 256; i++) { const v = Math.min(1, hist[i] / max) * h; x.fillRect((i / 256) * w, h - v, w / 256 + 0.6, v); }
}
let histTimer = null;
function scheduleHistogram() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    if (!doc()) return;
    freshComp();
    const s = Math.min(1, 512 / Math.max(doc().width, doc().height));
    const c = makeCanvas(doc().width * s, doc().height * s); const x = ctxOf(c); x.drawImage(comp, 0, 0, c.width, c.height);
    drawHistogram($('#histogram'), histogram(x.getImageData(0, 0, c.width, c.height)));
  }, 150);
}
function updateDocInfo() {
  try { updateTitle(); } catch { /* early boot */ }
  const d = doc(); $('#docinfo').textContent = d ? `${d.name} — ${d.width} × ${d.height} px · ${d.depth === 16 ? 16 : 8}-bit · ${d.layers.length} layer${d.layers.length > 1 ? 's' : ''} · ${engineLabel()}` : `${engineLabel()} engine`;
}
// ---- Document tabs UI (v0.9) --------------------------------------------------------------------------
function renderTabs() {
  const bar = $('#tabbar'); if (!bar) return;
  stashTab();
  bar.classList.toggle('hidden', !tabs.length);
  bar.replaceChildren(...tabs.map((t, i) => {
    const b = document.createElement('div'); b.className = 'doc-tab' + (t.doc === activeDoc ? ' active' : ''); b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.doc === activeDoc)); b.dataset.index = i; b.title = `${t.doc.name || 'Untitled'} — ${t.doc.width}×${t.doc.height}${t.doc.depth === 16 ? ', 16-bit' : ''}\nDrop a layer here to copy it into this document`;
    const n = document.createElement('span'); n.className = 'tab-name'; n.textContent = (t.doc.name || 'Untitled') + (tabDirty(t) ? ' •' : '');
    const x = document.createElement('button'); x.type = 'button'; x.className = 'tab-close'; x.textContent = '×'; x.title = `Close (${keyLabel('Ctrl+Alt+W')})`; x.setAttribute('aria-label', `Close ${t.doc.name || 'Untitled'}`);
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
    b.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } });
    b.addEventListener('click', () => switchTab(i));
    b.addEventListener('dragover', (e) => { if (dragLayerId == null || t.doc === activeDoc) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; b.classList.add('drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => { if (dragLayerId == null || t.doc === activeDoc) return; e.preventDefault(); e.stopPropagation(); b.classList.remove('drop'); const id = dragLayerId; dragLayerId = null; copyLayerToDoc(id, i); });
    b.append(n, x); return b;
  }));
}
function switchTab(i) {
  const t = tabs[(i + tabs.length) % tabs.length]; if (!t || t.doc === activeDoc) return;
  if (state.mxf) cancelMeshXf(); if (state.xf) cancelTransform(true);
  state.doc = t.doc;
  if (!t.view) fitToScreen();
  $('#welcome').classList.add('hidden'); updateAll(); updateTitle();
  status(`${t.doc.name || 'Untitled'} (${tabs.indexOf(t) + 1} of ${tabs.length})`);
}
const cycleTab = (dir) => { if (tabs.length > 1) switchTab(tabs.findIndex((t) => t.doc === activeDoc) + dir); };
/** Close tab i (default: the active one); asks first when it has unsaved changes. Resolves true when closed. */
function closeTab(i = tabs.findIndex((t) => t.doc === activeDoc), { force = false } = {}) {
  stashTab(); const t = tabs[i]; if (!t) return Promise.resolve(false);
  const doClose = () => {
    if (t.doc === activeDoc) { if (state.mxf) cancelMeshXf(); if (state.xf) cancelTransform(true); clearTimeout(autosaveTimer); autosaveTimer = null; }
    const was = t.doc === activeDoc, slot = t.doc.slot; tabs.splice(i, 1);
    if (slot) clearAutosave(slot).catch(() => {});
    if (was) {
      activeDoc = null; // the closed tab is gone: do not stash it
      const next = tabs[Math.min(i, tabs.length - 1)];
      if (next) switchTab(tabs.indexOf(next));
      else { state.doc = null; history.entries = []; history.index = -1; cleanEntry = writtenEntry = null; $('#welcome').classList.remove('hidden'); updateAll(); }
    }
    updateTitle(); return true;
  };
  if (force || !tabDirty(t)) return Promise.resolve(doClose());
  return new Promise((res) => {
    const body = document.createElement('p'); body.textContent = `“${t.doc.name || 'Untitled'}” has unsaved changes. Close it and discard them? (Save the project or export first to keep them.)`;
    showModal({ title: 'Close document?', body, okLabel: 'Discard and close', ok: () => res(doClose()), cancel: () => res(false) });
  });
}
/** Copy a layer (a group comes with its contents) from the active document into tab `ti`, centred on the same offset. */
function copyLayerToDoc(id, ti) {
  const src = doc(), l = layerById(src, id), t = tabs[ti]; if (!l || !t || t.doc === src) return false;
  const dst = t.doc, block = blockOf(src, l), ids = new Map(), dx = Math.round((dst.width - src.width) / 2), dy = Math.round((dst.height - src.height) / 2);
  const copies = block.map((x) => { const c = cloneLayerObj(x); ids.set(x.id, c.id); c.x = (x.x || 0) + dx; c.y = (x.y || 0) + dy; if (dst.depth !== 16) delete c.deep; return c; });
  for (const c of copies) c.parent = ids.has(c.parent) ? ids.get(c.parent) : null;
  const name = src.name || 'Untitled';
  switchTab(ti);
  dst.layers.push(...copies); normalizeTree(dst); dst.activeId = copies[copies.length - 1].id;
  compDirty = true; requestRender(); commit(`Layer from ${name}`); updateAll();
  status(`Copied “${l.name}” into ${dst.name || 'Untitled'}.`);
  return true;
}
function updateAll() { updateLayersPanel(); updateHistoryPanel(); buildOptionsBar(); updateDocInfo(); updateZoomLabel(); scheduleHistogram(); requestRender(); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildMenus(); buildToolbar(); buildSheets(); initEngine();
{ // Looks panel: intensity slider edits the selected look group's opacity (one history step per drag)
  const sl = $('#lookIntensity');
  sl.addEventListener('input', () => { $('#lookIntensityVal').textContent = `${sl.value}%`; setLookIntensity(+sl.value, false); });
  sl.addEventListener('change', () => setLookIntensity(+sl.value, true));
  const det = $('#looksDetails');
  det.open = localStorage.getItem('tintwork.looksOpen') === '1';
  det.addEventListener('toggle', () => { localStorage.setItem('tintwork.looksOpen', det.open ? '1' : '0'); if (det.open) updateLooksPanel(true); });
  updateLooksPanel(true);
}
// Installed app (PWA): files opened from Explorer / Finder via the manifest's file_handlers arrive here.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    for (const h of params.files || []) { try { await openHandle(h); } catch (err) { console.warn('launch file failed', err); } }
  });
}
// App shortcuts (manifest "shortcuts"): ?action=new | open | recent
{
  const act = new URLSearchParams(location.search).get('action');
  if (act) setTimeout(() => {
    if (act === 'new') run('new');
    else if (act === 'recent') run('openRecent');
    else if (act === 'open') { // the file picker needs a click, so ask for one
      const body = document.createElement('div'); body.innerHTML = '<p>Choose an image or a Tintwork project to open.</p>';
      showModal({ title: 'Open a file', body, okLabel: 'Choose file…', ok: () => run('open') });
    }
  }, 300);
}
// Window title shows the document (and the installed app's title bar uses it).
/** Window title: "name • — Tintwork" while there are unsaved changes (taskbar / installed-app title bar). */
function updateTitle() { renderTabs(); const d = doc(), dirty = d && (cleanEntry ? history.entries[history.index] !== cleanEntry : history.index > 0); document.title = d ? `${d.name || 'Untitled'}${dirty ? ' •' : ''} — ${APP}` : `${APP} — photo editor`; }
$('#toolsToggle').addEventListener('click', () => { document.body.classList.toggle('tools-collapsed'); $('#toolsToggle').classList.toggle('on', !document.body.classList.contains('tools-collapsed')); });
$('#toolsToggle').classList.add('on');
// Installable/offline: register the service worker on secure origins (https or localhost).
if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').then((reg) => {
    // long sessions: look for a deploy every hour and when the tab comes back after 10+ minutes
    let last = Date.now();
    const check = () => { last = Date.now(); reg.update().catch(() => {}); };
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60 * 1000) check(); });
  }).catch((err) => console.warn('Service worker not registered:', err)));
  // A new worker took over this page: a new version was deployed. Offer a reload (the page keeps running the old code).
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install, not an update
    showUpdateBar();
  });
}
async function swVersion() {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller; if (!c) return null;
  return new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); c.postMessage({ type: 'VERSION' }, [ch.port2]); setTimeout(() => res(null), 2000); });
}
async function showUpdateBar() {
  if ($('#updateBar')) return;
  const v = await swVersion();
  if (v && v === APP_VERSION) return; // same version (e.g. a re-deploy of identical code)
  const bar = document.createElement('div'); bar.id = 'updateBar'; bar.setAttribute('role', 'status');
  bar.innerHTML = `<span></span><button class="primary" data-act="reload">Reload</button><button data-act="later">Later</button>`;
  bar.firstChild.textContent = `A new version of Tintwork${v ? ` (${String(v).slice(0, 20)})` : ''} is ready; you are on ${APP_VERSION}. Save your work, then reload.`;
  bar.addEventListener('click', (e) => { const a = e.target.closest('button'); if (!a) return; if (a.dataset.act === 'reload') location.reload(); else bar.remove(); });
  document.body.append(bar);
}
document.querySelectorAll('.panel-actions [data-cmd]').forEach((b) => { b.innerHTML = ICONS[b.dataset.cmd] || b.innerHTML; }); setTool('brush'); setFg(state.fg);
$('#welcome').classList.remove('hidden');
render();
checkRecovery();
// warm the bundled open-licensed fonts so text renders with them on the first try
if (document.fonts) for (const f of Object.keys(BUNDLED_FONTS)) for (const bold of [false, true]) loadFont({ font: f, size: 16, bold }).catch(() => {});
// Platform-correct shortcut labels in static tooltips (index.html is written with neutral Ctrl/Alt/Shift names).
document.documentElement.dataset.platform = PLATFORM;
document.querySelectorAll('[title]').forEach((el) => {
  const cmd = el.dataset.cmd;
  el.title = el.title.replace(/\(((?:Ctrl|Alt|Shift)\+[^)]+)\)$/, (m, k) => `(${cmd ? shortcutLabel(cmd, k) : keyLabel(k)})`);
  el.title = platformText(el.title);
});
status(`${APP} ready — open an image (${shortcutLabel('open', 'Ctrl+O')}), drop one in, or create a new canvas (${shortcutLabel('new', 'Ctrl+N')}).`);

// Small automation/testing hook (also handy from the devtools console).
// ---------------------------------------------------------------------------
// v0.8: automatic tools (white balance, auto enhance, straighten), looks and 3D LUTs
// ---------------------------------------------------------------------------
/** Small CPU composite of the document (≤ maxSide px) for analysis; `hide` layers are left out. */
function analysisImage(maxSide = 512, hide = null) {
  const d = doc(), tmp = makeCanvas(d.width, d.height), saved = hide ? hide.visible : null;
  if (hide) hide.visible = false;
  try { composite(tmp, { sync: true, cpu: true }); } finally { if (hide) hide.visible = saved; compDirty = true; }
  const k = Math.min(1, maxSide / Math.max(d.width, d.height)), w = Math.max(1, Math.round(d.width * k)), h = Math.max(1, Math.round(d.height * k));
  const s = makeCanvas(w, h), x = s.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(tmp, 0, 0, w, h);
  return { img: x.getImageData(0, 0, w, h), k };
}
function makeAdjLayer(type, params, name) {
  const d = doc(), l = createLayer(name || ADJ_LAYER[type], 1, 1, { kind: 'adjust', adj: { type, params: structuredClone(params) }, editMask: true });
  l.mask = { canvas: makeMaskCanvas(d.width, d.height, true), enabled: true, rev: ++globalRev };
  return l;
}
/** Insert a pass-through group holding adjustment layers (bottom → top) above the active layer; one history step. */
function addAdjustmentGroup(name, specs, { opacity = 1, look = null, label } = {}) {
  const d = doc(), g = createLayer(name, 1, 1, { kind: 'group', blend: 'pass-through', collapsed: false, editMask: true, opacity });
  if (look) g.look = look;
  const a = activeLayer(), parent = a ? (isGroup(a) && !a.collapsed ? a.id : parentId(a)) : null;
  g.parent = parent;
  const at = a ? (isGroup(a) && !a.collapsed ? d.layers.indexOf(a) : d.layers.indexOf(a) + 1) : d.layers.length;
  const kids = specs.map((s) => { const l = makeAdjLayer(s.type, s.params, s.name); l.parent = g.id; return l; });
  d.layers.splice(at, 0, ...kids, g); normalizeTree(d); clearPicked(d);
  d.activeId = g.id; compDirty = true; requestRender(); commit(label || name);
  return g;
}
function autoWhiteBalanceCmd(o = autoOpts().wb) {
  const { img } = analysisImage();
  const p0 = auto.autoWhiteBalance(img), k = (o?.strength ?? 100) / 100;
  const p = { temperature: Math.max(-100, Math.min(100, Math.round(p0.temperature * k + (o?.warmth || 0)))), tint: Math.round(p0.tint * k) };
  recordStep({ t: 'autoWB', opts: o });
  if (Math.abs(p.temperature) + Math.abs(p.tint) < 2) { status('Auto white balance: the colours are already neutral.'); toast('Already neutral: no white balance change needed.'); return null; }
  const l = makeAdjLayer('whiteBalance', p, 'Auto white balance');
  addLayer(l, 'Auto white balance'); clearPicked();
  status(`Auto white balance: temperature ${p.temperature > 0 ? '+' : ''}${p.temperature}, tint ${p.tint > 0 ? '+' : ''}${p.tint} (editable adjustment layer)`);
  return p;
}
function autoEnhanceCmd(o = autoOpts().enhance) {
  const { img } = analysisImage(), specs = auto.autoEnhance(img, o || {});
  recordStep({ t: 'autoEnhance', opts: o });
  if (!specs.length) { status('Auto enhance: nothing to improve.'); toast('This picture already looks balanced: nothing changed.'); return null; }
  const g = addAdjustmentGroup('Auto enhance', specs, { label: 'Auto enhance' });
  status(`Auto enhance: ${specs.map((s) => s.name.replace(/^Auto /, '')).join(', ')} — editable layers in the “Auto enhance” group`);
  return { group: g.id, steps: specs.map((s) => s.type) };
}
/** White-balance eyedropper: the clicked spot becomes neutral grey (edits the active white-balance layer or adds one). */
function wbPickAt(p) {
  const d = doc(), a = activeLayer(), target = a && a.kind === 'adjust' && a.adj.type === 'whiteBalance' ? a : null;
  const { img, k } = analysisImage(Math.max(d.width, d.height), target);
  const r = auto.neutralAt(img, Math.round(p.x * k), Math.round(p.y * k), 2);
  if (!r) { status('That spot is transparent: click on a grey or white area of the picture.'); return null; }
  if (target) { target.adj = { type: 'whiteBalance', params: r }; compDirty = true; requestRender(); commit('White balance (eyedropper)'); }
  else addLayer(makeAdjLayer('whiteBalance', r, 'White balance'), 'White balance (eyedropper)');
  status(`White balance set from the clicked spot: temperature ${r.temperature}, tint ${r.tint}. Click another neutral spot to refine.`);
  return r;
}
/** Rotate every layer by `deg` (clockwise positive) about the canvas centre; optionally crop to the largest clean rectangle. */
function straightenBy(deg, crop = true) {
  const d = doc(); if (!d || !deg) return false;
  if (state.xf) applyTransform(); if (state.mxf) applyMeshXf();
  const W = d.width, H = d.height, t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const R = { a: c, b: s, c: -s, d: c, e: W / 2 - c * W / 2 + s * H / 2, f: H / 2 - s * W / 2 - c * H / 2 };
  let texts = 0;
  for (const l of d.layers) {
    if (isGroup(l)) continue;
    if (l.kind === 'text') { rasterize(l); texts++; }
    if (l.kind === 'smart') rasterize(l, 'straightening');
    const box = l.kind === 'adjust' ? null : l.canvas, mbox = l.mask ? l.mask.canvas : null, ref = box || mbox; if (!ref) continue;
    const M = mulOffset(R, l.x, l.y), { x0, y0, x1, y1 } = xfBounds({ w: ref.width, h: ref.height }, M), w = x1 - x0, h = y1 - y0;
    const deep = box && useDeep(l) ? deepOf(l) : null, sameRaw = l.raw && l.raw.rev === l.rev;
    if (box) l.canvas = drawTransformed(box, M, x0, y0, w, h);
    if (mbox) { l.mask.canvas = drawTransformed(mbox, M, x0, y0, w, h); touchMask(l); }
    delete l.deep; delete l.deepRev; delete l.deepOX; delete l.deepOY;
    l.x = x0; l.y = y0; touch(l);
    if (l.raw && box) trackRaw(l, affineCompose(invertM(M), { a: 1, b: 0, c: 0, d: 1, e: x0, f: y0 }), sameRaw);
    if (deep) { // 16-bit: the same rotation through the CPU mesh renderer, sampled from the 16-bit pixels
      const pts = [[0, 0], [ref.width, 0], [ref.width, ref.height], [0, ref.height]].map(([u, v]) => { const q = applyM(M, u, v); return [q.x, q.y]; });
      const m = mesh.perspectiveMesh(ref.width, ref.height, pts);
      if (m) { l.deep = deepMesh(deep, w, h, m, x0, y0); l.deepRev = l.rev; l.deepOX = 0; l.deepOY = 0; }
    }
  }
  if (texts) toast('Text layers were converted to pixels for straightening.');
  d.selection = null; compDirty = true;
  const label = `Straighten ${deg > 0 ? '+' : ''}${Math.round(deg * 10) / 10}°`;
  if (crop) { const r = auto.cropAfterRotate(W, H, deg); cropTo(r, label); }
  else { requestRender(); commit(label); }
  status(`${label}${crop ? ' and cropped to remove the empty corners' : ''}`);
  return true;
}
/** Auto straighten: Hough transform on the picture's edges finds the horizon (or verticals). */
function autoStraightenCmd() {
  const { img } = analysisImage(600), r = auto.detectTilt(img);
  if (!r || r.confidence < 0.05 || Math.abs(r.angle) < 0.15) { status(r ? `No tilt worth fixing found (${r.angle}°).` : 'No clear horizon or vertical lines found.'); toast(r ? 'The picture already looks level.' : 'No clear horizon or vertical edges found: use the Straighten tool to draw one.'); return r; }
  straightenBy(-r.angle, state.opts.straightenCrop);
  status(`Auto straighten: ${r.kind} lines were ${Math.abs(r.angle)}° ${r.angle > 0 ? 'clockwise' : 'counter-clockwise'}; rotated ${-r.angle > 0 ? '+' : ''}${-r.angle}°`);
  return r;
}
const straightenTool = {
  down(p) { drag = { str: true, a: p, b: p }; state.strLine = { a: p, b: p }; },
  move(p) { if (!drag?.str) return; drag.b = p; state.strLine = { a: drag.a, b: p }; requestRender(); buildOptionsBar(); },
  up() {
    const dr = drag; state.strLine = null; requestRender(); if (!dr?.str) return;
    const dx = dr.b.x - dr.a.x, dy = dr.b.y - dr.a.y; if (Math.hypot(dx, dy) * state.zoom < 8) { status('Drag along something that should be level (or vertical).'); return; }
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // the line's angle (clockwise positive)
    while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;
    const tilt = Math.abs(ang) <= 45 ? ang : ang > 0 ? ang - 90 : ang + 90;
    if (Math.abs(tilt) < 0.05) { status('That line is already level.'); return; }
    straightenBy(-tilt, state.opts.straightenCrop);
  },
};
const wbPickTool = { down(p) { drag = {}; wbPickAt(p); } };

// --- Looks ---------------------------------------------------------------------------------------
function lookTypes() { return new Set(Object.keys(ADJ_LAYER).filter((t) => t !== 'lut3d')); }
function userLooks() { try { return (JSON.parse(localStorage.getItem('tintwork.looks') || '[]') || []).map((o) => normalizeLook({ ...o, user: true }, lookTypes())).filter(Boolean); } catch { return []; } }
function saveUserLooks(list) { localStorage.setItem('tintwork.looks', JSON.stringify(list.map(({ id, name, layers }) => ({ id, name, layers })))); }
function allLooks() { return [...LOOKS.map((l) => ({ ...l, user: false })), ...userLooks()]; }
function applyLook(idOrLook, intensity = state.opts.lookIntensity) {
  const look = typeof idOrLook === 'string' ? allLooks().find((l) => l.id === idOrLook) : idOrLook;
  if (!look || !doc()) return null;
  const specs = lookToLayers(look).map((s) => ({ ...s, name: `${look.name}: ${ADJ_LAYER[s.type]}` }));
  const g = addAdjustmentGroup(`Look: ${look.name}`, specs, { opacity: Math.max(0, Math.min(1, intensity / 100)), look: look.id, label: `Look: ${look.name}` });
  status(`Look “${look.name}” added at ${Math.round(g.opacity * 100)}% — the group's opacity is its intensity; every layer inside stays editable.`);
  updateLooksPanel(); recordStep({ t: 'look', id: look.id, intensity }); return g;
}
/** The look group being edited (the active layer or its enclosing look group). */
function activeLookGroup() { const d = doc(); if (!d) return null; let l = activeLayer(); while (l && !l.look) l = layerById(d, parentId(l)); return l || null; }
function setLookIntensity(v, final) {
  const g = activeLookGroup();
  if (!g) { state.opts.lookIntensity = v; return; } // no look selected: sets the strength new looks start at
  g.opacity = v / 100; compDirty = true; requestRender();
  if (final) commit(`Look intensity ${v}%`);
}
/** Save the adjustment layers of the active group (or the picked adjustment layers) as a user look. */
function saveLookFromSelection(name) {
  const d = doc(), sel = pickedLayers(d), src = [];
  for (const r of sel) for (const l of blockOf(d, r)) if (l.kind === 'adjust' && l.visible && lookTypes().has(l.adj.type)) src.push(l);
  if (!src.length) { status('Select a group of adjustment layers (or Ctrl+click several) to save them as a look.'); toast('Nothing to save: select adjustment layers or a look group first.'); return null; }
  const look = normalizeLook({ id: `user-${Date.now().toString(36)}`, name: name || 'My look', layers: src.map((l) => ({ type: l.adj.type, params: l.adj.params })), user: true }, lookTypes());
  const list = userLooks(); list.push(look); saveUserLooks(list); updateLooksPanel(true);
  status(`Saved look “${look.name}” (${look.layers.length} adjustment${look.layers.length === 1 ? '' : 's'}).`); return look;
}
function exportLooksJSON() { return JSON.stringify({ format: 'tintwork-looks', version: 1, looks: userLooks().map(({ id, name, layers }) => ({ id, name, layers })) }, null, 2); }
function importLooksJSON(text) {
  let o; try { o = JSON.parse(text); } catch { throw new Error('Not a looks file (invalid JSON)'); }
  const arr = Array.isArray(o) ? o : o && o.format === 'tintwork-looks' ? o.looks : o && o.layers ? [o] : null;
  if (!arr) throw new Error('Not a looks file');
  const list = userLooks(), have = new Set(list.map((l) => l.id)); let n = 0;
  for (const raw of arr) { const l = normalizeLook({ ...raw, user: true }, lookTypes()); if (!l) continue; if (have.has(l.id)) l.id = `${l.id}-${Date.now().toString(36)}${n}`; list.push(l); n++; }
  if (!n) throw new Error('No usable looks in that file');
  saveUserLooks(list); updateLooksPanel(true); return n;
}
function pickFile(accept) {
  return new Promise((resolve) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.addEventListener('change', () => resolve(i.files[0] || null)); i.click(); });
}
var lookThumbKey = '', lookThumbTimer = 0; // var: updateLooksPanel can run during boot, before this line
function updateLooksPanel(force = false) {
  const box = $('#looksGrid'); if (!box) return;
  const d = doc(), looks = allLooks(), g = activeLookGroup();
  const slider = $('#lookIntensity'); if (slider) { slider.value = g ? Math.round(g.opacity * 100) : state.opts.lookIntensity; $('#lookIntensityVal').textContent = `${slider.value}%`; $('#lookTarget').textContent = g ? g.name.replace(/^Look: /, '') : 'new looks'; }
  const key = `${looks.map((l) => l.id).join(',')}|${d ? `${d.name}:${d.width}x${d.height}:${d.layers.length}` : '-'}`;
  if (!force && key === lookThumbKey && box.childElementCount) return;
  lookThumbKey = key;
  box.innerHTML = '';
  for (const look of looks) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'look' + (look.user ? ' user' : ''); b.dataset.look = look.id; b.title = `${look.name}${look.user ? ' (yours)' : ''} — click to add as an editable group`;
    const c = makeCanvas(72, 48); c.className = 'look-thumb'; b.append(c);
    const s = document.createElement('span'); s.textContent = look.name; b.append(s);
    b.addEventListener('click', () => { if (!doc()) { status('Open an image first.'); return; } applyLook(look.id); });
    if (look.user) b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (confirm(`Delete your look “${look.name}”?`)) { saveUserLooks(userLooks().filter((x) => x.id !== look.id)); updateLooksPanel(true); } });
    box.append(b);
  }
  clearTimeout(lookThumbTimer); if (d) lookThumbTimer = setTimeout(renderLookThumbs, 250);
}
/** Previews: each look's stack run on a tiny copy of the picture (CPU, ~72×48). */
function renderLookThumbs() {
  const d = doc(); if (!d) return;
  const { img } = analysisImage(96), looks = allLooks();
  for (const b of document.querySelectorAll('#looksGrid .look')) {
    const look = looks.find((l) => l.id === b.dataset.look); if (!look) continue;
    const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    for (const s of look.layers) runOp(s.type, out, s.params);
    const c = b.querySelector('canvas'), x = c.getContext('2d'), t = putInto(null, out), k = Math.max(72 / img.width, 48 / img.height);
    x.clearRect(0, 0, 72, 48); x.drawImage(t, (72 - img.width * k) / 2, (48 - img.height * k) / 2, img.width * k, img.height * k);
  }
}
async function importCubeText(text, name = 'LUT') {
  const t = parseCube(text); t.title ||= name.replace(/\.cube$/i, '');
  const id = registerLut(t), l = makeAdjLayer('lut3d', { lut: id, title: t.title, amount: 100 }, `LUT: ${t.title}`);
  addLayer(l, `Color lookup: ${t.title}`);
  status(`3D LUT “${t.title}” (${t.size}³) added as an adjustment layer. Double-click it to change the amount.`);
  return l;
}
lutStoreLoad();

// ===========================================================================================================
// v0.9 — crop / resize presets, multi-size export, batch processing, actions, auto options
// ===========================================================================================================
// ---- Actions: record a sequence of edits and replay it on another image -----------------------------------
const ACTIONS_KEY = 'tintwork.actions';
const REC_CMDS = new Set(['rotateCW', 'rotateCCW', 'rotate180', 'flipH', 'flipV', 'invert', 'grayscale', 'autoLevels', 'flatten', 'autoStraighten',
  'mode8', 'mode16', 'layerDuplicate', 'layerMergeDown', 'adjLayer_invert', 'adjLayer_grayscale', 'selectAll', 'deselect', 'invertSelection']);
const BUILTIN_ACTIONS = [
  { id: 'a-social-sq', name: 'Square 1080 for social', builtin: true, steps: [{ t: 'preset', id: 'sq', mode: 'fill' }] },
  { id: 'a-enhance-sharpen', name: 'Auto enhance + light sharpen', builtin: true, steps: [{ t: 'autoEnhance', opts: { strength: 100 } }, { t: 'cmd', name: 'flatten' }, { t: 'adjust', op: 'sharpen', params: { amount: 60, radius: 1, threshold: 2 } }] },
  { id: 'a-web-2048', name: 'Web size (2048 px long edge)', builtin: true, steps: [{ t: 'fitLong', long: 2048 }] },
];
const recorder = { on: false, steps: [], replaying: 0 };
function userActions() { try { return JSON.parse(localStorage.getItem(ACTIONS_KEY) || '[]').filter((a) => a && a.id && Array.isArray(a.steps)); } catch { return []; } }
function saveUserActions(list) { localStorage.setItem(ACTIONS_KEY, JSON.stringify(list.map(({ id, name, steps }) => ({ id, name, steps })))); }
const allActions = () => [...BUILTIN_ACTIONS, ...userActions()];
function recordStep(step) {
  if (!recorder.on || recorder.replaying) return;
  recorder.steps.push(JSON.parse(JSON.stringify(step))); updateRecBadge();
}
function updateRecBadge() {
  let b = $('#recBadge');
  if (!b) { b = document.createElement('button'); b.id = 'recBadge'; b.type = 'button'; b.className = 'rec-badge hidden'; b.title = 'Recording an action — click to stop and save'; b.addEventListener('click', () => run('actionStop')); $('#status').before(b); }
  b.classList.toggle('hidden', !recorder.on); b.textContent = `● REC ${recorder.steps.length} step${recorder.steps.length === 1 ? '' : 's'}`;
}
function startRecording() {
  if (recorder.on) { status('Already recording: Actions ▸ Stop recording saves it.'); return; }
  recorder.on = true; recorder.steps = []; updateRecBadge();
  status('Recording an action: adjustments, filters, rotate/flip, crop & resize presets, looks and auto fixes are recorded. Actions ▸ Stop recording saves it.');
}
function stopRecording(name) {
  if (!recorder.on) { status('Not recording.'); return null; }
  recorder.on = false; const steps = recorder.steps; recorder.steps = []; updateRecBadge();
  if (!steps.length) { toast('Nothing was recorded.'); return null; }
  const save = (n) => { const a = { id: `u-${Date.now().toString(36)}`, name: n || `Action ${userActions().length + 1}`, steps }; saveUserActions([...userActions(), a]); status(`Saved action “${a.name}” (${steps.length} step${steps.length === 1 ? '' : 's'}).`); return a; };
  if (name != null) return save(name);
  const body = document.createElement('div');
  body.innerHTML = formHTML([{ label: 'Action name', html: `<input type="text" id="actName" value="Action ${userActions().length + 1}" />` }]) +
    `<ol class="muted action-steps">${steps.map((s) => `<li>${escapeHtml(describeStep(s))}</li>`).join('')}</ol>`;
  showModal({ title: 'Save action', body, okLabel: 'Save', ok: () => { save(body.querySelector('#actName').value.trim()); } });
  return steps;
}
function describeStep(s) {
  switch (s.t) {
    case 'cmd': return MENUS.flatMap(([, items]) => items).find((it) => Array.isArray(it) && it[1] === s.name)?.[0] || s.name;
    case 'adjust': return `${Object.values(ADJ).find((d) => d.op === s.op)?.title || s.op} (${Object.entries(s.params || {}).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k} ${v}`).join(', ')})`;
    case 'adjLayer': return `${ADJ_LAYER[s.type] || s.type} layer`;
    case 'look': return `Look: ${allLooks().find((l) => l.id === s.id)?.name || s.id} at ${s.intensity}%`;
    case 'preset': { const p = presetById(s.id); return `${s.mode === 'fit' ? 'Fit' : 'Crop & resize'} to ${p ? p.name : s.id}`; }
    case 'crop': return s.preset ? `Crop to ${presetById(s.preset)?.name || s.preset}` : `Crop (${Math.round(s.fw * 100)}% × ${Math.round(s.fh * 100)}%)`;
    case 'resize': return `Resize to ${s.w}×${s.h}`;
    case 'fitLong': return `Fit within ${s.long} px`;
    case 'autoEnhance': return `Auto enhance (${s.opts?.strength ?? 100}%)`;
    case 'autoWB': return `Auto white balance (${s.opts?.strength ?? 100}%)`;
    default: return s.t;
  }
}
/** Replay an action (id or object) on the active document. Resolves { ok, steps, errors }. */
async function playAction(a, d0 = doc()) {
  const act = typeof a === 'string' ? allActions().find((x) => x.id === a) : a;
  if (!act || !d0) { status('Open an image and choose an action first.'); return { ok: false, steps: 0, errors: ['no action or document'] }; }
  recorder.replaying++; const errors = []; let n = 0;
  try {
    for (const s of act.steps) {
      if (doc() !== d0) { errors.push('document changed'); break; }
      try { await playStep(s); n++; } catch (err) { errors.push(`${describeStep(s)}: ${err.message || err}`); }
    }
  } finally { recorder.replaying--; }
  updateAll();
  status(errors.length ? `Action “${act.name}”: ${n} of ${act.steps.length} steps; ${errors[0]}` : `Played action “${act.name}” (${n} step${n === 1 ? '' : 's'}).`);
  return { ok: !errors.length, steps: n, errors };
}
async function playStep(s) {
  const d = doc();
  switch (s.t) {
    case 'cmd': { const f = cmds[s.name]; if (!f) throw new Error(`unknown command ${s.name}`); await f(); break; }
    case 'adjust': if (!(await applyAdjustDirect(s.op, s.params))) throw new Error('could not apply here'); break;
    case 'adjLayer': addLayer(makeAdjLayer(s.type, s.params, s.name || ADJ_LAYER[s.type]), s.name || ADJ_LAYER[s.type]); break;
    case 'look': if (!applyLook(s.id, s.intensity ?? 100)) throw new Error('look not found'); break;
    case 'preset': resizeToPreset(s.id, s); break;
    case 'crop':
      if (s.preset) { const px = presetPixels(presetById(s.preset) || { rw: 1, rh: 1 }, s.dpi || 300, s.orient || 'auto', d.width, d.height); cropTo(centredRatioRect(d.width, d.height, px.w, px.h), 'Crop'); if (s.resize && presetById(s.preset)?.rw == null) { resizeImage(px.w, px.h); if (s.dpi && presetById(s.preset)?.inW != null) doc().dpi = s.dpi; } }
      else cropTo({ x: Math.round(s.fx * d.width), y: Math.round(s.fy * d.height), w: Math.max(1, Math.round(s.fw * d.width)), h: Math.max(1, Math.round(s.fh * d.height)) }, 'Crop');
      break;
    case 'resize': resizeImage(s.w, s.h); break;
    case 'fitLong': { const k = s.long / Math.max(d.width, d.height); if (k < 1) resizeImage(Math.max(1, Math.round(d.width * k)), Math.max(1, Math.round(d.height * k))); break; }
    case 'autoEnhance': autoEnhanceCmd(s.opts); break;
    case 'autoWB': autoWhiteBalanceCmd(s.opts); break;
    default: throw new Error(`unknown step ${s.t}`);
  }
  await settle();
}
const settle = () => new Promise((r) => setTimeout(r, 0));
/** Apply a destructive adjustment / filter to the active layer without a dialog (actions and batch). */
async function applyAdjustDirect(op, params = {}) {
  const def = Object.values(ADJ).find((x) => x.op === op); if (!def || def.layerOnly) return false;
  const l = activeLayer(); if (!canAdjust(l, def)) return false;
  recordStep({ t: 'adjust', op, params });
  if (!editingMask(l)) rasterize(l, def.title);
  if (!editingMask(l) && (op === 'gaussianBlur' || op === 'sharpen')) ensureCoversDoc(l);
  const r = opRegion(l); if (!r) return false;
  const onMask = editingMask(l), c = ctxOf(targetCanvas(l)), original = c.getImageData(r.x, r.y, r.w, r.h);
  const deepSrc = !onMask && useDeep(l) && DEEP_OPS.includes(op) ? deepOf(l) : null;
  const p = { ...(def.curves ? identityCurves() : {}), ...Object.fromEntries(def.params.map((q) => [q.key, q.value])), ...params, ...(def.extra || {}) };
  const info = regionInfo(l, r), selMask = regionMask(l, r);
  setBusy(1);
  try {
    if (deepSrc) await deepOp(l, deepSrc, r, op, p, info, selMask);
    else { const out = await ops.process(op, original, p, info, selMask); c.putImageData(out, r.x, r.y); touchTarget(l); }
    requestRender(); commit(def.title); return true;
  } finally { setBusy(-1); }
}
function openActionsDialog() {
  const body = document.createElement('div');
  const draw = () => {
    const list = allActions();
    body.innerHTML = `<p class="muted">Record edits with <b>Start recording</b>, then replay them on any open image or use them in <b>File ▸ Batch process</b>.</p>
      <div class="row-btns"><button type="button" id="actRec" class="${recorder.on ? '' : 'primary'}">${recorder.on ? `■ Stop recording (${recorder.steps.length})` : '● Start recording'}</button>
      <button type="button" id="actImport">Import…</button><button type="button" id="actExport" ${userActions().length ? '' : 'disabled'}>Export…</button></div>
      <ul class="action-list">${list.map((a) => `<li data-id="${escapeHtml(a.id)}"><div><b>${escapeHtml(a.name)}</b>${a.builtin ? ' <span class="muted">(built-in)</span>' : ''}<div class="muted small">${a.steps.map((s) => escapeHtml(describeStep(s))).join(' → ')}</div></div>
        <span class="act-btns"><button type="button" data-play="${escapeHtml(a.id)}" class="primary" ${doc() ? '' : 'disabled'}>▶ Play</button>${a.builtin ? '' : `<button type="button" data-ren="${escapeHtml(a.id)}" title="Rename">✎</button><button type="button" data-del="${escapeHtml(a.id)}" title="Delete">✕</button>`}</span></li>`).join('')}</ul>`;
  };
  body.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'actRec') { if (recorder.on) { closeModal(); stopRecording(); } else { startRecording(); closeModal(); } return; }
    if (t.id === 'actExport') { download(new Blob([JSON.stringify({ format: 'tintwork-actions', version: 1, actions: userActions() }, null, 2)], { type: 'application/json' }), 'tintwork-actions.json'); return; }
    if (t.id === 'actImport') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const n = importActionsJSON(await f.text()); status(`Imported ${n} action${n === 1 ? '' : 's'}.`); draw(); } catch (err) { toast(`Could not import: ${err.message}`, 4000); } };
      inp.click(); return;
    }
    if (t.dataset.play) { closeModal(); await playAction(t.dataset.play); return; }
    if (t.dataset.del) { saveUserActions(userActions().filter((a) => a.id !== t.dataset.del)); draw(); return; }
    if (t.dataset.ren) { const list = userActions(), a = list.find((x) => x.id === t.dataset.ren), n = prompt('Action name', a?.name); if (a && n) { a.name = n.trim() || a.name; saveUserActions(list); draw(); } }
  });
  draw();
  showModal({ title: 'Actions', body, okLabel: 'Close', hideCancel: true, ok: () => {} });
}
function importActionsJSON(text) {
  const j = JSON.parse(text); if (j.format !== 'tintwork-actions' || !Array.isArray(j.actions)) throw new Error('not a Tintwork actions file');
  const ok = j.actions.filter((a) => a && typeof a.name === 'string' && Array.isArray(a.steps)).map((a) => ({ id: `u-${Math.random().toString(36).slice(2, 9)}`, name: a.name.slice(0, 80), steps: a.steps }));
  saveUserActions([...userActions(), ...ok]); return ok.length;
}

// ---- Crop & resize presets ------------------------------------------------------------------------------
function presetOptionsHTML(sel, { ratios = true, free = true } = {}) {
  const groups = new Map(); for (const p of allPresets()) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
  const opt = (p) => `<option value="${escapeHtml(p.id)}" ${p.id === sel ? 'selected' : ''}>${escapeHtml(p.name)}${p.w ? ` (${p.w}×${p.h})` : ''}</option>`;
  return (free ? `<option value="" ${!sel ? 'selected' : ''}>Free (no ratio)</option><option value="orig" ${sel === 'orig' ? 'selected' : ''}>Original ratio</option>` : '') +
    (ratios ? `<optgroup label="Ratio">${RATIO_ONLY.map(opt).join('')}</optgroup>` : '') +
    [...groups].map(([g, list]) => `<optgroup label="${escapeHtml(g)}">${list.map(opt).join('')}</optgroup>`).join('');
}
/** The crop tool's current aspect (w, h) or null for free cropping. */
function cropAspect() {
  const o = state.opts, d = doc(); if (!d) return null;
  if (o.cropLockRatio) return o.cropLockRatio;
  if (!o.cropPreset) return null;
  if (o.cropPreset === 'orig') return { w: d.width, h: d.height };
  const p = presetById(o.cropPreset); return p ? presetPixels(p, o.cropDpi, o.cropOrient, d.width, d.height) : null;
}
function setCropPreset(id) {
  const o = state.opts, d = doc(); o.cropPreset = id; o.cropLockRatio = null;
  const a = cropAspect(); state.crop = a && d ? centredRatioRect(d.width, d.height, a.w, a.h) : state.crop;
  buildOptionsBar(); requestRender();
}
function applyCropTool() {
  const d = doc(), c = state.crop, o = state.opts; if (!c) return;
  const p = o.cropPreset && o.cropPreset !== 'orig' ? presetById(o.cropPreset) : null;
  const px = p ? presetPixels(p, o.cropDpi, o.cropOrient, d.width, d.height) : null, fixed = p && p.rw == null;
  const step = { t: 'crop', fx: c.x / d.width, fy: c.y / d.height, fw: c.w / d.width, fh: c.h / d.height };
  if (p) Object.assign(step, { preset: p.id, dpi: o.cropDpi, orient: o.cropOrient, resize: !!(o.cropResize && fixed) });
  const h0 = history.index; cropTo(c);
  if (fixed && o.cropResize && (d.width !== px.w || d.height !== px.h)) resizeImage(px.w, px.h);
  if (p?.inW != null) doc().dpi = o.cropDpi;
  squashHistory(h0, p ? `Crop to ${p.name}` : 'Crop');
  recordStep(step);
  updateDocInfo();
}
/** Crop (mode 'fill': centred, to the preset's ratio) and/or resize to a preset; 'fit' keeps the ratio inside the preset size. */
/** Merge the history steps after index h0 into one (crop + resize is a single undo step); the last snapshot wins. */
function squashHistory(h0, label) {
  if (history.index - h0 < 2 || h0 < -1) return;
  const last = history.entries[history.index]; last.label = label; last.snap = snapshot(); // picks up the DPI too
  history.entries.splice(h0 + 1, history.index - h0, last); history.index = h0 + 1; updateHistoryPanel();
}
function resizeToPreset(id, { mode = 'fill', dpi = state.opts.cropDpi, orient = 'auto' } = {}) {
  const d = doc(), p = presetById(id); if (!d || !p) return false;
  const px = presetPixels(p, dpi, orient, d.width, d.height), h0 = history.index;
  if (p.rw != null) { cropTo(centredRatioRect(d.width, d.height, px.w, px.h), `Crop to ${p.name}`); }
  else if (mode === 'fit') { const k = Math.min(px.w / d.width, px.h / d.height); resizeImage(Math.max(1, Math.round(d.width * k)), Math.max(1, Math.round(d.height * k))); }
  else {
    const r = centredRatioRect(d.width, d.height, px.w, px.h);
    if (r.w !== d.width || r.h !== d.height) cropTo(r, `Crop to ${p.name}`);
    if (doc().width !== px.w || doc().height !== px.h) resizeImage(px.w, px.h);
  }
  if (p.inW != null) doc().dpi = dpi;
  squashHistory(h0, `Resize to ${p.name}`);
  recordStep({ t: 'preset', id, mode, dpi, orient });
  updateDocInfo(); status(`${mode === 'fit' ? 'Fitted' : 'Cropped and resized'} to ${describePreset(p, dpi)} → ${doc().width}×${doc().height}`);
  return true;
}
function openResizePresetDialog() {
  const d = doc(), o = state.opts, body = document.createElement('div');
  const draw = (sel = o.resizePreset || 'sq') => {
    body.innerHTML = formHTML([
      { label: 'Preset', html: `<select id="rpSel">${presetOptionsHTML(sel, { free: false })}</select>` },
      { label: 'Mode', html: `<select id="rpMode"><option value="fill">Crop to fill (exact size)</option><option value="fit">Fit inside (keep whole picture)</option></select>` },
      { label: 'Orientation', html: `<select id="rpOrient"><option value="auto">Auto</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>` },
      { label: 'Print resolution', html: `<input type="number" id="rpDpi" min="72" max="1200" value="${o.cropDpi}" /> DPI` },
    ]) + `<p class="muted" id="rpInfo"></p><details class="custom-presets"><summary>Custom presets</summary>
      ${formHTML([{ label: 'Name', html: '<input type="text" id="cpName" placeholder="e.g. Shop thumbnail" />' }, { label: 'Width × height', html: '<input type="number" id="cpW" min="1" max="16384" value="1200" style="width:80px"/> × <input type="number" id="cpH" min="1" max="16384" value="800" style="width:80px"/> <select id="cpUnit"><option value="px">px</option><option value="in">in</option></select>' }])}
      <div class="row-btns"><button type="button" id="cpSave">Save preset</button><button type="button" id="cpCur">Use current size</button><button type="button" id="cpDel" ${presetById(sel)?.group === 'Custom' ? '' : 'disabled'}>Delete selected</button></div></details>`;
    const info = () => { const p = presetById(body.querySelector('#rpSel').value); if (!p) return; const px = presetPixels(p, +body.querySelector('#rpDpi').value || 300, body.querySelector('#rpOrient').value, d.width, d.height);
      body.querySelector('#rpInfo').textContent = `${describePreset(p, +body.querySelector('#rpDpi').value || 300)} — result ${p.rw != null ? 'crop only (ratio)' : `${px.w}×${px.h} px`} from ${d.width}×${d.height}`; };
    body.querySelectorAll('select, input').forEach((x) => x.addEventListener('input', info)); info();
    body.querySelector('#cpCur').onclick = () => { body.querySelector('#cpW').value = d.width; body.querySelector('#cpH').value = d.height; body.querySelector('#cpUnit').value = 'px'; };
    body.querySelector('#cpSave').onclick = () => {
      const name = body.querySelector('#cpName').value.trim() || 'Custom', w = +body.querySelector('#cpW').value, h = +body.querySelector('#cpH').value, inch = body.querySelector('#cpUnit').value === 'in';
      if (!(w > 0 && h > 0)) return;
      const id = saveCustomPreset(inch ? { name, inW: w, inH: h } : { name, w: Math.round(w), h: Math.round(h) }); o.resizePreset = id; draw(id);
    };
    body.querySelector('#cpDel').onclick = () => { deleteCustomPreset(body.querySelector('#rpSel').value); draw('sq'); };
  };
  draw();
  showModal({ title: 'Resize to preset', body, okLabel: 'Apply', ok: () => {
    const id = body.querySelector('#rpSel').value; o.resizePreset = id; o.cropDpi = Math.max(72, Math.min(1200, +body.querySelector('#rpDpi').value || 300));
    resizeToPreset(id, { mode: body.querySelector('#rpMode').value, dpi: o.cropDpi, orient: body.querySelector('#rpOrient').value });
  } });
}

// ---- Auto enhance / white balance options -------------------------------------------------------------------
const AUTO_KEY = 'tintwork.autoOpts';
function autoOpts() { try { return { enhance: { wb: true, tone: true, contrast: true, color: true, strength: 100 }, wb: { strength: 100, warmth: 0 }, ...JSON.parse(localStorage.getItem(AUTO_KEY) || '{}') }; } catch { return { enhance: { strength: 100 }, wb: { strength: 100, warmth: 0 } }; } }
function saveAutoOpts(o) { try { localStorage.setItem(AUTO_KEY, JSON.stringify(o)); } catch { /* ignore */ } }
function openAutoOptionsDialog(kind = 'enhance') {
  const all = autoOpts(), o = { ...all[kind] }, body = document.createElement('div');
  const ck = (k, label) => `<label class="radio-row"><input type="checkbox" data-k="${k}" ${o[k] !== false ? 'checked' : ''}/> ${label}</label>`;
  body.innerHTML = (kind === 'enhance'
    ? `<p class="muted">Auto enhance adds editable adjustment layers in a group. Choose the corrections and their strength.</p><div class="field two"><span>Corrections</span><span>${ck('wb', 'White balance')}${ck('tone', 'Tone (levels)')}${ck('contrast', 'Contrast (curve)')}${ck('color', 'Color (saturation)')}</span></div>`
    : '<p class="muted">Auto white balance neutralises the average of the mid-tones. Strength scales the correction; warmth shifts the result warmer (+) or cooler (−).</p>');
  body.append(paramField({ key: 'strength', label: 'Strength', min: 0, max: 150, value: o.strength ?? 100, unit: '%' }, o, () => {}, 100));
  if (kind === 'wb') body.append(paramField({ key: 'warmth', label: 'Warmth', min: -40, max: 40, value: o.warmth ?? 0 }, o, () => {}, 0));
  body.addEventListener('change', (e) => { const k = e.target.dataset?.k; if (k) o[k] = e.target.checked; });
  showModal({ title: kind === 'enhance' ? 'Auto enhance options' : 'Auto white balance options', body, okLabel: doc() ? 'Apply' : 'Save', ok: () => {
    all[kind] = o; saveAutoOpts(all); if (doc()) (kind === 'enhance' ? autoEnhanceCmd(o) : autoWhiteBalanceCmd(o));
  } });
}

// ---- Export presets and watermark (v1.8) ---------------------------------------------------------------------
const LAST_BATCH_PRESET_KEY = 'tintwork.lastBatchPreset';
const EXPORT_PRESETS_KEY = 'tintwork.exportPresets', LAST_EXPORT_PRESET_KEY = 'tintwork.lastExportPreset', WATERMARK_KEY = 'tintwork.watermark';
const BUILTIN_EXPORT_PRESETS = [
  { id: 'web', name: 'Web: JPEG 85, 2048 px long edge', type: 'image/jpeg', quality: 85, size: { mode: 'long', long: 2048 }, dpi: 72, watermark: false, sharpen: 'screen-std' },
  { id: 'email', name: 'Email: JPEG 80, 1200 px long edge', type: 'image/jpeg', quality: 80, size: { mode: 'long', long: 1200 }, dpi: 72, watermark: false },
  { id: 'print', name: 'Print: JPEG 95, full size, 300 ppi', type: 'image/jpeg', quality: 95, size: null, dpi: 300, watermark: false, sharpen: 'matte-std' },
  { id: 'png', name: 'Lossless PNG, full size', type: 'image/png', quality: 100, size: null, dpi: null, watermark: false },
];
function userExportPresets() {
  try { const v = JSON.parse(localStorage.getItem(EXPORT_PRESETS_KEY) || '[]'); return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && EXPORT_EXT[p.type]) : []; } catch { return []; }
}
function allExportPresets() { return [...BUILTIN_EXPORT_PRESETS.map((p) => ({ ...p, builtin: true })), ...userExportPresets()]; }
function saveExportPreset(p) {
  const list = userExportPresets(), old = list.find((x) => x.name === p.name);
  const q = { id: old?.id || `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: String(p.name).slice(0, 80), type: p.type, quality: Math.max(1, Math.min(100, Math.round(p.quality ?? 90))),
    size: p.size || null, dpi: p.dpi ? Math.max(1, Math.min(2400, Math.round(p.dpi))) : null, watermark: p.watermark && typeof p.watermark === 'object' ? presetWatermark(p.watermark) : !!p.watermark,
    sharpen: (p.sharpen && EXPORT_SHARP_PRESETS[p.sharpen] !== undefined) ? p.sharpen : 'off' };
  const next = [...list.filter((x) => x.id !== q.id), q];
  try { localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return q;
}
/** A preset keeps its own copy of the watermark (v1.9), so a logo preset still has its logo after the global watermark changes. */
function presetWatermark(w) { const keep = {}; for (const k of Object.keys(WM_DEFAULT)) if (w[k] !== undefined) keep[k] = w[k]; return keep; }
/** The watermark settings a preset exports with: its own copy, or (v1.8 presets) the current global settings. */
function watermarkOfPreset(p) {
  if (!p?.watermark) return null; if (p.watermark === true) return watermarkSettings();
  const g = { ...WM_DEFAULT, ...p.watermark }; return sanitizeWatermark(g);
}
function deleteExportPreset(id) { try { localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(userExportPresets().filter((x) => x.id !== id))); if (localStorage.getItem(LAST_EXPORT_PRESET_KEY) === id) localStorage.removeItem(LAST_EXPORT_PRESET_KEY); } catch { /* ignore */ } }
const WM_DEFAULT = { kind: 'text', text: '© Your name', size: 4, opacity: 60, position: 'br', color: '#ffffff', margin: 3, shadow: true, image: null, imageName: '', scale: 20, fit: 'short' };
const WM_IMAGE_MAX = 1024, WM_IMAGE_BYTES = 1.5e6; // a logo is kept as a PNG data URL in this browser's storage
const WM_POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
function watermarkSettings() {
  let w; try { w = { ...WM_DEFAULT, ...JSON.parse(localStorage.getItem(WATERMARK_KEY) || '{}') }; } catch { w = { ...WM_DEFAULT }; }
  return sanitizeWatermark(w);
}
function sanitizeWatermark(w) {
  if (!WM_POSITIONS.includes(w.position)) w.position = 'br';
  w.size = Math.max(0.5, Math.min(40, +w.size || 4)); w.opacity = Math.max(1, Math.min(100, +w.opacity || 60)); w.margin = Math.max(0, Math.min(30, +w.margin || 0));
  if (!/^#[0-9a-f]{6}$/i.test(w.color)) w.color = '#ffffff';
  if (typeof w.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(w.image) || w.image.length > WM_IMAGE_BYTES * 1.4) w.image = null;
  w.kind = w.kind === 'image' && w.image ? 'image' : 'text';
  w.scale = Math.max(1, Math.min(100, +w.scale || 20)); if (!['short', 'width', 'fit'].includes(w.fit)) w.fit = 'short'; w.imageName = String(w.imageName || '').slice(0, 120);
  return w;
}
/** Decoded logo images, by data URL (drawing must stay synchronous, so exports call readyWatermark first). */
const wmLogoCache = new Map();
async function readyWatermark(wm) {
  if (!wm || typeof wm !== 'object' || wm.kind !== 'image' || !wm.image || wmLogoCache.has(wm.image)) return wm;
  try { const bm = await createImageBitmap(await (await fetch(wm.image)).blob()); if (wmLogoCache.size > 8) wmLogoCache.clear(); wmLogoCache.set(wm.image, bm); }
  catch (err) { status(`The watermark logo could not be read (${err.message}).`); }
  return wm;
}
/** Turn a picked file into a stored logo: decoded, scaled to at most 1024 px, kept as PNG (transparency survives). */
async function watermarkImageFromFile(file) {
  const bm = await createImageBitmap(file); let side = WM_IMAGE_MAX, url = '';
  for (let k = 0; k < 4; k++) {
    const f = Math.min(1, side / Math.max(bm.width, bm.height)), c = makeCanvas(Math.max(1, Math.round(bm.width * f)), Math.max(1, Math.round(bm.height * f)));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(bm, 0, 0, c.width, c.height);
    url = c.toDataURL('image/png'); c.width = 0; if (url.length <= WM_IMAGE_BYTES * 1.37) break; side = Math.round(side * 0.7);
  }
  bm.close?.(); return url;
}
function saveWatermark(w) { try { localStorage.setItem(WATERMARK_KEY, JSON.stringify({ ...watermarkSettings(), ...w })); } catch { /* ignore */ } return watermarkSettings(); }
/** Draw the text watermark onto an output canvas. Size and margin are % of the shorter side, so every size matches. */
function drawWatermark(cv, wm = watermarkSettings()) {
  if (wm.kind === 'image') return drawLogoWatermark(cv, wm);
  const text = String(wm.text || '').trim(); if (!text) return false;
  const W = cv.width, H = cv.height, c = cv.getContext('2d'), short = Math.min(W, H);
  const px = Math.max(6, Math.round(short * wm.size / 100)), m = Math.round(short * wm.margin / 100), pos = wm.position || 'br';
  c.save(); c.font = `600 ${px}px "Segoe UI", system-ui, sans-serif`; c.textBaseline = 'alphabetic';
  const met = c.measureText(text), tw = met.width;
  const x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - m - tw : (W - tw) / 2;
  const y = pos[0] === 't' ? m + px * 0.8 : pos[0] === 'b' ? H - m - px * 0.22 : H / 2 + px * 0.3;
  c.globalAlpha = wm.opacity / 100;
  if (wm.shadow) { c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = Math.max(1, px * 0.08); c.shadowOffsetY = Math.max(1, px * 0.04); }
  c.fillStyle = wm.color; c.fillText(text, x, y); c.restore();
  return true;
}
/** Image (logo) watermark: sized by `fit` and `scale`, aspect kept, same 9 positions and margin as text. */
function drawLogoWatermark(cv, wm) {
  const bm = wmLogoCache.get(wm.image); if (!bm) return false;
  const W = cv.width, H = cv.height, short = Math.min(W, H), m = Math.round(short * wm.margin / 100), pos = wm.position || 'br';
  // size: % of the short side (default), % of the image width, or fitted inside a box of that % of width and height
  let w, h; const s = wm.scale / 100;
  if (wm.fit === 'fit') { const f = Math.min(W * s / bm.width, H * s / bm.height); w = Math.max(1, Math.round(bm.width * f)); h = Math.max(1, Math.round(bm.height * f)); }
  else { w = Math.max(1, Math.round((wm.fit === 'width' ? W : short) * s)); h = Math.max(1, Math.round(w * bm.height / bm.width)); }
  const maxH = Math.max(1, H - 2 * m); if (h > maxH) { w = Math.max(1, Math.round(w * maxH / h)); h = maxH; }
  const x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - m - w : Math.round((W - w) / 2);
  const y = pos[0] === 't' ? m : pos[0] === 'b' ? H - m - h : Math.round((H - h) / 2);
  const c = cv.getContext('2d'); c.save(); c.globalAlpha = wm.opacity / 100; c.imageSmoothingQuality = 'high';
  if (wm.shadow) { c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = Math.max(1, h * 0.04); c.shadowOffsetY = Math.max(1, h * 0.02); }
  c.drawImage(bm, x, y, w, h); c.restore();
  return true;
}
/** The same watermark on a 16-bit composite: render it 8-bit on a clear canvas and blend it in as a coverage mask. */
function watermarkDeep(deep, wm) {
  const W = deep.width, H = deep.height, cv = makeCanvas(W, H); if (!drawWatermark(cv, wm)) return false;
  const px = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data, a = deep.data, scale = 65535 / 255;
  for (let i = 0, j = 0; i < px.length; i += 4, j += 4) {
    const t = px[i + 3]; if (!t) continue;
    const f = t / 255, oa = a[j + 3] / 65535, na = f + oa * (1 - f);
    for (let ch = 0; ch < 3; ch++) a[j + ch] = Math.round(na > 0 ? (px[i + ch] * scale * f + a[j + ch] * oa * (1 - f)) / na : 0);
    a[j + 3] = Math.round(na * 65535);
  }
  cv.width = 0; return true;
}
function watermarkLabel(w) { return w.kind === 'image' ? `logo “${w.imageName || 'image'}”` : `“${w.text}”`; }
function watermarkFieldHTML(id) {
  const w = watermarkSettings();
  return `<span><label><input type="checkbox" id="${id}" ${localStorage.getItem(`${WATERMARK_KEY}.on`) === '1' ? 'checked' : ''}/> Add <span data-wmtext>${escapeHtml(watermarkLabel(w))}</span></label> <button type="button" data-wmedit="${id}">Watermark…</button></span>`;
}
function wireWatermarkField(root, id, onChange = () => {}) {
  const box = root.querySelector(`#${id}`);
  box.addEventListener('change', () => { try { localStorage.setItem(`${WATERMARK_KEY}.on`, box.checked ? '1' : '0'); } catch { /* ignore */ } onChange(); });
  root.querySelector(`[data-wmedit="${id}"]`).addEventListener('click', () => openWatermarkEditor(root, () => { box.checked = true; box.dispatchEvent(new Event('change')); }));
}
/** Watermark settings as an inline panel (the export dialogs are already modal, so it opens in place). */
function openWatermarkEditor(root, after = () => {}) {
  let panel = root.querySelector('.wm-panel'); if (panel) { panel.remove(); return; }
  const w = watermarkSettings(); panel = document.createElement('div'); panel.className = 'wm-panel';
  panel.innerHTML = formHTML([
    { label: 'Type', html: `<select data-wm="kind"><option value="text" ${w.kind === 'text' ? 'selected' : ''}>Text</option><option value="image" ${w.kind === 'image' ? 'selected' : ''}>Logo image</option></select>` },
    { label: 'Text', html: `<input type="text" data-wm="text" value="${escapeHtml(w.text)}" maxlength="120"/>`, cls: 'wm-text' },
    { label: 'Size (% of short side)', html: `<input type="number" data-wm="size" min="0.5" max="40" step="0.5" value="${w.size}" style="width:72px"/>`, cls: 'wm-text' },
    { label: 'Logo', html: `<span><button type="button" data-wmpick>Choose image…</button> <span class="muted small" data-wmname>${escapeHtml(w.imageName || (w.image ? 'image' : 'none (PNG with transparency works best)'))}</span></span>`, cls: 'wm-image' },
    { label: 'Logo size', html: `<span><select data-wm="fit" title="What the percentage is of"><option value="short" ${w.fit === 'short' ? 'selected' : ''}>Width, % of short side</option><option value="width" ${w.fit === 'width' ? 'selected' : ''}>Width, % of image width</option><option value="fit" ${w.fit === 'fit' ? 'selected' : ''}>Fit inside % of width and height</option></select> <input type="number" data-wm="scale" min="1" max="100" step="1" value="${w.scale}" style="width:64px" aria-label="Logo size (%)"/> %</span>`, cls: 'wm-image' },
    { label: 'Opacity (%)', html: `<input type="number" data-wm="opacity" min="1" max="100" value="${w.opacity}" style="width:72px"/>` },
    { label: 'Position', html: `<select data-wm="position">${WM_POSITIONS.map((p) => `<option value="${p}" ${w.position === p ? 'selected' : ''}>${({ t: 'Top', m: 'Middle', b: 'Bottom' })[p[0]]} ${({ l: 'left', c: 'centre', r: 'right' })[p[1]]}</option>`).join('')}</select>` },
    { label: 'Margin (%)', html: `<input type="number" data-wm="margin" min="0" max="30" step="0.5" value="${w.margin}" style="width:72px"/>` },
    { label: 'Color', html: `<input type="color" data-wm="color" value="${w.color}"/>`, cls: 'wm-text' },
    { label: 'Shadow', html: `<span><input type="checkbox" data-wm="shadow" ${w.shadow ? 'checked' : ''}/> Soft shadow</span>` },
  ]) + '<p class="muted small">Saved for every export, multi-size export and batch. The watermark scales with each output size.</p><button type="button" data-wmdone class="primary">Done</button>';
  const showKind = () => { const k = panel.querySelector('[data-wm=kind]').value; panel.querySelectorAll('.wm-text').forEach((el) => el.classList.toggle('hidden', k !== 'text')); panel.querySelectorAll('.wm-image').forEach((el) => el.classList.toggle('hidden', k !== 'image')); };
  const save = () => { const o = {}; panel.querySelectorAll('[data-wm]').forEach((el) => { const k = el.dataset.wm; o[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value; }); const nw = saveWatermark(o); showKind(); root.querySelectorAll('[data-wmtext]').forEach((s) => { s.textContent = watermarkLabel(nw); }); };
  panel.querySelector('[data-wmpick]').addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
    inp.onchange = async () => { const f = inp.files?.[0]; if (!f) return; try { const url = await watermarkImageFromFile(f); const nw = saveWatermark({ kind: 'image', image: url, imageName: f.name }); await readyWatermark(nw); panel.querySelector('[data-wm=kind]').value = 'image'; panel.querySelector('[data-wmname]').textContent = f.name; save(); status(`Watermark logo: ${f.name}`); } catch (err) { status(`That image could not be used as a logo (${err.message}).`); } };
    inp.click();
  });
  panel.addEventListener('input', save); panel.addEventListener('change', save);
  panel.querySelector('[data-wmdone]').addEventListener('click', () => { save(); panel.remove(); after(); });
  root.append(panel); showKind(); panel.querySelector(w.kind === 'image' ? '[data-wm=kind]' : '[data-wm=text]').focus();
}
function openWatermarkDialog() {
  const body = document.createElement('div');
  body.innerHTML = `<p class="muted">The watermark is added when “Add watermark” is ticked in Export, Export multiple sizes, Batch, or in a saved export preset.</p>`;
  openWatermarkEditor(body); body.querySelector('[data-wmdone]')?.remove();
  showModal({ title: 'Export watermark', body, okLabel: 'Save', ok: () => { status(`Watermark saved: ${watermarkLabel(watermarkSettings())}.`); } });
}

// ---- Multi-size export and batch processing ----------------------------------------------------------------
const EXPORT_SETS_KEY = 'tintwork.exportVariants';
const DEFAULT_VARIANTS = [
  { mode: 'original', type: 'image/jpeg', quality: 90 },
  { mode: 'long', long: 2048, type: 'image/jpeg', quality: 85 },
  { mode: 'long', long: 1080, type: 'image/webp', quality: 80 },
];
function savedVariants() { try { const v = JSON.parse(localStorage.getItem(EXPORT_SETS_KEY) || 'null'); return Array.isArray(v) && v.length ? v : DEFAULT_VARIANTS.map((x) => ({ ...x })); } catch { return DEFAULT_VARIANTS.map((x) => ({ ...x })); } }
const VARIANT_TYPES = [['image/jpeg', 'JPEG'], ['image/png', 'PNG'], ['image/webp', 'WebP'], [PSD_TYPE, 'PSD']];
/** Variant list editor (shared by the export and batch dialogs). */
function variantEditor(list) {
  const el = document.createElement('div'); el.className = 'variant-editor';
  const draw = () => {
    el.innerHTML = `<table class="variants"><thead><tr><th>Size</th><th></th><th>Format</th><th>Quality</th><th></th></tr></thead><tbody>${list.map((v, i) => `<tr data-i="${i}">
      <td><select data-f="mode"><option value="original">Original</option><option value="long">Long edge</option><option value="width">Width</option><option value="scale">Scale %</option><option value="preset">Preset</option></select></td>
      <td>${v.mode === 'preset' ? `<select data-f="preset">${presetOptionsHTML(v.preset || 'sq', { free: false })}</select>` : v.mode === 'original' ? '' : `<input type="number" data-f="${v.mode === 'long' ? 'long' : v.mode === 'width' ? 'w' : 'pct'}" min="1" max="16384" value="${v.mode === 'long' ? v.long ?? 2048 : v.mode === 'width' ? v.w ?? 1200 : v.pct ?? 50}" style="width:72px"/>`}</td>
      <td><select data-f="type">${VARIANT_TYPES.map(([t, n]) => `<option value="${t}" ${v.type === t ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td><input type="number" data-f="quality" min="1" max="100" value="${v.quality ?? 90}" style="width:56px" ${v.type === 'image/png' || v.type === PSD_TYPE ? 'disabled' : ''}/></td>
      <td><button type="button" data-rm="${i}" title="Remove" ${list.length < 2 ? 'disabled' : ''}>✕</button></td></tr>`).join('')}</tbody></table>
      <button type="button" id="varAdd">＋ Add size</button>`;
    el.querySelectorAll('tr[data-i]').forEach((tr) => { tr.querySelector('[data-f=mode]').value = list[+tr.dataset.i].mode; });
  };
  el.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f; if (!tr || !f) return;
    const v = list[+tr.dataset.i]; v[f] = ['long', 'w', 'pct', 'quality'].includes(f) ? +e.target.value : e.target.value;
    if (f === 'mode' && v.mode === 'preset') v.preset ||= 'sq';
    if (f === 'mode' || f === 'type') draw();
  });
  el.addEventListener('redraw', () => draw());
  el.addEventListener('click', (e) => {
    if (e.target.id === 'varAdd') { list.push({ mode: 'long', long: 1200, type: 'image/jpeg', quality: 85 }); draw(); }
    else if (e.target.dataset.rm) { list.splice(+e.target.dataset.rm, 1); draw(); }
  });
  draw(); return el;
}
const variantLabel = (v) => v.mode === 'original' ? 'original' : v.mode === 'long' ? `${v.long}px` : v.mode === 'width' ? `w${v.w}` : v.mode === 'scale' ? `${v.pct}pct` : (presetById(v.preset)?.name || v.preset).replace(/\s+/g, '-');
/** Render the active document as one variant: { blob, w, h, ext }. */
async function renderVariant(v, base = null) {
  const d = doc(), type = v.type || 'image/jpeg', q = (v.quality ?? 90) / 100;
  let src = base, sx = 0, sy = 0, sw = d.width, sh = d.height, w, h;
  if (v.mode === 'preset') {
    const p = presetById(v.preset); if (!p) throw new Error(`unknown preset ${v.preset}`);
    const px = presetPixels(p, v.dpi || 300, v.orient || 'auto', d.width, d.height);
    const r = centredRatioRect(d.width, d.height, px.w, px.h); sx = r.x; sy = r.y; sw = r.w; sh = r.h;
    if (p.rw != null) { w = sw; h = sh; } else { w = px.w; h = px.h; }
  } else ({ w, h } = variantSize(d.width, d.height, v));
  // PSD at full size keeps the layers; any other size or crop is a flattened single-layer PSD
  if (type === PSD_TYPE && w === d.width && h === d.height && sw === d.width && sh === d.height) return { blob: (await documentToPSD(d)).blob, w, h, ext: 'psd' };
  if (!src) { src = makeCanvas(d.width, d.height); composite(src, { background: type === 'image/jpeg' ? '#ffffff' : null, sync: true }); }
  // high-quality downscale: halve while more than 2× too big, then one smooth draw
  let cur = src, cx = sx, cy = sy, cw = sw, chh = sh;
  while (cw / 2 >= w && chh / 2 >= h && cw > 2 && chh > 2) {
    const t = makeCanvas(Math.round(cw / 2), Math.round(chh / 2)), x = t.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(cur, cx, cy, cw, chh, 0, 0, t.width, t.height); if (cur !== src) cur.width = 0; cur = t; cx = 0; cy = 0; cw = t.width; chh = t.height;
  }
  const out = makeCanvas(w, h), x = out.getContext('2d'); x.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
  x.drawImage(cur, cx, cy, cw, chh, 0, 0, w, h); if (cur !== src) cur.width = 0;
  if (v.sharpen && v.sharpen !== 'off') applyExportSharpen(out, v.sharpen);
  if (v.watermark) drawWatermark(out, v.watermark === true ? watermarkSettings() : v.watermark);
  if (type === PSD_TYPE) { const b = await flatPSD(out); out.width = 0; return { blob: b, w, h, ext: 'psd' }; }
  let blob = await new Promise((res) => out.toBlob(res, type, q)); out.width = 0;
  if (!blob) throw new Error(`${type} encoding is not supported in this browser`);
  if (blob.type !== type) toast(`${type.split('/')[1].toUpperCase()} is not supported here; saved as ${blob.type.split('/')[1].toUpperCase()}.`, 4000);
  const dpi = v.mode === 'preset' && presetById(v.preset)?.inW != null ? v.dpi || 300 : v.mode !== 'preset' && v.dpi ? v.dpi : d.dpi; // non-preset sizes: an export preset's ppi (v1.10)
  if (dpi) blob = await withDpi(blob, dpi); if (blob.type === 'image/jpeg') blob = await withSrgbIcc(blob); if (blob.type === 'image/png') blob = await withPngSrgb(blob);
  return { blob, w, h, ext: EXPORT_EXT[blob.type] || 'img' };
}
/** Sinks: where batch / multi-size output goes. */
function dirSink(dir) {
  return { label: dir.name, async write(name, blob) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); }, async finish() {} };
}
function zipSink(zipName) {
  const files = {};
  return { label: zipName, files, async write(name, blob) { files[name] = new Uint8Array(await blob.arrayBuffer()); },
    async finish(cancelled) { if (!Object.keys(files).length) return; download(new Blob([zipFiles(files)], { type: 'application/zip' }), zipName); if (cancelled) toast('Cancelled: the zip holds the files finished so far.', 4000); } };
}
const memorySink = () => { const files = {}; return { label: 'memory', files, async write(name, blob) { files[name] = { size: blob.size, type: blob.type, blob }; }, async finish() {} }; };
async function chooseSink(zipName) {
  if ('showDirectoryPicker' in window) {
    try { const dir = await window.showDirectoryPicker({ id: 'tintwork-export', mode: 'readwrite' }); return dirSink(dir); }
    catch (err) { if (err?.name === 'AbortError') return null; toast(`Folder access unavailable (${err.message}); downloading a zip instead.`, 4000); }
  }
  return zipSink(zipName);
}
/** Progress panel with Cancel; returns { signal, update(i, n, text), done() }. */
function progressUI(title) {
  const ctl = new AbortController(), el = document.createElement('div'); el.id = 'batchProgress'; el.setAttribute('role', 'status');
  el.innerHTML = `<b>${escapeHtml(title)}</b><progress max="1" value="0"></progress><span class="muted" id="bpText">Starting…</span><button type="button">Cancel</button>`;
  el.querySelector('button').onclick = () => { ctl.abort(); el.querySelector('#bpText').textContent = 'Cancelling after the current file…'; };
  document.body.append(el);
  return { signal: ctl.signal, update(i, n, text) { const p = el.querySelector('progress'); p.max = n; p.value = i; el.querySelector('#bpText').textContent = text; status(`${title}: ${text}`); }, done() { el.remove(); } };
}
/** Export the active document in several sizes / formats. */
async function exportVariants(variants, { pattern = '{name}-{preset}', sink, signal, onProgress, tokens = {}, watermark = null } = {}) {
  if (watermark) variants = variants.map((v) => ({ ...v, watermark: watermark === true ? watermarkSettings() : watermark }));
  for (const v of variants) if (v.watermark && v.watermark !== true) await readyWatermark(v.watermark);
  const d = doc(), name = tokens.name || (d.name || 'Untitled').replace(/\.[^.]+$/, ''), uniq = uniqueNamer(), out = [];
  const needWhite = variants.some((v) => (v.type || 'image/jpeg') === 'image/jpeg'), needAlpha = variants.some((v) => v.type !== 'image/jpeg');
  const white = needWhite ? makeCanvas(d.width, d.height) : null, clear = needAlpha ? makeCanvas(d.width, d.height) : null;
  if (white) composite(white, { background: '#ffffff', sync: true }); if (clear) composite(clear, { background: null, sync: true });
  for (let i = 0; i < variants.length; i++) {
    if (signal?.aborted) break;
    const v = variants[i], r = await renderVariant(v, v.type === 'image/jpeg' ? white : clear);
    const fname = uniq(`${formatName(pattern, { N: 1, ...tokens, name, n: i + 1, w: r.w, h: r.h, preset: variantLabel(v), ext: r.ext })}.${r.ext}`);
    await sink.write(fname, r.blob); out.push({ name: fname, w: r.w, h: r.h, size: r.blob.size, type: r.blob.type });
    onProgress?.(i + 1, variants.length, fname);
  }
  if (white) white.width = 0; if (clear) clear.width = 0;
  return out;
}
function openExportVariantsDialog() {
  const d = doc(), list = savedVariants(), body = document.createElement('div');
  body.innerHTML = `<p class="muted">Export “${escapeHtml(d.name || 'Untitled')}” in several sizes and formats at once. Saved to a folder you choose${'showDirectoryPicker' in window ? '' : ' (this browser downloads a .zip)'}.</p>`;
  body.append(variantEditor(list));
  const pat = document.createElement('div'); pat.innerHTML = formHTML([{ label: 'File names', html: `<input type="text" id="vxPattern" value="${escapeHtml(localStorage.getItem('tintwork.exportPattern') || '{name}-{preset}')}" />` }]) +
    '<p class="muted small">Tokens: {name} {preset} {w} {h} {n} {n:3} {date}</p>' + formHTML([{ label: 'Watermark', html: watermarkFieldHTML('vxWm') }]);
  body.append(pat); wireWatermarkField(body, 'vxWm');
  showModal({ title: 'Export multiple sizes', body, okLabel: 'Export', ok: () => {
    const pattern = body.querySelector('#vxPattern').value || '{name}-{preset}';
    try { localStorage.setItem(EXPORT_SETS_KEY, JSON.stringify(list)); localStorage.setItem('tintwork.exportPattern', pattern); } catch { /* ignore */ }
    (async () => {
      const sink = await chooseSink(`${(d.name || 'Untitled').replace(/\.[^.]+$/, '')}-export.zip`); if (!sink) { status('Export cancelled.'); return; }
      const ui = progressUI('Export sizes');
      try { const out = await exportVariants(list, { pattern, sink, watermark: body.querySelector('#vxWm').checked ? watermarkSettings() : null, signal: ui.signal, onProgress: (i, n, f) => ui.update(i, n, `${i}/${n} · ${f}`) }); await sink.finish(ui.signal.aborted); status(`Exported ${out.length} file${out.length === 1 ? '' : 's'} to ${sink.label}.`); }
      catch (err) { toast(`Export failed: ${err.message}`, 5000); } finally { ui.done(); }
    })();
  } });
}
/**
 * Batch: open each file in a temporary tab, apply an action and / or a look, export every variant, close the tab.
 * sources: File[] or { name, getFile() }[]. Resolves { done, failed: [{ name, error }], cancelled, files }.
 */
async function runBatch(sources, { actionId = null, lookId = null, intensity = 100, rawSettings = null, variants, pattern = '{name}-{preset}', sink, signal, onProgress, watermark = null } = {}) {
  if (watermark && watermark !== true) await readyWatermark(watermark);
  const home = doc(), files = [], failed = []; let done = 0, n = 0;
  const uniq = uniqueNamer(), wrapSink = { write: (name, blob) => sink.write(uniq(name), blob) };
  for (const s of sources) {
    if (signal?.aborted) break;
    n++; const label = s.name;
    onProgress?.(n - 1, sources.length, `${n}/${sources.length} · ${label}`);
    let opened = null;
    try {
      const file = s instanceof Blob ? s : await s.getFile();
      if (home && doc() !== home && tabs.some((t) => t.doc === home)) switchTab(tabs.findIndex((t) => t.doc === home));
      const before = doc(); await openFile(file, 'open', { interactive: false, rawSettings });
      if (!doc() || doc() === before) throw new Error('could not open this file');
      opened = doc();
      if (actionId) { const r = await playAction(actionId, opened); if (!r.ok) throw new Error(r.errors[0] || 'action failed'); }
      if (lookId && !applyLook(lookId, intensity)) throw new Error('look not found');
      const base = label.replace(/\.[^.]+$/, '');
      const out = await exportVariants(variants, { pattern: variants.length > 1 && !/\{(preset|w|h|n)/.test(pattern) ? `${pattern}-{preset}` : pattern, sink: wrapSink, tokens: { name: base, N: n }, watermark });
      files.push(...out);
      done++;
    } catch (err) { failed.push({ name: label, error: err.message || String(err) }); }
    finally { if (opened && tabs.some((t) => t.doc === opened)) await closeTab(tabs.findIndex((t) => t.doc === opened), { force: true }); }
  }
  if (home && tabs.some((t) => t.doc === home) && doc() !== home) switchTab(tabs.findIndex((t) => t.doc === home));
  onProgress?.(n, sources.length, `${done} done${failed.length ? `, ${failed.length} failed` : ''}`);
  return { done, failed, cancelled: !!signal?.aborted && n < sources.length, files };
}
async function collectFolderImages(dir, recurse = false, out = []) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'file' && (/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(name) || isRawName(name) || isPsdName(name))) out.push(h);
    else if (recurse && h.kind === 'directory') await collectFolderImages(h, true, out);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
// ---- v1.11: remembered batch folders, Batch again, drop onto the dialog ----
// The source and output folders are kept as File System Access handles in IndexedDB (the linked-file store), so
// the next session can reuse them. Browsers forget the permission between sessions unless the user chose
// "Allow on every visit", so each run asks again (one prompt per folder) from the click that starts it.
const LAST_BATCH_KEY = 'tintwork.lastBatch', BATCH_WRITTEN_KEY = 'tintwork.lastBatchWritten', BATCH_IN = 'batch:in', BATCH_OUT = 'batch:out';
let batchDrop = null, lastBatchPrompts = 0;
async function batchHandle(key) { try { const r = await getLink(key); return r?.handle?.kind === 'directory' ? r.handle : null; } catch { return null; } }
async function rememberBatchDir(key, h) { if (h?.kind === 'directory') { try { await putLink(key, h, { name: h.name }); } catch { /* handles not storable here */ } } }
async function forgetBatchDirs() { await deleteLink(BATCH_IN); await deleteLink(BATCH_OUT); }
/** Permission for a stored handle; counts the prompts it had to show (lastBatchPrompts). */
async function batchGrant(h, mode) {
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  lastBatchPrompts++;
  try { return !!h.requestPermission && (await h.requestPermission({ mode })) === 'granted'; } catch { return false; }
}
/** false when a stored folder was deleted, moved or renamed since (its handle no longer resolves). */
async function dirAlive(h) { try { for await (const k of h.keys()) { void k; break; } return true; } catch { return false; } }
async function batchDestSink(remembered) {
  if (remembered) {
    if (!(await batchGrant(remembered, 'readwrite'))) toast(`No permission to write to “${remembered.name}”. Choose the output folder.`, 4000);
    else if (!(await dirAlive(remembered))) { toast(`The output folder “${remembered.name}” is gone (moved, renamed or deleted). Choose it again.`, 5000); await deleteLink(BATCH_OUT); }
    else return dirSink(remembered);
  }
  if ('showDirectoryPicker' in window) {
    try { const dir = await window.showDirectoryPicker({ id: 'tintwork-export', mode: 'readwrite' }); await rememberBatchDir(BATCH_OUT, dir); return dirSink(dir); }
    catch (err) { if (err?.name === 'AbortError') return null; toast(`Folder access unavailable (${err.message}); downloading a zip instead.`, 4000); }
  }
  return zipSink('tintwork-batch.zip');
}
function batchWritten() { try { const v = JSON.parse(localStorage.getItem(BATCH_WRITTEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
/** Sources from a folder, minus the files the last batch wrote there when the output folder is the same folder. */
async function batchSourcesFrom(dir, dest) {
  let list = await collectFolderImages(dir);
  let same = false; try { same = !!dest && (await dir.isSameEntry?.(dest)); } catch { /* ignore */ }
  if (same) { const w = new Set(batchWritten()); list = list.filter((h) => !w.has(h.name)); }
  return list;
}
/** Open tabs as batch sources (original file handle when known, else a JPEG of that tab's composite). Optional name filter = last-opened subset. */
async function sourcesFromOpenTabs(filterNames = null) {
  const want = filterNames?.length ? new Set(filterNames) : null, out = [];
  const home = doc();
  for (let i = 0; i < tabs.length; i++) {
    const d = tabs[i].doc; if (!d?.name) continue;
    if (want && !want.has(d.name)) continue;
    if (d.fileHandle?.kind === 'file') { out.push(d.fileHandle); continue; }
    switchTab(i);
    freshComp();
    try { await compositeSettled(); } catch { /* ignore */ }
    const blob = await new Promise((r) => comp.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) continue;
    const base = (d.name || 'image').replace(/\.tintwork$/i, '').replace(/\.[^.]+$/, '');
    out.push(new File([blob], `${base}.jpg`, { type: 'image/jpeg' }));
  }
  if (home && tabs.some((t) => t.doc === home)) switchTab(tabs.findIndex((t) => t.doc === home));
  return out;
}
async function executeBatch(sources, opts, destHandle) {
  const sink = await batchDestSink(destHandle); if (!sink) { status('Batch cancelled.'); return null; }
  const ui = progressUI('Batch');
  try {
    const r = await runBatch(sources, { ...opts, sink, signal: ui.signal, onProgress: (i, n, t) => ui.update(i, n, t) });
    await sink.finish(r.cancelled);
    try { localStorage.setItem(BATCH_WRITTEN_KEY, JSON.stringify(r.files.map((f) => f.name).slice(0, 5000))); } catch { /* ignore */ }
    const msg = `Batch ${r.cancelled ? 'cancelled' : 'finished'}: ${r.done} of ${sources.length} images, ${r.files.length} files written to ${sink.label}${r.failed.length ? `; ${r.failed.length} failed (${r.failed[0].name}: ${r.failed[0].error})` : ''}.`;
    status(msg); toast(msg, 6000);
    return r;
  } catch (err) { toast(`Batch failed: ${err.message}`, 5000); return null; } finally { ui.done(); }
}
/** Saved dialog settings → runBatch options, or a reason string when they no longer work. */
function batchOptsFrom(last) {
  if (last.actionId && !allActions().some((a) => a.id === last.actionId)) return 'its action was deleted';
  if (last.lookId && !allLooks().some((l) => l.id === last.lookId)) return 'its look was deleted';
  let watermark = null;
  if (last.wm === 'preset') { const p = allExportPresets().find((x) => x.id === last.presetId); if (!p) return 'its export preset was deleted'; watermark = watermarkOfPreset(p); }
  else if (last.wm === 'global') watermark = watermarkSettings();
  if (!Array.isArray(last.variants) || !last.variants.length) return 'it has no outputs';
  return { actionId: last.actionId || null, lookId: last.lookId || null, intensity: last.intensity || 100, rawSettings: rawSettingsFor(last.raw || ''), variants: last.variants, pattern: last.pattern || '{name}-edited', watermark };
}
/** File ▸ Batch again: last settings on the source folder, or on the open tabs that match the last file/tabs run. */
async function batchAgain() {
  let last = null; try { last = JSON.parse(localStorage.getItem(LAST_BATCH_KEY) || 'null'); } catch { /* ignore */ }
  lastBatchPrompts = 0;
  if (!last) { toast('Batch again repeats the last batch. Run Batch process once first (folder, files, or open tabs).', 5000); openBatchDialog(); return null; }
  const opts = batchOptsFrom(last);
  if (typeof opts === 'string') { toast(`Can't repeat the last batch: ${opts}. Opening Batch process.`, 5000); openBatchDialog(); return null; }
  const outH = await batchHandle(BATCH_OUT);
  if (last.src === 'folder') {
    const inH = await batchHandle(BATCH_IN);
    if (!inH) { toast('Batch again needs the last source folder. Run Batch process on a folder once first.', 5000); openBatchDialog(); return null; }
    if (!(await batchGrant(inH, 'read'))) { toast(`No permission to read “${inH.name}”.`, 4000); return null; }
    if (!(await dirAlive(inH))) { await deleteLink(BATCH_IN); toast(`The source folder “${inH.name}” is gone (moved, renamed or deleted). Choose it again.`, 5000); openBatchDialog(); return null; }
    const sources = await batchSourcesFrom(inH, outH);
    if (!sources.length) { toast(`No images in “${inH.name}”.`, 4000); return null; }
    status(`Batch again: ${sources.length} images from “${inH.name}”…`);
    return executeBatch(sources, opts, outH);
  }
  // files / tabs: re-run on currently open tabs (filtered to the last names when remembered)
  const sources = await sourcesFromOpenTabs(last.names || null);
  if (!sources.length) {
    toast(last.names?.length
      ? `Open the last batch's images again (or their tabs), then Batch again. Looking for: ${last.names.slice(0, 4).join(', ')}${last.names.length > 4 ? '…' : ''}.`
      : 'Open the images in tabs first, or run Batch process and choose files / Open tabs.', 6000);
    openBatchDialog(); return null;
  }
  status(`Batch again: ${sources.length} open tab${sources.length === 1 ? '' : 's'}…`);
  return executeBatch(sources, opts, outH);
}
function openBatchDialog() {
  const list = savedVariants().slice(0, 1), body = document.createElement('div'); let sources = [], srcDir = null, destDir = null;
  const acts = allActions(), looks = allLooks(), fsa = 'showDirectoryPicker' in window;
  body.innerHTML = `<div class="field two"><span>Source</span><span><button type="button" id="bSrcDir" ${fsa ? '' : 'disabled title="Folder access needs Chrome or Edge"'}>Choose folder…</button> <button type="button" id="bSrcFiles">Choose files…</button> <button type="button" id="bSrcTabs" title="Use the images already open as tabs (Batch again can repeat this subset)">Open tabs</button> <span id="bSrcInfo" class="muted">No images chosen (or drop files or a folder here)</span></span></div>` +
    `<div class="field two"><span>Output folder</span><span><button type="button" id="bDestDir" ${fsa ? '' : 'disabled title="Folder access needs Chrome or Edge; a .zip is downloaded"'}>Choose folder…</button> <span id="bDestInfo" class="muted">${fsa ? 'Asked when you run' : '.zip download'}</span> <button type="button" id="bForget" class="hidden" title="Forget the remembered source and output folders">Forget folders</button></span></div>` +
    formHTML([
      { label: 'Export preset', html: `<select id="bPreset" title="Use a saved export preset for the outputs (format, quality, size, ppi and its watermark)"><option value="">(set the outputs below)</option>${allExportPresets().map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>` },
      { label: 'Action', html: `<select id="bAct"><option value="">(none)</option>${acts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('')}</select>` },
      { label: 'Look', html: `<select id="bLook"><option value="">(none)</option>${looks.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}</select>` },
      { label: 'Look intensity (%)', html: `<input type="number" id="bInt" min="0" max="100" value="100" style="width:72px"/>` },
      { label: 'RAW files develop with', html: `<select id="bRaw" title="Develop settings for camera RAW files in the batch">${rawPresetOptions(false)}</select>` },
      { label: 'File names', html: `<input type="text" id="bPattern" value="{name}-edited" />` },
      { label: 'Watermark', html: watermarkFieldHTML('bWm') },
    ]) + '<p class="muted small">Tokens: {name} {preset} {w} {h} {N} (file number, {N:3} padded) {date}. Tintwork remembers both folders for next time; File ▸ Batch again also repeats a files/Open-tabs run on the matching open tabs. The browser may ask again for folder permission.</p><b>Outputs</b>';
  const ve = variantEditor(list); body.append(ve);
  let presetWm = null; // the chosen export preset's own watermark (until the watermark is edited here)
  wireWatermarkField(body, 'bWm', () => {});
  body.querySelector('[data-wmedit="bWm"]').addEventListener('click', () => { presetWm = null; });
  const bp = body.querySelector('#bPreset'), lastBp = localStorage.getItem(LAST_BATCH_PRESET_KEY);
  const useExportPreset = (p) => {
    const sz = p.size; list.splice(0, list.length, { ...(sz ? { ...sz } : { mode: 'original' }), type: p.type === PSD_TYPE ? 'image/png' : p.type, quality: p.quality ?? 90, ...(p.dpi ? { dpi: p.dpi } : {}), ...(p.sharpen && p.sharpen !== 'off' ? { sharpen: p.sharpen } : {}) });
    ve.dispatchEvent(new CustomEvent('redraw'));
    presetWm = watermarkOfPreset(p); const box = body.querySelector('#bWm'); box.checked = !!presetWm;
    body.querySelectorAll('[data-wmtext]').forEach((el) => { el.textContent = watermarkLabel(presetWm || watermarkSettings()); });
    body.querySelector('.wm-panel')?.remove();
  };
  bp.addEventListener('change', () => { const p = allExportPresets().find((x) => x.id === bp.value); if (p) useExportPreset(p); try { localStorage.setItem(LAST_BATCH_PRESET_KEY, bp.value); } catch { /* ignore */ } });
  ve.addEventListener('change', () => { if (bp.value) { bp.value = ''; presetWm = null; } }); // editing the outputs by hand leaves the preset
  if (lastBp && allExportPresets().some((x) => x.id === lastBp)) { bp.value = lastBp; useExportPreset(allExportPresets().find((x) => x.id === lastBp)); }
  const plural = (n) => `${n} image${n === 1 ? '' : 's'}`;
  const info = (text) => { body.querySelector('#bSrcInfo').textContent = text ?? (sources.length ? `${plural(sources.length)}${srcDir ? ` in “${srcDir.name}”` : ''}` : srcDir ? `“${srcDir.name}” (last folder; the browser may ask to read it again when you run)` : 'No images chosen (or drop files or a folder here)'); };
  const destInfo = () => { body.querySelector('#bDestInfo').textContent = destDir ? `“${destDir.name}”${destDir === rememberedOut ? ' (last used)' : ''}` : fsa ? 'Asked when you run' : '.zip download'; body.querySelector('#bForget').classList.toggle('hidden', !(destDir || srcDir)); };
  let rememberedOut = null, picked = false; // picked: the user chose a source in this dialog (don't overwrite it with the remembered one)
  const useDir = async (dir) => { picked = true; srcDir = dir; sources = await batchSourcesFrom(dir, destDir); info(); destInfo(); await rememberBatchDir(BATCH_IN, dir); };
  (async () => { // remembered folders
    const [inH, outH] = await Promise.all([batchHandle(BATCH_IN), batchHandle(BATCH_OUT)]);
    if (outH && !destDir) { destDir = rememberedOut = outH; destInfo(); }
    if (inH && !picked) {
      srcDir = inH; info(); destInfo();
      try { if ((await inH.queryPermission?.({ mode: 'read' })) === 'granted' && !picked) { if (!(await dirAlive(inH))) { srcDir = null; await deleteLink(BATCH_IN); info(); destInfo(); } else { sources = await batchSourcesFrom(inH, destDir); info(); } } } catch { /* ask when run */ }
    }
  })();
  body.querySelector('#bSrcDir').onclick = async () => { try { await useDir(await window.showDirectoryPicker({ id: 'tintwork-batch-in', mode: 'read' })); } catch (err) { if (err?.name !== 'AbortError') toast(err.message, 4000); } };
  body.querySelector('#bSrcFiles').onclick = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = OPEN_ACCEPT; inp.onchange = () => { picked = true; srcDir = null; sources = [...inp.files]; info(); destInfo(); }; inp.click(); };
  body.querySelector('#bSrcTabs').onclick = async () => {
    if (!tabs.length) { toast('Open one or more images first (each is a tab).'); return; }
    picked = true; srcDir = null; sources = await sourcesFromOpenTabs(); info(`Open tabs: ${plural(sources.length)}`); destInfo();
  };
  body.querySelector('#bDestDir').onclick = async () => { try { const dir = await window.showDirectoryPicker({ id: 'tintwork-export', mode: 'readwrite' }); destDir = dir; rememberedOut = null; destInfo(); await rememberBatchDir(BATCH_OUT, dir); } catch (err) { if (err?.name !== 'AbortError') toast(err.message, 4000); } };
  body.querySelector('#bForget').onclick = async () => { await forgetBatchDirs(); destDir = rememberedOut = null; if (!picked) { srcDir = null; sources = []; } destInfo(); info(); status('Batch folders forgotten.'); };
  const isImageName = (n) => /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(n) || isRawName(n) || isPsdName(n);
  batchDrop = async (e) => { // files or one folder dropped anywhere while this dialog is open
    const items = [...(e.dataTransfer?.items || [])].filter((it) => it.kind === 'file');
    const hs = await Promise.all(items.map((it) => (typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle().catch(() => null) : null)));
    const dir = hs.find((h) => h?.kind === 'directory');
    if (dir) { await useDir(dir); return; }
    const files = [...(e.dataTransfer?.files || [])].filter((f) => isImageName(f.name));
    if (!files.length) { toast('Drop image files or a folder of images.'); return; }
    picked = true; srcDir = null; sources = files; info(); destInfo();
  };
  showModal({ title: 'Batch process', body, okLabel: 'Run batch', onClose: () => { batchDrop = null; }, ok: () => {
    if (!sources.length && !srcDir) { toast('Choose a folder or some images first.'); return false; }
    const raw = body.querySelector('#bRaw').value, wmOn = body.querySelector('#bWm').checked;
    const opts = { actionId: body.querySelector('#bAct').value || null, lookId: body.querySelector('#bLook').value || null, intensity: +body.querySelector('#bInt').value || 100, rawSettings: rawSettingsFor(raw), variants: list, pattern: body.querySelector('#bPattern').value || '{name}-edited', watermark: wmOn ? (presetWm || watermarkSettings()) : null };
    try {
      const srcKind = srcDir ? 'folder' : (body.querySelector('#bSrcInfo')?.textContent || '').startsWith('Open tabs') ? 'tabs' : 'files';
      localStorage.setItem(LAST_BATCH_KEY, JSON.stringify({ src: srcKind, names: srcKind === 'folder' ? null : sources.map((x) => x.name).slice(0, 200), presetId: bp.value || null, actionId: opts.actionId, lookId: opts.lookId, intensity: opts.intensity, raw, variants: list.map((v) => ({ ...v })), pattern: opts.pattern, wm: !wmOn ? 'none' : presetWm ? 'preset' : 'global' }));
    } catch { /* ignore */ }
    lastBatchPrompts = 0;
    const dir = srcDir, dest = destDir;
    (async () => {
      let src = sources;
      if (dir) { // a remembered folder needs its permission again in a new session; this click allows the prompt
        if (!(await batchGrant(dir, 'read'))) { toast(`No permission to read “${dir.name}”.`, 4000); return; }
        if (!src.length && !(await dirAlive(dir))) { await deleteLink(BATCH_IN); toast(`The source folder “${dir.name}” is gone (moved, renamed or deleted). Choose it again.`, 5000); return; }
        if (!src.length) src = await batchSourcesFrom(dir, dest);
        if (!src.length) { toast(`No images in “${dir.name}”.`, 4000); return; }
      }
      await executeBatch(src, opts, dest);
    })();
  } });
}
/**
 * Embed a compact sRGB ICC profile in a JPEG (APP2 ICC_PROFILE). PNG already carries an sRGB chunk from encodePng;
 * other types are unchanged. Skips the write when an ICC segment is already present.
 */
async function withSrgbIcc(blob) {
  if (blob.type !== 'image/jpeg') return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return blob;
  for (let i = 2; i + 4 < b.length && b[i] === 0xff;) {
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xda || m === 0xd9) break;
    if (m === 0xe2) {
      let ok = true; const tag = 'ICC_PROFILE';
      for (let k = 0; k < tag.length; k++) if (b[i + 4 + k] !== tag.charCodeAt(k)) { ok = false; break; }
      if (ok) return blob;
    }
    if (len < 2) break;
    i += 2 + len;
  }
  const icc = srgbIccBytes();
  const head = 14; // 'ICC_PROFILE\0' (12) + chunk seq + chunk count
  if (icc.length + head > 65535) return blob; // single-segment only for this compact profile
  const seg = new Uint8Array(2 + 2 + head + icc.length);
  seg[0] = 0xff; seg[1] = 0xe2;
  const len = 2 + head + icc.length; seg[2] = len >> 8; seg[3] = len & 255;
  const tag = 'ICC_PROFILE';
  for (let k = 0; k < tag.length; k++) seg[4 + k] = tag.charCodeAt(k);
  seg[4 + tag.length] = 0; // NUL
  seg[4 + tag.length + 1] = 1; // chunk sequence (1-based)
  seg[4 + tag.length + 2] = 1; // chunk count
  seg.set(icc, 2 + 2 + head);
  let insertAt = 2;
  if (b[2] === 0xff && (b[3] === 0xe0 || b[3] === 0xe1)) insertAt = 2 + 2 + ((b[4] << 8) | b[5]);
  return new Blob([b.subarray(0, insertAt), seg, b.subarray(insertAt)], { type: blob.type });
}
/** Insert a PNG sRGB chunk after IHDR when the encoder (canvas toBlob) omitted one. encodePNG already writes it. */
async function withPngSrgb(blob) {
  if (blob.type !== 'image/png') return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  if (b[0] !== 0x89 || b[1] !== 0x50) return blob;
  for (let i = 8; i + 8 < b.length;) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'sRGB' || type === 'iCCP') return blob;
    if (type === 'IHDR') {
      const data = new Uint8Array([0]); // perceptual
      const chunk = new Uint8Array(12 + 1), dv = new DataView(chunk.buffer);
      dv.setUint32(0, 1); chunk.set([0x73, 0x52, 0x47, 0x42], 4); chunk[8] = 0;
      dv.setUint32(9, crc32(chunk.subarray(4, 9)));
      const at = i + 12 + len;
      return new Blob([b.subarray(0, at), chunk, b.subarray(at)], { type: blob.type });
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return blob;
}
/** Write the print resolution into PNG (pHYs) or JPEG (JFIF density) bytes. */
async function withDpi(blob, dpi) {
  const b = new Uint8Array(await blob.arrayBuffer());
  if (blob.type === 'image/jpeg' && b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(...b.subarray(6, 10)) === 'JFIF') {
    b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255; return new Blob([b], { type: blob.type });
  }
  if (blob.type === 'image/png' && b[12] === 0x49 && b[13] === 0x48) { // IHDR is first: insert pHYs after it
    const ppm = Math.round(dpi / 0.0254), chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 8 + 25; return new Blob([b.subarray(0, at), chunk, b.subarray(at)], { type: blob.type });
  }
  return blob;
}
let crcTable = null;
function crc32(a) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < a.length; i++) c = crcTable[(c ^ a[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
function openLayerToDocDialog() {
  const others = tabs.map((t, i) => [t, i]).filter(([t]) => t.doc !== doc());
  if (!others.length) { toast('Open another image or canvas first (each opens in its own tab).'); return; }
  const body = document.createElement('div');
  body.innerHTML = formHTML([{ label: 'Copy to', html: `<select id="ltd">${others.map(([t, i]) => `<option value="${i}">${escapeHtml(t.doc.name || 'Untitled')} (${t.doc.width}×${t.doc.height})</option>`).join('')}</select>` }]) +
    '<p class="muted small">Tip: you can also drag a layer from the Layers panel onto a document tab.</p>';
  showModal({ title: `Duplicate “${activeLayer().name}” to document`, body, okLabel: 'Duplicate', ok: () => { copyLayerToDoc(activeLayer().id, +body.querySelector('#ltd').value); } });
}

window.tintwork = {
  setDevelopEnv, get lastDecoder() { return lastDecoder; }, redevelopRaw,
  // v1.4
  openHandle, embedLinkedRaw, setRelinkPicker: (fn) => { relinkPicker = fn; }, forgetLinkHandles: () => linkHandles.clear(), get lastRelink() { return { ...lastRelink }; },
  lensProfiles, saveLensProfile, forgetLensProfile, lensDistortionFor, trackRaw, rawMapOf, transformLayer, transformDoc, resizeImage, exportRawPresets, importRawPresets, parseRawPresetFile, projectData, loadProject, cropTo,
  // v1.1
  openPSD, openRAW, documentFromPSD, documentToPSD, flatPSD, get rawUI() { return rawUI; }, get lastImport() { return lastImport; }, get lastExportNotes() { return lastExportNotes; },
  readPSDAsync, writePSDAsync, openRawSession, isRawName, isPsdName, RAW_DEFAULTS, PSD_TYPE, DEEP_LIMIT_MB,
  // v1.2
  rawPresets, saveRawPreset, deleteRawPreset, rawSettingsFor, rawLastSettings, cleanRawSettings, get lastDevelopProgress() { return lastDevelopProgress; },
  // v0.9
  tabs, switchTab, closeTab, cycleTab, copyLayerToDoc, tabDirty, stashTab,
  presets: { allPresets, presetById, presetPixels, centredRatioRect, constrainRect, saveCustomPreset, deleteCustomPreset, customPresets }, setCropPreset, applyCropTool, resizeToPreset, cropAspect,
  recorder, startRecording, stopRecording, playAction, allActions, userActions, importActionsJSON, applyAdjustDirect, describeStep,
  // v1.8
  objSel: { run: async (rect, { strokes = [], mode = 'new', refine } = {}) => { const d = doc(); if (refine != null) state.opts.objRefine = refine; state.objSel = { doc: d, rect, strokes: strokes.map((s) => ({ fg: s.fg !== false, r: s.r || 12, pts: s.pts })), base: mode === 'new' ? null : d.selection, prev: d.selection, mode }; return objSelRun(); },
    stroke: async (st) => { const s = state.objSel; if (!s) return null; s.strokes.push({ fg: st.fg !== false, r: st.r || 12, pts: st.pts }); return objSelRun(); }, settled: () => objSelJob, done: objSelDone, cancel: objSelCancel, get state() { return state.objSel; } },
  autoUprightCmd, get lastUpright() { return lastUpright; }, cropEmptyEdges, fillEmptyEdges, innerOpaqueRect, segment: seg,
  exportPresets: { all: allExportPresets, user: userExportPresets, save: saveExportPreset, remove: deleteExportPreset, builtin: BUILTIN_EXPORT_PRESETS, lastKey: LAST_EXPORT_PRESET_KEY },
  exportSharpen: { apply: applyExportSharpen, optionsHTML: exportSharpOptionsHTML, label: exportSharpLabel, presets: EXPORT_SHARP_PRESETS, scaledSharpParams },
  finishGuidedUpright, uprightFromGuides,
  setProof, setProofWarn, get proofMode() { return proofMode; }, get proofWarn() { return proofWarn; }, PROOF_PAPERS,
  batchAgain, forgetBatchDirs, batchHandle, get lastBatchPrompts() { return lastBatchPrompts; }, LAST_BATCH_KEY,
  watermarkSettings, saveWatermark, drawWatermark, exportWithLastPreset, renderExportWith, readyWatermark, watermarkImageFromFile,
  renderVariant, exportVariants, runBatch, sourcesFromOpenTabs, memorySink, zipSink, formatName, variantSize, withDpi, withSrgbIcc, withPngSrgb, autoOpts, saveAutoOpts, openAutoOptionsDialog,
  // v0.8
  pickLayer: (ids) => { const d = doc(); d.activeId = ids[ids.length - 1]; d.picked = new Set(ids.length > 1 ? ids : []); updateLayersPanel(); },
  pickedLayers: () => pickedLayers().map((l) => l.id), alignLayers, straightenBy, autoStraightenCmd, autoEnhanceCmd, autoWhiteBalanceCmd, wbPickAt,
  detectTilt: () => auto.detectTilt(analysisImage(600).img), applyLook, allLooks, saveLookFromSelection, exportLooksJSON, importLooksJSON, importCubeText,
  setLookIntensity, addAdj: (type, params, name) => { const l = makeAdjLayer(type, params, name); addLayer(l, name || type); return l; }, analysisImage, layerBounds: (id) => layerBounds(doc(), layerById(doc(), id)),
  renderNow: () => { render(); }, markDirty: () => { compDirty = true; }, adjInteractive,
  // v1.0
  APP_VERSION, compositeCanvas: () => { freshComp(); return comp; }, guardSize, estimateMB, mdToHtml, openUserGuide, onGlobalError, refreshWelcome, renderExportBlob: (type, q) => renderExport(type, q), reportError, MEM_LIMIT_MB,
  state, cmds, run, setTool, openFile, newDocument, history, commit, composite, activeLayer, setFg, serializeProject, openAdjust, ADJ,
  ops, setSelection, makeSelection, rectMask, renderSource, updateLayersPanel, touch, fitToScreen,
  mods, setMod, openSheet, closeSheet, toast, MAX_PIXELS, IS_IOS, fitPixels, renderExport,
  /** true once the current state is in IndexedDB and nothing is waiting to be written */
  get autosaveSettled() { return !autosaveTimer && !autosaveRunning && writtenEntry === history.entries[history.index]; },
  autosaveNow, readAutosave, clearAutosave, listAutosaves, checkRecovery, restoreAutosave,
  startTransform, applyTransform, cancelTransform, get xf() { return state.xf; }, previewTransform, xfMatrix,
  convertToSmart, setSmartFilters, updateSmart, openSmartFilterDialog, openLiveFilterPanel, composeSmart, filteredSync, addFilterMask,
  openColorRangeDialog, openRefineDialog, colorRangeMask, bakeAdjustment, BUNDLED_FONTS, fontReady, loadFont, AUTOSAVE_STEPS, MAX_SLOTS, newAdjustmentLayer, editLayer, adjCache, rasterize, renderTextLayer, textLayerAt, undo, redo, closeModal, mergeDown,
  isGroup, childrenOf, descendantsOf, placeLayer, normalizeTree, resolveItems, insertLayer, openStylesDialog, defaultEffect, mergeGroup, layerById, mesh,
  startMeshXf, applyMeshXf, cancelMeshXf, uprightFromGuides, mxfRender, renderMeshAny, get mxf() { return state.mxf; }, runBenchmarkInApp, benchText, openBenchmarkDialog, benchTableHTML, redEyeAt,
  /** Liquify stroke through the real tool code; resolves after the final (GPU or CPU) render. */
  async liquifyStroke(points) { const h = liquifyTool; h.down(points[0]); for (let i = 1; i < points.length; i++) h.move(points[i]); await h.up(); return gfx.lastWarpPath; },
  createLayer, defaultAdjParams, gfx, initEngine, setEnginePref, setDepth, deepOf, setDeep, compositeDeepDoc, encodePNG, decodePNG, pngInfo, deepToImageData, deepFromImageData, createDeep, loadProject, openEngineDialog, exportImage, gpuLayerList, platform: { IS_MAC, PLATFORM, keyLabel, platformText, shortcutFor, comboOf, RESERVED },
  /** Run a brush/eraser stroke through the real tool code (tests and benchmarks). points: [{x, y}] in doc px. */
  paintStroke(points, { tool = 'brush', shift = false } = {}) {
    const h = toolHandlers[tool], ev = { shiftKey: shift, altKey: false, ctrlKey: false, metaKey: false, button: 0, pointerType: 'mouse' };
    h.down(points[0], ev); for (let i = 1; i < points.length; i++) h.move(points[i], ev); h.up(points[points.length - 1], ev); drag = null;
    return { dabPath: gfx.dabPath || 'cpu' };
  },
  closeContextMenu, showContextMenu, adjustBrushHardness, adjustBrushSize, applyGradient, addShapeLayer, shapeGeom, redEyeAt,
  get engine() { return gfx.engine; }, compositeSettled, get engineReady() { return gfx.ready || Promise.resolve(gfx.engine); },
  get zoom() { return state.zoom; },
  async compositePixelAsync(x, y) { freshComp(); await compositeSettled(); return [...compCtx.getImageData(x, y, 1, 1).data]; },
  compositePixel(x, y) { freshComp(); return [...compCtx.getImageData(x, y, 1, 1).data]; },
  get doc() { return state.doc; },
  get workerAvailable() { return ops.workerStatus().available; },
  /** Resolves once queued worker jobs have finished. */
  idle: () => new Promise((res) => { const t = () => (state.busy || adjPending ? setTimeout(t, 10) : res()); t(); }),
};
