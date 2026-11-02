// Develop band worker (original code): runs develop → noise reduction → sharpening on one band of output rows.
// Spawned by the codec worker, several at once, so a full-resolution develop uses every core. A band job can first
// post a half-resolution version of its rows (a quick preview while the full-resolution rows are still running).
import * as R from './raw.js';

self.onmessage = (e) => {
  const { id, region, opts, half } = e.data;
  try {
    if (half) {
      const t = performance.now(), hr = R.halveRegion(region), o = opts.orientation || 1;
      const [, hOH] = R.orientedSize(hr.fullW, hr.fullH, o);
      const rows = [Math.min(hOH, opts.rows[0] / 2), Math.min(hOH, Math.floor(opts.rows[1] / 2))];
      const r = R.developRows(hr, { ...opts, settings: { ...opts.settings, sharpen: 0, nrLuma: 0 }, nrScale: 1, factor: (opts.factor || 1) * 2, scale: (opts.scale ?? 1) / 2, rows, halo: (opts.halo ?? R.BAND_HALO) / 2, bits: 8 });
      self.postMessage({ id, stage: 'half', res: { ...r, ms: { total: performance.now() - t } } }, [r.data.buffer]);
    }
    const t = performance.now(), r = R.developRows(region, opts), t1 = performance.now();
    const data8 = r.bits === 16 ? R.to8(r.data) : null;
    const res = { ...r, data8, ms: { ...r.ms, develop: t1 - t - r.ms.nr - r.ms.sharpen, total: performance.now() - t } };
    self.postMessage({ id, stage: 'done', res }, data8 ? [r.data.buffer, data8.buffer] : [r.data.buffer]);
  } catch (err) {
    self.postMessage({ id, stage: 'error', error: err?.message || String(err) });
  }
};
