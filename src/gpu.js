// WebGL2 rendering engine: layer compositing (16 blend modes, masks, adjustment layers) and filters
// (separable Gaussian blur, unsharp mask, noise, vignette, LUT point ops, HSL, greyscale, sepia) on the GPU.
// Accumulation happens in half-float (RGBA16F) textures in premultiplied sRGB, mirroring the CPU path's
// maths so both engines agree within a couple of levels. Large documents are drawn out in tiles; textures
// are cached per layer revision under a memory budget (LRU). Anything unsupported throws, and the caller
// falls back to the CPU path.
import { pointFns } from './pixels.js';

const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
uint ihash(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float rnd(ivec2 p, uint s) { return float(ihash(uint(p.x) * 0x9e3779b1u ^ ihash(uint(p.y) ^ (s * 0x85ebca77u)))) / 4294967296.0; }
vec3 straight(vec4 c) { return c.a > 0.0 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0); }
`;

const FS = {
  prep: `uniform sampler2D uSrc; uniform bool uStraight;
void main() { vec4 c = clamp(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0), 0.0, 1.0); o = uStraight ? vec4(c.rgb * c.a, c.a) : c; }`,

  layer: `uniform sampler2D uDst, uSrc, uMask; uniform bool uHasMask, uStraight, uLerp;
uniform ivec2 uOff, uSize, uMaskOff, uMaskSize; uniform float uOpacity; uniform int uMode;
float lumf(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) { float l = lumf(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / (l - n); if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l); return c; }
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lumf(c))); }
float satf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) { float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)); return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0); }
vec3 softD(vec3 b) { return mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25))); }
vec3 B(int m, vec3 b, vec3 s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return mix(1.0 - 2.0 * (1.0 - b) * (1.0 - s), 2.0 * b * s, step(b, vec3(0.5)));
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) { vec3 r = min(vec3(1.0), b / max(1.0 - s, vec3(1e-6))); r = mix(r, vec3(1.0), step(1.0, s)); return mix(r, vec3(0.0), step(b, vec3(0.0))); }
  if (m == 7) { vec3 r = 1.0 - min(vec3(1.0), (1.0 - b) / max(s, vec3(1e-6))); r = mix(r, vec3(0.0), step(s, vec3(0.0))); return mix(r, vec3(1.0), step(1.0, b)); }
  if (m == 8) return mix(b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0), b * 2.0 * s, step(s, vec3(0.5)));
  if (m == 9) return mix(b + (2.0 * s - 1.0) * (softD(b) - b), b - (1.0 - 2.0 * s) * b * (1.0 - b), step(s, vec3(0.5)));
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  if (m == 12) return setLum(setSat(s, satf(b)), lumf(b));
  if (m == 13) return setLum(setSat(b, satf(s)), lumf(b));
  if (m == 14) return setLum(s, lumf(b));
  if (m == 15) return setLum(b, lumf(s));
  return s;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDst, p, 0);
  ivec2 q = p - uOff; vec4 s = vec4(0.0);
  if (q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y) { s = clamp(texelFetch(uSrc, q, 0), 0.0, 1.0); if (uStraight) s.rgb *= s.a; }
  float k = uOpacity;
  if (uHasMask) { ivec2 m = p - uMaskOff; k *= (m.x >= 0 && m.y >= 0 && m.x < uMaskSize.x && m.y < uMaskSize.y) ? texelFetch(uMask, m, 0).a : 0.0; }
  if (uLerp) { o = d * (1.0 - k) + s * k; return; }
  s *= k;
  if (uMode == 0 || s.a <= 0.0) { o = s + d * (1.0 - s.a); return; }
  vec3 cb = straight(d), cs = straight(s);
  o = vec4(s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B(uMode, cb, cs), s.a + d.a * (1.0 - s.a));
}`,

  adjust: `uniform sampler2D uSrc, uLut; uniform int uOp; uniform vec3 uHsl; uniform float uAmount;
