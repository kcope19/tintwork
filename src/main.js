// Tintwork — an original, browser-based layered image editor (Canvas 2D).
import { floodMask, similarMask, histogram, runOp, channelHistograms, colorRangeMask, HUE_PRESETS } from './pixels.js';
import { createCurvesEditor, identityCurves } from './curves-editor.js';
import { readAutosave, writeAutosave, clearAutosave, markAutosaveClean, listAutosaves, readImages, imageRef, deepRef, isDeepId, adoptImage, decodeImage, MAX_SLOTS } from './autosave.js';
import { makeSelection, shapeMask, rectMask, combine, invertSelection, selectionCanvas, selectionOutline, maskRegion, translateSelection } from './selection.js';
import * as ops from './ops.js';
import { ICONS } from './icons.js';
import { createEngine } from './gpu.js';
import { createWebGPUEngine, webgpuAvailable } from './webgpu.js';
import { fsaSupported, pickOpen, pickSave, writeFile, ensurePermission, listRecent, addRecent, removeRecent, clearRecent, EXPORT_TYPES } from './files.js';
import { blendIndex, createDeep, cloneDeep, deepFromImageData, deepToImageData, reconcileDeep, compositeDeep, accToDeep, runDeep, DEEP_OPS } from './deep.js';
import { decodePNG, encodePNG, pngInfo } from './png.js';
import { IS_MAC, PLATFORM, primaryMod, keyLabel, platformText, comboOf, RESERVED } from './platform.js';

const APP = 'Tintwork';
const APP_VERSION = '0.6.0';
const PROJECT_FORMAT = 'tintwork-project';
const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const viewport = $('#viewport');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  doc: null,          // { width, height, layers: [], activeId, selection, name }
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
    selMode: 'new', wandTolerance: 32, wandContiguous: true, wandSampleAll: false, featherRadius: 8,
    cloneSize: 40, cloneHardness: 60, cloneOpacity: 100, cloneAligned: true,
    healSize: 40, healHardness: 80, healOpacity: 100, spotSize: 30, spotHardness: 80, spotOpacity: 100,
    xfKeepAspect: false, xfSkew: false,
    gradType: 'linear', gradColors: 'fg-bg', gradReverse: false, gradOpacity: 100,
    shapeKind: 'rect', shapeStyle: 'fill', shapeStroke: 8, shapeRadius: 0,
    toneSize: 60, toneHardness: 40, toneOpacity: 40, toneMode: 'dodge', toneRange: 'midtones',
    redeyeSize: 40, redeyeDarken: 60,
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
// Rendering engine (gpu.js) — View ▸ Rendering engine… chooses Auto / GPU / CPU (remembered per browser).
const ENGINE_KEY = 'tintwork.engine';
const readPref = (k, def) => { try { return localStorage.getItem(k) || def; } catch { return def; } };
const gfx = { pref: readPref(ENGINE_KEY, 'auto'), engine: null, reason: 'not started', path: 'cpu', notices: new Set(), frame: 0, linear: readPref('tintwork.linear', '0') === '1' };
// GPU memory budget for textures. iPhones share RAM between CPU and GPU and kill tabs early, so keep it small.
// Desktop budget scales with the reported device memory (Chrome/Edge: navigator.deviceMemory, capped at 8 GB).
const DEVICE_GB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
const GPU_BUDGET_MB = IS_IOS ? 384 : DEVICE_GB >= 8 ? 3072 : DEVICE_GB >= 4 ? 2048 : 1024;
const GPU_PROBE_MS = 40; // 1 MP blur (upload + 2 passes + readback): hardware GPUs take a few ms, software GL 50–300 ms
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
const geomCanvas = (l) => (l.kind === 'adjust' ? l.mask.canvas : l.canvas);
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
const editingMask = (l = activeLayer()) => !!(l && (editingFMask(l) || (l.mask && (l.editMask || l.kind === 'adjust'))));
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
  if (layer.kind === 'adjust') return;
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
  layer.canvas = c; layer.x = x0; layer.y = y0; touch(layer);
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
        ...(l.deep ? { deep: l.deep, deepRev: l.deepRev, deepOX: l.deepOX || 0, deepOY: l.deepOY || 0 } : {}), // 16-bit data is immutable too
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
function undo() { if (state.xf) { cancelTransform(); return; } if (history.index > 0) { restore(history.index - 1); status(`Undo: ${history.entries[history.index + 1].label}`); } }
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
  c.clearRect(0, 0, d.width, d.height);
  if (opts.background) { c.fillStyle = opts.background; c.fillRect(0, 0, d.width, d.height); }
  const below = [opts.background || ''];
  for (const l of d.layers) {
    if (l.visible && l.opacity > 0) {
      if (l.kind === 'adjust') drawAdjustmentLayer(c, l, below.join('|'), opts);
      else {
        c.globalAlpha = l.opacity;
        c.globalCompositeOperation = l.blend;
        c.drawImage(renderSource(l), l.x, l.y);
      }
    }
    below.push(layerSignature(l));
  }
  c.restore();
  return target;
}

