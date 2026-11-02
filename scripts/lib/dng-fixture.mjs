// Synthetic DNG writer for the tests (original code): a little-endian TIFF with an RGGB CFA, colour matrix,
// as-shot neutral and optional lens opcodes (WarpRectilinear + FixVignetteRadial) or an embedded JPEG preview.
export function tiff(ifds) { // ifds: [{ entries: [[tag, type, values|Uint8Array]], data?: Uint8Array, sub?: index }]; little-endian
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8, 12: 8 };
  const parts = []; let off = 8;
  const layout = ifds.map((ifd) => { const n = ifd.entries.length, size = 2 + n * 12 + 4; const at = off; off += size; return { at, n }; });
  const blobs = []; const blobAt = (u8) => { const a = off; blobs.push(u8); off += u8.length + (u8.length & 1); return a; };
  const enc = (type, vals) => {
    if (vals instanceof Uint8Array) return vals;
    const b = new DataView(new ArrayBuffer(vals.length * SZ[type]));
    vals.forEach((v, i) => {
      if (type === 3) b.setUint16(i * 2, v, true); else if (type === 4) b.setUint32(i * 4, v, true);
      else if (type === 5 || type === 10) { const den = 10000; (type === 5 ? b.setUint32 : b.setInt32).call(b, i * 8, Math.round(v * den), true); b.setUint32(i * 8 + 4, den, true); }
      else if (type === 12) b.setFloat64(i * 8, v, true); else b.setUint8(i, v);
    });
    return new Uint8Array(b.buffer);
  };
  const dataAt = ifds.map((ifd) => (ifd.data ? blobAt(ifd.data) : 0));
  const resolved = ifds.map((ifd, k) => ifd.entries.map(([tag, type, vals]) => {
    if (vals === 'DATA') vals = [dataAt[k]]; else if (vals === 'DATALEN') vals = [ifd.data.length]; else if (typeof vals === 'object' && vals?.ifd != null) vals = [layout[vals.ifd].at];
    if (type === 2 && typeof vals === 'string') vals = new Uint8Array([...Buffer.from(vals + '\0')]);
    const raw = enc(type, vals), count = type === 2 || type === 7 || vals instanceof Uint8Array ? raw.length / (SZ[type] || 1) : vals.length;
    return { tag, type, count, raw, at: raw.length > 4 ? blobAt(raw) : -1 };
  }).sort((a, b) => a.tag - b.tag));
  const out = new Uint8Array(off), dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true);
  resolved.forEach((es, k) => {
    let p = layout[k].at; dv.setUint16(p, es.length, true); p += 2;
    for (const e of es) { dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true); if (e.at >= 0) dv.setUint32(p + 8, e.at, true); else out.set(e.raw, p + 8); p += 12; }
    dv.setUint32(p, 0, true);
  });
  let p = layout.length ? layout[layout.length - 1].at + 2 + resolved[resolved.length - 1].length * 12 + 4 : 8; void p;
  let q = layout[layout.length - 1].at + 2 + resolved[resolved.length - 1].length * 12 + 4;
  for (const b of blobs) { out.set(b, q); q += b.length + (b.length & 1); }
  return out;
}
const be = () => { const a = []; const o = { u32: (v) => { a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return o; }, f64: (v) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v); a.push(...new Uint8Array(b.buffer)); return o; }, bytes: () => new Uint8Array(a) }; return o; };
export function opcodeList(ops) {
  const w = be(); w.u32(ops.length);
  for (const op of ops) {
    const p = be();
    if (op.id === 1) { p.u32(op.planes.length); for (const pl of op.planes) [...pl.kr, ...pl.kt].forEach((v) => p.f64(v)); p.f64(op.cx).f64(op.cy); }
    if (op.id === 3) { op.k.forEach((v) => p.f64(v)); p.f64(op.cx).f64(op.cy); }
    const pb = p.bytes(); w.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(pb.length); for (const b of pb) w.bytes; const head = w.bytes(); void head; op._p = pb; // appended below
    ops._chunks = (ops._chunks || []).concat([pb]);
  }
  // rebuild in one pass (header + params interleaved)
  const out = be(); out.u32(ops.length); const chunks = [];
  ops.forEach((op, i) => { out.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(ops._chunks[i].length); chunks.push([out.bytes().length, ops._chunks[i]]); for (const b of ops._chunks[i]) out.u32; });
  const parts = []; let h = be(); h.u32(ops.length); parts.push(h.bytes());
  ops.forEach((op, i) => { const x = be(); x.u32(op.id).u32(0x01030000).u32(op.optional ? 1 : 0).u32(ops._chunks[i].length); parts.push(x.bytes(), ops._chunks[i]); });
  const len = parts.reduce((s, x) => s + x.length, 0), u = new Uint8Array(len); let o = 0; for (const x of parts) { u.set(x, o); o += x.length; }
  return u;
}
const XYZ2SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
export function makeDNG({ W = 720, H = 480, lens = true, compression = 1, preview = null, scene }) {
  const neutral = [0.5, 1, 0.7], black = 256, white = 16383, k0 = 0.6;
  const cfa = new Uint8Array(W * H * 2), dv = new DataView(cfa.buffer), cx = (W - 1) / 2, cy = (H - 1) / 2, rmax = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2), r2 = ((x - cx) ** 2 + (y - cy) ** 2) / rmax ** 2;
    const v = scene(x, y)[c] * neutral[c] / (lens ? 1 + k0 * r2 : 1); // vignetted by exactly what the opcode undoes
    dv.setUint16((y * W + x) * 2, Math.max(0, Math.min(white, Math.round(black + v * (white - black)))), true);
  }
  const cm = XYZ2SRGB.map((v, i) => v * neutral[Math.floor(i / 3)]);
  const rawEntries = [[254, 4, [0]], [256, 4, [W]], [257, 4, [H]], [258, 3, [16]], [259, 3, [compression]], [262, 3, [32803]], [273, 4, 'DATA'], [277, 3, [1]], [278, 4, [H]], [279, 4, 'DATALEN'], [284, 3, [1]],
    [33421, 3, [2, 2]], [33422, 1, [0, 1, 1, 2]], [50714, 4, [black]], [50717, 4, [white]]];
  if (lens) rawEntries.push([51022, 7, opcodeList([{ id: 1, planes: [{ kr: [1, 0.06, 0, 0], kt: [0, 0] }], cx: 0.5, cy: 0.5 }, { id: 3, k: [k0, 0, 0, 0, 0], cx: 0.5, cy: 0.5, optional: true }])]);
  const ifd0 = [[271, 2, 'Tintwork'], [272, 2, 'Synthetic DNG'], [274, 3, [1]], [50706, 1, [1, 4, 0, 0]], [50707, 1, [1, 1, 0, 0]], [50708, 2, 'Tintwork Synthetic DNG'],
    [50721, 10, cm], [50728, 5, neutral], [50778, 3, [21]]];
  if (preview) {
    ifd0.push([254, 4, [1]], [256, 4, [preview.w]], [257, 4, [preview.h]], [258, 3, [8, 8, 8]], [259, 3, [7]], [262, 3, [6]], [273, 4, 'DATA'], [277, 3, [3]], [278, 4, [preview.h]], [279, 4, 'DATALEN'], [330, 4, { ifd: 1 }]);
    return tiff([{ entries: ifd0, data: preview.jpeg }, { entries: rawEntries, data: cfa }]);
  }
  return tiff([{ entries: [...ifd0, ...rawEntries], data: cfa }]);
}