uniform sampler2D uCube; uniform int uCubeN; uniform vec3 uDmin, uDmax;
vec3 cubeAt(ivec3 q) { return texelFetch(uCube, ivec2(q.x + q.z * uCubeN, q.y), 0).rgb; }
vec3 cube3(vec3 v) { vec3 t = clamp((v - uDmin) / (uDmax - uDmin), 0.0, 1.0) * float(uCubeN - 1);
  ivec3 i = min(ivec3(floor(t)), ivec3(uCubeN - 2)); vec3 f = t - vec3(i);
  vec3 c00 = mix(cubeAt(i), cubeAt(i + ivec3(1, 0, 0)), f.x), c10 = mix(cubeAt(i + ivec3(0, 1, 0)), cubeAt(i + ivec3(1, 1, 0)), f.x);
  vec3 c01 = mix(cubeAt(i + ivec3(0, 0, 1)), cubeAt(i + ivec3(1, 0, 1)), f.x), c11 = mix(cubeAt(i + ivec3(0, 1, 1)), cubeAt(i + ivec3(1, 1, 1)), f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z); }
float lut1(float x, int ch) { x = clamp(x, 0.0, 1.0) * 4095.0; int i = int(floor(x)); int j = min(i + 1, 4095);
  return mix(texelFetch(uLut, ivec2(i, 0), 0)[ch], texelFetch(uLut, ivec2(j, 0), 0)[ch], x - float(i)); }
vec3 rgb2hsl(vec3 c) { float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), l = (mx + mn) * 0.5, h = 0.0, s = 0.0;
  if (mx != mn) { float d = mx - mn; s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0; h /= 6.0; }
  return vec3(h, s, l); }
float hue2rgb(float p, float q, float t) { if (t < 0.0) t += 1.0; if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t; if (t < 0.5) return q; if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0; return p; }
vec3 hsl2rgb(vec3 h) { if (h.y == 0.0) return vec3(h.z); float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y, p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0)); }
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); vec3 v = straight(c);
  if (uOp == 0) v = vec3(lut1(v.r, 0), lut1(v.g, 1), lut1(v.b, 2));
  else if (uOp == 1) { vec3 h = rgb2hsl(v); h.x = mod(h.x + uHsl.x + 1.0, 1.0);
    h.y = uHsl.y > 0.0 ? h.y + (1.0 - h.y) * uHsl.y : h.y * (1.0 + uHsl.y);
    h.z = uHsl.z > 0.0 ? h.z + (1.0 - h.z) * uHsl.z : h.z * (1.0 + uHsl.z); v = hsl2rgb(h); }
  else if (uOp == 2) v = vec3(dot(v, vec3(0.2126, 0.7152, 0.0722)));
  else if (uOp == 3) { vec3 s = vec3(dot(v, vec3(0.393, 0.769, 0.189)), dot(v, vec3(0.349, 0.686, 0.168)), dot(v, vec3(0.272, 0.534, 0.131))); v = v + (s - v) * uAmount; }
  else if (uOp == 4) v = mix(v, cube3(clamp(v, 0.0, 1.0)), uAmount);
  o = vec4(clamp(v, 0.0, 1.0) * c.a, c.a);
}`,

  // Separable Gaussian (sigma = radius, taps out to 3 sigma). With linear filtering, pairs of taps are
  // fetched with one bilinear sample placed between them (half the fetches); clamp-to-edge borders.
  blur: `uniform sampler2D uSrc; uniform ivec2 uDir, uSize; uniform float uSigma; uniform bool uLinear;