// --- adjustment layers: re-applied to everything below them on each composite ----
// Results are cached per layer, keyed by a signature of the layers underneath, so
// painting above an adjustment layer costs nothing extra. Big documents compute in
// the pixel worker (showing the previous result until the new one is ready).
const ADJ_LAYER = {
  brightnessContrast: 'Brightness / contrast', hueSaturation: 'Hue / saturation', exposure: 'Exposure',
  levels: 'Levels', curves: 'Curves', invert: 'Invert', grayscale: 'Grayscale',
};
const ADJ_SYNC_PIXELS = 2_500_000;
const adjCache = new Map();
let adjPending = 0;
let adjScratch = null;
function layerSignature(l) {
  return `${l.id}:${l.rev}:${l.visible ? 1 : 0}:${l.opacity}:${l.blend}:${l.x},${l.y}:${l.mask ? `${l.mask.rev}${l.mask.enabled ? 'e' : 'd'}` : '-'}${l.kind === 'adjust' ? ':' + JSON.stringify(l.adj) : ''}`;
}
function putInto(canvas, img) {
  if (!canvas || canvas.width !== img.width || canvas.height !== img.height) canvas = makeCanvas(img.width, img.height);
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
function drawAdjustmentLayer(c, l, below, opts) {
  const d = doc(), W = d.width, H = d.height;
  const key = `${W}x${H}|${below}|${JSON.stringify(l.adj)}`;
  let e = adjCache.get(l.id); if (!e) { e = { key: null, canvas: null, running: false }; adjCache.set(l.id, e); }
  if (e.key !== key) {
    if (!opts.sync && W * H > ADJ_SYNC_PIXELS && ops.workerStatus().available) {
      if (!e.running) {
        e.running = true; adjPending++;
        const img = c.getImageData(0, 0, W, H);
        ops.process(l.adj.type, img, l.adj.params || {}).then((out) => { e.canvas = putInto(e.canvas, out); e.key = key; })
          .catch((err) => status(`Adjustment layer failed: ${err.message}`))
          .finally(() => { e.running = false; adjPending--; compDirty = true; requestRender(); });
      }
      if (!e.canvas || e.canvas.width !== W || e.canvas.height !== H) return; // first result not ready yet
    } else {
      const img = c.getImageData(0, 0, W, H);
      runOp(l.adj.type, img, l.adj.params || {});
      e.canvas = putInto(e.canvas, img); e.key = key;
    }
  }
  if (!adjScratch || adjScratch.width !== W || adjScratch.height !== H) adjScratch = makeCanvas(W, H);
  const sx = adjScratch.getContext('2d');
  sx.save(); sx.globalAlpha = 1; sx.globalCompositeOperation = 'copy'; sx.drawImage(e.canvas, 0, 0);
  const masked = l.mask && l.mask.enabled;
  if (masked) {
    sx.globalCompositeOperation = 'destination-in'; sx.drawImage(l.mask.canvas, l.x, l.y);
    sx.globalCompositeOperation = 'source-over';
    const mx = l.x, my = l.y, mw = l.mask.canvas.width, mh = l.mask.canvas.height; // nothing outside the mask
    sx.clearRect(0, 0, W, Math.max(0, my)); sx.clearRect(0, my + mh, W, H); sx.clearRect(0, 0, Math.max(0, mx), H); sx.clearRect(mx + mw, 0, W, H);
  }
  sx.restore();
  c.save(); c.globalAlpha = l.opacity;
  if (l.blend === 'source-over') {
    // result = below × (1 − k) + adjusted × k, with k = mask × opacity (exact on premultiplied pixels)
    c.globalCompositeOperation = 'destination-out';
    if (masked) c.drawImage(l.mask.canvas, l.x, l.y); else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    c.globalCompositeOperation = 'lighter';
  } else c.globalCompositeOperation = l.blend;
  c.drawImage(adjScratch, 0, 0);
  c.restore();
}
// ---------------------------------------------------------------------------
// GPU engine glue. Every GPU job has a CPU fallback: unsupported, too large, out of budget or a lost
// context all drop back to the Canvas 2D / worker path (with a one-time notice).
// ---------------------------------------------------------------------------
let engineGen = 0;
/**
 * Pick the rendering engine. Order in automatic mode: WebGPU (hardware adapter that passes the speed
 * probe) → WebGL2 (same test) → CPU. 'webgpu' and 'gpu' (WebGL2) force that engine even on a software
 * renderer. WebGPU start-up is asynchronous: the CPU path renders until it is ready.
 * Returns a promise that resolves once the final engine is in place.
 */
function initEngine() {
  const gen = ++engineGen;
  if (gfx.engine) { try { gfx.engine.destroy(); } catch { /* already gone */ } }
  gfx.engine = null; ops.setAccelerator(null); gfx.path = 'cpu'; gfx.notices.clear(); gfx.webgpuReason = ''; gfx.asyncFailed = false;
  if (gfx.pref === 'cpu') { gfx.reason = 'CPU engine selected'; compDirty = true; updateDocInfo(); return Promise.resolve(null); }
  const wantGPU = gfx.pref === 'webgpu' || (gfx.pref === 'auto' && webgpuAvailable());
  if (!wantGPU) { initWebGL(); return Promise.resolve(gfx.engine); }
  gfx.reason = 'starting WebGPU…'; updateDocInfo();
  gfx.ready = (async () => {
    let e;
    try { e = await createWebGPUEngine({ budgetMB: GPU_BUDGET_MB, tile: 4096, onLost: onGpuLost }); } catch (err) { e = { error: err?.message || String(err) }; }
    if (gen !== engineGen) { if (!e.error) e.destroy(); return gfx.engine; }
    if (e.error) {
      gfx.webgpuReason = e.error;
      if (gfx.pref === 'webgpu') { toast(`WebGPU unavailable (${e.error}) — using the CPU engine.`, 5000); gfx.reason = e.error; compDirty = true; requestRender(); updateDocInfo(); return null; }
      initWebGL(); requestRender(); return gfx.engine;
    }
    if (gfx.pref === 'auto' && await webgpuIsSlow(e)) {
      if (gen !== engineGen) { e.destroy(); return gfx.engine; }
      gfx.webgpuReason = `software / slow WebGPU adapter (${e.info.renderer})`; e.destroy();
      initWebGL(); requestRender(); return gfx.engine;
    }
    if (gen !== engineGen) { e.destroy(); return gfx.engine; }
    gfx.engine = e; ops.setAccelerator(e); gfx.reason = '';
    smartCache.clear(); compDirty = true; requestRender(); updateDocInfo();
    return e;
  })();
  return gfx.ready;
}
/** WebGL2 engine (fallback for WebGPU; forced by pref 'gpu'). */
function initWebGL() {
  let e;
  try { e = createEngine({ budgetMB: Math.min(GPU_BUDGET_MB, IS_IOS ? 384 : 2048), tile: IS_IOS ? 2048 : 4096, onLost: onGpuLost }); }
  catch (err) { e = { error: err?.message || String(err) }; }
  if (e.error) {
    gfx.reason = e.error;
    if (gfx.pref === 'gpu') toast(`GPU engine unavailable (${e.error}) — using the CPU engine.`, 5000);
  } else if (gfx.pref === 'auto' && gpuIsSlow(e)) {
    // Automatic mode only uses a hardware GPU: a software rasteriser (SwiftShader, llvmpipe…) runs on the
    // main thread and is slower than the CPU worker path. View ▸ Rendering engine still forces it.
    gfx.reason = `software / slow GPU renderer (${e.info.renderer}); the CPU engine is faster here`;
    e.destroy();
  } else { gfx.engine = e; ops.setAccelerator(e); gfx.reason = ''; }
  compDirty = true; updateDocInfo();
}
/** WebGPU version of the speed probe (async readback); cached per adapter. */
async function webgpuIsSlow(e) {
  if (e.info.software) return true;
  const key = 'tintwork.webgpuProbe', id = `${e.info.renderer}|${APP_VERSION}`;
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.id === id) { gfx.probeMs = c.ms; return c.ms > GPU_PROBE_MS; } } catch { /* ignore */ }
  let ms = Infinity;
  try {
    const n = 1024, img = new ImageData(n, n), info = { docW: n, docH: n, offX: 0, offY: 0 };
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7) & 255;
    await e.processImageData('gaussianBlur', img, { radius: 8 }, info);
    const t0 = performance.now(); await e.processImageData('gaussianBlur', img, { radius: 8 }, info); ms = performance.now() - t0;
  } catch (err) { console.warn('WebGPU probe failed', err); }
  gfx.probeMs = Math.round(ms);
  try { if (Number.isFinite(ms)) localStorage.setItem(key, JSON.stringify({ id, ms: gfx.probeMs })); } catch { /* ignore */ }
  return ms > GPU_PROBE_MS;
}
/** True for software GL, or when a 1 MP blur probe is slower than a hardware GPU would be (cached per renderer). */
function gpuIsSlow(e) {
  if (e.info.software) { gfx.probeMs = null; return true; }
  const key = 'tintwork.gpuProbe', id = `${e.info.vendor}|${e.info.renderer}|${APP_VERSION}`;
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && c.id === id) { gfx.probeMs = c.ms; return c.ms > GPU_PROBE_MS; } } catch { /* ignore */ }
  let ms = Infinity;
  try {
    const n = 1024, img = new ImageData(n, n), info = { docW: n, docH: n, offX: 0, offY: 0 };
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7) & 255;
    e.processImageData('gaussianBlur', img, { radius: 8 }, info); // compiles shaders, allocates
    const t0 = performance.now(); e.processImageData('gaussianBlur', img, { radius: 8 }, info); ms = performance.now() - t0;
  } catch (err) { console.warn('GPU probe failed', err); }
  gfx.probeMs = Math.round(ms);
  try { if (Number.isFinite(ms)) localStorage.setItem(key, JSON.stringify({ id, ms: gfx.probeMs })); } catch { /* ignore */ }
  return ms > GPU_PROBE_MS;
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
  const out = [];
  for (const l of d.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    const vol = isVolatile(l) ? `:f${gfx.frame}` : '';
    const mode = blendIndex(l.blend);
    const mask = l.mask && l.mask.enabled ? { key: `m${l.id}:${l.mask.rev}${vol}`, slot: `m${l.id}`, canvas: l.mask.canvas, x: l.x, y: l.y } : null;
    if (l.kind === 'adjust') { out.push({ kind: 'adjust', op: l.adj.type, params: l.adj.params || {}, opacity: l.opacity, mode, mask }); continue; }
    const deep = deepIfSynced(l), src = deep || l.canvas;
    out.push({ kind: 'pixels', key: `${deep ? 'd' : 'c'}${l.id}:${l.rev}${vol}`, slot: `p${l.id}`, src, x: l.x, y: l.y, w: src.width, h: src.height, opacity: l.opacity, mode, mask });
  }
  return out;
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
/** Float composite of the document (or a subset of layers) -> 16-bit DImage. */
function compositeDeepDoc({ background = null, layers = doc().layers } = {}) {
  const d = doc(), list = [];
  for (const l of layers) {
    if (!l.visible || l.opacity <= 0) continue;
    const mode = blendIndex(l.blend), mask = maskDesc(l);
    if (l.kind === 'adjust') list.push({ kind: 'adjust', op: l.adj.type, params: l.adj.params || {}, opacity: l.opacity, mode, mask });
    else list.push({ kind: 'pixels', img: is16() ? deepOf(l) : deepOf({ ...l, kind: 'tmp' }), x: l.x, y: l.y, opacity: l.opacity, mode, mask });
  }
  return accToDeep(compositeDeep(d.width, d.height, list, { background: background ? hexToRgb(background) : null, info: { linear: gfx.linear } }), d.width, d.height);
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
  body.innerHTML = `<div class="field two"><span>Engine</span><span>${opt('auto', 'Automatic (WebGPU → WebGL2 → CPU)')}${opt('webgpu', 'GPU (WebGPU compute)')}${opt('gpu', 'GPU (WebGL2)')}${opt('cpu', 'CPU (Canvas 2D + worker)')}</span></div>
    <div class="field two"><span>16-bit blur</span><label><input type="checkbox" id="engLinear" ${gfx.linear ? 'checked' : ''}/> Blur &amp; sharpen in linear light (16-bit documents)</label></div>
    <p class="muted" id="engInfo">${e ? `Active: ${e.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} — ${escapeHtml(i.renderer)}${i.software ? ' (software renderer)' : ''}<br>Max texture ${i.maxTextureSize}px · tile ${i.tile}px · memory ${e.usedMB.toFixed(0)} / ${e.budgetMB} MB${e.kind === 'webgpu' ? ` · output: ${e.syncOutput ? 'canvas' : 'buffer readback (async)'}` : ` · half-float ${i.halfFloat ? 'yes' : 'no'} · float32 targets ${i.float32 ? 'yes' : 'no'}${i.webgpu ? ' · WebGPU present' : ''}`}${gfx.webgpuReason ? `<br>WebGPU not used: ${escapeHtml(gfx.webgpuReason)}` : ''}`
      : `Active: CPU${gfx.reason ? ` — ${escapeHtml(gfx.reason)}` : ''}`}${gfx.probeMs != null ? `<br>GPU speed probe: ${gfx.probeMs} ms for a 1 MP blur` : ''}</p>`;
  showModal({ title: 'Rendering engine', body, okLabel: 'Apply', ok: () => {
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
  const apply = () => { l.adj = { type, params: structuredClone(values) }; compDirty = true; requestRender(); };
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
    ok: () => { apply(); if (JSON.stringify(before) !== JSON.stringify(l.adj)) commit(`Edit ${ADJ_LAYER[type]} layer`); else if (isNew) updateLayersPanel(); },
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
  else if (l.kind === 'text') openTextDialog(null, l);
  else if (l.kind === 'smart') openLiveFilterPanel(l);
  else status('Only adjustment, text and live filter layers have settings to edit.');
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
  if (compDirty) { composite(); compDirty = false; }
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
  if (state.hover && PAINT_TOOLS.includes(state.tool) && !state.xf) {
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

function fitToScreen() {
  const d = doc(); if (!d) return;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  state.zoom = Math.min((w - 48) / d.width, (h - 48) / d.height, 1);
  centerView();
}
function centerView() {
  const d = doc();
  state.panX = Math.round((viewport.clientWidth - d.width * state.zoom) / 2);
  state.panY = Math.round((viewport.clientHeight - d.height * state.zoom) / 2);
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
const PAINT_TOOLS = ['brush', 'eraser', 'clone', 'heal', 'spot', 'tone', 'redeye']; // tools with a round size cursor and [ ] sizing
const TOOLS = [
  { id: 'move', name: 'Move', key: 'V' },
  { id: 'select', name: 'Rectangle select', key: 'M' },
  { id: 'ellipse', name: 'Ellipse select', key: 'O' },
  { id: 'lasso', name: 'Lasso', key: 'L' },
  { id: 'polylasso', name: 'Polygonal lasso', key: 'P' },
  { id: 'wand', name: 'Magic wand', key: 'W' },
  { id: 'crop', name: 'Crop', key: 'C' },
  { sep: true },
  { id: 'brush', name: 'Brush', key: 'B' },
  { id: 'eraser', name: 'Eraser', key: 'E' },
  { id: 'clone', name: 'Clone stamp (Alt+click sets source)', key: 'S' },
  { id: 'heal', name: 'Healing brush (Alt+click sets source)', key: 'R' },
  { id: 'spot', name: 'Spot healing', key: 'J' },
  { id: 'redeye', name: 'Red eye (J again)', key: 'J' },
  { id: 'tone', name: 'Dodge / burn (O again)', key: 'O' },
  { id: 'gradient', name: 'Gradient', key: 'G' },
  { id: 'fill', name: 'Fill (G again)', key: 'G' },
  { id: 'shape', name: 'Shape', key: 'U' },
  { id: 'text', name: 'Text', key: 'T' },
  { id: 'eyedropper', name: 'Color picker', key: 'I' },
  { sep: true },
  { id: 'hand', name: 'Hand (hold Space)', key: 'H' },
  { id: 'zoom', name: 'Zoom (Alt to zoom out)', key: 'Z' },
];

function setTool(id) {
  if (state.xf && id !== state.tool) applyTransform();
  if (state.tool === 'crop' && id !== 'crop') state.crop = null;
  if (state.tool === 'polylasso' && id !== 'polylasso') state.poly = null;
  state.tool = id;
  for (const b of document.querySelectorAll('#toolbar button')) b.classList.toggle('active', b.dataset.tool === id);
  const cursors = { move: 'move', select: 'crosshair', lasso: 'crosshair', polylasso: 'crosshair', wand: 'crosshair', crop: 'crosshair', brush: 'none', eraser: 'none', clone: 'none', heal: 'none', spot: 'none', tone: 'none', redeye: 'none', gradient: 'crosshair', shape: 'crosshair', fill: 'cell', text: 'text', eyedropper: 'copy', hand: 'grab', zoom: 'zoom-in' };
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
function magicWand(p, mode) {
  const d = doc(), x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
  let img;
  if (state.opts.wandSampleAll) {
    if (compDirty) { composite(); compDirty = false; }
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
      if (doc().selection && !(l.kind === 'adjust' && !l.mask)) { startFloat(l, p, e.altKey); return; }
      drag = { start: p, ox: l.x, oy: l.y, layer: l, moved: false };
    },
    move(p) {
      if (drag.float) { moveFloat(p); return; }
      const l = drag.layer; l.x = Math.round(drag.ox + p.x - drag.start.x); l.y = Math.round(drag.oy + p.y - drag.start.y);
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
  crop: {
    down(p) { drag = { start: clampPt(p) }; },
    move(p, e) { state.crop = rectFromPoints(drag.start, clampPt(p), e.shiftKey); buildOptionsBar(); requestRender(); },
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
      trim: t, piece: crop(l.canvas), w: t.w, h: t.h, cx: l.x + t.x + t.w / 2, cy: l.y + t.y + t.h / 2,
      maskPiece: l.mask ? cloneCanvas(l.mask.canvas) : null, fmaskPiece: l.kind === 'smart' && l.fmask ? cloneCanvas(l.fmask.canvas) : null,
      sourcePiece: l.kind === 'smart' ? crop(l.source) : null,
    });
  }
  x.start = xfParams(x);
  state.xf = x; drag = null;
  previewTransform(); buildOptionsBar(); requestRender();
  status('Free transform: drag the handles; Enter applies, Esc cancels.');
}
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
const handler = () => (colorRangeSampler ? samplerHandler : state.xf ? xfHandler : toolHandlers[state.tool]);
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
let moveLastDown = null;
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
  touchTarget(l); requestRender();
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
  const i = d.layers.indexOf(activeLayer());
  d.layers.splice(i < 0 ? d.layers.length : i + 1, 0, l); d.activeId = l.id;
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
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r; if (dist >= 1) continue;
    const j = ((y - y0) * (x1 - x0) + (x - x0)) * 4, R = d[j], G = d[j + 1], B = d[j + 2], gb = (G + B) / 2;
    const redness = R > 50 ? (R - Math.max(G, B)) / R : 0; if (redness <= 0.25) continue;
    const k = Math.min(1, (redness - 0.25) / 0.25) * Math.min(1, (1 - dist) / 0.25);
    d[j] = Math.round(R + (gb * dark - R) * k); d[j + 1] = Math.round(G + (G * dark - G) * k); d[j + 2] = Math.round(B + (B * dark - B) * k); n++;
  }
  if (!n) { status('No red eye found there. Click the centre of the pupil, or make the tool bigger.'); return 0; }
  c.putImageData(img, x0, y0); touch(layer); requestRender(); commit('Red eye'); updateLayersPanel();
  return n;
}

function pickColor(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  let px;
  if (state.opts.sampleAll) {
    if (x < 0 || y < 0 || x >= doc().width || y >= doc().height) return;
    if (compDirty) { composite(); compDirty = false; }
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
    ...(l.kind ? [['Edit layer settings…', 'editLayer'], ['Convert to pixels', 'rasterizeLayer']] : [['Convert to live layer', 'convertSmart']]), '-',
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
      if (key === 'arrowleft') l.x -= s; if (key === 'arrowright') l.x += s;
      if (key === 'arrowup') l.y -= s; if (key === 'arrowdown') l.y += s;
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
  mode8: needDoc(() => setDepth(8)),
  mode16: needDoc(() => setDepth(16)),
  engine: () => openEngineDialog(),
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
  layerDuplicate: needDoc(() => {
    const l = activeLayer();
    addLayer({ ...l, id: nextLayerId++, name: `${l.name} copy`, canvas: cloneCanvas(l.canvas), mask: cloneMask(l.mask), rev: ++globalRev, ...(l.kind === 'smart' ? { fmask: cloneMask(l.fmask) } : {}) }, 'Duplicate layer');
  }),
  layerDelete: needDoc(() => {
    const d = doc(); if (d.layers.length <= 1) { status('A document needs at least one layer.'); return; }
    const i = activeIndex(); d.layers.splice(i, 1); d.activeId = d.layers[Math.max(0, i - 1)].id;
    compDirty = true; requestRender(); commit('Delete layer');
  }),
  layerUp: needDoc(() => moveLayer(activeIndex(), activeIndex() + 1)),
  layerDown: needDoc(() => moveLayer(activeIndex(), activeIndex() - 1)),
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
  cropApply: needDoc(() => { if (state.crop) cropTo(state.crop); }),
  cropCancel: () => { state.crop = null; buildOptionsBar(); requestRender(); },
  zoomIn: needDoc(() => zoomAt(1.25)), zoomOut: needDoc(() => zoomAt(0.8)),
  zoomFit: needDoc(() => fitToScreen()), zoom100: needDoc(() => setZoom(1)),
  shortcuts: () => openShortcutsDialog(),
  about: () => openInfo(`About ${APP}`, `<p>${APP} ${APP_VERSION} is an original, browser-based layered image editor (WebGL2 GPU engine with a Canvas 2D fallback, 8- and 16-bit documents).</p><p class="muted">Everything runs locally in your browser; images never leave your device.</p>`),
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
function run(name) { closeMenus(); if (state.xf && !XF_SAFE.has(name)) applyTransform(); cmds[name]?.(); }

// Ctrl+V is handled by the paste event (so system-clipboard images work too).
const SHORTCUTS = {
  'mod+n': 'new', 'mod+o': 'open', 'mod+shift+o': 'place', 'mod+s': 'saveProject', 'mod+shift+s': 'saveAs', 'mod+shift+e': 'export',
  'mod+z': 'undo', 'mod+shift+z': 'redo', 'mod+y': 'redo',
  'mod+a': 'selectAll', 'mod+d': 'deselect', 'mod+shift+i': 'invertSelection', 'mod+alt+d': 'feather', 'shift+f6': 'feather', '\\': 'editMaskToggle', 'delete': 'clear', 'backspace': 'clear', 'alt+backspace': 'fillSelection',
  'mod+c': 'copy', 'mod+shift+c': 'copyMerged', 'mod+x': 'cut',
  'mod+shift+n': 'layerNew', 'mod+j': 'layerDuplicate', 'mod+e': 'layerMergeDown', 'mod+]': 'layerUp', 'mod+[': 'layerDown',
  'mod+=': 'zoomIn', 'mod++': 'zoomIn', 'mod+shift+=': 'zoomIn', 'mod+shift++': 'zoomIn', 'mod+-': 'zoomOut', 'mod+0': 'zoomFit', 'mod+1': 'zoom100',
  'mod+b': 'brightnessContrast', 'mod+u': 'hueSaturation', 'mod+l': 'levels', 'mod+m': 'curves', 'mod+i': 'invert', 'mod+shift+u': 'grayscale',
  'mod+t': 'freeTransform', 'mod+alt+r': 'refineEdge',
  // Alternates for combos the browser or OS keeps (see RESERVED in platform.js); the menus show these where needed.
  'mod+alt+n': 'new', 'mod+shift+alt+n': 'layerNew', 'mod+alt+t': 'freeTransform', 'mod+shift+m': 'curves',
  'shift+f7': 'invertSelection', 'mod+shift+alt+c': 'copyMerged', 'mod+alt+0': 'zoom100',
  'x': 'swapColors', 'd': 'resetColors', '?': 'shortcuts', 'shift+?': 'shortcuts',
};
/** Neutral spec ('Ctrl+Shift+N') → combo ('mod+shift+n'), in comboOf()'s modifier order. */
function specCombo(spec) {
  const parts = spec.split('+'), key = parts.pop().toLowerCase();
  return (parts.includes('Ctrl') ? 'mod+' : '') + (parts.includes('Shift') ? 'shift+' : '') + (parts.includes('Alt') ? 'alt+' : '') + key;
}
const ALTERNATE_KEYS = { new: 'Ctrl+Alt+N', layerNew: 'Ctrl+Alt+Shift+N', freeTransform: 'Ctrl+Alt+T', curves: 'Ctrl+Shift+M',
  invertSelection: 'Shift+F7', copyMerged: 'Ctrl+Alt+Shift+C', zoom100: 'Ctrl+Alt+0', feather: 'Shift+F6' };
/** The shortcut to show for a command: its usual combo, or the alternate when this browser/OS reserves the usual one. */
function shortcutFor(cmd, spec) {
  if (!spec) return '';
  if (spec.includes('+') && RESERVED.has(specCombo(spec)) && ALTERNATE_KEYS[cmd]) return ALTERNATE_KEYS[cmd];
  return spec;
}
const shortcutLabel = (cmd, spec) => keyLabel(shortcutFor(cmd, spec));

const MENUS = [
  ['File', [['New canvas…', 'new', 'Ctrl+N'], ['Open…', 'open', 'Ctrl+O'], ['Take photo (camera)…', 'camera'], ['Place image as layer…', 'place', 'Ctrl+Shift+O'], '-',
    ['Open recent…', 'openRecent'], '-', ['Save', 'saveProject', 'Ctrl+S'], ['Save as…', 'saveAs', 'Ctrl+Shift+S'], ['Recover autosave…', 'recoverAutosave'], ['Export image…', 'export', 'Ctrl+Shift+E']]],
  ['Edit', [['Undo', 'undo', 'Ctrl+Z'], ['Redo', 'redo', 'Ctrl+Shift+Z'], '-', ['Cut', 'cut', 'Ctrl+X'], ['Copy', 'copy', 'Ctrl+C'],
    ['Copy merged', 'copyMerged', 'Ctrl+Shift+C'], ['Paste as layer', 'paste', 'Ctrl+V'], '-',
    ['Clear', 'clear', 'Del'], ['Fill with color', 'fillSelection', 'Alt+⌫'], '-', ['Free transform', 'freeTransform', 'Ctrl+T']]],
  ['Image', [['Image size…', 'imageSize'], ['Canvas size…', 'canvasSize'], ['Crop to selection', 'cropToSelection'], '-',
    ['Rotate 90° clockwise', 'rotateCW'], ['Rotate 90° counter-clockwise', 'rotateCCW'], ['Rotate 180°', 'rotate180'],
    ['Flip horizontal', 'flipH'], ['Flip vertical', 'flipV'], '-', ['Mode: 8 bits/channel', 'mode8'], ['Mode: 16 bits/channel', 'mode16'], '-', ['Flatten', 'flatten']]],
  ['Select', [['All', 'selectAll', 'Ctrl+A'], ['Deselect', 'deselect', 'Ctrl+D'], ['Invert selection', 'invertSelection', 'Ctrl+Shift+I'], '-',
    ['Color range…', 'colorRange'], ['Refine edge…', 'refineEdge', 'Ctrl+Alt+R'], ['Feather…', 'feather', 'Shift+F6'], ['Select layer pixels', 'selectLayerPixels'], '-', ['Crop to selection', 'cropToSelection']]],
  ['Layer', [['New layer', 'layerNew', 'Ctrl+Shift+N'], ['New adjustment layer: Curves…', 'adjLayer_curves'], ['New adjustment layer: Levels…', 'adjLayer_levels'],
    ['New adjustment layer: Brightness / contrast…', 'adjLayer_brightnessContrast'], ['New adjustment layer: Hue / saturation…', 'adjLayer_hueSaturation'],
    ['New adjustment layer: Exposure…', 'adjLayer_exposure'], ['New adjustment layer: Invert', 'adjLayer_invert'], ['New adjustment layer: Grayscale', 'adjLayer_grayscale'],
    ['Edit layer settings…', 'editLayer'], ['Convert to live layer (editable filters)', 'convertSmart'], ['Convert text / live layer to pixels', 'rasterizeLayer'], '-', ['Duplicate layer', 'layerDuplicate', 'Ctrl+J'], ['Delete layer', 'layerDelete'], '-',
    ['Move up', 'layerUp', 'Ctrl+]'], ['Move down', 'layerDown', 'Ctrl+['], ['Merge down', 'layerMergeDown', 'Ctrl+E'], '-',
    ['Flip layer horizontal', 'flipLayerH'], ['Flip layer vertical', 'flipLayerV'], '-',
    ['Add layer mask (reveal all)', 'addMask'], ['Add mask from selection', 'addMaskFromSelection'], ['Edit mask / pixels', 'editMaskToggle', '\\'],
    ['Enable / disable mask', 'toggleMask'], ['Invert mask', 'invertMask'], ['Apply mask', 'applyMask'], ['Delete mask', 'deleteMask']]],
  ['Adjust', [['Brightness / contrast…', 'brightnessContrast', 'Ctrl+B'], ['Hue / saturation / lightness…', 'hueSaturation', 'Ctrl+U'],
    ['Exposure…', 'exposure'], ['Levels…', 'levels', 'Ctrl+L'], ['Curves…', 'curves', 'Ctrl+M'], ['Auto levels', 'autoLevels'], '-',
    ['Invert', 'invert', 'Ctrl+I'], ['Grayscale', 'grayscale', 'Ctrl+Shift+U'], ['Sepia tone…', 'sepia']]],
  ['Filter', [['Convert to live layer', 'convertSmart'], '-', ['Gaussian blur…', 'gaussianBlur'], ['Sharpen (unsharp)…', 'sharpen'], ['Add noise…', 'noise'], ['Vignette…', 'vignette']]],
  ['View', [['Zoom in', 'zoomIn', 'Ctrl++'], ['Zoom out', 'zoomOut', 'Ctrl+-'], ['Fit on screen', 'zoomFit', 'Ctrl+0'], ['Actual pixels', 'zoom100', 'Ctrl+1'], '-', ['Rendering engine…', 'engine']]],
  ['Help', [['Keyboard shortcuts', 'shortcuts', '?'], [`About ${APP}`, 'about']]],
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
  const m = makeMaskCanvas(l.canvas.width, l.canvas.height, !fromSelection);
  if (fromSelection) m.getContext('2d').drawImage(selectionCanvas(sel), -l.x, -l.y);
  l.mask = { canvas: m, enabled: true, rev: ++globalRev }; l.editMask = true;
  compDirty = true; requestRender(); commit(fromSelection ? 'Add mask from selection' : 'Add layer mask');
}
function addLayer(layer, label) {
  const d = doc(); const i = activeIndex();
  d.layers.splice(i + 1, 0, layer); d.activeId = layer.id;
  compDirty = true; requestRender(); commit(label);
}
function moveLayer(from, to) {
  const d = doc(); if (to < 0 || to >= d.layers.length || from === to) return;
  const [l] = d.layers.splice(from, 1); d.layers.splice(to, 0, l);
  compDirty = true; requestRender(); commit('Reorder layers');
}
function mergeDown() {
  const d = doc(); const i = activeIndex(); if (i <= 0) { status('No layer below to merge into.'); return; }
  const upper = d.layers[i], lower = d.layers[i - 1];
  if (lower.kind === 'adjust') { status('Cannot merge into an adjustment layer. Move the layer or merge the adjustment down first.'); return; }
  rasterize(lower);
  if (upper.kind === 'adjust') { bakeAdjustment(upper, lower); d.layers.splice(i, 1); d.activeId = lower.id; compDirty = true; requestRender(); commit('Merge adjustment down'); return; }
  const x0 = Math.min(0, lower.x, upper.x), y0 = Math.min(0, lower.y, upper.y);
  const x1 = Math.max(d.width, lower.x + lower.canvas.width, upper.x + upper.canvas.width);
  const y1 = Math.max(d.height, lower.y + lower.canvas.height, upper.y + upper.canvas.height);
  if (is16()) { // float composite of the two layers keeps 16-bit precision
    const W2 = x1 - x0, H2 = y1 - y0, list = [{ kind: 'pixels', img: deepOf(lower), x: lower.x - x0, y: lower.y - y0, opacity: 1, mode: 0, mask: maskDesc(lower, -x0, -y0) }];
    if (upper.visible) list.push({ kind: 'pixels', img: deepOf(upper), x: upper.x - x0, y: upper.y - y0, opacity: upper.opacity, mode: blendIndex(upper.blend), mask: maskDesc(upper, -x0, -y0) });
    const nd = accToDeep(compositeDeep(W2, H2, list), W2, H2);
    lower.x = x0; lower.y = y0; lower.mask = null; lower.editMask = false; setDeep(lower, nd);
    d.layers.splice(i, 1); d.activeId = lower.id;
    compDirty = true; requestRender(); commit('Merge down'); return;
  }
  const c = makeCanvas(x1 - x0, y1 - y0), x = c.getContext('2d');
  x.drawImage(renderSource(lower), lower.x - x0, lower.y - y0);
  x.globalAlpha = upper.opacity; x.globalCompositeOperation = upper.blend;
  if (upper.visible) x.drawImage(renderSource(upper), upper.x - x0, upper.y - y0);
  lower.canvas = c; lower.x = x0; lower.y = y0; lower.mask = null; lower.editMask = false; touch(lower);
  d.layers.splice(i, 1); d.activeId = lower.id;
  compDirty = true; requestRender(); commit('Merge down');
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
    if (l.kind === 'smart') smartGeom(l, (c) => rotatedCanvas(c, kind));
    else if (l.kind !== 'adjust') l.canvas = rotatedCanvas(l.canvas, kind);
    l.x = x; l.y = y; touch(l);
    if (l.mask) { l.mask.canvas = rotatedCanvas(l.mask.canvas, kind); touchMask(l); }
  }
  if (kind === 'cw' || kind === 'ccw') { d.width = H; d.height = W; }
  d.selection = null;
  compDirty = true; fitToScreen(); commit(label);
}
function transformLayer(kind, label) {
  const l = activeLayer(); if (l.kind === 'text') rasterize(l, 'the transform');
  if (l.kind === 'smart') smartGeom(l, (c) => rotatedCanvas(c, kind));
  else if (l.kind !== 'adjust') l.canvas = rotatedCanvas(l.canvas, kind);
  touch(l);
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
    if (l.kind === 'smart') smartGeom(l, scale);
    else if (l.kind !== 'adjust') l.canvas = scale(l.canvas);
    l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy); touch(l);
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
    if (l.kind === 'adjust') { // grow the adjustment's mask over the new area (revealed), keep its painted part
      const m = makeMaskCanvas(nw, nh, true), mx = m.getContext('2d'), old = l.mask.canvas;
      mx.clearRect(l.x, l.y, old.width, old.height); mx.drawImage(old, l.x, l.y);
      l.mask.canvas = m; l.x = 0; l.y = 0; touchMask(l);
    }
  }
  d.width = nw; d.height = nh; d.selection = null;
  compDirty = true; fitToScreen(); commit(`Canvas size ${nw}×${nh}`);
}
function cropTo(r) {
  const d = doc();
  r = rectIntersect(r, { x: 0, y: 0, w: d.width, h: d.height }); if (!r) return;
  for (const l of d.layers) {
    if (l.kind === 'text') { l.x -= r.x; l.y -= r.y; touch(l); continue; } // stays editable; just shifts
    if (l.kind === 'smart') { // crop the original too (blur near the new edge then sees transparency, as after any crop)
      smartGeom(l, (src) => { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(src, l.x - r.x, l.y - r.y); return m; });
      if (l.mask) { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(l.mask.canvas, l.x - r.x, l.y - r.y); l.mask.canvas = m; touchMask(l); }
      l.x = 0; l.y = 0; touch(l); continue;
    }
    const c = l.kind === 'adjust' ? l.canvas : makeCanvas(r.w, r.h);
    if (l.kind !== 'adjust') c.getContext('2d').drawImage(l.canvas, l.x - r.x, l.y - r.y);
    if (l.mask) { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(l.mask.canvas, l.x - r.x, l.y - r.y); l.mask.canvas = m; touchMask(l); }
    if (l.deep && l.kind !== 'adjust') { l.deepOX = (l.deepOX || 0) + l.x - r.x; l.deepOY = (l.deepOY || 0) + l.y - r.y; }
    l.canvas = c; l.x = 0; l.y = 0; touch(l);
  }
  d.width = r.w; d.height = r.h; d.selection = null; state.crop = null;
  compDirty = true; fitToScreen(); buildOptionsBar(); commit(`Crop ${r.w}×${r.h}`);
}

function copySelection(merged) {
  const d = doc(); const sel = d.selection || { x: 0, y: 0, w: d.width, h: d.height };
  const c = makeCanvas(sel.w, sel.h), x = c.getContext('2d');
  if (merged) { if (compDirty) { composite(); compDirty = false; } x.drawImage(comp, -sel.x, -sel.y); }
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
        requestRender(); commit(def.title); status(def.title); updateLayersPanel();
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
function fullComposite() { if (compDirty) { composite(); compDirty = false; } return comp; }
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
  row.innerHTML = `<span>${p.label}</span><input type="range" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${p.value}" /><output>${p.value}${p.unit || ''}</output>`;
  const input = row.querySelector('input'), out = row.querySelector('output');
  input.dataset.key = p.key;
  input.title = 'Double-click to reset';
  input.addEventListener('input', () => { values[p.key] = +input.value; out.textContent = input.value + (p.unit || ''); onChange(); });
  input.addEventListener('dblclick', () => { input.value = defaultValue; input.dispatchEvent(new Event('input')); });
  return row;
}

// ---------------------------------------------------------------------------
// Modal dialogs
// ---------------------------------------------------------------------------
let modalHandlers = null;
function showModal({ title, body, ok, cancel, okLabel = 'OK', cancelLabel = 'Cancel', preview = false, passive = false, onPreviewToggle, hideCancel = false }) {
  closeSheet();
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
  modalHandlers = { ok, cancel };
  if (!IS_TOUCH) setTimeout(() => mb.querySelector('textarea, input[type=number], input[type=text], select')?.focus(), 0);
}
function closeModal() { $('#modal').classList.add('hidden'); modalHandlers = null; viewport.focus(); }
$('#modalOk').addEventListener('click', () => { const h = modalHandlers; if (h?.ok?.() === false) return; closeModal(); });
$('#modalCancel').addEventListener('click', () => { const h = modalHandlers; h?.cancel?.(); closeModal(); });
function openInfo(title, html) { showModal({ title, body: html, hideCancel: true, okLabel: 'Close' }); }
const formHTML = (fields) => fields.map((f) => `<label class="field two"><span>${f.label}</span>${f.html}</label>`).join('');
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
    if (w !== d.width || h !== d.height) resizeImage(w, h);
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
  if (!existing) d.layers.splice(activeIndex() + 1, 0, layer);
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
    { label: 'File name', html: `<input type="text" id="eName" value="${escapeHtml(base)}" />` },
    { label: 'Format', html: `<select id="eFmt"><option value="image/png">PNG (lossless)</option><option value="image/png16">PNG 16-bit</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option></select>` },
    { label: 'Quality', html: `<span><input type="range" id="eQ" min="1" max="100" value="90" disabled /> <output id="eQv">90</output></span>` },
    { label: 'Size', html: `<span class="muted">${doc().width} × ${doc().height} px</span>` },
  ]);
  const fmt = body.querySelector('#eFmt'), q = body.querySelector('#eQ');
  // navigator.share needs a fresh user gesture, so the file is rendered ahead of time and the
  // Share button hands it over synchronously (iOS Safari is strict about this).
  let ready = null, prepTimer = 0;
  const key = () => `${fmt.value}|${q.value}|${body.querySelector('#eName').value}`;
  const prepare = () => {
    clearTimeout(prepTimer);
    prepTimer = setTimeout(async () => {
      const k = key(); const blob = await renderExport(fmt.value, q.value / 100);
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
  fmt.addEventListener('change', () => { q.disabled = fmt.value.startsWith('image/png'); if (canShareFiles) prepare(); });
  q.addEventListener('input', () => { body.querySelector('#eQv').textContent = q.value; if (canShareFiles) prepare(); });
  body.querySelector('#eName').addEventListener('input', () => { if (canShareFiles) prepare(); });
  showModal({ title: 'Export image', body, okLabel: canShareFiles ? 'Download' : 'Export', ok: () => {
    exportImage(fmt.value, q.value / 100, body.querySelector('#eName').value || 'image');
  } });
}
const EXPORT_EXT = { 'image/png': 'png', 'image/png16': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/**
 * 'image/png16' writes a 16-bit PNG (png.js). 16-bit documents are composited in float (deep.js) and
 * dithered down for 8-bit formats so smooth gradients don't band.
 */
async function renderExport(type, quality) {
  const d = doc(), bg = type === 'image/jpeg' ? '#ffffff' : null;
  if (type === 'image/png16' || is16()) {
    const deep = compositeDeepDoc({ background: bg });
    if (type === 'image/png16') return new Blob([encodePNG({ width: deep.width, height: deep.height, data: deep.data, depth: 16 })], { type: 'image/png' });
    const out = makeCanvas(d.width, d.height); ctxOf(out).putImageData(deepToImageData(deep, { dither: true }), 0, 0);
    return new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, type, quality));
  }
  const out = makeCanvas(doc().width, doc().height);
  // JPEG has no alpha channel: flatten onto white so transparent areas don't turn black
  composite(out, { background: type === 'image/jpeg' ? '#ffffff' : null, sync: true });
  return new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, type, quality));
}
async function exportImage(type, quality, name) {
  const ext = EXPORT_EXT[type];
  let handle = null;
  if (fsaSupported && EXPORT_TYPES[type]) {
    try { handle = await pickSave(`${name}.${ext}`, EXPORT_TYPES[type]); } catch (err) { status(`Export: ${err.message}`); }
    if (!handle) { status('Export cancelled.'); return; }
  }
  const blob = await renderExport(type, quality);
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
    ['V / M / C', 'Move / Rectangle select / Crop'], ['L / P / W', 'Lasso / Polygonal lasso / Magic wand'], ['B / E / S', 'Brush / Eraser / Clone stamp'], ['G (again: Fill) / U', 'Gradient / Shapes'], ['O again / J again', 'Dodge-burn / Red eye'], ['T / I', 'Text / Color picker'],
    [platformText('Shift / Alt / Shift+Alt (selecting)'), 'Add / subtract / intersect'], [`${K('invertSelection', 'Ctrl+Shift+I')}, ${keyLabel('Shift+F6')}`, 'Invert selection / feather'], ['Enter, double-click / Esc', 'Close / cancel polygon'],
    ['R / J', 'Healing brush / Spot healing'], [platformText('Alt+click (clone, healing)'), 'Set source point'], ['\\', 'Toggle editing mask / pixels'],
    ['H, hold Space', 'Pan'], ['Z, mouse wheel', platformText('Zoom (Shift+wheel pans)')], ['[ and ]', 'Brush size'], [platformText('Shift+click'), 'Straight brush line'], [platformText('Alt+click (brush)'), 'Pick color'],
    ['X / D', 'Swap / default colors'], [`${K('undo', 'Ctrl+Z')}, ${K('redo', 'Ctrl+Shift+Z')}`, 'Undo / redo'], [`${K('selectAll', 'Ctrl+A')} / ${K('deselect', 'Ctrl+D')}`, 'Select all / deselect'],
    [`${IS_MAC ? '⌦ / ⌫' : 'Del'}, ${keyLabel('Alt+Backspace')}`, 'Clear / fill selection'], [`${K('copy', 'Ctrl+C')} / ${K('cut', 'Ctrl+X')} / ${K('paste', 'Ctrl+V')}`, 'Copy / cut / paste as layer'], [`${K('layerDuplicate', 'Ctrl+J')} / ${K('layerMergeDown', 'Ctrl+E')}`, 'Duplicate layer / merge down'],
    [`${K('new', 'Ctrl+N')} / ${K('layerNew', 'Ctrl+Shift+N')}`, 'New canvas / new layer'], [K('freeTransform', 'Ctrl+T'), 'Free transform'],
    [`${K('brightnessContrast', 'Ctrl+B')} / ${K('hueSaturation', 'Ctrl+U')} / ${K('levels', 'Ctrl+L')} / ${K('curves', 'Ctrl+M')} / ${K('invert', 'Ctrl+I')}`, 'Brightness-contrast / Hue-sat / Levels / Curves / Invert'],
    [`${K('zoomFit', 'Ctrl+0')} / ${K('zoom100', 'Ctrl+1')}`, 'Fit / 100%'], ['Enter / Esc', 'Apply / cancel crop'],
    ['Arrows (Move tool)', platformText('Nudge layer (Shift = 10px)')], [`${K('saveProject', 'Ctrl+S')} / ${K('saveAs', 'Ctrl+Shift+S')} / ${K('export', 'Ctrl+Shift+E')}`, 'Save / save as / export'],
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
async function openFile(file, mode = 'open') {
  try {
    if (/\.(json|tintwork)$/i.test(file.name) || file.type === 'application/json') {
      await loadProject(JSON.parse(await file.text()), file.name);
      return;
    }
    if (!file.type.startsWith('image/') && !/\.png$/i.test(file.name)) { status(`Unsupported file: ${file.name}`); return; }
    if (mode !== 'place' || !doc()) {
      if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
        const buf = new Uint8Array(await file.arrayBuffer()), info = pngInfo(buf);
        if (info && info.bitDepth === 16 && documentFromDeepPNG(buf, file.name, info)) return;
      }
    }
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (mode === 'place' && doc()) placeImage(img, file.name.replace(/\.[^.]+$/, ''));
    else documentFromImage(img, file.name);
    URL.revokeObjectURL(url);
    status(`${mode === 'place' && doc() ? 'Placed' : 'Opened'} ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
  } catch (err) { status(`Error: ${err.message}`); console.error(err); }
}
for (const id of ['#fileInput', '#cameraInput']) $(id).addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f, fileMode); e.target.value = ''; });

function serializeProject() {
  const d = doc();
  return {
    format: PROJECT_FORMAT, version: 5, app: APP, width: d.width, height: d.height, name: d.name, depth: d.depth === 16 ? 16 : 8,
    activeIndex: activeIndex(),
    layers: d.layers.map((l) => ({
      name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, data: l.canvas.toDataURL('image/png'),
      mask: l.mask ? { enabled: l.mask.enabled, data: l.mask.canvas.toDataURL('image/png') } : null,
      ...(l.kind ? { kind: l.kind, adj: l.adj, text: l.text } : {}),
      ...(d.depth === 16 && !l.kind ? { deep: deepDataURL(deepOf(l)) } : {}), // v5: 16-bit pixels; `data` stays as the 8-bit fallback
      ...(l.kind === 'smart' ? { source: l.source.toDataURL('image/png'), filters: l.filters, fmask: l.fmask ? { enabled: l.fmask.enabled, data: l.fmask.canvas.toDataURL('image/png') } : null } : {}),
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
const projectBlob = () => new Blob([JSON.stringify(serializeProject())], { type: 'application/json' });
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
  download(projectBlob(), `${name}.tintwork`);
  status(`Saved project ${name}.tintwork`);
  markSaved();
}
/** File ▸ Save as… (Ctrl+Shift+S). */
async function saveProjectAs() {
  if (!fsaSupported) { const name = baseName(); download(projectBlob(), `${name}.tintwork`); status(`Saved project ${name}.tintwork`); markSaved(); return; }
  let h;
  try { h = await pickSave(`${baseName()}.tintwork`); } catch (err) { status(`Save as: ${err.message}`); return; }
  if (!h) { status('Save cancelled.'); return; }
  await writeProjectTo(h);
}
async function writeProjectTo(h) {
  const d = doc(), entry = history.entries[history.index];
  try {
    setBusy(1); await writeFile(h, projectBlob());
    d.fileHandle = h; d.fileKind = 'project'; d.name = h.name;
    addRecent(h, 'project');
    status(`Saved ${h.name}`); markSaved(entry); updateDocInfo();
  } catch (err) {
    toast(`Could not save ${h.name}: ${err.message}. Use Save as… to pick another place.`, 6000);
  } finally { setBusy(-1); }
}
async function openWithPicker() {
  let h;
  try { h = await pickOpen(); } catch (err) { status(`Open: ${err.message}`); return; }
  if (h) await openHandle(h);
}
/** Open a FileSystemFileHandle (picker, recent list, or the OS via the installed app's file handler). */
async function openHandle(h, { remember = true } = {}) {
  let file;
  try { if (!(await ensurePermission(h, 'read'))) { status(`Permission to read ${h.name} was denied.`); return false; } file = await h.getFile(); }
  catch (err) { status(`Could not open ${h.name}: ${err.message}`); return false; }
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
const newSlot = () => `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
/**
 * Autosave record v2: the last AUTOSAVE_STEPS history entries with every canvas stored once
 * (history canvases are immutable and shared between entries, so each image is encoded and written once).
 */
function encodeHistory(d, dirty) {
  const images = new Map(), ref = (c) => { const r = imageRef(c); images.set(r.id, r.encode); return r.id; };
  const dref = (dd) => { const r = deepRef(dd); images.set(r.id, r.encode); return r.id; };
  const n = history.entries.length;
  // 16-bit data is autosaved for the current step only, and only up to a size cap (it is 8 bytes/pixel)
  const curSnap = history.entries[history.index].snap;
  let deepPx = 0; for (const l of curSnap.layers) if (l.deep) deepPx += l.deep.width * l.deep.height;
  const deepOk = curSnap.depth === 16 && deepPx <= AUTOSAVE_DEEP_PX;
  if (curSnap.depth === 16 && !deepOk) gpuNotice('autosave-deep', 'This 16-bit document is too large for 16-bit autosave; crash recovery keeps an 8-bit copy. Save the project to keep 16-bit data.');
  const start = Math.max(0, Math.min(history.index, n - AUTOSAVE_STEPS)), end = Math.min(n, start + AUTOSAVE_STEPS);
  const entries = history.entries.slice(start, end).map((e) => {
    const sn = e.snap;
    return {
      label: e.label,
      snap: {
        width: sn.width, height: sn.height, activeId: sn.activeId, depth: sn.depth || 8,
        selection: sn.selection ? ref(selectionCanvas(sn.selection)) : null,
        layers: sn.layers.map((l) => ({
          id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, rev: l.rev, editMask: l.editMask,
          kind: l.kind, adj: l.adj, text: l.text, canvas: ref(l.canvas),
          ...(deepOk && sn === curSnap && l.deep ? { deep: dref(l.deep), deepRev: l.deepRev, deepOX: l.deepOX || 0, deepOY: l.deepOY || 0 } : {}),
          mask: l.mask ? { enabled: l.mask.enabled, rev: l.mask.rev, canvas: ref(l.mask.canvas) } : null,
          ...(l.kind === 'smart' ? { source: ref(l.source), filters: l.filters, editFMask: l.editFMask,
            fmask: l.fmask ? { enabled: l.fmask.enabled, rev: l.fmask.rev, canvas: ref(l.fmask.canvas) } : null } : {}),
        })),
      },
    };
  });
  const cur = history.entries[history.index].snap;
  const record = {
    format: 'tintwork-autosave', version: 2, app: APP, appVersion: APP_VERSION, slot: d.slot, name: d.name || 'Untitled',
    width: d.width, height: d.height, savedAt: Date.now(), dirty, layerCount: cur.layers.length, steps: entries.length,
    history: { index: history.index - start, entries }, imageIds: [...images.keys()],
  };
  return { record, images };
}
/** Write the current document to IndexedDB now (serialized: one write at a time). */
async function autosaveNow() {
  clearTimeout(autosaveTimer); autosaveTimer = null;
  while (autosaveRunning) await autosaveRunning;
  const d = doc(); if (!d || recoveryPending || history.index < 0) return;
  const entry = history.entries[history.index];
  autosaveRunning = (async () => {
    try {
      const { record, images } = encodeHistory(d, entry !== cleanEntry);
      await writeAutosave(record, images);
      writtenEntry = entry; lastAutosave = Date.now();
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
        const l = { ...L, canvas: get(L.canvas), mask: L.mask ? { ...L.mask, canvas: get(L.mask.canvas) } : null };
        if (L.deep) l.deep = get(L.deep); else delete l.deep;
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
async function checkRecovery(manual = false) {
  let list; try { list = await listAutosaves(); } catch (err) { if (manual) status(`Autosave unavailable: ${err?.message || err}`); return; }
  list = list.filter((r) => recordLayers(r) > 0 && (manual || r.dirty));
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
    layers.push(l);
  }
  if (!layers.length) throw new Error('Project has no layers');
  for (const l of layers) if (l.kind === 'smart') renderSmartSync(l);
  const ai = Math.min(layers.length - 1, Math.max(0, data.activeIndex ?? layers.length - 1));
  state.doc = { width: data.width, height: data.height, layers, activeId: layers[ai].id, selection: null, name: filename || data.name || 'Untitled', depth: data.depth === 16 ? 16 : 8 };
  afterDocChange('Open project');
  status(`Opened project ${filename} (${layers.length} layers)`);
}

// drag & drop: opens a file when nothing is open, otherwise places it as a new layer (hold Shift to open instead)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropzone').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropzone').classList.add('hidden');
  const files = [...(e.dataTransfer?.files || [])];
  for (let i = 0; i < files.length; i++) {
    const isProject = /\.(json|tintwork)$/i.test(files[i].name);
    await openFile(files[i], doc() && !isProject && !(i === 0 && e.shiftKey) ? 'place' : 'open');
  }
});
window.addEventListener('beforeunload', (e) => { if (history.entries.length > 1) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------------------
// UI building
// ---------------------------------------------------------------------------
function status(msg) { $('#status').textContent = platformText(msg); }
let toastTimer = 0;
function toast(msg, ms = 2200) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = platformText(msg); t.classList.remove('fade'); status(msg);
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
    const m = document.createElement('div'); m.className = 'menu';
    const b = document.createElement('button'); b.textContent = title; m.append(b);
    const list = document.createElement('div'); list.className = 'menu-items';
    for (const it of items) {
      if (it === '-') { list.append(document.createElement('hr')); continue; }
      const [label, cmd, key] = it;
      const ib = document.createElement('button'); ib.dataset.cmd = cmd;
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
  const parts = state.xf ? xfBarParts() : [`<span class="tool-title">${t.name}</span>`];
  const range = (key, label, min, max, unit = '') => `<label>${label} <input type="range" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" /><input type="number" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" />${unit}</label>`;
  const seg = (key, choices) => `<span class="seg">${choices.map(([v, label]) => `<button data-seg="${key}" data-val="${v}" class="${o[key] === v ? 'on' : ''}">${label}</button>`).join('')}</span>`;
  const d = doc();
  switch (state.xf ? '' : state.tool) {
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
    case 'redeye': parts.push(range('redeyeSize', 'Pupil size', 4, 400, 'px'), range('redeyeDarken', 'Darken', 0, 100, '%'), `<span class="muted">Click the centre of each red pupil</span>`); break;
    case 'eyedropper': parts.push(`<label><input type="checkbox" data-opt="sampleAll" ${o.sampleAll ? 'checked' : ''}/> Sample all layers</label>`); break;
    case 'crop': {
      const c = state.crop;
      parts.push(`<span class="muted">${c ? `${c.w} × ${c.h} px` : 'Drag a crop rectangle · Shift = square'}</span>`);
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
  if (!state.xf && d && ['select', 'lasso', 'polylasso', 'wand', 'ellipse'].includes(state.tool)) parts.push(`<button data-cmd="colorRange">Color range…</button>`, `<button data-cmd="refineEdge" ${d.selection ? '' : 'disabled'}>Refine edge…</button>`);
  if (!state.xf && d && state.tool === 'move') parts.push(`<button data-cmd="freeTransform">Transform</button>`);
  bar.classList.toggle('xf', !!state.xf);
  bar.innerHTML = platformText(parts.join(''));
  bar.querySelectorAll('[data-xf]').forEach((inp) => inp.addEventListener('change', () => setXfField(inp.dataset.xf, +inp.value)));
  bar.querySelectorAll('[data-selmode]').forEach((b) => b.addEventListener('click', () => { o.selMode = b.dataset.selmode; buildOptionsBar(); }));
  bar.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => { o[b.dataset.seg] = b.dataset.val; buildOptionsBar(); }));
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
function updateLayersPanel() {
  const ul = $('#layerList'); ul.innerHTML = '';
  const d = doc(); if (!d) return;
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const l = d.layers[i];
    const li = document.createElement('li'); li.draggable = true; li.dataset.id = l.id;
    if (l.id === d.activeId) li.classList.add('active');
    const eye = document.createElement('button'); eye.className = 'eye' + (l.visible ? '' : ' off'); eye.innerHTML = ICONS.eye; eye.title = 'Toggle visibility';
    eye.addEventListener('click', (e) => { e.stopPropagation(); l.visible = !l.visible; compDirty = true; requestRender(); commit(l.visible ? 'Show layer' : 'Hide layer'); });
    const th = makeCanvas(40, 30); const tx = th.getContext('2d');
    const s = Math.min(40 / d.width, 30 / d.height);
    tx.save(); tx.translate((40 - d.width * s) / 2, (30 - d.height * s) / 2); tx.scale(s, s);
    if (l.kind !== 'adjust') { tx.beginPath(); tx.rect(0, 0, d.width, d.height); tx.clip(); tx.drawImage(l.canvas, l.x, l.y); }
    tx.restore();
    if (l.kind === 'adjust') { // a simple original badge: half-filled circle
      tx.fillStyle = '#2a2c33'; tx.fillRect(0, 0, 40, 30); tx.strokeStyle = tx.fillStyle = '#d9dce2'; tx.lineWidth = 2;
      tx.beginPath(); tx.arc(20, 15, 9, 0, Math.PI * 2); tx.stroke(); tx.beginPath(); tx.arc(20, 15, 9, Math.PI / 2, Math.PI * 1.5); tx.fill();
    } else if (l.kind === 'smart') { // live-filter badge
      tx.fillStyle = '#7a5cffdd'; tx.fillRect(26, 16, 14, 14); tx.fillStyle = '#fff'; tx.font = '700 12px sans-serif'; tx.textAlign = 'center'; tx.textBaseline = 'middle'; tx.fillText('≈', 33, 23);
    } else if (l.kind === 'text') {
      tx.fillStyle = '#000a'; tx.fillRect(26, 16, 14, 14); tx.fillStyle = '#fff'; tx.font = '700 12px sans-serif'; tx.textAlign = 'center'; tx.textBaseline = 'middle'; tx.fillText('T', 33, 23.5);
    }
    th.className = 'thumb' + (l.id === d.activeId && l.mask && !editingMask(l) ? ' target' : '');
    th.title = l.kind === 'adjust' ? `${ADJ_LAYER[l.adj.type]} — double-click to edit` : l.kind === 'text' ? 'Text — double-click to edit' : l.kind === 'smart' ? 'Live filter layer — double-click to manage filters' : 'Layer pixels';
    th.addEventListener('click', (e) => { e.stopPropagation(); if (state.xf) applyTransform(); d.activeId = l.id; l.editFMask = false; if (l.kind !== 'adjust') setMaskTarget(l, false); else updateLayersPanel(); buildOptionsBar(); requestRender(); });
    if (l.kind) th.addEventListener('dblclick', (e) => { e.stopPropagation(); d.activeId = l.id; editLayer(l); });
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
    meta.textContent = `${Math.round(l.opacity * 100)}%${l.blend !== 'source-over' ? ' · ' + BLEND_MODES.find((b) => b[0] === l.blend)?.[1] : ''}`;
    li.append(eye, th); if (mth) li.append(mth); li.append(name, meta);
    li.addEventListener('click', () => { if (state.xf && l.id !== d.activeId) applyTransform(); d.activeId = l.id; updateLayersPanel(); buildOptionsBar(); requestRender(); });
    li.addEventListener('dblclick', () => {
      const input = document.createElement('input'); input.type = 'text'; input.value = l.name; input.style.flex = '1'; input.style.minWidth = '0';
      name.replaceWith(input); input.focus(); input.select();
      const done = () => { const v = input.value.trim(); if (v && v !== l.name) { l.name = v; commit('Rename layer'); } else updateLayersPanel(); };
      input.addEventListener('blur', done); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = l.name; input.blur(); } });
    });
    li.addEventListener('dragstart', (e) => { dragLayerId = l.id; e.dataTransfer.effectAllowed = 'move'; });
    li.addEventListener('dragover', (e) => { if (dragLayerId == null) return; e.preventDefault(); e.stopPropagation(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      if (dragLayerId == null) return;
      e.preventDefault(); e.stopPropagation(); li.classList.remove('dragover');
      const from = d.layers.findIndex((x) => x.id === dragLayerId); const to = d.layers.findIndex((x) => x.id === l.id);
      dragLayerId = null; if (from !== to) moveLayer(from, to);
    });
    li.addEventListener('dragend', () => { dragLayerId = null; });
    ul.append(li);
    if (l.kind === 'smart') ul.append(...smartRows(l, d, s));
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
    if (compDirty) { composite(); compDirty = false; }
    const s = Math.min(1, 512 / Math.max(doc().width, doc().height));
    const c = makeCanvas(doc().width * s, doc().height * s); const x = ctxOf(c); x.drawImage(comp, 0, 0, c.width, c.height);
    drawHistogram($('#histogram'), histogram(x.getImageData(0, 0, c.width, c.height)));
  }, 150);
}
function updateDocInfo() {
  try { updateTitle(); } catch { /* early boot */ }
  const d = doc(); $('#docinfo').textContent = d ? `${d.name} — ${d.width} × ${d.height} px · ${d.depth === 16 ? 16 : 8}-bit · ${d.layers.length} layer${d.layers.length > 1 ? 's' : ''} · ${engineLabel()}` : `${engineLabel()} engine`;
}
function updateAll() { updateLayersPanel(); updateHistoryPanel(); buildOptionsBar(); updateDocInfo(); updateZoomLabel(); scheduleHistogram(); requestRender(); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildMenus(); buildToolbar(); buildSheets(); initEngine();
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
function updateTitle() { const d = doc(), dirty = d && (cleanEntry ? history.entries[history.index] !== cleanEntry : history.index > 0); document.title = d ? `${d.name || 'Untitled'}${dirty ? ' •' : ''} — ${APP}` : `${APP} — photo editor`; }
$('#toolsToggle').addEventListener('click', () => { document.body.classList.toggle('tools-collapsed'); $('#toolsToggle').classList.toggle('on', !document.body.classList.contains('tools-collapsed')); });
$('#toolsToggle').classList.add('on');
// Installable/offline: register the service worker on secure origins (https or localhost).
if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered:', err)));
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
window.tintwork = {
  state, cmds, run, setTool, openFile, newDocument, history, commit, composite, activeLayer, setFg, serializeProject, openAdjust, ADJ,
  ops, setSelection, makeSelection, rectMask, renderSource, updateLayersPanel, touch, fitToScreen,
  mods, setMod, openSheet, closeSheet, toast, MAX_PIXELS, IS_IOS, fitPixels, renderExport,
  /** true once the current state is in IndexedDB and nothing is waiting to be written */
  get autosaveSettled() { return !autosaveTimer && !autosaveRunning && writtenEntry === history.entries[history.index]; },
  autosaveNow, readAutosave, clearAutosave, listAutosaves, checkRecovery, restoreAutosave,
  startTransform, applyTransform, cancelTransform, get xf() { return state.xf; }, previewTransform, xfMatrix,
  convertToSmart, setSmartFilters, updateSmart, openSmartFilterDialog, openLiveFilterPanel, composeSmart, filteredSync, addFilterMask,
  openColorRangeDialog, openRefineDialog, colorRangeMask, bakeAdjustment, BUNDLED_FONTS, fontReady, loadFont, AUTOSAVE_STEPS, MAX_SLOTS, newAdjustmentLayer, editLayer, adjCache, rasterize, renderTextLayer, textLayerAt, undo, redo, closeModal, mergeDown,
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
  async compositePixelAsync(x, y) { if (compDirty) { composite(); compDirty = false; } await compositeSettled(); return [...compCtx.getImageData(x, y, 1, 1).data]; },
  compositePixel(x, y) { if (compDirty) { composite(); compDirty = false; } return [...compCtx.getImageData(x, y, 1, 1).data]; },
  get doc() { return state.doc; },
  get workerAvailable() { return ops.workerStatus().available; },
  /** Resolves once queued worker jobs have finished. */
  idle: () => new Promise((res) => { const t = () => (state.busy || adjPending ? setTimeout(t, 10) : res()); t(); }),
};
