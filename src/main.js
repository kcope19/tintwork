// Tintwork — an original, browser-based layered image editor (Canvas 2D).
import { floodMask, similarMask, histogram } from './pixels.js';
import { makeSelection, shapeMask, rectMask, combine, invertSelection, selectionCanvas, selectionOutline, maskRegion } from './selection.js';
import * as ops from './ops.js';
import { ICONS } from './icons.js';

const APP = 'Tintwork';
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
    brushSize: 24, brushHardness: 70, brushOpacity: 100,
    eraserSize: 40, eraserHardness: 50, eraserOpacity: 100,
    fillTolerance: 32, fillContiguous: true,
    textFont: 'system-ui', textSize: 64, textBold: true, textItalic: false,
    sampleAll: true,
    selMode: 'new', wandTolerance: 32, wandContiguous: true, wandSampleAll: false, featherRadius: 8,
    cloneSize: 40, cloneHardness: 60, cloneOpacity: 100, cloneAligned: true,
  },
  selPreview: null,   // in-progress rectangle / lasso outline
  poly: null,         // in-progress polygonal lasso { pts, mode }
  cloneSrc: null, cloneOffset: null,
  busy: 0,
};
let nextLayerId = 1;
let globalRev = 1;
let compDirty = true;
const comp = document.createElement('canvas');
const compCtx = comp.getContext('2d', { willReadFrequently: true });
const history = { entries: [], index: -1, limit: 60 };
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
function touchMask(layer) { if (layer.mask) layer.mask.rev = ++globalRev; compDirty = true; }
/** Canvas currently being edited on a layer: its mask (when targeted) or its pixels. */
const editingMask = (l = activeLayer()) => !!(l && l.mask && l.editMask);
const targetCanvas = (l = activeLayer()) => (editingMask(l) ? l.mask.canvas : l.canvas);
function touchTarget(l) { if (editingMask(l)) touchMask(l); else touch(l); }
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
  const full = { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height };
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
  layer.canvas = c; layer.x = x0; layer.y = y0; touch(layer);
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------
function newDocument(width, height, background = 'white', name = 'Untitled') {
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
  const base = createLayer('Background', img.naturalWidth || img.width, img.naturalHeight || img.height);
  base.canvas.getContext('2d').drawImage(img, 0, 0);
  state.doc = { width: base.canvas.width, height: base.canvas.height, layers: [base], activeId: base.id, selection: null, name };
  afterDocChange('Open');
}
function afterDocChange(label) {
  history.entries = []; history.index = -1;
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
    width: d.width, height: d.height, activeId: d.activeId,
    selection: d.selection, // selections are immutable, so they can be shared
    layers: d.layers.map((l) => {
      const old = prev?.layers.find((p) => p.id === l.id && p.rev === l.rev);
      const oldMask = l.mask && prev?.layers.find((p) => p.id === l.id && p.mask && p.mask.rev === l.mask.rev)?.mask;
      return {
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
        x: l.x, y: l.y, rev: l.rev, canvas: old ? old.canvas : cloneCanvas(l.canvas), editMask: l.editMask,
        mask: l.mask ? { enabled: l.mask.enabled, rev: l.mask.rev, canvas: oldMask ? oldMask.canvas : cloneCanvas(l.mask.canvas) } : null,
      };
    }),
  };
}
function commit(label) {
  if (!doc()) return;
  history.entries.length = history.index + 1;
  history.entries.push({ label, snap: snapshot() });
  if (history.entries.length > history.limit) history.entries.shift();
  history.index = history.entries.length - 1;
  updateHistoryPanel();
  updateLayersPanel();
  scheduleHistogram();
  updateDocInfo();
}
function restore(i) {
  const e = history.entries[i];
  if (!e) return;
  const s = e.snap;
  state.doc.width = s.width; state.doc.height = s.height;
  state.doc.activeId = s.activeId;
  state.doc.selection = s.selection;
  state.doc.layers = s.layers.map((l) => ({ ...l, canvas: cloneCanvas(l.canvas), mask: cloneMask(l.mask) }));
  state.poly = null; state.selPreview = null;
  history.index = i;
  state.crop = null;
  compDirty = true;
  updateAll();
}
function undo() { if (history.index > 0) { restore(history.index - 1); status(`Undo: ${history.entries[history.index + 1].label}`); } }
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
  c.clearRect(0, 0, d.width, d.height);
  if (opts.background) { c.fillStyle = opts.background; c.fillRect(0, 0, d.width, d.height); }
  for (const l of d.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    c.globalAlpha = l.opacity;
    c.globalCompositeOperation = l.blend;
    c.drawImage(renderSource(l), l.x, l.y);
  }
  c.restore();
  return target;
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
  if (state.tool === 'move' && al) {
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
  if (d.selection) ants(selectionOutline(d.selection));
  if (state.selPreview) {
    const sp = state.selPreview, path = new Path2D();
    if (sp.rect) path.rect(sp.rect.x, sp.rect.y, sp.rect.w, sp.rect.h);
    else if (sp.pts?.length) { path.moveTo(sp.pts[0].x, sp.pts[0].y); for (const q of sp.pts) path.lineTo(q.x, q.y); path.closePath(); }
    ants(path);
  }
  if (state.poly?.pts.length) {
    const path = new Path2D(), pts = state.poly.pts;
    path.moveTo(pts[0].x, pts[0].y); for (const q of pts) path.lineTo(q.x, q.y);
    if (state.hover) path.lineTo(state.hover.x, state.hover.y);
    ants(path);
    const [fx, fy] = toS(pts[0].x, pts[0].y);
    vctx.save(); vctx.strokeStyle = '#fff'; vctx.fillStyle = '#e8553a'; vctx.beginPath(); vctx.arc(fx, fy, 4, 0, Math.PI * 2); vctx.fill(); vctx.stroke(); vctx.restore();
  }
  if (state.tool === 'clone' && state.cloneSrc) {
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
  if (state.hover && (state.tool === 'brush' || state.tool === 'eraser' || state.tool === 'clone')) {
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
const TOOLS = [
  { id: 'move', name: 'Move', key: 'V' },
  { id: 'select', name: 'Rectangle select', key: 'M' },
  { id: 'lasso', name: 'Lasso', key: 'L' },
  { id: 'polylasso', name: 'Polygonal lasso', key: 'P' },
  { id: 'wand', name: 'Magic wand', key: 'W' },
  { id: 'crop', name: 'Crop', key: 'C' },
  { sep: true },
  { id: 'brush', name: 'Brush', key: 'B' },
  { id: 'eraser', name: 'Eraser', key: 'E' },
  { id: 'clone', name: 'Clone stamp (Alt+click sets source)', key: 'S' },
  { id: 'fill', name: 'Fill', key: 'G' },
  { id: 'text', name: 'Text', key: 'T' },
  { id: 'eyedropper', name: 'Color picker', key: 'I' },
  { sep: true },
  { id: 'hand', name: 'Hand (hold Space)', key: 'H' },
  { id: 'zoom', name: 'Zoom (Alt to zoom out)', key: 'Z' },
];

function setTool(id) {
  if (state.tool === 'crop' && id !== 'crop') state.crop = null;
  if (state.tool === 'polylasso' && id !== 'polylasso') state.poly = null;
  state.tool = id;
  for (const b of document.querySelectorAll('#toolbar button')) b.classList.toggle('active', b.dataset.tool === id);
  const cursors = { move: 'move', select: 'crosshair', lasso: 'crosshair', polylasso: 'crosshair', wand: 'crosshair', crop: 'crosshair', brush: 'none', eraser: 'none', clone: 'none', fill: 'cell', text: 'text', eyedropper: 'copy', hand: 'grab', zoom: 'zoom-in' };
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
  const poly = state.poly; state.poly = null;
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
    down(p) { const l = activeLayer(); if (!l) return; drag = { start: p, ox: l.x, oy: l.y, layer: l, moved: false }; },
    move(p) {
      const l = drag.layer; l.x = Math.round(drag.ox + p.x - drag.start.x); l.y = Math.round(drag.oy + p.y - drag.start.y);
      drag.moved = true; compDirty = true; requestRender(); buildOptionsBar();
    },
    up() { if (drag.moved) commit('Move layer'); },
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
      if (!state.poly) { state.poly = { pts: [p], mode: selModeFor(e) }; requestRender(); return; }
      const pts = state.poly.pts, first = pts[0];
      const nearStart = Math.hypot(p.x - first.x, p.y - first.y) * state.zoom < 8;
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
  fill: { down(p) { fillAt(p); } },
  eyedropper: { down(p) { drag = {}; pickColor(p); }, move(p) { pickColor(p); } },
  text: { down(p) { openTextDialog(p); } },
  zoom: { down(p, e) { const r = view.getBoundingClientRect(); zoomAt(e.altKey ? 1 / 1.5 : 1.5, e.clientX - r.left, e.clientY - r.top); } },
};

function clampPt(p) {
  return { x: Math.max(0, Math.min(doc().width, Math.round(p.x))), y: Math.max(0, Math.min(doc().height, Math.round(p.y))) };
}
function rectFromPoints(a, b, square) {
  let w = b.x - a.x, h = b.y - a.y;
  if (square) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  const x = Math.min(a.x, a.x + w), y = Math.min(a.y, a.y + h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) };
}

/** Brush, eraser and clone stamp share the same stroke machinery. */
function paintTool(kind) {
  const erase = kind === 'eraser', clone = kind === 'clone';
  return {
    down(p, e) {
      const layer = activeLayer(); if (!layer) return;
      if (!layer.visible) { status('The active layer is hidden. Show it to paint.'); return; }
      if (clone) {
        if (e.altKey) { state.cloneSrc = { x: p.x, y: p.y }; state.cloneOffset = null; status(`Clone source set at ${Math.round(p.x)}, ${Math.round(p.y)}`); buildOptionsBar(); requestRender(); return; }
        if (!state.cloneSrc) { status('Alt+click to set a clone source first.'); return; }
        if (editingMask(layer)) { status('The clone stamp paints layer pixels. Click the layer thumbnail to target pixels.'); return; }
      } else if (e.altKey && kind === 'brush') { pickColor(p); return; }
      ensureCoversDoc(layer);
      const o = state.opts;
      const size = o[`${kind}Size`];
      const hardness = o[`${kind}Hardness`] / 100;
      const onMask = editingMask(layer);
      const canvas = targetCanvas(layer);
      drag = {
        layer, erase, clone, onMask, canvas, size,
        opacity: o[`${kind}Opacity`] / 100,
        lum: onMask && !erase ? luminance(state.fg) : 0,
        backup: cloneCanvas(canvas),
        stroke: makeCanvas(canvas.width, canvas.height),
        tmp: doc().selection || clone ? makeCanvas(canvas.width, canvas.height) : null,
        stamp: makeStamp(size, hardness, erase || clone || onMask ? '#ffffff' : state.fg),
        last: null,
      };
      if (clone) {
        if (!o.cloneAligned || !state.cloneOffset) state.cloneOffset = { dx: state.cloneSrc.x - p.x, dy: state.cloneSrc.y - p.y };
        drag.dx = state.cloneOffset.dx; drag.dy = state.cloneOffset.dy;
        drag.srcTmp = makeCanvas(canvas.width, canvas.height);
      }
      if (e.shiftKey && lastPaintPoint && !clone) stampLine(lastPaintPoint, p);
      else stampAt(p);
      drag.last = p;
      applyStroke();
    },
    move(p) {
      if (!drag?.stroke) return;
      stampLine(drag.last, p); drag.last = p; applyStroke();
    },
    up() {
      if (!drag?.stroke) return;
      lastPaintPoint = drag.last;
      if (drag.onMask) touchMask(drag.layer); else touch(drag.layer);
      commit(clone ? 'Clone stamp' : drag.onMask ? (erase ? 'Erase mask' : 'Paint mask') : erase ? 'Eraser' : 'Brush stroke');
      updateLayersPanel();
    },
  };
}
function stampAt(p) {
  const s = drag.stamp, l = drag.layer;
  drag.stroke.getContext('2d').drawImage(s, p.x - l.x - s.width / 2, p.y - l.y - s.height / 2);
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
  // coverage = stroke stamps limited by the selection
  let cover = drag.stroke;
  if (drag.tmp && doc().selection) {
    const t = drag.tmp.getContext('2d');
    t.globalCompositeOperation = 'copy'; t.drawImage(drag.stroke, 0, 0); t.globalCompositeOperation = 'source-over';
    maskBySelection(t, l);
    cover = drag.tmp;
  }
  c.save();
  c.globalCompositeOperation = 'copy';
  c.drawImage(drag.backup, 0, 0);
  c.globalCompositeOperation = 'source-over';
  if (drag.clone) {
    // source pixels shifted by the clone offset, cut to the brush coverage
    const t = drag.srcTmp.getContext('2d');
    t.globalCompositeOperation = 'copy'; t.drawImage(drag.backup, -drag.dx, -drag.dy);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(cover, 0, 0);
    t.globalCompositeOperation = 'source-over';
    c.globalAlpha = drag.opacity; c.drawImage(drag.srcTmp, 0, 0);
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
  compDirty = true; requestRender();
}

function fillAt(p) {
  const layer = activeLayer(); if (!layer) return;
  const sel = doc().selection;
  const px = Math.floor(p.x), py = Math.floor(p.y);
  if (sel && !(px >= 0 && py >= 0 && px < sel.W && py < sel.H && sel.mask[py * sel.W + px])) return;
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
  if (onMask) touchMask(layer); else touch(layer);
  requestRender(); commit(onMask ? 'Fill mask' : 'Fill'); updateLayersPanel();
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
view.addEventListener('pointerdown', (e) => {
  if (!doc()) return;
  viewport.focus();
  view.setPointerCapture(e.pointerId);
  const p = screenToDoc(e);
  if (e.button === 1 || spaceDown || state.tool === 'hand') {
    drag = { pan: true, sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    view.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
  if (state.busy) { status('Still processing… one moment.'); return; }
  toolHandlers[state.tool]?.down?.(p, e);
});
view.addEventListener('pointermove', (e) => {
  if (!doc()) return;
  const p = screenToDoc(e);
  state.hover = p;
  $('#cursorPos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
  if (drag?.pan) {
    state.panX = drag.px + e.clientX - drag.sx; state.panY = drag.py + e.clientY - drag.sy; requestRender(); return;
  }
  if (drag && e.buttons & 1) toolHandlers[state.tool]?.move?.(p, e);
  if (['brush', 'eraser', 'clone', 'polylasso'].includes(state.tool)) requestRender();
});
view.addEventListener('pointerup', (e) => {
  if (drag?.pan) { drag = null; setTool(state.tool); return; }
  if (drag) toolHandlers[state.tool]?.up?.(screenToDoc(e), e);
  drag = null;
});
view.addEventListener('pointerleave', () => { state.hover = null; requestRender(); });
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
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const combo = (mod ? 'mod+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + key;
  const cmd = SHORTCUTS[combo];
  if (cmd) { e.preventDefault(); run(cmd); return; }
  if (key === ' ') { if (!spaceDown) { spaceDown = true; view.style.cursor = 'grab'; } e.preventDefault(); return; }
  if (!mod && !e.altKey) {
    const t = TOOLS.find((tt) => tt.key && tt.key.toLowerCase() === key);
    if (t) { setTool(t.id); return; }
    if (key === '[' || key === ']') { adjustBrushSize(key === ']' ? 1 : -1); return; }
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

function adjustBrushSize(dir) {
  const k = state.tool === 'eraser' ? 'eraserSize' : state.tool === 'clone' ? 'cloneSize' : 'brushSize';
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
  open: () => { fileMode = 'open'; $('#fileInput').click(); },
  place: needDoc(() => { fileMode = 'place'; $('#fileInput').click(); }),
  saveProject: needDoc(() => saveProject()),
  export: needDoc(() => openExportDialog()),
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
    const c = ctxOf(targetCanvas(l)), sel = doc().selection;
    if (sel) { c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(selectionCanvas(sel), -l.x, -l.y); c.restore(); }
    else c.clearRect(r.x, r.y, r.w, r.h);
    touchTarget(l); requestRender(); commit(editingMask(l) ? 'Clear mask' : 'Clear'); updateLayersPanel();
  }),
  fillSelection: needDoc(() => {
    const l = activeLayer(); ensureCoversDoc(l); if (!opRegion(l)) return;
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
    const l = activeLayer(); if (!l.mask) return status('This layer has no mask.');
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
    addLayer({ ...l, id: nextLayerId++, name: `${l.name} copy`, canvas: cloneCanvas(l.canvas), mask: cloneMask(l.mask), rev: ++globalRev }, 'Duplicate layer');
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
    composite(flat.canvas); d.layers = [flat]; d.activeId = flat.id; compDirty = true; requestRender(); commit('Flatten image');
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
  about: () => openInfo(`About ${APP}`, `<p>${APP} is an original, browser-based layered image editor built on the HTML Canvas 2D API.</p><p class="muted">Everything runs locally in your browser; images never leave your device.</p>`),
  brightnessContrast: needDoc(() => openAdjust(ADJ.brightnessContrast)),
  hueSaturation: needDoc(() => openAdjust(ADJ.hueSaturation)),
  exposure: needDoc(() => openAdjust(ADJ.exposure)),
  levels: needDoc(() => openAdjust(ADJ.levels)),
  sepia: needDoc(() => openAdjust(ADJ.sepia)),
  invert: needDoc(() => (editingMask() ? cmds.invertMask() : applyInstant('Invert', 'invert'))),
  grayscale: needDoc(() => applyInstant('Grayscale', 'grayscale')),
  autoLevels: needDoc(() => applyInstant('Auto levels', 'autoLevels')),
  gaussianBlur: needDoc(() => openAdjust(ADJ.gaussianBlur)),
  sharpen: needDoc(() => openAdjust(ADJ.sharpen)),
  noise: needDoc(() => openAdjust(ADJ.noise)),
  vignette: needDoc(() => openAdjust(ADJ.vignette)),
  swapColors: () => { const f = state.fg; setFg(state.bg); setBg(f); },
  resetColors: () => { setFg('#000000'); setBg('#ffffff'); },
};
function run(name) { closeMenus(); cmds[name]?.(); }

// Ctrl+V is handled by the paste event (so system-clipboard images work too).
const SHORTCUTS = {
  'mod+n': 'new', 'mod+o': 'open', 'mod+shift+o': 'place', 'mod+s': 'saveProject', 'mod+shift+e': 'export',
  'mod+z': 'undo', 'mod+shift+z': 'redo', 'mod+y': 'redo',
  'mod+a': 'selectAll', 'mod+d': 'deselect', 'mod+shift+i': 'invertSelection', 'mod+alt+d': 'feather', 'shift+f6': 'feather', '\\': 'editMaskToggle', 'delete': 'clear', 'backspace': 'clear', 'alt+backspace': 'fillSelection',
  'mod+c': 'copy', 'mod+shift+c': 'copyMerged', 'mod+x': 'cut',
  'mod+shift+n': 'layerNew', 'mod+j': 'layerDuplicate', 'mod+e': 'layerMergeDown', 'mod+]': 'layerUp', 'mod+[': 'layerDown',
  'mod+=': 'zoomIn', 'mod++': 'zoomIn', 'mod+shift+=': 'zoomIn', 'mod+shift++': 'zoomIn', 'mod+-': 'zoomOut', 'mod+0': 'zoomFit', 'mod+1': 'zoom100',
  'mod+b': 'brightnessContrast', 'mod+u': 'hueSaturation', 'mod+l': 'levels', 'mod+i': 'invert', 'mod+shift+u': 'grayscale',
  'x': 'swapColors', 'd': 'resetColors', '?': 'shortcuts', 'shift+?': 'shortcuts',
};

const MENUS = [
  ['File', [['New canvas…', 'new', 'Ctrl+N'], ['Open…', 'open', 'Ctrl+O'], ['Place image as layer…', 'place', 'Ctrl+Shift+O'], '-',
    ['Save project', 'saveProject', 'Ctrl+S'], ['Export image…', 'export', 'Ctrl+Shift+E']]],
  ['Edit', [['Undo', 'undo', 'Ctrl+Z'], ['Redo', 'redo', 'Ctrl+Shift+Z'], '-', ['Cut', 'cut', 'Ctrl+X'], ['Copy', 'copy', 'Ctrl+C'],
    ['Copy merged', 'copyMerged', 'Ctrl+Shift+C'], ['Paste as layer', 'paste', 'Ctrl+V'], '-',
    ['Clear', 'clear', 'Del'], ['Fill with color', 'fillSelection', 'Alt+⌫']]],
  ['Image', [['Image size…', 'imageSize'], ['Canvas size…', 'canvasSize'], ['Crop to selection', 'cropToSelection'], '-',
    ['Rotate 90° clockwise', 'rotateCW'], ['Rotate 90° counter-clockwise', 'rotateCCW'], ['Rotate 180°', 'rotate180'],
    ['Flip horizontal', 'flipH'], ['Flip vertical', 'flipV'], '-', ['Flatten', 'flatten']]],
  ['Select', [['All', 'selectAll', 'Ctrl+A'], ['Deselect', 'deselect', 'Ctrl+D'], ['Invert selection', 'invertSelection', 'Ctrl+Shift+I'], '-',
    ['Feather…', 'feather', 'Shift+F6'], ['Select layer pixels', 'selectLayerPixels'], '-', ['Crop to selection', 'cropToSelection']]],
  ['Layer', [['New layer', 'layerNew', 'Ctrl+Shift+N'], ['Duplicate layer', 'layerDuplicate', 'Ctrl+J'], ['Delete layer', 'layerDelete'], '-',
    ['Move up', 'layerUp', 'Ctrl+]'], ['Move down', 'layerDown', 'Ctrl+['], ['Merge down', 'layerMergeDown', 'Ctrl+E'], '-',
    ['Flip layer horizontal', 'flipLayerH'], ['Flip layer vertical', 'flipLayerV'], '-',
    ['Add layer mask (reveal all)', 'addMask'], ['Add mask from selection', 'addMaskFromSelection'], ['Edit mask / pixels', 'editMaskToggle', '\\'],
    ['Enable / disable mask', 'toggleMask'], ['Invert mask', 'invertMask'], ['Apply mask', 'applyMask'], ['Delete mask', 'deleteMask']]],
  ['Adjust', [['Brightness / contrast…', 'brightnessContrast', 'Ctrl+B'], ['Hue / saturation / lightness…', 'hueSaturation', 'Ctrl+U'],
    ['Exposure…', 'exposure'], ['Levels…', 'levels', 'Ctrl+L'], ['Auto levels', 'autoLevels'], '-',
    ['Invert', 'invert', 'Ctrl+I'], ['Grayscale', 'grayscale', 'Ctrl+Shift+U'], ['Sepia tone…', 'sepia']]],
  ['Filter', [['Gaussian blur…', 'gaussianBlur'], ['Sharpen (unsharp)…', 'sharpen'], ['Add noise…', 'noise'], ['Vignette…', 'vignette']]],
  ['View', [['Zoom in', 'zoomIn', 'Ctrl++'], ['Zoom out', 'zoomOut', 'Ctrl+-'], ['Fit on screen', 'zoomFit', 'Ctrl+0'], ['Actual pixels', 'zoom100', 'Ctrl+1']]],
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
  l.editMask = !!(onMask && l.mask);
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
  const x0 = Math.min(0, lower.x, upper.x), y0 = Math.min(0, lower.y, upper.y);
  const x1 = Math.max(d.width, lower.x + lower.canvas.width, upper.x + upper.canvas.width);
  const y1 = Math.max(d.height, lower.y + lower.canvas.height, upper.y + upper.canvas.height);
  const c = makeCanvas(x1 - x0, y1 - y0), x = c.getContext('2d');
  x.drawImage(renderSource(lower), lower.x - x0, lower.y - y0);
  x.globalAlpha = upper.opacity; x.globalCompositeOperation = upper.blend;
  if (upper.visible) x.drawImage(renderSource(upper), upper.x - x0, upper.y - y0);
  lower.canvas = c; lower.x = x0; lower.y = y0; lower.mask = null; lower.editMask = false; touch(lower);
  d.layers.splice(i, 1); d.activeId = lower.id;
  compDirty = true; requestRender(); commit('Merge down');
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
  for (const l of d.layers) {
    const w = l.canvas.width, h = l.canvas.height; let { x, y } = l;
    if (kind === 'cw') [x, y] = [H - (l.y + h), l.x];
    else if (kind === 'ccw') [x, y] = [l.y, W - (l.x + w)];
    else if (kind === '180') [x, y] = [W - (l.x + w), H - (l.y + h)];
    else if (kind === 'fh') x = W - (l.x + w);
    else if (kind === 'fv') y = H - (l.y + h);
    l.canvas = rotatedCanvas(l.canvas, kind); l.x = x; l.y = y; touch(l);
    if (l.mask) { l.mask.canvas = rotatedCanvas(l.mask.canvas, kind); touchMask(l); }
  }
  if (kind === 'cw' || kind === 'ccw') { d.width = H; d.height = W; }
  d.selection = null;
  compDirty = true; fitToScreen(); commit(label);
}
function transformLayer(kind, label) {
  const l = activeLayer(); l.canvas = rotatedCanvas(l.canvas, kind); touch(l);
  if (l.mask) { l.mask.canvas = rotatedCanvas(l.mask.canvas, kind); touchMask(l); }
  requestRender(); commit(label);
}
function resizeImage(nw, nh) {
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
    l.canvas = scale(l.canvas); l.x = Math.round(l.x * sx); l.y = Math.round(l.y * sy); touch(l);
    if (l.mask) { l.mask.canvas = scale(l.mask.canvas); touchMask(l); }
  }
  d.width = nw; d.height = nh; d.selection = null;
  compDirty = true; fitToScreen(); commit(`Image size ${nw}×${nh}`);
}
function resizeCanvas(nw, nh, ax, ay) {
  const d = doc(); const dx = Math.round((nw - d.width) * ax), dy = Math.round((nh - d.height) * ay);
  for (const l of d.layers) { l.x += dx; l.y += dy; touch(l); }
  d.width = nw; d.height = nh; d.selection = null;
  compDirty = true; fitToScreen(); commit(`Canvas size ${nw}×${nh}`);
}
function cropTo(r) {
  const d = doc();
  r = rectIntersect(r, { x: 0, y: 0, w: d.width, h: d.height }); if (!r) return;
  for (const l of d.layers) {
    const c = makeCanvas(r.w, r.h); c.getContext('2d').drawImage(l.canvas, l.x - r.x, l.y - r.y);
    if (l.mask) { const m = makeCanvas(r.w, r.h); m.getContext('2d').drawImage(l.mask.canvas, l.x - r.x, l.y - r.y); l.mask.canvas = m; touchMask(l); }
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
  const r = opRegion(l); if (!r) return;
  const c = ctxOf(l.canvas); const img = c.getImageData(r.x, r.y, r.w, r.h);
  setBusy(1);
  try {
    const out = await ops.process(op, img, {}, regionInfo(l, r), regionMask(l, r));
    c.putImageData(out, r.x, r.y); touch(l); requestRender(); commit(label); status(label);
  } catch (err) { status(`${label} failed: ${err.message}`); } finally { setBusy(-1); }
}

function openAdjust(def, presetValues = {}) {
  const l = activeLayer(); if (!canAdjust(l, def)) return;
  const r = opRegion(l);
  if (!r) { status('The selection does not overlap the active layer.'); return; }
  const onMask = editingMask(l), cv = targetCanvas(l);
  const c = ctxOf(cv);
  const original = c.getImageData(r.x, r.y, r.w, r.h);
  const values = Object.fromEntries(def.params.map((p) => [p.key, presetValues[p.key] ?? p.value]));
  const info = regionInfo(l, r), selMask = regionMask(l, r);
  const params = () => ({ ...values, ...(def.extra || {}) });
  const touchIt = () => (onMask ? touchMask(l) : touch(l));
  // Previews run in the worker; while one is running only the latest request is kept.
  let closed = false, running = false, dirty = false;
  const pump = async () => {
    running = true;
    while (dirty && !closed) {
      dirty = false;
      if (!$('#modalPreview').checked) { c.putImageData(original, r.x, r.y); compDirty = true; requestRender(); continue; }
      setBusy(1);
      let out = null;
      try { out = await ops.process(def.op, original, params(), info, selMask); } catch (err) { status(err.message); }
      setBusy(-1);
      if (closed || !out) continue;
      c.putImageData(out, r.x, r.y); compDirty = true; requestRender();
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
  for (const p of def.params) body.append(paramField({ ...p, value: values[p.key] }, values, preview, p.value));
  showModal({
    title: def.title, body, preview: true, passive: true,
    onPreviewToggle: preview,
    ok: async () => {
      closed = true; setBusy(1);
      try {
        const out = await ops.process(def.op, original, params(), info, selMask);
        c.putImageData(out, r.x, r.y); touchIt(); requestRender(); commit(def.title); status(def.title); updateLayersPanel();
      } catch (err) { c.putImageData(original, r.x, r.y); compDirty = true; requestRender(); status(`${def.title} failed: ${err.message}`); }
      finally { setBusy(-1); }
    },
    cancel: () => { closed = true; c.putImageData(original, r.x, r.y); compDirty = true; requestRender(); },
  });
  preview();
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
function showModal({ title, body, ok, cancel, okLabel = 'OK', preview = false, passive = false, onPreviewToggle, hideCancel = false }) {
  $('#modalTitle').textContent = title;
  const mb = $('#modalBody'); mb.innerHTML = '';
  if (typeof body === 'string') mb.innerHTML = body; else mb.append(body);
  $('#modalOk').textContent = okLabel;
  $('#modalCancel').classList.toggle('hidden', hideCancel);
  $('#previewWrap').classList.toggle('hidden', !preview);
  $('#modalPreview').checked = true;
  $('#modalPreview').onchange = onPreviewToggle || null;
  $('#modal').classList.toggle('passive', passive);
  $('#modal').classList.remove('hidden');
  modalHandlers = { ok, cancel };
  setTimeout(() => mb.querySelector('textarea, input[type=number], input[type=text], select')?.focus(), 0);
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

function openTextDialog(p) {
  const d = doc();
  const layer = createLayer('Text', d.width, d.height);
  const o = state.opts;
  const body = document.createElement('div');
  body.innerHTML = `<textarea id="tText" placeholder="Type your text">Hello</textarea>` + formHTML([
    { label: 'Font', html: `<select id="tFont">${['system-ui', 'sans-serif', 'serif', 'monospace', 'Georgia', 'Verdana', 'Courier New', 'cursive'].map((f) => `<option ${f === o.textFont ? 'selected' : ''}>${f}</option>`).join('')}</select>` },
    { label: 'Size (px)', html: `<input type="number" id="tSize" value="${o.textSize}" min="4" max="2000" />` },
    { label: 'Style', html: `<span><input type="checkbox" id="tBold" ${o.textBold ? 'checked' : ''}/> Bold <input type="checkbox" id="tItalic" ${o.textItalic ? 'checked' : ''}/> Italic</span>` },
    { label: 'Color', html: `<input type="color" id="tColor" value="${state.fg}" />` },
  ]);
  d.layers.splice(activeIndex() + 1, 0, layer);
  const draw = () => {
    o.textFont = body.querySelector('#tFont').value; o.textSize = +body.querySelector('#tSize').value || 64;
    o.textBold = body.querySelector('#tBold').checked; o.textItalic = body.querySelector('#tItalic').checked;
    const x = ctxOf(layer.canvas); x.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    x.font = `${o.textItalic ? 'italic ' : ''}${o.textBold ? '700 ' : ''}${o.textSize}px ${o.textFont}`;
    x.fillStyle = body.querySelector('#tColor').value; x.textBaseline = 'top';
    const text = body.querySelector('#tText').value;
    text.split('\n').forEach((line, i) => x.fillText(line, p.x, p.y + i * o.textSize * 1.2));
    layer.name = `Text: ${text.split('\n')[0].slice(0, 24) || '(empty)'}`;
    touch(layer); requestRender();
  };
  body.addEventListener('input', draw);
  draw();
  showModal({ title: 'Add text', body, passive: true, okLabel: 'Add text',
    ok: () => { d.activeId = layer.id; touch(layer); commit('Text'); },
    cancel: () => { d.layers.splice(d.layers.indexOf(layer), 1); compDirty = true; requestRender(); } });
}

function openExportDialog() {
  const body = document.createElement('div');
  const base = (doc().name || 'image').replace(/\.[^.]+$/, '');
  body.innerHTML = formHTML([
    { label: 'File name', html: `<input type="text" id="eName" value="${escapeHtml(base)}" />` },
    { label: 'Format', html: `<select id="eFmt"><option value="image/png">PNG (lossless)</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option></select>` },
    { label: 'Quality', html: `<span><input type="range" id="eQ" min="1" max="100" value="90" disabled /> <output id="eQv">90</output></span>` },
    { label: 'Size', html: `<span class="muted">${doc().width} × ${doc().height} px</span>` },
  ]);
  const fmt = body.querySelector('#eFmt'), q = body.querySelector('#eQ');
  fmt.addEventListener('change', () => { q.disabled = fmt.value === 'image/png'; });
  q.addEventListener('input', () => { body.querySelector('#eQv').textContent = q.value; });
  showModal({ title: 'Export image', body, okLabel: 'Export', ok: () => {
    exportImage(fmt.value, q.value / 100, body.querySelector('#eName').value || 'image');
  } });
}
function exportImage(type, quality, name) {
  const out = makeCanvas(doc().width, doc().height);
  // JPEG has no alpha channel: flatten onto white so transparent areas don't turn black
  composite(out, { background: type === 'image/jpeg' ? '#ffffff' : null });
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type];
  out.toBlob((blob) => {
    download(blob, `${name}.${ext}`);
    status(`Exported ${name}.${ext} (${(blob.size / 1024).toFixed(0)} KB)`);
  }, type, quality);
}
function download(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function openShortcutsDialog() {
  const rows = [
    ['V / M / C', 'Move / Rectangle select / Crop'], ['L / P / W', 'Lasso / Polygonal lasso / Magic wand'], ['B / E / S / G', 'Brush / Eraser / Clone stamp / Fill'], ['T / I', 'Text / Color picker'],
    ['Shift / Alt / Shift+Alt (selecting)', 'Add / subtract / intersect'], ['Ctrl+Shift+I, Shift+F6', 'Invert selection / feather'], ['Enter, double-click / Esc', 'Close / cancel polygon'],
    ['Alt+click (clone stamp)', 'Set clone source'], ['\\', 'Toggle editing mask / pixels'],
    ['H, hold Space', 'Pan'], ['Z, mouse wheel', 'Zoom (Shift+wheel pans)'], ['[ and ]', 'Brush size'], ['Shift+click', 'Straight brush line'], ['Alt+click (brush)', 'Pick color'],
    ['X / D', 'Swap / default colors'], ['Ctrl+Z, Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+A / Ctrl+D', 'Select all / deselect'],
    ['Del, Alt+Backspace', 'Clear / fill selection'], ['Ctrl+C / X / V', 'Copy / cut / paste as layer'], ['Ctrl+J / Ctrl+E', 'Duplicate layer / merge down'],
    ['Ctrl+B / U / L / I', 'Brightness-contrast / Hue-sat / Levels / Invert'], ['Ctrl+0 / Ctrl+1', 'Fit / 100%'], ['Enter / Esc', 'Apply / cancel crop'],
    ['Arrows (Move tool)', 'Nudge layer (Shift = 10px)'], ['Ctrl+S / Ctrl+Shift+E', 'Save project / export'],
  ];
  openInfo('Keyboard shortcuts', `<table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:3px 8px 3px 0;white-space:nowrap"><b>${k}</b></td><td class="muted">${v}</td></tr>`).join('')}</table>`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------
let fileMode = 'open';
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not decode image')); i.src = src; });
}
function placeImage(img, name) {
  const d = doc(); const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const l = createLayer(name, w, h, { x: Math.round((d.width - w) / 2), y: Math.round((d.height - h) / 2) });
  l.canvas.getContext('2d').drawImage(img, 0, 0);
  addLayer(l, 'Place image');
}
async function openFile(file, mode = 'open') {
  try {
    if (/\.(json|tintwork)$/i.test(file.name) || file.type === 'application/json') {
      await loadProject(JSON.parse(await file.text()), file.name);
      return;
    }
    if (!file.type.startsWith('image/')) { status(`Unsupported file: ${file.name}`); return; }
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (mode === 'place' && doc()) placeImage(img, file.name.replace(/\.[^.]+$/, ''));
    else documentFromImage(img, file.name);
    URL.revokeObjectURL(url);
    status(`${mode === 'place' && doc() ? 'Placed' : 'Opened'} ${file.name} (${img.naturalWidth}×${img.naturalHeight})`);
  } catch (err) { status(`Error: ${err.message}`); console.error(err); }
}
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f, fileMode); e.target.value = ''; });

function serializeProject() {
  const d = doc();
  return {
    format: PROJECT_FORMAT, version: 2, app: APP, width: d.width, height: d.height, name: d.name,
    activeIndex: activeIndex(),
    layers: d.layers.map((l) => ({
      name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, data: l.canvas.toDataURL('image/png'),
      mask: l.mask ? { enabled: l.mask.enabled, data: l.mask.canvas.toDataURL('image/png') } : null,
    })),
  };
}
function saveProject() {
  const name = (doc().name || 'project').replace(/\.[^.]+$/, '').replace(/\.tintwork$/, '');
  download(new Blob([JSON.stringify(serializeProject())], { type: 'application/json' }), `${name}.tintwork.json`);
  status(`Saved project ${name}.tintwork.json`);
}
async function loadProject(data, filename) {
  if (data.format !== PROJECT_FORMAT) throw new Error('Not a Tintwork project file');
  const layers = [];
  for (const L of data.layers) {
    const img = await loadImage(L.data);
    const l = createLayer(L.name, img.width, img.height, { visible: L.visible, opacity: L.opacity, blend: L.blend, x: L.x, y: L.y });
    l.canvas.getContext('2d').drawImage(img, 0, 0);
    if (L.mask?.data) {
      const mi = await loadImage(L.mask.data);
      const m = makeCanvas(img.width, img.height); m.getContext('2d').drawImage(mi, 0, 0);
      l.mask = { canvas: m, enabled: L.mask.enabled !== false, rev: ++globalRev };
    }
    layers.push(l);
  }
  if (!layers.length) throw new Error('Project has no layers');
  const ai = Math.min(layers.length - 1, Math.max(0, data.activeIndex ?? layers.length - 1));
  state.doc = { width: data.width, height: data.height, layers, activeId: layers[ai].id, selection: null, name: data.name || filename };
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
function status(msg) { $('#status').textContent = msg; }
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
      ib.innerHTML = `<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`;
      list.append(ib);
    }
    m.append(list); nav.append(m);
    b.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); });
    b.addEventListener('mouseenter', () => { if (document.querySelector('.menu.open') && !m.classList.contains('open')) { closeMenus(); m.classList.add('open'); } });
  }
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cmd]');
  if (c) { run(c.dataset.cmd); return; }
  if (!e.target.closest('.menu')) closeMenus();
});

function buildToolbar() {
  const tb = $('#toolbar');
  for (const t of TOOLS) {
    if (t.sep) { const s = document.createElement('div'); s.className = 'sep'; tb.append(s); continue; }
    const b = document.createElement('button'); b.dataset.tool = t.id; b.title = `${t.name} (${t.key})`;
    b.innerHTML = ICONS[t.id]; b.addEventListener('click', () => setTool(t.id)); tb.append(b);
  }
}

function buildOptionsBar() {
  const bar = $('#optionsbar'); const o = state.opts; const t = TOOLS.find((x) => x.id === state.tool);
  const parts = [`<span class="tool-title">${t.name}</span>`];
  const range = (key, label, min, max, unit = '') => `<label>${label} <input type="range" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" /><input type="number" data-opt="${key}" min="${min}" max="${max}" value="${o[key]}" />${unit}</label>`;
  const d = doc();
  switch (state.tool) {
    case 'brush': parts.push(range('brushSize', 'Size', 1, 500, 'px'), range('brushHardness', 'Hardness', 0, 100, '%'), range('brushOpacity', 'Opacity', 1, 100, '%'), `<span class="muted">Shift+click: straight line · Alt+click: pick color</span>`); break;
    case 'eraser': parts.push(range('eraserSize', 'Size', 1, 500, 'px'), range('eraserHardness', 'Hardness', 0, 100, '%'), range('eraserOpacity', 'Opacity', 1, 100, '%')); break;
    case 'clone': parts.push(range('cloneSize', 'Size', 1, 500, 'px'), range('cloneHardness', 'Hardness', 0, 100, '%'), range('cloneOpacity', 'Opacity', 1, 100, '%'),
      `<label><input type="checkbox" data-opt="cloneAligned" ${o.cloneAligned ? 'checked' : ''}/> Aligned</label>`,
      `<span class="muted">${state.cloneSrc ? `Source ${Math.round(state.cloneSrc.x)}, ${Math.round(state.cloneSrc.y)}` : 'Alt+click to set the source'}</span>`); break;
    case 'lasso': case 'polylasso': case 'wand': case 'select': {
      const s = d?.selection;
      parts.push(`<span class="seg">${['new', 'add', 'subtract', 'intersect'].map((m) => `<button data-selmode="${m}" class="${o.selMode === m ? 'on' : ''}" title="${m === 'new' ? 'New selection' : m === 'add' ? 'Add (Shift)' : m === 'subtract' ? 'Subtract (Alt)' : 'Intersect (Shift+Alt)'}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</span>`);
      if (state.tool === 'wand') parts.push(range('wandTolerance', 'Tolerance', 0, 255), `<label><input type="checkbox" data-opt="wandContiguous" ${o.wandContiguous ? 'checked' : ''}/> Contiguous</label>`, `<label><input type="checkbox" data-opt="wandSampleAll" ${o.wandSampleAll ? 'checked' : ''}/> Sample all layers</label>`);
      const hint = { select: 'Drag a rectangle', lasso: 'Drag a freehand outline', polylasso: 'Click points · double-click, Enter or click the start to close · Esc cancels', wand: 'Click a color' }[state.tool];
      parts.push(`<span class="muted">${s ? `${s.w} × ${s.h} px at ${s.x}, ${s.y}` : hint}</span>`, `<button data-cmd="feather">Feather…</button>`, `<button data-cmd="invertSelection">Invert</button>`, `<button data-cmd="deselect">Deselect</button>`);
      break;
    }
    case 'fill': parts.push(range('fillTolerance', 'Tolerance', 0, 255), `<label><input type="checkbox" data-opt="fillContiguous" ${o.fillContiguous ? 'checked' : ''}/> Contiguous</label>`, `<button data-cmd="fillSelection">Fill selection</button>`); break;
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
  if (al && editingMask(al) && ['brush', 'eraser', 'fill'].includes(state.tool)) parts.push(`<span class="mask-badge">Editing mask</span>`);
  bar.innerHTML = parts.join('');
  bar.querySelectorAll('[data-selmode]').forEach((b) => b.addEventListener('click', () => { o.selMode = b.dataset.selmode; buildOptionsBar(); }));
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
    tx.beginPath(); tx.rect(0, 0, d.width, d.height); tx.clip(); tx.drawImage(l.canvas, l.x, l.y); tx.restore();
    th.className = 'thumb' + (l.id === d.activeId && l.mask && !l.editMask ? ' target' : '');
    th.title = 'Layer pixels';
    th.addEventListener('click', (e) => { e.stopPropagation(); d.activeId = l.id; setMaskTarget(l, false); requestRender(); });
    let mth = null;
    if (l.mask) {
      mth = makeCanvas(40, 30); const mx = mth.getContext('2d');
      mx.fillStyle = '#000'; mx.fillRect(0, 0, 40, 30);
      mx.save(); mx.translate((40 - d.width * s) / 2, (30 - d.height * s) / 2); mx.scale(s, s);
      mx.beginPath(); mx.rect(0, 0, d.width, d.height); mx.clip(); mx.drawImage(l.mask.canvas, l.x, l.y); mx.restore();
      if (!l.mask.enabled) { mx.strokeStyle = '#e8453a'; mx.lineWidth = 2.5; mx.beginPath(); mx.moveTo(3, 3); mx.lineTo(37, 27); mx.moveTo(37, 3); mx.lineTo(3, 27); mx.stroke(); }
      mth.className = 'thumb mask-thumb' + (l.id === d.activeId && l.editMask ? ' target' : '');
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
    li.addEventListener('click', () => { d.activeId = l.id; updateLayersPanel(); buildOptionsBar(); requestRender(); });
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
  }
  const al = activeLayer();
  document.querySelector('#layersPanel [data-cmd="addMask"]')?.classList.toggle('on', !!al.mask);
  $('#blendMode').value = al.blend;
  $('#layerOpacity').value = Math.round(al.opacity * 100);
  $('#layerOpacityVal').textContent = `${Math.round(al.opacity * 100)}%`;
}

function updateHistoryPanel() {
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
  const d = doc(); $('#docinfo').textContent = d ? `${d.name} — ${d.width} × ${d.height} px · ${d.layers.length} layer${d.layers.length > 1 ? 's' : ''}` : '';
  document.title = d ? `${d.name} — ${APP}` : `${APP} — browser image editor`;
}
function updateAll() { updateLayersPanel(); updateHistoryPanel(); buildOptionsBar(); updateDocInfo(); updateZoomLabel(); scheduleHistogram(); requestRender(); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildMenus(); buildToolbar();
document.querySelectorAll('.panel-actions [data-cmd]').forEach((b) => { b.innerHTML = ICONS[b.dataset.cmd] || b.innerHTML; }); setTool('brush'); setFg(state.fg);
$('#welcome').classList.remove('hidden');
render();
status(`${APP} ready — open an image (Ctrl+O), drop one in, or create a new canvas (Ctrl+N).`);

// Small automation/testing hook (also handy from the devtools console).
window.tintwork = {
  state, cmds, run, setTool, openFile, newDocument, history, commit, composite, activeLayer, setFg, serializeProject, openAdjust, ADJ,
  ops, setSelection, makeSelection, rectMask, renderSource, updateLayersPanel, touch, fitToScreen,
  compositePixel(x, y) { if (compDirty) { composite(); compDirty = false; } return [...compCtx.getImageData(x, y, 1, 1).data]; },
  get doc() { return state.doc; },
  get workerAvailable() { return ops.workerStatus().available; },
  /** Resolves once queued worker jobs have finished. */
  idle: () => new Promise((res) => { const t = () => (state.busy ? setTimeout(t, 10) : res()); t(); }),
};