float g(float i) { return exp(-(i * i) / (2.0 * uSigma * uSigma)); }
void main() {
  int R = int(ceil(uSigma * 3.0));
  vec2 inv = 1.0 / vec2(uSize), p = gl_FragCoord.xy, dir = vec2(uDir);
  vec4 acc; float total;
  if (uLinear) {
    acc = texture(uSrc, p * inv); total = 1.0;
    for (int i = 1; i <= R; i += 2) {
      float a = g(float(i)), b = i + 1 <= R ? g(float(i + 1)) : 0.0, w = a + b, off = (float(i) * a + float(i + 1) * b) / w;
      acc += (texture(uSrc, (p + dir * off) * inv) + texture(uSrc, (p - dir * off) * inv)) * w; total += 2.0 * w;
    }
  } else {
    ivec2 ip = ivec2(p); acc = texelFetch(uSrc, ip, 0); total = 1.0;
    for (int i = 1; i <= R; i++) {
      float w = g(float(i));
      acc += (texelFetch(uSrc, clamp(ip + uDir * i, ivec2(0), uSize - 1), 0) + texelFetch(uSrc, clamp(ip - uDir * i, ivec2(0), uSize - 1), 0)) * w; total += 2.0 * w;
    }
  }
  o = acc / total;
}`,

  unsharp: `uniform sampler2D uSrc, uBlur; uniform float uAmount, uThreshold;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec4 s = texelFetch(uSrc, p, 0); vec3 cs = straight(s), cb = straight(texelFetch(uBlur, p, 0));
  vec3 d = cs - cb; vec3 r = mix(cs, cs + d * uAmount, step(vec3(uThreshold), abs(d))); o = vec4(clamp(r, 0.0, 1.0) * s.a, s.a); }`,

  noise: `uniform sampler2D uSrc; uniform float uAmount; uniform bool uMono; uniform uint uSeed; uniform ivec2 uOff;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec4 s = texelFetch(uSrc, p, 0); if (s.a <= 0.0) { o = s; return; }
  vec3 c = straight(s); ivec2 q = p + uOff;
  if (uMono) c += (rnd(q, uSeed) - 0.5) * uAmount;
  else c += (vec3(rnd(q, uSeed * 3u + 1u), rnd(q, uSeed * 3u + 2u), rnd(q, uSeed * 3u + 3u)) - 0.5) * uAmount;
  o = vec4(clamp(c, 0.0, 1.0) * s.a, s.a); }`,

  vignette: `uniform sampler2D uSrc; uniform vec2 uCenter; uniform float uInner, uOuter, uK; uniform ivec2 uOff;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); vec4 s = texelFetch(uSrc, p, 0); vec3 c = straight(s);
  float t = clamp((length(vec2(p + uOff) - uCenter) - uInner) / (uOuter - uInner), 0.0, 1.0); t = t * t * (3.0 - 2.0 * t);
  c = uK >= 0.0 ? c * (1.0 - t * uK) : c + (1.0 - c) * (-t * uK); o = vec4(clamp(c, 0.0, 1.0) * s.a, s.a); }`,

  // Final pass to the on-screen canvas: flip rows for drawImage, optional dither (for 16-bit documents).
  screen: `uniform sampler2D uSrc; uniform ivec2 uOff; uniform int uH; uniform bool uDither;
void main() { ivec2 f = ivec2(gl_FragCoord.xy); ivec2 p = ivec2(f.x, uH - 1 - f.y) + uOff; vec4 c = clamp(texelFetch(uSrc, p, 0), 0.0, 1.0);
  if (uDither) c.rgb = clamp(c.rgb + (rnd(p, 7u) - rnd(p, 11u)) / 255.0, vec3(0.0), vec3(c.a));
  o = c; }`,

  straight: `uniform sampler2D uSrc;
