// Interactive tone-curve editor (original implementation).
// Click/tap to add a point, drag to move it, drag it far off the graph or
// double-click it to remove it. Separate curves for the composite (RGB) and
// each channel; values are arrays of [input, output] pairs in 0..255.
import { curveLUT } from './pixels.js';

const CH = { rgb: ['RGB', '#d9dce2'], r: ['Red', '#ff5a4f'], g: ['Green', '#4fd16b'], b: ['Blue', '#5aa2ff'] };
export const identityCurves = () => ({ rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] });

/**
 * @param {object} values  {rgb, r, g, b} point lists (mutated in place)
 * @param {(values) => void} onChange  called after every edit
 * @param {object} [hist]  optional {r,g,b,l} 256-bin histograms drawn behind the curve
 */
export function createCurvesEditor(values, onChange, hist = null) {
  for (const k of Object.keys(CH)) if (!values[k]) values[k] = [[0, 0], [255, 255]];
  let ch = 'rgb', sel = 1, dragIdx = -1, removing = false;
  const root = document.createElement('div'); root.className = 'curves';
  root.innerHTML = `
    <div class="curves-top">
      <span class="seg curves-ch">${Object.entries(CH).map(([k, [n]]) => `<button type="button" data-ch="${k}" class="${k === ch ? 'on' : ''}">${n}</button>`).join('')}</span>
      <span class="spacer"></span><button type="button" class="curves-reset" title="Reset this channel">Reset</button>
    </div>
    <canvas class="curves-graph" width="512" height="512" aria-label="Curve graph"></canvas>
    <div class="curves-readout muted"><span>Input <b class="ci">0</b></span><span>Output <b class="co">0</b></span><span class="spacer"></span><span class="hint">Tap to add · drag off to remove</span></div>`;
  const cv = root.querySelector('canvas'), x = cv.getContext('2d');
  const pts = () => values[ch];
  const toGraph = (e) => {
    const r = cv.getBoundingClientRect();
    return { gx: ((e.clientX - r.left) / r.width) * 255, gy: (1 - (e.clientY - r.top) / r.height) * 255, out: e.clientY < r.top - 24 || e.clientY > r.bottom + 24 || e.clientX < r.left - 24 || e.clientX > r.right + 24, scale: 255 / r.width };
  };
  function draw() {
    const W = cv.width, H = cv.height, sx = W / 255, sy = H / 255;
    x.clearRect(0, 0, W, H); x.fillStyle = '#16171b'; x.fillRect(0, 0, W, H);
    if (hist) {
      const hh = hist[ch === 'rgb' ? 'l' : ch]; if (hh) {
        const max = Math.max(1, ...hh.slice(1, 255)); x.fillStyle = ch === 'rgb' ? '#ffffff22' : CH[ch][1] + '33';
        for (let i = 0; i < 256; i++) { const h = Math.min(1, hh[i] / max) * H; x.fillRect(i * sx, H - h, sx + 0.5, h); }
      }
    }
    x.strokeStyle = '#ffffff1a'; x.lineWidth = 1;
    for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo((W * i) / 4, 0); x.lineTo((W * i) / 4, H); x.moveTo(0, (H * i) / 4); x.lineTo(W, (H * i) / 4); x.stroke(); }
    x.strokeStyle = '#ffffff30'; x.beginPath(); x.moveTo(0, H); x.lineTo(W, 0); x.stroke();
    // other channels faintly, then the active one
    for (const k of Object.keys(CH)) {
      if (k === ch) continue; const p = values[k];
      if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255) continue;
      plot(curveLUT(p), CH[k][1] + '55', 2);
    }
    plot(curveLUT(pts()), CH[ch][1], 3);
    pts().forEach(([px, py], i) => {
      x.beginPath(); x.arc(px * sx, H - py * sy, i === sel ? 11 : 8, 0, Math.PI * 2);
      x.fillStyle = i === sel ? CH[ch][1] : '#16171b'; x.fill(); x.lineWidth = 3; x.strokeStyle = CH[ch][1]; x.stroke();
    });
    const s = pts()[sel]; root.querySelector('.ci').textContent = s ? Math.round(s[0]) : '–'; root.querySelector('.co').textContent = s ? Math.round(s[1]) : '–';
  }
  function plot(lut, color, w) {
    const W = cv.width, H = cv.height; x.strokeStyle = color; x.lineWidth = w; x.beginPath();
    for (let i = 0; i < 256; i++) { const px = (i / 255) * W, py = H - (lut[i] / 255) * H; if (i) x.lineTo(px, py); else x.moveTo(px, py); }
    x.stroke();
  }
  const changed = () => { draw(); onChange(values); };
  const nearest = (g) => {
    let best = -1, bd = Infinity;
    pts().forEach(([px, py], i) => { const d = Math.hypot(px - g.gx, py - g.gy); if (d < bd) { bd = d; best = i; } });
    return bd <= 14 * g.scale * (window.matchMedia('(pointer: coarse)').matches ? 2 : 1) ? best : -1;
  };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const g = toGraph(e); let i = nearest(g);
    if (i < 0) { // add a point on the curve at this input value, then drag it
      const lut = curveLUT(pts()); const gx = Math.round(Math.max(1, Math.min(254, g.gx)));
      const p = pts(); p.push([gx, Math.abs(g.gy - lut[gx]) < 20 * g.scale ? lut[gx] : Math.round(Math.max(0, Math.min(255, g.gy)))]); p.sort((a, b) => a[0] - b[0]);
      i = p.findIndex((q) => q[0] === gx); changed();
    }
    sel = dragIdx = i; removing = false; draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    const g = toGraph(e), p = pts(), last = p.length - 1;
    const isEnd = dragIdx === 0 || dragIdx === last;
    removing = g.out && !isEnd && p.length > 2;
    const lo = dragIdx === 0 ? 0 : p[dragIdx - 1][0] + 1, hi = dragIdx === last ? 255 : p[dragIdx + 1][0] - 1;
    p[dragIdx] = [Math.round(Math.max(lo, Math.min(hi, g.gx))), Math.round(Math.max(0, Math.min(255, g.gy)))];
    cv.style.opacity = removing ? 0.6 : 1;
    changed();
  });
  const end = () => {
    if (dragIdx >= 0 && removing) { pts().splice(dragIdx, 1); sel = Math.min(sel, pts().length - 1); changed(); }
    dragIdx = -1; removing = false; cv.style.opacity = 1;
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (e) => {
    const i = nearest(toGraph(e)); const p = pts();
    if (i > 0 && i < p.length - 1) { p.splice(i, 1); sel = 0; changed(); }
  });
  root.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => {
    ch = b.dataset.ch; sel = Math.min(1, pts().length - 1);
    root.querySelectorAll('[data-ch]').forEach((q) => q.classList.toggle('on', q === b)); draw();
  }));
  root.querySelector('.curves-reset').addEventListener('click', () => { values[ch] = [[0, 0], [255, 255]]; sel = 1; changed(); });
  // Keyboard nudging of the selected point (arrow keys), for precision.
  cv.tabIndex = 0;
  cv.addEventListener('keydown', (e) => {
    const p = pts()[sel]; if (!p) return;
    const step = e.shiftKey ? 10 : 1; let used = true;
    if (e.key === 'ArrowUp') p[1] = Math.min(255, p[1] + step); else if (e.key === 'ArrowDown') p[1] = Math.max(0, p[1] - step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const a = pts(), lo = sel === 0 ? 0 : a[sel - 1][0] + 1, hi = sel === a.length - 1 ? 255 : a[sel + 1][0] - 1;
      p[0] = Math.max(lo, Math.min(hi, p[0] + (e.key === 'ArrowRight' ? step : -step)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') { if (sel > 0 && sel < pts().length - 1) { pts().splice(sel, 1); sel--; } }
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); changed(); }
  });
  draw();
  return root;
}
