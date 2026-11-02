// Tintwork performance benchmark + automatic engine probe.
// Runs the same operations on every available engine (CPU = Canvas 2D + worker, WebGL2, WebGPU) on synthetic
// images, each engine in isolation: engines are created, measured and destroyed one after another (some
// drivers, notably SwiftShader, drop existing WebGL contexts when a WebGPU device is created).
import { createEngine } from './gpu.js';
import { createWebGPUEngine, webgpuAvailable } from './webgpu.js';
import * as ops from './ops.js';
import { perspectiveMesh, renderMeshCPU } from './mesh.js';
import { blendIndex } from './deep.js';

export const BENCH_SIZES = { 1: [1200, 900], 12: [4000, 3000], 24: [6000, 4000] };
const BLENDS = ['source-over', 'multiply', 'screen', 'overlay', 'soft-light', 'difference', 'color', 'luminosity', 'darken', 'lighten'];
const now = () => performance.now();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Synthetic test image (gradient + translucent blocks + fine detail). */
export function syntheticCanvas(W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true });
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#203050'); g.addColorStop(0.5, '#d09060'); g.addColorStop(1, '#40e0b0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) { x.fillStyle = `hsla(${i * 37},70%,50%,0.5)`; x.fillRect((i * 997) % W, (i * 613) % H, W / 6, H / 6); }
  x.strokeStyle = 'rgba(255,255,255,0.6)'; x.lineWidth = 2; for (let i = 0; i < W; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(W - i, H); x.stroke(); }
  return c;
}
function cpuComposite(target, src, n, changed = -1) {
  const W = target.width, H = target.height, c = target.getContext('2d', { willReadFrequently: true });
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) { c.globalAlpha = 0.7; c.globalCompositeOperation = BLENDS[i % BLENDS.length]; c.drawImage(src, (i * 50 + (i === changed ? 3 : 0)) % 200, 0); }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.getImageData(0, 0, 1, 1);
}
const layerList = (src, W, H, n, rev = 0, changed = -1) => Array.from({ length: n }, (_, i) => ({
  kind: 'pixels', key: `bench${i}:${i === changed ? rev : 0}`, slot: `bench${i}`, src, x: (i * 50 + (i === changed ? 3 : 0)) % 200, y: 0, w: W, h: H, opacity: 0.7, mode: blendIndex(BLENDS[i % BLENDS.length]), mask: null,
}));
function quad(W, H) { return [[W * 0.06, H * 0.04], [W * 0.95, H * 0.12], [W, H * 0.97], [0, H * 0.9]]; }

/** Engine factory: 'cpu' | 'webgl' | 'webgpu' → { e, info } or { error }. */
export async function openEngine(kind, budgetMB = 2048) {
  if (kind === 'cpu') return { e: null, info: { renderer: `CPU (${navigator.hardwareConcurrency || '?'} threads)`, vendor: '', software: false } };
  try {
    const e = kind === 'webgl' ? createEngine({ budgetMB, tile: 4096 }) : webgpuAvailable() ? await createWebGPUEngine({ budgetMB, tile: 4096, present: 'readback' }) /* timings include readback; skips the canvas-presentation probe */ : { error: 'WebGPU is not available in this browser' };
    if (e.error) return { error: e.error };
    return { e, info: e.info };
  } catch (err) { return { error: err?.message || String(err) }; }
}

/**
 * Time one engine on a W×H synthetic image. Ops: blur, curves, composite (cold + warm), warp.
 * Returns { op: ms } (+ op_error strings). `which` limits the ops.
 */
export async function measure(kind, e, W, H, { which = ['blur', 'curves', 'composite', 'warp'], curves, layers = 10 } = {}) {
  const src = syntheticCanvas(W, H), img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const info = { docW: W, docH: H, offX: 0, offY: 0 }, out = {};
  const time = async (label, fn) => {
    try { const t0 = now(); await fn(); out[label] = Math.round((now() - t0) * 10) / 10; } catch (err) { out[label] = null; out[`${label}_error`] = err?.message || String(err); }
    await tick();
  };
  const filt = async (op, p) => (kind === 'cpu' ? ops.processCpu(op, img, p, info) : e.processImageData(op, img, p, info));
  try {
    if (e) { await filt('gaussianBlur', { radius: 2 }); } // warm-up: shader compile + allocation
    if (which.includes('blur')) await time('blur', () => filt('gaussianBlur', { radius: 25 }));
    if (which.includes('curves') && curves) await time('curves', () => filt('curves', curves));
    if (which.includes('composite')) {
      const target = document.createElement('canvas'); target.width = W; target.height = H; const tc = target.getContext('2d', { willReadFrequently: true });
      const comp = async (rev, changed) => {
        if (kind === 'cpu') return cpuComposite(target, src, layers, changed);
        const list = layerList(src, W, H, layers, rev, changed);
        if (e.kind === 'webgpu') await e.compositeAsync(list, W, H, tc); else e.composite(list, W, H, tc);
        tc.getImageData(0, 0, 1, 1);
      };
      await time('composite', () => comp(0, -1));
      await time('composite_warm', () => comp(1, 5));
      target.width = target.height = 0;
      if (e) e.flush();
    }
    if (which.includes('warp')) {
      const mesh = perspectiveMesh(W, H, quad(W, H));
      await time('warp', async () => (kind === 'cpu' ? renderMeshCPU(img, W, H, mesh, 0, 0) : e.warpMesh(img, W, H, mesh, 0, 0)));
    }
  } finally { src.width = src.height = 0; }
  return out;
}

