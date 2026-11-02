// WebGPU engine (primary path on Chrome / Edge): compute-shader compositing (all 16 blend modes, masks,
// adjustment layers), filters (shared-memory separable Gaussian blur, unsharp mask, noise, vignette,
// LUT point ops, HSL, greyscale, sepia) and brush dab stamping. It exposes the same interface as the
// WebGL2 engine in gpu.js, so main.js / ops.js can use either. Accumulation is in rgba16float
// (premultiplied sRGB, matching the CPU maths); 16-bit documents are processed in rgba32float.
// Output reaches the 2D canvases through a WebGPU canvas + drawImage (synchronous), tile by tile.
// Readbacks (processImageData / processDeep) are asynchronous (mapAsync).
import { pointFns } from './pixels.js';
import { GPU_OPS } from './gpu.js';

const ADJ_POINT = new Set(['brightnessContrast', 'exposure', 'levels', 'invert', 'curves', 'hueSaturation', 'grayscale', 'sepia']);
const BPP = { rgba8unorm: 4, rgba16float: 8, rgba32float: 16 };
const MAXR = 300; // blur apron (radius 100 → 3 sigma)

const COMMON = `
fn ihash(x0: u32) -> u32 { var x = x0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
fn rnd(p: vec2<i32>, s: u32) -> f32 { return f32(ihash((bitcast<u32>(p.x) * 0x9e3779b1u) ^ ihash(bitcast<u32>(p.y) ^ (s * 0x85ebca77u)))) / 4294967296.0; }
fn straightc(c: vec4f) -> vec3f { if (c.a > 0.0) { return clamp(c.rgb / c.a, vec3f(0.0), vec3f(1.0)); } return vec3f(0.0); }
fn inside(p: vec2<i32>, s: vec2<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.x < s.x && p.y < s.y; }
`;

