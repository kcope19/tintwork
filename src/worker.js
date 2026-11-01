// Background worker for heavy pixel work so the UI stays responsive.
import { runOp, blendMasked, blurMask, healRegion, spotHeal } from './pixels.js';

self.onmessage = (e) => {
  const { id, kind } = e.data;
  try {
    if (kind === 'blurMask') {
      const { mask, W, H, radius } = e.data;
      const out = blurMask(new Uint8Array(mask), W, H, radius);
      self.postMessage({ id, mask: out.buffer }, [out.buffer]);
      return;
    }
    if (kind === 'heal') {
      const { dst, src, cover, w, h } = e.data;
      const out = healRegion(new Uint8ClampedArray(dst), new Uint8ClampedArray(src), new Uint8Array(cover), w, h);
      self.postMessage({ id, data: out.buffer }, [out.buffer]);
      return;
    }
    if (kind === 'spotHeal') {
      const { img, cover, w, h } = e.data;
      const res = spotHeal(new Uint8ClampedArray(img), new Uint8Array(cover), w, h);
      self.postMessage({ id, data: res.data.buffer, offset: res.offset }, [res.data.buffer]);
      return;
    }
    const { name, width, height, buffer, params, info, mask } = e.data;
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const orig = mask ? new Uint8ClampedArray(img.data) : null;
    runOp(name, img, params, info);
    if (mask) blendMasked(orig, img.data, new Uint8Array(mask));
    self.postMessage({ id, buffer: img.data.buffer }, [img.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
self.postMessage({ ready: true });