export const BENCH_OPS = [
  ['blur', 'Gaussian blur, radius 25 (incl. upload + readback)'],
  ['curves', 'Curves (incl. upload + readback)'],
  ['composite', '10-layer composite, mixed blend modes (cold)'],
  ['composite_warm', '10-layer composite, one layer changed'],
  ['warp', 'Perspective warp (mesh) of the full image'],
];

/**
 * Full benchmark. engines: subset of ['cpu','webgl','webgpu']; sizes: keys of BENCH_SIZES.
 * onProgress(text) is called between steps. Returns { engines: {kind: info|error}, rows: [{mp, op, kind, ms}], env }.
 */
export async function runBenchmark({ engines = ['cpu', 'webgl', 'webgpu'], sizes = [12, 24], curves, onProgress = () => {}, budgetMB = 2048 } = {}) {
  const res = { engines: {}, rows: [], env: envInfo(), started: new Date().toISOString() };
  for (const kind of engines) {
    onProgress(`Starting ${kind.toUpperCase()}…`); await tick();
    const o = await openEngine(kind, budgetMB);
    if (o.error) { res.engines[kind] = { error: o.error }; continue; }
    res.engines[kind] = summarizeInfo(kind, o.info);
    try {
      for (const mp of sizes) {
        const [W, H] = BENCH_SIZES[mp];
        onProgress(`${kind.toUpperCase()} · ${mp} MP (${W}×${H})…`); await tick();
        let m = await measure(kind, o.e, W, H, { curves });
        // A GPU context can be lost mid-run (some drivers drop WebGL contexts after a WebGPU device existed in
        // the page). Start the engine again once and repeat this size before reporting errors.
        if (kind !== 'cpu' && (o.e.lost || BENCH_OPS.some(([op]) => m[`${op}_error`]))) {
          onProgress(`${kind.toUpperCase()} · ${mp} MP: GPU context lost, restarting the engine…`);
          try { o.e.destroy(); } catch { /* gone */ }
          await new Promise((r) => setTimeout(r, 400));
          const o2 = await openEngine(kind, budgetMB);
          if (!o2.error) { o.e = o2.e; const m2 = await measure(kind, o.e, W, H, { curves }); if (BENCH_OPS.filter(([op]) => m2[`${op}_error`]).length < BENCH_OPS.filter(([op]) => m[`${op}_error`]).length) { m = m2; res.engines[kind].restarted = true; } }
        }
        for (const [op] of BENCH_OPS) if (op in m) res.rows.push({ mp, op, kind, ms: m[op], error: m[`${op}_error`] || '' });
      }
    } finally { if (o.e) try { o.e.destroy(); } catch { /* gone */ } }
  }
  res.finished = new Date().toISOString();
  return res;
}
function summarizeInfo(kind, i) {
  const a = i.adapter || {};
  return {
    renderer: i.renderer || '', vendor: a.vendor || i.vendor || '', architecture: a.architecture || '', device: a.device || '', description: a.description || '',
    software: !!i.software, fallback: !!a.fallback, maxTextureSize: i.maxTextureSize || null, present: kind === 'webgpu' ? i.present || '' : '',
  };
}
export function envInfo() {
  return { userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || '', threads: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null, dpr: window.devicePixelRatio || 1 };
}
const NAMES = { cpu: 'CPU', webgl: 'WebGL2', webgpu: 'WebGPU' };
/** Plain-text report (what "Copy results" puts on the clipboard). */
export function benchText(res, appVersion = '') {
  const L = [];
  L.push(`Tintwork ${appVersion} performance benchmark — ${res.started}`);
  L.push(`Browser: ${res.env.userAgent}`);
  L.push(`Platform: ${res.env.platform} · ${res.env.threads ?? '?'} threads · ${res.env.memoryGB ?? '?'} GB (reported) · DPR ${res.env.dpr}`);
  for (const [k, v] of Object.entries(res.engines)) {
    if (v.error) { L.push(`${NAMES[k]}: unavailable (${v.error})`); continue; }
    const id = k === 'webgpu' ? [v.vendor && `vendor ${v.vendor}`, v.architecture && `architecture ${v.architecture}`, v.device && `device ${v.device}`, v.description && `“${v.description}”`].filter(Boolean).join(', ') : v.renderer;
    L.push(`${NAMES[k]}: ${id || v.renderer}${v.software ? ' — SOFTWARE adapter (numbers are not representative of a hardware GPU)' : k === 'cpu' ? '' : ' — hardware'}${v.present ? ` · output ${v.present}` : ''}`);
  }
  const kinds = Object.keys(res.engines).filter((k) => !res.engines[k].error), sizes = [...new Set(res.rows.map((r) => r.mp))];
  const head = ['Operation', 'MP', ...kinds.map((k) => NAMES[k])], rows = [head];
  for (const mp of sizes) for (const [op, label] of BENCH_OPS) {
    const cells = kinds.map((k) => { const r = res.rows.find((x) => x.mp === mp && x.op === op && x.kind === k); return !r ? '—' : r.ms == null ? 'error' : `${r.ms} ms`; });
    if (cells.every((c) => c === '—')) continue;
    rows.push([label, String(mp), ...cells]);
  }
  const wd = head.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  rows.forEach((r, j) => { L.push(r.map((c, i) => (i === 0 ? c.padEnd(wd[i]) : c.padStart(wd[i]))).join('  ')); if (!j) L.push(wd.map((n) => '-'.repeat(n)).join('  ')); });
  const errs = res.rows.filter((r) => r.error); for (const r of errs) L.push(`! ${NAMES[r.kind]} ${r.op} @ ${r.mp} MP: ${r.error}`);
  return L.join('\n');
}