// Uniform blocks are declared as scalar lists so JS packing is trivial (4 bytes each).
const PASSES = {
  prep: { u: [['straightIn', 'u32']], tex: ['src'], body: `
  let c = clamp(textureLoad(src, p, 0), vec4f(0.0), vec4f(1.0));
  if (u.straightIn == 1u) { textureStore(dst, p, vec4f(c.rgb * c.a, c.a)); } else { textureStore(dst, p, c); }` },

  layer: { u: [['offX', 'i32'], ['offY', 'i32'], ['sw', 'i32'], ['sh', 'i32'], ['mx', 'i32'], ['my', 'i32'], ['mw', 'i32'], ['mh', 'i32'], ['opacity', 'f32'], ['mode', 'i32'], ['flags', 'u32']],
    tex: ['base', 'src', 'mask'], extra: `
fn lumf(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }
fn clipColor(c0: vec3f) -> vec3f { var c = c0; let l = lumf(c); let n = min(c.r, min(c.g, c.b)); let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { c = l + (c - l) * l / (l - n); } if (x > 1.0) { c = l + (c - l) * (1.0 - l) / (x - l); } return c; }
fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + (l - lumf(c))); }
fn satf(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn setSat(c: vec3f, s: f32) -> vec3f { let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b)); if (mx > mn) { return (c - mn) * s / (mx - mn); } return vec3f(0.0); }
fn softD(b: vec3f) -> vec3f { return mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3f(0.25))); }
fn B(m: i32, b: vec3f, s: vec3f) -> vec3f {
  switch m {
    case 1: { return b * s; }
    case 2: { return b + s - b * s; }
    case 3: { return mix(1.0 - 2.0 * (1.0 - b) * (1.0 - s), 2.0 * b * s, step(b, vec3f(0.5))); }
    case 4: { return min(b, s); }
    case 5: { return max(b, s); }
    case 6: { var r = min(vec3f(1.0), b / max(1.0 - s, vec3f(1e-6))); r = mix(r, vec3f(1.0), step(vec3f(1.0), s)); return mix(r, vec3f(0.0), step(b, vec3f(0.0))); }
    case 7: { var r = 1.0 - min(vec3f(1.0), (1.0 - b) / max(s, vec3f(1e-6))); r = mix(r, vec3f(0.0), step(s, vec3f(0.0))); return mix(r, vec3f(1.0), step(vec3f(1.0), b)); }
    case 8: { return mix(b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0), b * 2.0 * s, step(s, vec3f(0.5))); }
    case 9: { return mix(b + (2.0 * s - 1.0) * (softD(b) - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3f(0.5))); }
    case 10: { return abs(b - s); }
    case 11: { return b + s - 2.0 * b * s; }
    case 12: { return setLum(setSat(s, satf(b)), lumf(b)); }
    case 13: { return setLum(setSat(b, satf(s)), lumf(b)); }
    case 14: { return setLum(s, lumf(b)); }
    case 15: { return setLum(b, lumf(s)); }
    default: { return s; }
  }
}`, body: `
  let d = textureLoad(base, p, 0);
  let q = p - vec2<i32>(u.offX, u.offY); var s = vec4f(0.0);
  if (inside(q, vec2<i32>(u.sw, u.sh))) { s = clamp(textureLoad(src, q, 0), vec4f(0.0), vec4f(1.0)); if ((u.flags & 2u) != 0u) { s = vec4f(s.rgb * s.a, s.a); } }
  var k = u.opacity;
  let mq = p - vec2<i32>(u.mx, u.my); let mv = textureLoad(mask, clamp(mq, vec2<i32>(0), vec2<i32>(u.mw - 1, u.mh - 1)), 0).a;
  if ((u.flags & 1u) != 0u) { k *= select(0.0, mv, inside(mq, vec2<i32>(u.mw, u.mh))); }
  if ((u.flags & 4u) != 0u) { textureStore(dst, p, d * (1.0 - k) + s * k); return; }
  s *= k;
  if (u.mode == 0 || s.a <= 0.0) { textureStore(dst, p, s + d * (1.0 - s.a)); return; }
  let cb = straightc(d); let cs = straightc(s);
  textureStore(dst, p, vec4f(s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B(u.mode, cb, cs), s.a + d.a * (1.0 - s.a)));` },

  adjust: { u: [['op', 'u32'], ['h', 'f32'], ['s', 'f32'], ['l', 'f32'], ['amount', 'f32']], tex: ['src', 'lut'], extra: `
fn lut1(x0: f32, ch: i32) -> f32 { let x = clamp(x0, 0.0, 1.0) * 4095.0; let i = i32(floor(x)); let j = min(i + 1, 4095);
  return mix(textureLoad(lut, vec2<i32>(i, 0), 0)[ch], textureLoad(lut, vec2<i32>(j, 0), 0)[ch], x - f32(i)); }
fn rgb2hsl(c: vec3f) -> vec3f { let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b)); let l = (mx + mn) * 0.5; var h = 0.0; var s = 0.0;
  if (mx != mn) { let d = mx - mn; s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
    if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); } else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; } else { h = (c.r - c.g) / d + 4.0; } h /= 6.0; }
  return vec3f(h, s, l); }
fn hue2rgb(p: f32, q: f32, t0: f32) -> f32 { var t = t0; if (t < 0.0) { t += 1.0; } if (t > 1.0) { t -= 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; } if (t < 0.5) { return q; } if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; } return p; }
fn hsl2rgb(h: vec3f) -> vec3f { if (h.y == 0.0) { return vec3f(h.z); } let q = select(h.z + h.y - h.z * h.y, h.z * (1.0 + h.y), h.z < 0.5); let p = 2.0 * h.z - q;
  return vec3f(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0)); }`, body: `
  let c = textureLoad(src, p, 0); var v = straightc(c);
  if (u.op == 0u) { v = vec3f(lut1(v.r, 0), lut1(v.g, 1), lut1(v.b, 2)); }
  else if (u.op == 1u) { var h = rgb2hsl(v); h.x = fract(h.x + u.h + 1.0);
    h.y = select(h.y * (1.0 + u.s), h.y + (1.0 - h.y) * u.s, u.s > 0.0);
    h.z = select(h.z * (1.0 + u.l), h.z + (1.0 - h.z) * u.l, u.l > 0.0); v = hsl2rgb(h); }
  else if (u.op == 2u) { v = vec3f(dot(v, vec3f(0.2126, 0.7152, 0.0722))); }
  else if (u.op == 3u) { let s = vec3f(dot(v, vec3f(0.393, 0.769, 0.189)), dot(v, vec3f(0.349, 0.686, 0.168)), dot(v, vec3f(0.272, 0.534, 0.131))); v = v + (s - v) * u.amount; }
  textureStore(dst, p, vec4f(clamp(v, vec3f(0.0), vec3f(1.0)) * c.a, c.a));` },

  unsharp: { u: [['amount', 'f32'], ['threshold', 'f32']], tex: ['src', 'blr'], body: `
  let s = textureLoad(src, p, 0); let cs = straightc(s); let cb = straightc(textureLoad(blr, p, 0));
  let d = cs - cb; let r = mix(cs, cs + d * u.amount, step(vec3f(u.threshold), abs(d)));
  textureStore(dst, p, vec4f(clamp(r, vec3f(0.0), vec3f(1.0)) * s.a, s.a));` },

  noise: { u: [['amount', 'f32'], ['mono', 'u32'], ['seed', 'u32'], ['offX', 'i32'], ['offY', 'i32']], tex: ['src'], body: `
  let s = textureLoad(src, p, 0); if (s.a <= 0.0) { textureStore(dst, p, s); return; }
  var c = straightc(s); let q = p + vec2<i32>(u.offX, u.offY);
  if (u.mono == 1u) { c += (rnd(q, u.seed) - 0.5) * u.amount; }
  else { c += (vec3f(rnd(q, u.seed * 3u + 1u), rnd(q, u.seed * 3u + 2u), rnd(q, u.seed * 3u + 3u)) - 0.5) * u.amount; }
  textureStore(dst, p, vec4f(clamp(c, vec3f(0.0), vec3f(1.0)) * s.a, s.a));` },

  vignette: { u: [['cx', 'f32'], ['cy', 'f32'], ['inner', 'f32'], ['outer', 'f32'], ['k', 'f32'], ['offX', 'i32'], ['offY', 'i32']], tex: ['src'], body: `
  let s = textureLoad(src, p, 0); var c = straightc(s);
  var t = clamp((length(vec2f(p + vec2<i32>(u.offX, u.offY)) - vec2f(u.cx, u.cy)) - u.inner) / (u.outer - u.inner), 0.0, 1.0); t = t * t * (3.0 - 2.0 * t);
  if (u.k >= 0.0) { c = c * (1.0 - t * u.k); } else { c = c + (1.0 - c) * (-t * u.k); }
  textureStore(dst, p, vec4f(clamp(c, vec3f(0.0), vec3f(1.0)) * s.a, s.a));` },

  screen: { u: [['offX', 'i32'], ['offY', 'i32'], ['dither', 'u32']], tex: ['src'], body: `
  let q = p + vec2<i32>(u.offX, u.offY); var c = clamp(textureLoad(src, q, 0), vec4f(0.0), vec4f(1.0));
  if (u.dither == 1u) { c = vec4f(clamp(c.rgb + (rnd(q, 7u) - rnd(q, 11u)) / 255.0, vec3f(0.0), vec3f(c.a)), c.a); }
  textureStore(dst, p, c);`, srcOffset: true },

  straight: { u: [['dither', 'u32']], tex: ['src'], body: `
  let c = textureLoad(src, p, 0); var v = straightc(c);
  if (u.dither == 1u) { v = clamp(v + (rnd(p, 7u) - rnd(p, 11u)) / 255.0, vec3f(0.0), vec3f(1.0)); }
  textureStore(dst, p, vec4f(v, clamp(c.a, 0.0, 1.0)));` },

  // Brush dabs: soft round stamps (premultiplied colour, Porter-Duff over or erase) into a float layer.
  dabs: { u: [['n', 'u32'], ['r', 'f32'], ['g', 'f32'], ['b', 'f32'], ['erase', 'u32']], tex: ['src'], dabs: true, body: `
  var c = textureLoad(src, p, 0); let pf = vec2f(p) + 0.5;
  for (var i = 0u; i < u.n; i++) {
    let D = dabList[i]; let dist = length(pf - D.xy);
    if (dist >= D.z) { continue; }
    let hard = D.w; let t = dist / D.z;
    let a = select(clamp((1.0 - t) / max(1e-4, 1.0 - hard), 0.0, 1.0), 1.0, t <= hard) * dabAlpha[i];
    if (u.erase == 1u) { c = c * (1.0 - a); } else { c = vec4f(vec3f(u.r, u.g, u.b) * a, a) + c * (1.0 - a); }
  }
  textureStore(dst, p, c);` },
};