void main() { vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); o = vec4(straight(c), clamp(c.a, 0.0, 1.0)); }`,
};

export const GPU_OPS = new Set(['brightnessContrast', 'exposure', 'levels', 'invert', 'curves', 'hueSaturation', 'grayscale', 'sepia', 'gaussianBlur', 'sharpen', 'noise', 'vignette', 'whiteBalance', 'lut3d']);
const ADJ_POINT = new Set(['brightnessContrast', 'exposure', 'levels', 'invert', 'curves', 'hueSaturation', 'grayscale', 'sepia', 'whiteBalance', 'lut3d']);
const MARKERS = new Set(['groupBegin', 'groupEnd', 'passBegin', 'passEnd']);
const BPP = { rgba8: 4, rgba16f: 8, rgba32f: 16 };

// float -> IEEE half bits
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v; const x = u32[0], sign = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m |= 0x800000; const s = 14 - e; let h = m >> s; if ((m >> (s - 1)) & 1) h++; return sign | h; }
  if (e >= 31) return sign | 0x7c00;
  let h = sign | (e << 10) | (m >> 13); if (m & 0x1000) h++; return h;
}
let halfTable = null;
const halfOf16 = () => { if (!halfTable) { halfTable = new Uint16Array(65536); for (let i = 0; i < 65536; i++) halfTable[i] = toHalf(i / 65535); } return halfTable; };

export function gpuError(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * Create the engine. Returns the engine object, or { error } when WebGL2 / half-float rendering is unavailable.
 * opts: { budgetMB = 1024, tile = 4096, onLost }
 */
export function createEngine(opts = {}) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  let gl = null;
  try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }); } catch { gl = null; }
  if (!gl) return { error: 'WebGL2 is not available' };
  const extF = gl.getExtension('EXT_color_buffer_float'), extH = extF ? null : gl.getExtension('EXT_color_buffer_half_float');
  const linear32 = !!gl.getExtension('OES_texture_float_linear');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE), maxVP = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  const FMT = { rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE], rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT], rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT] };
  const renderable = (fmt) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, FMT[fmt][0], 4, 4);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(f); gl.deleteTexture(t); return ok;
  };
  const can16 = !!(extF || extH) && renderable('rgba16f'), can32 = !!extF && renderable('rgba32f');
  if (!can16) return { error: 'half-float render targets are not supported', renderer };
  const tile = Math.min(opts.tile || 4096, maxTex, maxVP[0], maxVP[1]);
  const info = {
    renderer, vendor, maxTextureSize: maxTex, tile, halfFloat: can16, float32: can32, float32Linear: linear32,
    software: /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer),
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
  };
  let budget = (opts.budgetMB || 1024) * 1048576, used = 0, lost = false;
  const stats = { uploads: 0, passes: 0, composites: 0, ops: 0, evictions: 0 };
  let destroyed = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; if (!destroyed && opts.onLost) opts.onLost(); });

  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const vao = gl.createVertexArray();
  const programs = {};
  function program(name) {
    if (programs[name]) return programs[name];
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gpuError('shader', `${name}: ${gl.getShaderInfoLog(s)}`); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + FS[name])); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw gpuError('shader', `${name}: ${gl.getProgramInfoLog(p)}`);
    const uni = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); let unit = 0;
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); uni[u.name] = { loc: gl.getUniformLocation(p, u.name), type: u.type, unit: u.type === gl.SAMPLER_2D ? unit++ : -1 }; }
    return (programs[name] = { p, uni });
  }

  // ---- textures --------------------------------------------------------------------------------
  function makeTex(w, h, fmt) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, FMT[fmt][0], w, h);
    const filt = fmt === 'rgba32f' && !linear32 ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const bytes = w * h * BPP[fmt]; used += bytes;
    return { tex: t, w, h, fmt, bytes, fbo: null };
  }
  function freeTex(t) { if (!t || !t.tex) return; if (t.fbo) gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); used -= t.bytes; t.tex = null; }
  function fbo(t) {
    if (!t.fbo) { t.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0); }
    return t.fbo;
  }
  // scratch pool (render targets reused between frames)
  const pool = [];
  function scratch(w, h, fmt) {
    const i = pool.findIndex((t) => !t.busy && t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) { pool[i].busy = true; return pool[i]; }
    room(w * h * BPP[fmt]);
    const t = makeTex(w, h, fmt); t.busy = true; pool.push(t); return t;
  }
  const release = (...ts) => { for (const t of ts) if (t) t.busy = false; };
  function trimPool(keepFmt = null) {
    for (let i = pool.length - 1; i >= 0; i--) if (!pool[i].busy && pool[i].fmt !== keepFmt) { freeTex(pool[i]); pool.splice(i, 1); }
  }
  // layer texture cache: key -> { t, slot, last, pinned }
  const cache = new Map(); let clock = 0;
  function room(bytes) {
    if (used + bytes <= budget) return;
    // free idle scratch of other sizes first, then least recently used layer textures
    for (let i = pool.length - 1; i >= 0 && used + bytes > budget; i--) if (!pool[i].busy) { freeTex(pool[i]); pool.splice(i, 1); }
    const entries = [...cache.entries()].filter(([, e]) => !e.pinned).sort((a, b) => a[1].last - b[1].last);
    for (const [k, e] of entries) { if (used + bytes <= budget) break; freeTex(e.t); cache.delete(k); stats.evictions++; }
    if (used + bytes > budget) throw gpuError('memory', `GPU memory budget exceeded (${Math.round((used + bytes) / 1048576)} MB needed of ${Math.round(budget / 1048576)} MB)`);
  }
  function upload(t, src, straight) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (src instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) || (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap)) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !straight);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } else {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, FMT[t.fmt][2], src);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    stats.uploads++;
  }
  /** Cached texture for a layer source: canvas (premultiplied RGBA8) or deep image (straight RGBA16F). */
  function cached(key, slot, src, w, h) {
    let e = cache.get(key);
    if (e) { e.last = ++clock; e.pinned = true; return e.t; }
    for (const [k, o] of cache) if (o.slot === slot) { freeTex(o.t); cache.delete(k); }
    const deep = !!(src && src.data instanceof Uint16Array);
    const fmt = deep ? 'rgba16f' : 'rgba8';
    room(w * h * BPP[fmt]);
    const t = makeTex(w, h, fmt);
    if (deep) { const hb = halfOf16(), s = src.data, half = new Uint16Array(s.length); for (let i = 0; i < s.length; i++) half[i] = hb[s[i]]; upload(t, half, true); }
    else upload(t, src, false);
    e = { t, slot, last: ++clock, pinned: true, straight: deep }; cache.set(key, e); return t;
  }
  const unpinAll = () => { for (const e of cache.values()) e.pinned = false; };
  const cubeCache = new Map();
  /** A 3D LUT as a 2D float texture (N*N wide, N tall: x = r + b*N, y = g), fetched with manual trilinear filtering. */
  function cubeTex(T) {
    let t = cubeCache.get(T); if (t) return t;
    const N = T.size, data = new Float32Array(N * N * N * 4);
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) { const s = ((b * N + g) * N + r) * 3, o = (g * N * N + b * N + r) * 4; data[o] = T.data[s]; data[o + 1] = T.data[s + 1]; data[o + 2] = T.data[s + 2]; data[o + 3] = 1; }
    if (cubeCache.size >= 6) { const [k, old] = cubeCache.entries().next().value; freeTex(old); cubeCache.delete(k); }
    t = makeTex(N * N, N, 'rgba32f'); upload(t, data, true); cubeCache.set(T, t); return t;
  }
  const lutCache = new Map();
  function lutTex(op, params) {
    const key = op + JSON.stringify(params || {});
    let t = lutCache.get(key); if (t) return t;
    const fns = pointFns(op, params || {}); if (!fns) throw gpuError('unsupported', op);
    const data = new Float32Array(4096 * 4);
    for (let i = 0; i < 4096; i++) { const x = (i / 4095) * 255; data[i * 4] = fns[0](x) / 255; data[i * 4 + 1] = fns[1](x) / 255; data[i * 4 + 2] = fns[2](x) / 255; data[i * 4 + 3] = 1; }
    if (lutCache.size >= 24) { const [k, old] = lutCache.entries().next().value; freeTex(old); lutCache.delete(k); }
    t = makeTex(4096, 1, 'rgba32f'); upload(t, data, true); lutCache.set(key, t); return t;
  }

  // ---- passes ----------------------------------------------------------------------------------
  function run(name, target, w, h, u = {}, viewport = null) {
    const { p, uni } = program(name);
    gl.useProgram(p); gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? fbo(target) : null);
    if (viewport) gl.viewport(...viewport); else gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    for (const name2 in uni) {
      const { loc, type, unit } = uni[name2]; const v = u[name2];
      if (unit >= 0) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v ? v.tex : null); gl.uniform1i(loc, unit); continue; }
      if (v === undefined) continue;
      switch (type) {
        case gl.FLOAT: gl.uniform1f(loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2f(loc, v[0], v[1]); break;
        case gl.FLOAT_VEC3: gl.uniform3f(loc, v[0], v[1], v[2]); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(loc, typeof v === 'boolean' ? (v ? 1 : 0) : v); break;
        case gl.INT_VEC2: gl.uniform2i(loc, v[0], v[1]); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(loc, v >>> 0); break;
        default: throw gpuError('shader', `uniform type ${type}`);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3); stats.passes++;
  }
  /** Apply one filter / adjustment to premultiplied float texture `a`; returns the result texture (a is released). */
  function applyOp(a, name, params = {}, info = {}) {
    const { w, h, fmt } = a; const out = () => scratch(w, h, fmt);
    let r;
    if (ADJ_POINT.has(name)) {
      r = out();
      if (name === 'hueSaturation') run('adjust', r, w, h, { uSrc: a, uOp: 1, uHsl: [(params.hue || 0) / 360, (params.saturation || 0) / 100, (params.lightness || 0) / 100] });
      else if (name === 'grayscale') run('adjust', r, w, h, { uSrc: a, uOp: 2 });
      else if (name === 'sepia') run('adjust', r, w, h, { uSrc: a, uOp: 3, uAmount: (params.amount ?? 100) / 100 });
      else if (name === 'lut3d') { const T = params.table; if (!T) { release(r); return a; } run('adjust', r, w, h, { uSrc: a, uOp: 4, uCube: cubeTex(T), uCubeN: T.size, uDmin: T.domainMin || [0, 0, 0], uDmax: T.domainMax || [1, 1, 1], uAmount: (params.amount ?? 100) / 100 }); }
      else run('adjust', r, w, h, { uSrc: a, uOp: 0, uLut: lutTex(name, params) });
    } else if (name === 'gaussianBlur' || name === 'sharpen') {
      const sigma = name === 'gaussianBlur' ? params.radius || 0 : params.radius ?? 1.5;
      if (sigma <= 0) return a;
      const lin = fmt !== 'rgba32f' || linear32;
      const t = out(); run('blur', t, w, h, { uSrc: a, uDir: [1, 0], uSize: [w, h], uSigma: sigma, uLinear: lin });
      const b = out(); run('blur', b, w, h, { uSrc: t, uDir: [0, 1], uSize: [w, h], uSigma: sigma, uLinear: lin }); release(t);
      if (name === 'gaussianBlur') r = b;
      else { r = out(); run('unsharp', r, w, h, { uSrc: a, uBlur: b, uAmount: (params.amount ?? 80) / 100, uThreshold: (params.threshold || 0) / 255 }); release(b); }
    } else if (name === 'noise') {
      r = out(); run('noise', r, w, h, { uSrc: a, uAmount: ((params.amount ?? 20) * 2.55) / 255, uMono: params.monochrome !== false, uSeed: params.seed || 1, uOff: [info.offX || 0, info.offY || 0] });
    } else if (name === 'vignette') {
      const W = info.docW || w, H = info.docH || h, cx = W / 2, cy = H / 2, maxR = Math.hypot(cx, cy), inner = ((params.size ?? 60) / 100) * maxR;
      r = out(); run('vignette', r, w, h, { uSrc: a, uCenter: [cx, cy], uInner: inner, uOuter: inner + Math.max(1, ((params.feather ?? 50) / 100) * maxR), uK: (params.amount ?? 50) / 100, uOff: [info.offX || 0, info.offY || 0] });
    } else throw gpuError('unsupported', `GPU has no ${name}`);
    release(a); stats.ops++;
    return r;
  }
  /** Draw texture `t` (premultiplied) into a 2D context at (ox, oy), tile by tile. */
  function toContext(t, ctx, ox = 0, oy = 0, dither = false) {
    const W = t.w, H = t.h, cw = Math.min(W, tile), ch = Math.min(H, tile);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    for (let ty = 0; ty < H; ty += tile) for (let tx = 0; tx < W; tx += tile) {
      const tw = Math.min(tile, W - tx), th = Math.min(tile, H - ty);
      run('screen', null, cw, ch, { uSrc: t, uOff: [tx, ty], uH: ch, uDither: dither }, [0, ch - th, tw, th]);
      ctx.clearRect(ox + tx, oy + ty, tw, th);
      ctx.drawImage(canvas, 0, 0, tw, th, ox + tx, oy + ty, tw, th);
    }
  }
  function readStraight(t, float) {
    const { w, h } = t, o = scratch(w, h, float ? 'rgba32f' : 'rgba8');
    run('straight', o, w, h, { uSrc: t });
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo(o));
    const out = float ? new Float32Array(w * h * 4) : new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    release(o); return out;
  }
  const checkSize = (w, h) => {
    if (lost || gl.isContextLost()) throw gpuError('lost', 'GPU context lost');
    if (w > maxTex || h > maxTex) throw gpuError('too-large', `${w}×${h} exceeds the GPU texture limit (${maxTex}px)`);
  };
  const fits = (bytes) => used + bytes <= budget || bytes <= budget * 0.9;
  const accumFormat = (W, H) => (fits(W * H * 8 * 3 + W * H * 4) ? 'rgba16f' : fits(W * H * 4 * 4) ? 'rgba8' : null);

  // ---- textured triangle meshes (perspective / warp / liquify) -------------------------------------
  let meshProg = null;
  function meshProgram() {
    if (meshProg) return meshProg;
    const VSM = `#version 300 es