// --- automatic engine selection -------------------------------------------------------------------
/** Identity of the graphics stack without creating devices (cache key for the probe). */
export async function stackId(appVersion) {
  let gpu = '-', gl = '-';
  try { if (webgpuAvailable()) { const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); const i = a?.info || {}; gpu = a ? [i.vendor, i.architecture, i.device, i.description, a.isFallbackAdapter ? 'fallback' : ''].filter(Boolean).join(' ') || 'adapter' : 'none'; } } catch { gpu = 'error'; }
  try {
    const c = document.createElement('canvas'), x = c.getContext('webgl2');
    if (x) { const d = x.getExtension('WEBGL_debug_renderer_info'); gl = d ? x.getParameter(d.UNMASKED_RENDERER_WEBGL) : x.getParameter(x.RENDERER); x.getExtension('WEBGL_lose_context')?.loseContext(); } else gl = 'none';
  } catch { gl = 'error'; }
  return `${appVersion}|${gpu}|${gl}|${navigator.hardwareConcurrency || 0}`;
}
/**
 * Quick probe (~1 MP blur + curves + 4-layer composite) on each engine. Returns { ms: {cpu, webgl, webgpu}, choice, keep }
 * where keep is the winning engine instance if it is still open (WebGPU is measured last so it can be kept).
 */
export async function probeEngines({ curves, budgetMB = 2048, keepWinner = true } = {}) {
  const W = 1024, H = 1024, ms = {}, info = {}, errors = {};
  const score = (m) => (m.blur ?? Infinity) + (m.curves ?? Infinity) + (m.composite_warm ?? Infinity);
  ms.cpu = score(await measure('cpu', null, W, H, { which: ['blur', 'curves', 'composite'], curves, layers: 4 }));
  let keep = null;
  for (const kind of ['webgl', 'webgpu']) {
    const o = await openEngine(kind, budgetMB);
    if (o.error) { errors[kind] = o.error; continue; }
    info[kind] = summarizeInfo(kind, o.info);
    try { ms[kind] = score(await measure(kind, o.e, W, H, { which: ['blur', 'curves', 'composite'], curves, layers: 4 })); }
    catch (err) { errors[kind] = err?.message || String(err); }
    if (kind === 'webgpu' && keepWinner) keep = o.e; else try { o.e.destroy(); } catch { /* gone */ }
  }
  for (const k in ms) ms[k] = Number.isFinite(ms[k]) ? Math.round(ms[k]) : null;
  // fastest wins; a GPU within 10% of the CPU is preferred (it frees the main thread / worker)
  const order = ['webgpu', 'webgl', 'cpu'].filter((k) => ms[k] != null);
  let choice = 'cpu', best = Infinity; for (const k of order) if (ms[k] < best) { best = ms[k]; choice = k; }
  for (const k of order) if (k !== 'cpu' && ms[k] <= best * 1.1) { choice = k; break; }
  if (keep && choice !== 'webgpu') { try { keep.destroy(); } catch { /* gone */ } keep = null; }
  return { ms, choice, info, errors, keep, at: new Date().toISOString() };
}