function wgslFor(name, fmt) {
  const P = PASSES[name];
  const fields = P.u.map(([n, t]) => `${n}: ${t}`).join(', ');
  const tex = P.tex.map((t, i) => `@group(0) @binding(${i}) var ${t}: texture_2d<f32>;`).join('\n');
  const n = P.tex.length;
  const dabs = P.dabs ? `@group(0) @binding(${n + 2}) var<storage, read> dabList: array<vec4f>;\n@group(0) @binding(${n + 3}) var<storage, read> dabAlpha: array<f32>;` : '';
  return `${COMMON}
struct U { ${fields} };
${tex}
@group(0) @binding(${n}) var dst: texture_storage_2d<${fmt}, write>;
@group(0) @binding(${n + 1}) var<uniform> u: U;
${dabs}
${P.extra || ''}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dsz = vec2<i32>(textureDimensions(dst));
  let p = vec2<i32>(gid.xy);
  if (p.x >= dsz.x || p.y >= dsz.y) { return; }
  ${P.body}
}`;
}

function blurWGSL(fmt) {
  return `
struct U { horiz: u32, w: i32, h: i32, R: i32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${fmt}, write>;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var<storage, read> W: array<f32>;
var<workgroup> tile: array<vec4f, ${256 + 2 * MAXR}>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let horiz = u.horiz == 1u;
  let len = select(u.h, u.w, horiz);
  let line = i32(wg.y);
  let start = i32(wg.x) * 256;
  let R = u.R;
  for (var i = i32(li); i < 256 + 2 * R; i += 256) {
    let a = clamp(start - R + i, 0, len - 1);
    tile[i] = textureLoad(src, select(vec2<i32>(line, a), vec2<i32>(a, line), horiz), 0);
  }
  workgroupBarrier();
  let a = start + i32(li);
  if (a >= len) { return; }
  let c = i32(li) + R;
  var acc = tile[c] * W[0];
  for (var k = 1; k <= R; k++) { acc += (tile[c + k] + tile[c - k]) * W[k]; }
  textureStore(dst, select(vec2<i32>(line, a), vec2<i32>(a, line), horiz), acc);
}`;
}

/**
 * Gather blur for filterable formats: each thread reads its own taps through a linear sampler, two texels
 * per fetch (offsets/weights pre-merged on the CPU), no shared memory or barriers.
 */
function blurLinearWGSL(fmt) {
  return `
struct U { horiz: u32, w: i32, h: i32, N: i32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${fmt}, write>;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var<storage, read> P: array<vec2f>;
@group(0) @binding(4) var smp: sampler;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2<i32>(g.xy); if (p.x >= u.w || p.y >= u.h) { return; }
  let size = vec2f(f32(u.w), f32(u.h)); let uv = (vec2f(p) + 0.5) / size;
  let dir = select(vec2f(0.0, 1.0 / size.y), vec2f(1.0 / size.x, 0.0), u.horiz == 1u);
  var acc = textureLoad(src, p, 0) * P[0].y;
  for (var i = 1; i < u.N; i++) { let o = dir * P[i].x; acc += (textureSampleLevel(src, smp, uv + o, 0.0) + textureSampleLevel(src, smp, uv - o, 0.0)) * P[i].y; }
  textureStore(dst, p, acc);
}`;
}

/** f32 → IEEE half bits (for uploading 16-bit layers as rgba16float). */
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0], sign = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m |= 0x800000; const s = 14 - e; let h = m >> s; if ((m >> (s - 1)) & 1) h++; return sign | h; }
  if (e >= 31) return sign | 0x7c00;
  let h = sign | (e << 10) | (m >> 13); if (m & 0x1000) h++; return h;
}
let halfTable = null;
const halfOf16 = () => { if (!halfTable) { halfTable = new Uint16Array(65536); for (let i = 0; i < 65536; i++) halfTable[i] = toHalf(i / 65535); } return halfTable; };
const gpuError = (code, message) => Object.assign(new Error(message), { code });

export const webgpuAvailable = () => typeof navigator !== 'undefined' && !!navigator.gpu;

/**
 * Create the WebGPU engine (async). Resolves to the engine, or { error } when WebGPU is unavailable.
 * opts: { budgetMB = 2048, tile = 4096, onLost, powerPreference = 'high-performance' }
 */
/**
 * Can a WebGPU canvas be presented and drawn into a 2D canvas here? Uses its own throwaway adapter/device,
 * because a failing presentation path can destroy the device (seen in headless SwiftShader builds).
 */
export async function probeCanvasPresent() {
  if (!webgpuAvailable()) return false;
  try {
    const a = await navigator.gpu.requestAdapter(); if (!a) return false;
    const d = await a.requestDevice(); let gone = false; d.lost.then(() => { gone = true; });
    const cv = document.createElement('canvas'); cv.width = cv.height = 4;
    const cx = cv.getContext('webgpu'); if (!cx) { d.destroy(); return false; }
    cx.configure({ device: d, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT, alphaMode: 'premultiplied' });
    const enc = d.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: cx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 1, b: 0, a: 1 } }] }).end();
    d.queue.submit([enc.finish()]);
    const k = document.createElement('canvas'); k.width = k.height = 4; const kc = k.getContext('2d', { willReadFrequently: true });
    kc.drawImage(cv, 0, 0); const px = kc.getImageData(1, 1, 1, 1).data;
    await Promise.race([d.queue.onSubmittedWorkDone().catch(() => {}), new Promise((r) => setTimeout(r, 100))]);
    await new Promise((r) => setTimeout(r, 30));
    const ok = !gone && px[1] > 200 && px[0] < 50;
    if (!gone) d.destroy();
    return ok;
  } catch { return false; }
}