layout(location = 0) in vec3 aP; layout(location = 1) in vec2 aT;
uniform vec4 uO; uniform vec2 uS; out vec2 vT;
void main() { gl_Position = vec4(((aP.x - uO.x) / uO.z * 2.0 - 1.0) * aP.z, ((aP.y - uO.y) / uO.w * 2.0 - 1.0) * aP.z, 0.0, aP.z); vT = aT / uS; }`;
    const FSM = `#version 300 es
precision highp float; in vec2 vT; uniform sampler2D uSrc; out vec4 o; void main() { o = texture(uSrc, vT); }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gpuError('shader', `mesh: ${gl.getShaderInfoLog(s)}`); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VSM)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FSM)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw gpuError('shader', `mesh: ${gl.getProgramInfoLog(p)}`);
    meshProg = { p, uO: gl.getUniformLocation(p, 'uO'), uS: gl.getUniformLocation(p, 'uS'), uSrc: gl.getUniformLocation(p, 'uSrc'), vao: gl.createVertexArray(), vb: gl.createBuffer(), ib: gl.createBuffer() };
    return meshProg;
  }
  function warpMesh(img, outW, outH, mesh, ox = 0, oy = 0) {
    const w = img.width, h = img.height; checkSize(w, h); checkSize(outW, outH);
    const s8 = scratch(w, h, 'rgba8'); upload(s8, img.data, true);
    const a = scratch(w, h, 'rgba16f'); run('prep', a, w, h, { uSrc: s8, uStraight: true }); release(s8);
    const out = scratch(outW, outH, 'rgba16f');
    try {
      const M = meshProgram(), nv = mesh.pos.length / 3, verts = new Float32Array(nv * 5);
      for (let i = 0; i < nv; i++) { verts.set(mesh.pos.subarray(i * 3, i * 3 + 3), i * 5); verts[i * 5 + 3] = mesh.uv[i * 2]; verts[i * 5 + 4] = mesh.uv[i * 2 + 1]; }
      const idx = mesh.idx instanceof Uint32Array ? mesh.idx : new Uint32Array(mesh.idx);
      gl.useProgram(M.p); gl.bindVertexArray(M.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, M.vb); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, M.ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo(out)); gl.viewport(0, 0, outW, outH);
      gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a.tex); gl.uniform1i(M.uSrc, 0);
      gl.uniform4f(M.uO, ox, oy, outW, outH); gl.uniform2f(M.uS, w, h);
      gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0); stats.passes++;
      gl.bindVertexArray(vao);
      return new ImageData(readStraight(out, false), outW, outH);
    } finally { release(a, out); }
  }

  const engine = {
    info, stats, canvas, gl,
    get lost() { return lost || gl.isContextLost(); },
    get usedMB() { return used / 1048576; },
    get budgetMB() { return budget / 1048576; },
    setBudget(mb) { budget = mb * 1048576; trimPool(); },
    accumFormat,
    supports(name, w, h) { return !engine.lost && GPU_OPS.has(name) && w <= maxTex && h <= maxTex && fits(w * h * (4 + 8 * 4)); },
    supportsDeep(name, w, h, info2 = {}) { return can32 && !engine.lost && GPU_OPS.has(name) && !info2.linear && w <= maxTex && h <= maxTex && fits(w * h * 16 * 4); },
    canComposite(layers, W, H) {
      if (engine.lost || W > maxTex || H > maxTex || !accumFormat(W, H)) return false;
      return layers.every((L) => L.kind !== 'adjust' || ADJ_POINT.has(L.op));
    },
    markers: true,
    /**
     * Composite layers into ctx (a 2D context of a W×H canvas). Layer descriptors:
     *  { kind:'pixels', key, slot, src: canvas | DImage, x, y, w, h, opacity, mode, mask? }
     *  { kind:'adjust', op, params, opacity, mode, mask? }      mask = { key, slot, canvas, x, y }
     * Returns the accumulator format used ('rgba16f' or 'rgba8').
     */
    composite(layers, W, H, ctx, { background = null, dither = false } = {}) {
      checkSize(W, H);
      const fmt = accumFormat(W, H); if (!fmt) throw gpuError('memory', 'Not enough GPU memory for this canvas');
      unpinAll();
      let A = scratch(W, H, fmt), Bt = scratch(W, H, fmt); const stack = [];
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo(A));
        if (background) gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1); else gl.clearColor(0, 0, 0, 0);
        gl.viewport(0, 0, W, H); gl.clear(gl.COLOR_BUFFER_BIT);
        for (const L of layers) {
          if (L.kind === 'groupBegin' || L.kind === 'passBegin') {
            stack.push(A); A = scratch(W, H, fmt);
            if (L.kind === 'passBegin') run('prep', A, W, H, { uSrc: stack[stack.length - 1], uStraight: false });
            else { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo(A)); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
            continue;
          }
          const m = L.mask ? cached(L.mask.key, L.mask.slot, L.mask.canvas, L.mask.canvas.width, L.mask.canvas.height) : null;
          const mu = m ? { uMask: m, uHasMask: true, uMaskOff: [L.mask.x, L.mask.y], uMaskSize: [m.w, m.h] } : { uHasMask: false, uMaskOff: [0, 0], uMaskSize: [1, 1] };
          if (L.kind === 'groupEnd' || L.kind === 'passEnd') {
            const G = A; A = stack.pop();
            if (L.opacity > 0) {
              const pass = L.kind === 'passEnd';
              run('layer', Bt, W, H, { uDst: A, uSrc: G, uOff: [0, 0], uSize: [W, H], uStraight: false, uOpacity: L.opacity, uMode: pass ? 0 : L.mode, uLerp: pass, ...mu });
              const s = A; A = Bt; Bt = s;
            }
            release(G); continue;
          }
          if (L.opacity <= 0) continue;
          if (L.kind === 'adjust') {
            const C = scratch(W, H, fmt); run('prep', C, W, H, { uSrc: A, uStraight: false });
            const adj = applyOp(C, L.op, L.params, { docW: W, docH: H });
            run('layer', Bt, W, H, { uDst: A, uSrc: adj, uOff: [0, 0], uSize: [W, H], uStraight: false, uOpacity: L.opacity, uMode: L.mode, uLerp: L.mode === 0, ...mu });
            release(adj);
          } else {
            const t = cached(L.key, L.slot, L.src, L.w, L.h), straight = t.fmt === 'rgba16f';
            run('layer', Bt, W, H, { uDst: A, uSrc: t, uOff: [L.x, L.y], uSize: [L.w, L.h], uStraight: straight, uOpacity: L.opacity, uMode: L.mode, uLerp: false, ...mu });
          }
          const s = A; A = Bt; Bt = s;
        }
        toContext(A, ctx, 0, 0, dither);
        stats.composites++;
        return fmt;
      } finally { release(A, Bt, ...stack); }
    },
    /** Render a textured triangle mesh (see mesh.js) of straight ImageData into a new outW×outH ImageData at offset (ox, oy). */
    warpMesh,
    /** Run filters [{ name, params }] on a canvas (premultiplied); returns a new canvas. */
    filterCanvas(src, chain, info2 = {}) {
      const w = src.width, h = src.height; checkSize(w, h);
      if (!chain.every((f) => GPU_OPS.has(f.name))) throw gpuError('unsupported', 'filter not on GPU');
      const s8 = scratch(w, h, 'rgba8'); upload(s8, src, false);
      let a = scratch(w, h, 'rgba16f'); run('prep', a, w, h, { uSrc: s8, uStraight: false }); release(s8);
      try {
        for (const f of chain) a = applyOp(a, f.name, f.params, info2);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        toContext(a, c.getContext('2d'));
        return c;
      } finally { release(a); }
    },
    /** One op on straight 8-bit ImageData; returns a new ImageData. */
    processImageData(name, img, params = {}, info2 = {}) {
      const { width: w, height: h } = img; checkSize(w, h);
      const s8 = scratch(w, h, 'rgba8'); upload(s8, img.data, true);
      let a = scratch(w, h, 'rgba16f'); run('prep', a, w, h, { uSrc: s8, uStraight: true }); release(s8);
      try { a = applyOp(a, name, params, info2); return new ImageData(readStraight(a, false), w, h); } finally { release(a); }
    },
    /** One op on a 16-bit DImage at 32-bit float precision; returns a new DImage. */
    processDeep(name, d, params = {}, info2 = {}) {
      if (!can32) throw gpuError('unsupported', 'no float32 render targets');
      const { width: w, height: h } = d; checkSize(w, h);
      const f = new Float32Array(d.data.length); for (let i = 0; i < f.length; i++) f[i] = d.data[i] / 65535;
      const s = scratch(w, h, 'rgba32f'); upload(s, f, true);
      let a = scratch(w, h, 'rgba32f'); run('prep', a, w, h, { uSrc: s, uStraight: true }); release(s);
      try {
        a = applyOp(a, name, params, info2);
        const r = readStraight(a, true), out = new Uint16Array(r.length);
        for (let i = 0; i < r.length; i++) { const v = Math.round(r[i] * 65535); out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v; }
        return { width: w, height: h, data: out };
      } finally { release(a); trimPool('rgba16f'); }
    },
    /** Drop cached layer textures (e.g. on document switch) and idle scratch targets. */
    flush() { for (const e of cache.values()) freeTex(e.t); cache.clear(); trimPool(); },
    finish() { const px = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); },
    destroy() { destroyed = true; engine.flush(); for (const t of lutCache.values()) freeTex(t); lutCache.clear(); const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); },
  };
  return engine;
}