export async function createWebGPUEngine(opts = {}) {
  if (!webgpuAvailable()) return { error: 'WebGPU is not available in this browser' };
  if (!opts.present) opts = { ...opts, present: (await probeCanvasPresent()) ? 'canvas' : 'readback' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: opts.powerPreference || 'high-performance' }); } catch (e) { return { error: `WebGPU adapter request failed: ${e.message}` }; }
  if (!adapter) return { error: 'no WebGPU adapter' };
  const al = adapter.limits;
  const want = { maxTextureDimension2D: Math.min(al.maxTextureDimension2D, 16384), maxBufferSize: al.maxBufferSize, maxStorageBufferBindingSize: al.maxStorageBufferBindingSize };
  let device;
  try { device = await adapter.requestDevice({ requiredLimits: want }); } catch (e) { return { error: `WebGPU device request failed: ${e.message}` }; }
  const ai = adapter.info || {};
  const renderer = [ai.vendor, ai.architecture, ai.device, ai.description].filter(Boolean).join(' ') || 'WebGPU adapter';
  const maxTex = device.limits.maxTextureDimension2D;
  const tile = Math.min(opts.tile || 4096, maxTex);
  const info = {
    api: 'webgpu', renderer, vendor: ai.vendor || '', maxTextureSize: maxTex, tile, halfFloat: true, float32: true, float32Linear: false,
    software: !!adapter.isFallbackAdapter || /swiftshader|llvmpipe|software|basic render/i.test(renderer), webgpu: true,
    maxBufferMB: Math.round(device.limits.maxBufferSize / 1048576),
  };
  let budget = (opts.budgetMB || 2048) * 1048576, used = 0, lost = false, destroyed = false, deviceError = null;
  const stats = { uploads: 0, passes: 0, composites: 0, ops: 0, evictions: 0, dabs: 0 };
  device.lost.then((i) => { lost = true; if (!destroyed && opts.onLost) opts.onLost(i && i.message); });
  device.addEventListener && device.addEventListener('uncapturederror', (ev) => { deviceError = ev.error; console.warn('WebGPU error', ev.error && ev.error.message); });

  // ---- pipelines ---------------------------------------------------------------------------------
  const pipes = new Map();
  // Blend mode / adjustment op are baked into specialised pipelines (one per value) so the shader has no
  // 16-way branch: much faster on SIMD software rasterisers and cheaper on real GPUs too.
  const SPEC = { layer: [['mode', 'u.mode', 'i'], ['flags', 'u.flags', 'u']], adjust: [['op', 'u.op', 'u']] };
  const specOf = (name, vals) => (SPEC[name] ? SPEC[name].map(([f]) => vals[f] ?? 0).join(',') : null);
  function pipe(name, fmt, specVal = null) {
    const key = `${name}|${fmt}|${specVal ?? ''}`; let p = pipes.get(key); if (p) return p;
    let code = name === 'blur' ? blurWGSL(fmt) : name === 'blurlin' ? blurLinearWGSL(fmt) : wgslFor(name, fmt);
    if (specVal != null && SPEC[name]) {
      const body0 = code.indexOf('fn main'), vals = String(specVal).split(',');
      let body = code.slice(body0);
      SPEC[name].forEach(([, ref, suf], i) => { body = body.split(ref).join(`${vals[i]}${suf}`); });
      code = code.slice(0, body0) + body;
    }
    const module = device.createShaderModule({ code, label: key });
    p = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: key });
    pipes.set(key, p); return p;
  }

  // ---- textures & memory ---------------------------------------------------------------------------
  const USAGE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  function makeTex(w, h, fmt, extra = 0) {
    const usage = USAGE | extra;
    const tex = device.createTexture({ size: [w, h], format: fmt, usage });
    const bytes = w * h * BPP[fmt]; used += bytes;
    return { tex, view: tex.createView(), w, h, fmt, bytes };
  }
  function freeTex(t) { if (!t || !t.tex) return; t.tex.destroy(); used -= t.bytes; t.tex = null; }
  const pool = [];
  function scratch(w, h, fmt) {
    const i = pool.findIndex((t) => !t.busy && t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) { pool[i].busy = true; return pool[i]; }
    room(w * h * BPP[fmt]);
    const t = makeTex(w, h, fmt); t.busy = true; pool.push(t); return t;
  }
  const release = (...ts) => { for (const t of ts) if (t) t.busy = false; };
  function trimPool(keepFmt = null) { for (let i = pool.length - 1; i >= 0; i--) if (!pool[i].busy && pool[i].fmt !== keepFmt) { freeTex(pool[i]); pool.splice(i, 1); } }
  const cache = new Map(); let clock = 0;
  function room(bytes) {
    if (used + bytes <= budget) return;
    for (let i = pool.length - 1; i >= 0 && used + bytes > budget; i--) if (!pool[i].busy) { freeTex(pool[i]); pool.splice(i, 1); }
    const entries = [...cache.entries()].filter(([, e]) => !e.pinned).sort((a, b) => a[1].last - b[1].last);
    for (const [k, e] of entries) { if (used + bytes <= budget) break; freeTex(e.t); cache.delete(k); stats.evictions++; }
    if (used + bytes > budget) throw gpuError('memory', `GPU memory budget exceeded (${Math.round((used + bytes) / 1048576)} MB needed of ${Math.round(budget / 1048576)} MB)`);
  }
  const isImageSource = (s) => (typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== 'undefined' && s instanceof OffscreenCanvas) || (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap);
  function writeTex(t, data, bpp) { device.queue.writeTexture({ texture: t.tex }, data, { bytesPerRow: t.w * bpp, rowsPerImage: t.h }, [t.w, t.h]); stats.uploads++; }
  function uploadCanvas(t, src) {
    if (!src.width || !src.height) return;
    try { device.queue.copyExternalImageToTexture({ source: src }, { texture: t.tex, premultipliedAlpha: true }, [t.w, t.h]); }
    catch (err) {
      // a canvas nobody has drawn on yet (no rendering context) is fully transparent: clear instead of copying
      if (!/rendering context|context/i.test(err.message)) throw err;
      const ce = device.createCommandEncoder(); ce.beginRenderPass({ colorAttachments: [{ view: t.tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
      device.queue.submit([ce.finish()]); // a queue operation, like the copy it replaces
    }
    stats.uploads++;
  }
  function cached(key, slot, src, w, h) {
    let e = cache.get(key);
    if (e) { e.last = ++clock; e.pinned = true; return e.t; }
    for (const [k, o] of cache) if (o.slot === slot) { freeTex(o.t); cache.delete(k); }
    const deep = !!(src && src.data instanceof Uint16Array), fmt = deep ? 'rgba16float' : 'rgba8unorm';
    room(w * h * BPP[fmt]);
    const t = makeTex(Math.max(1, w), Math.max(1, h), fmt);
    if (deep) { const hb = halfOf16(), s = src.data, half = new Uint16Array(s.length); for (let i = 0; i < s.length; i++) half[i] = hb[s[i]]; writeTex(t, half, 8); }
    else if (isImageSource(src)) uploadCanvas(t, src);
    e = { t, slot, last: ++clock, pinned: true, straight: deep }; cache.set(key, e); return t;
  }
  const unpinAll = () => { for (const e of cache.values()) e.pinned = false; };
  const dummy = makeTex(1, 1, 'rgba8unorm');
  const lutCache = new Map();
  function lutTex(op, params) {
    const key = op + JSON.stringify(params || {}); let t = lutCache.get(key); if (t) return t;
    const fns = pointFns(op, params || {}); if (!fns) throw gpuError('unsupported', op);
    const data = new Float32Array(4096 * 4);
    for (let i = 0; i < 4096; i++) { const x = (i / 4095) * 255; data[i * 4] = fns[0](x) / 255; data[i * 4 + 1] = fns[1](x) / 255; data[i * 4 + 2] = fns[2](x) / 255; data[i * 4 + 3] = 1; }
    if (lutCache.size >= 24) { const [k, old] = lutCache.entries().next().value; freeTex(old); lutCache.delete(k); }
    t = makeTex(4096, 1, 'rgba32float'); writeTex(t, data, 16); lutCache.set(key, t); return t;
  }

  // ---- command recording ---------------------------------------------------------------------------
  let enc = null; const garbage = [];
  const encoder = () => (enc || (enc = device.createCommandEncoder()));
  function submit() { if (!enc) return; device.queue.submit([enc.finish()]); enc = null; for (const b of garbage.splice(0)) b.destroy(); }
  function uniformBuf(spec, vals) {
    const n = Math.max(4, Math.ceil(spec.length / 4) * 4), buf = new ArrayBuffer(n * 4), dv = new DataView(buf);
    spec.forEach(([k, t], i) => { const v = vals[k] ?? 0; if (t === 'f32') dv.setFloat32(i * 4, v, true); else if (t === 'i32') dv.setInt32(i * 4, v | 0, true); else dv.setUint32(i * 4, (typeof v === 'boolean' ? (v ? 1 : 0) : v) >>> 0, true); });
    const b = device.createBuffer({ size: buf.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, buf); garbage.push(b); return b;
  }
  function storageBuf(arr) {
    const b = device.createBuffer({ size: Math.max(16, arr.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, arr); garbage.push(b); return b;
  }
  /** One per-pixel compute pass: textures (by name) → dst (texture or canvas texture view). */
  function run(name, dst, texs, vals = {}, extra = []) {
    const P = PASSES[name], fmt = dst.fmt;
    const p = pipe(name, fmt, specOf(name, vals));
    const entries = P.tex.map((tn, i) => ({ binding: i, resource: (texs[tn] || dummy).view }));
    entries.push({ binding: P.tex.length, resource: dst.view }, { binding: P.tex.length + 1, resource: { buffer: uniformBuf(P.u, vals) } });
    extra.forEach((b, i) => entries.push({ binding: P.tex.length + 2 + i, resource: { buffer: b } }));
    const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
    const pass = encoder().beginComputePass(); pass.setPipeline(p); pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(dst.w / 16), Math.ceil(dst.h / 16)); pass.end(); stats.passes++;
  }
  const weightCache = new Map(), pairCache = new Map();
  const linSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  // 'linear' = gather with bilinear tap pairs (default; fastest on software adapters and fine on GPUs),
  // 'shared' = workgroup-shared-memory line blur (opts.blur = 'shared'); 32-bit float (16-bit docs) always
  // uses 'shared' because rgba32float is not filterable without an optional feature.
  const blurMode = opts.blur || 'linear';
  function blurPass(src, dst, horiz, sigma) {
    const R = Math.min(MAXR, Math.ceil(sigma * 3));
    if (blurMode === 'linear' && src.fmt !== 'rgba32float') {
      let pb = pairCache.get(sigma);
      if (!pb) {
        const w = new Float64Array(R + 2); let tot = 0;
        for (let i = 0; i <= R; i++) { w[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); tot += i ? 2 * w[i] : w[i]; }
        const pairs = [[0, w[0] / tot]];
        for (let i = 1; i <= R; i += 2) { const a = w[i] / tot, b = (i + 1 <= R ? w[i + 1] : 0) / tot, ww = a + b; pairs.push([ww > 0 ? (i * a + (i + 1) * b) / ww : i, ww]); }
        const f = new Float32Array(pairs.flat());
        pb = { buf: device.createBuffer({ size: Math.max(16, f.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }), n: pairs.length };
        device.queue.writeBuffer(pb.buf, 0, f);
        if (pairCache.size > 16) { const [k, b] = pairCache.entries().next().value; b.buf.destroy(); pairCache.delete(k); }
        pairCache.set(sigma, pb);
      }
      const p = pipe('blurlin', dst.fmt);
      const ub = uniformBuf([['horiz', 'u32'], ['w', 'i32'], ['h', 'i32'], ['N', 'i32']], { horiz: horiz ? 1 : 0, w: src.w, h: src.h, N: pb.n });
      const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: src.view }, { binding: 1, resource: dst.view }, { binding: 2, resource: { buffer: ub } }, { binding: 3, resource: { buffer: pb.buf } }, { binding: 4, resource: linSampler }] });
      const pass = encoder().beginComputePass(); pass.setPipeline(p); pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(src.w / 16), Math.ceil(src.h / 16)); pass.end(); stats.passes += 1;
      return;
    }
    let wb = weightCache.get(sigma);
    if (!wb) {
      const w = new Float32Array(R + 1); let tot = 0;
      for (let i = 0; i <= R; i++) { w[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); tot += i ? 2 * w[i] : w[i]; }
      for (let i = 0; i <= R; i++) w[i] /= tot;
      wb = device.createBuffer({ size: Math.max(16, w.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(wb, 0, w);
      if (weightCache.size > 16) { const [k, b] = weightCache.entries().next().value; b.destroy(); weightCache.delete(k); }
      weightCache.set(sigma, wb);
    }
    const p = pipe('blur', dst.fmt);
    const ub = uniformBuf([['horiz', 'u32'], ['w', 'i32'], ['h', 'i32'], ['R', 'i32']], { horiz: horiz ? 1 : 0, w: src.w, h: src.h, R });
    const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: src.view }, { binding: 1, resource: dst.view }, { binding: 2, resource: { buffer: ub } }, { binding: 3, resource: { buffer: wb } }] });
    const pass = encoder().beginComputePass(); pass.setPipeline(p); pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil((horiz ? src.w : src.h) / 256), horiz ? src.h : src.w); pass.end(); stats.passes += 1;
  }
  function applyOp(a, name, params = {}, info2 = {}) {
    const { w, h, fmt } = a; const out = () => scratch(w, h, fmt);
    let r;
    if (ADJ_POINT.has(name)) {
      r = out();
      if (name === 'hueSaturation') run('adjust', r, { src: a }, { op: 1, h: (params.hue || 0) / 360, s: (params.saturation || 0) / 100, l: (params.lightness || 0) / 100 });
      else if (name === 'grayscale') run('adjust', r, { src: a }, { op: 2 });
      else if (name === 'sepia') run('adjust', r, { src: a }, { op: 3, amount: (params.amount ?? 100) / 100 });
      else run('adjust', r, { src: a, lut: lutTex(name, params) }, { op: 0 });
    } else if (name === 'gaussianBlur' || name === 'sharpen') {
      const sigma = name === 'gaussianBlur' ? params.radius || 0 : params.radius ?? 1.5;
      if (sigma <= 0) return a;
      const t = out(); blurPass(a, t, true, sigma);
      const b = out(); blurPass(t, b, false, sigma); release(t);
      if (name === 'gaussianBlur') r = b;
      else { r = out(); run('unsharp', r, { src: a, blr: b }, { amount: (params.amount ?? 80) / 100, threshold: (params.threshold || 0) / 255 }); release(b); }
    } else if (name === 'noise') {
      r = out(); run('noise', r, { src: a }, { amount: ((params.amount ?? 20) * 2.55) / 255, mono: params.monochrome !== false ? 1 : 0, seed: params.seed || 1, offX: info2.offX || 0, offY: info2.offY || 0 });
    } else if (name === 'vignette') {
      const W = info2.docW || w, H = info2.docH || h, cx = W / 2, cy = H / 2, maxR = Math.hypot(cx, cy), inner = ((params.size ?? 60) / 100) * maxR;
      r = out(); run('vignette', r, { src: a }, { cx, cy, inner, outer: inner + Math.max(1, ((params.feather ?? 50) / 100) * maxR), k: (params.amount ?? 50) / 100, offX: info2.offX || 0, offY: info2.offY || 0 });
    } else throw gpuError('unsupported', `WebGPU has no ${name}`);
    release(a); stats.ops++;
    return r;
  }

  // ---- output ----------------------------------------------------------------------------------------
  // Two ways to get pixels out: draw a WebGPU canvas into the 2D context (synchronous, the normal path on
  // real Chrome/Edge), or copy to a mapped buffer and putImageData (asynchronous; used where WebGPU canvas
  // presentation is unavailable, e.g. headless SwiftShader). `present` is decided by probeCanvasPresent().
  const present = opts.present || 'readback';
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const cctx = present === 'canvas' ? canvas.getContext('webgpu') : null;
  if (present === 'canvas' && !cctx) { device.destroy(); return { error: 'WebGPU canvas context unavailable' }; }
  let configured = '';
  const SCREEN_WGSL = `${COMMON}
struct U { offX: i32, offY: i32, dither: u32, pad: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let q = vec2<i32>(fc.xy) + vec2<i32>(u.offX, u.offY); var c = clamp(textureLoad(src, q, 0), vec4f(0.0), vec4f(1.0));
  if (u.dither == 1u) { c = vec4f(clamp(c.rgb + (rnd(q, 7u) - rnd(q, 11u)) / 255.0, vec3f(0.0), vec3f(c.a)), c.a); }
  return c + f32(u.pad) * 0.0; }`;
  let screenPipe = null;
  function screenPass(t, view, ox, oy, dither) {
    if (!screenPipe) { const module = device.createShaderModule({ code: SCREEN_WGSL, label: 'screen' }); screenPipe = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } }); }
    const ub = uniformBuf([['offX', 'i32'], ['offY', 'i32'], ['dither', 'u32'], ['pad', 'u32']], { offX: ox, offY: oy, dither: dither ? 1 : 0 });
    const bg = device.createBindGroup({ layout: screenPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.view }, { binding: 1, resource: { buffer: ub } }] });
    const rp = encoder().beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    rp.setPipeline(screenPipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end(); stats.passes++;
  }
  function screenTarget(w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; configured = ''; }
    if (!configured) { cctx.configure({ device, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, alphaMode: 'premultiplied' }); configured = 'y'; }
    const tex = cctx.getCurrentTexture();
    return { tex, view: tex.createView(), w, h, fmt: 'rgba8unorm' };
  }
  /** Draw float texture `t` into a 2D context at (ox, oy), tile by tile (synchronous for the caller). */
  function toContext(t, ctx, ox = 0, oy = 0, dither = false) {
    const W = t.w, H = t.h, cw = Math.min(W, tile), ch = Math.min(H, tile);
    for (let ty = 0; ty < H; ty += tile) for (let tx = 0; tx < W; tx += tile) {
      const tw = Math.min(tile, W - tx), th = Math.min(tile, H - ty);
      const target = screenTarget(cw, ch);
      screenPass(t, target.view, tx, ty, dither);
      submit();
      ctx.clearRect(ox + tx, oy + ty, tw, th);
      ctx.drawImage(canvas, 0, 0, tw, th, ox + tx, oy + ty, tw, th);
    }
  }
  /** Asynchronous output: straight 8-bit readback + putImageData at (ox, oy). */
  async function toContextAsync(t, ctx, ox = 0, oy = 0, dither = false) {
    const o = scratch(t.w, t.h, 'rgba8unorm');
    try {
      run('straight', o, { src: t }, { dither: dither ? 1 : 0 });
      const bytes = await readback(o);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer), t.w, t.h), ox, oy);
    } finally { release(o); }
  }
  const needSync = () => { if (present !== 'canvas') throw gpuError('unsupported', 'synchronous WebGPU output is unavailable here (use the async methods)'); };
  async function readback(t) {
    const bpp = BPP[t.fmt], bpr = Math.ceil((t.w * bpp) / 256) * 256;
    const buf = device.createBuffer({ size: bpr * t.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder().copyTextureToBuffer({ texture: t.tex }, { buffer: buf, bytesPerRow: bpr }, [t.w, t.h]); submit();
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), row = t.w * bpp, out = new Uint8Array(row * t.h);
    if (bpr === row) out.set(src.subarray(0, out.length)); else for (let y = 0; y < t.h; y++) out.set(src.subarray(y * bpr, y * bpr + row), y * row);
    buf.unmap(); buf.destroy();
    return out;
  }
  const checkSize = (w, h) => {
    if (lost) throw gpuError('lost', 'WebGPU device lost');
    if (w > maxTex || h > maxTex) throw gpuError('too-large', `${w}×${h} exceeds the GPU texture limit (${maxTex}px)`);
  };
  const fits = (bytes) => used + bytes <= budget || bytes <= budget * 0.9;
  const accumFormat = (W, H) => (fits(W * H * 8 * 3 + W * H * 4) ? 'rgba16f' : fits(W * H * 4 * 4) ? 'rgba8' : null);
  const FMTMAP = { rgba16f: 'rgba16float', rgba8: 'rgba8unorm' };

  function compositeTex(layers, W, H, background = null) {
      checkSize(W, H);
      const af = accumFormat(W, H); if (!af) throw gpuError('memory', 'Not enough GPU memory for this canvas');
      const fmt = FMTMAP[af];
      unpinAll();
      let A = scratch(W, H, fmt), Bt = scratch(W, H, fmt);
      try {
        // clear A to the background colour (or transparent) with a render pass
        const bg = background ? { r: background[0] / 255, g: background[1] / 255, b: background[2] / 255, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
        encoder().beginRenderPass({ colorAttachments: [{ view: A.view, loadOp: 'clear', storeOp: 'store', clearValue: bg }] }).end();
        for (const L of layers) {
          if (L.opacity <= 0) continue;
          const m = L.mask ? cached(L.mask.key, L.mask.slot, L.mask.canvas, L.mask.canvas.width, L.mask.canvas.height) : null;
          const mu = m ? { mx: L.mask.x, my: L.mask.y, mw: m.w, mh: m.h } : { mw: 1, mh: 1 };
          let flags = m ? 1 : 0;
          if (L.kind === 'adjust') {
            const C = scratch(W, H, fmt); run('prep', C, { src: A }, { straightIn: 0 });
            const adj = applyOp(C, L.op, L.params, { docW: W, docH: H });
            run('layer', Bt, { base: A, src: adj, mask: m }, { offX: 0, offY: 0, sw: W, sh: H, opacity: L.opacity, mode: L.mode, flags: flags | (L.mode === 0 ? 4 : 0), ...mu });
            release(adj);
          } else {
            const t = cached(L.key, L.slot, L.src, L.w, L.h);
            if (t.fmt === 'rgba16float') flags |= 2;
            run('layer', Bt, { base: A, src: t, mask: m }, { offX: L.x, offY: L.y, sw: L.w, sh: L.h, opacity: L.opacity, mode: L.mode, flags, ...mu });
          }
          const s = A; A = Bt; Bt = s;
        }
        const res = A; A = null;
        return { A: res, af };
      } catch (err) { release(A); throw err; } finally { release(Bt); }
  }
  async function filterAsyncOut(a, c) { await toContextAsync(a, c.getContext('2d')); return c; }
  function filterCore(src, chain, info2, async) {
      const w = src.width, h = src.height; checkSize(w, h);
      if (!chain.every((f) => GPU_OPS.has(f.name))) throw gpuError('unsupported', 'filter not on GPU');
      const s8 = scratch(w, h, 'rgba8unorm'); uploadCanvas(s8, src);
      let a = scratch(w, h, 'rgba16float'); run('prep', a, { src: s8 }, { straightIn: 0 }); release(s8);
      try {
        for (const f of chain) a = applyOp(a, f.name, f.params, info2);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        if (!async) { toContext(a, c.getContext('2d')); release(a); return c; }
        const keep = a; a = null; return filterAsyncOut(keep, c).finally(() => release(keep));
      } catch (err) { release(a); throw err; }
  }
    /**
     * Stamp brush dabs onto a canvas region on the GPU and draw the result back (used for large brushes).
     * dabs: Float32Array [x, y, radius, hardness]*n (canvas pixel coords), alphas: Float32Array n.
     * Returns the number of dabs drawn.
     */
  function dabsCore(target, rect, dabs, alphas, { color = [0, 0, 0], erase = false } = {}, async = false) {
      const { x, y, w, h } = rect; checkSize(w, h);
      const n = alphas.length; if (!n) return async ? Promise.resolve(0) : 0;
      const ctx = target.getContext('2d');
      const s8 = scratch(w, h, 'rgba8unorm');
      // copy the region of the target into a texture (premultiplied)
      device.queue.copyExternalImageToTexture({ source: target, origin: [x, y] }, { texture: s8.tex, premultipliedAlpha: true }, [w, h]);
      let a = scratch(w, h, 'rgba16float'); run('prep', a, { src: s8 }, { straightIn: 0 }); release(s8);
      const local = new Float32Array(dabs); for (let i = 0; i < n; i++) { local[i * 4] -= x; local[i * 4 + 1] -= y; }
      const b = scratch(w, h, 'rgba16float');
      run('dabs', b, { src: a }, { n, r: color[0] / 255, g: color[1] / 255, b: color[2] / 255, erase: erase ? 1 : 0 }, [storageBuf(local), storageBuf(new Float32Array(alphas))]);
      release(a);
      stats.dabs += n;
      if (!async) { try { toContext(b, ctx, x, y); } finally { release(b); } return n; }
      return toContextAsync(b, ctx, x, y).then(() => n).finally(() => release(b));
  }
  const engine = {
    kind: 'webgpu', info, stats, canvas, device,
    get lost() { return lost; },
    get usedMB() { return used / 1048576; },
    get budgetMB() { return budget / 1048576; },
    get lastError() { return deviceError; },
    setBudget(mb) { budget = mb * 1048576; trimPool(); },
    accumFormat,
    supports(name, w, h) { return !lost && GPU_OPS.has(name) && w <= maxTex && h <= maxTex && fits(w * h * (4 + 8 * 4)); },
    supportsDeep(name, w, h, info2 = {}) { return !lost && GPU_OPS.has(name) && !info2.linear && w <= maxTex && h <= maxTex && fits(w * h * 16 * 4); },
    canComposite(layers, W, H) {
      if (lost || W > maxTex || H > maxTex || !accumFormat(W, H)) return false;
      return layers.every((L) => L.kind !== 'adjust' || ADJ_POINT.has(L.op));
    },
    /** Same contract as the WebGL2 engine's composite(); returns 'rgba16f' or 'rgba8'. */
    composite(layers, W, H, ctx, o = {}) {
      needSync();
      const { A, af } = compositeTex(layers, W, H, o.background);
      try { toContext(A, ctx, 0, 0, !!o.dither); stats.composites++; return af; } finally { release(A); }
    },
    /** Same as composite() but resolves when the pixels are in ctx (works with either output path). */
    async compositeAsync(layers, W, H, ctx, o = {}) {
      const { A, af } = compositeTex(layers, W, H, o.background);
      try { if (present === 'canvas') toContext(A, ctx, 0, 0, !!o.dither); else await toContextAsync(A, ctx, 0, 0, !!o.dither); stats.composites++; return af; } finally { release(A); }
    },
    get syncOutput() { return present === 'canvas'; },
    present,
    filterCanvas(src, chain, info2 = {}) { needSync(); return filterCore(src, chain, info2, false); },
    filterCanvasAsync(src, chain, info2 = {}) { return filterCore(src, chain, info2, true); },
    stampDabs(target, rect, dabs, alphas, o = {}) { needSync(); return dabsCore(target, rect, dabs, alphas, o, false); },
    stampDabsAsync(target, rect, dabs, alphas, o = {}) { return dabsCore(target, rect, dabs, alphas, o, true); },
    /** One op on straight 8-bit ImageData; resolves to a new ImageData. */
    async processImageData(name, img, params = {}, info2 = {}) {
      const { width: w, height: h } = img; checkSize(w, h);
      const s8 = scratch(w, h, 'rgba8unorm'); writeTex(s8, img.data, 4);
      let a = scratch(w, h, 'rgba16float'); run('prep', a, { src: s8 }, { straightIn: 1 }); release(s8);
      let o = null;
      try {
        a = applyOp(a, name, params, info2);
        o = scratch(w, h, 'rgba8unorm'); run('straight', o, { src: a });
        const bytes = await readback(o);
        return new ImageData(new Uint8ClampedArray(bytes.buffer), w, h);
      } finally { release(a, o); }
    },
    /** One op on a 16-bit DImage at float32 precision; resolves to a new DImage. */
    async processDeep(name, d, params = {}, info2 = {}) {
      const { width: w, height: h } = d; checkSize(w, h);
      const f = new Float32Array(d.data.length); for (let i = 0; i < f.length; i++) f[i] = d.data[i] / 65535;
      const s = scratch(w, h, 'rgba32float'); writeTex(s, f, 16);
      let a = scratch(w, h, 'rgba32float'); run('prep', a, { src: s }, { straightIn: 1 }); release(s);
      let o = null;
      try {
        a = applyOp(a, name, params, info2);
        o = scratch(w, h, 'rgba32float'); run('straight', o, { src: a });
        const r = new Float32Array((await readback(o)).buffer), out = new Uint16Array(r.length);
        for (let i = 0; i < r.length; i++) { const v = Math.round(r[i] * 65535); out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v; }
        return { width: w, height: h, data: out };
      } finally { release(a, o); trimPool('rgba16float'); }
    },
    flush() { for (const e of cache.values()) freeTex(e.t); cache.clear(); trimPool(); },
    async finish() { submit(); await device.queue.onSubmittedWorkDone(); },
    destroy() { destroyed = true; try { engine.flush(); for (const t of lutCache.values()) freeTex(t); lutCache.clear(); device.destroy(); } catch { /* gone */ } },
  };
  // compile the hot pipelines up front
  try { pipe('prep', 'rgba16float'); pipe('layer', 'rgba16float', '0,0'); pipe('blur', 'rgba16float'); } catch (e) { device.destroy(); return { error: `WebGPU shader compile failed: ${e.message}` }; }
  return engine;
}
