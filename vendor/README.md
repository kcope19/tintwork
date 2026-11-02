# Third-party code

| Folder | Library | Version | License | Use |
|---|---|---|---|---|
| `fflate/` | [fflate](https://github.com/101arrowz/fflate) by Arjun Barrett | 0.8.2 (unmodified `esm/browser.js`) | MIT (`fflate/LICENSE`) | zlib inflate/deflate for the 16-bit PNG codec in `src/png.js` |
| `flashraw/` | [FlashRaw](https://github.com/ybouane/flashraw) by Yassine Bouanane | 0.1.0 (unmodified browser build from the npm package `dist/`) | MIT OR Apache-2.0 (`flashraw/LICENSE-MIT`, `flashraw/LICENSE-APACHE`); used under MIT | Camera RAW decoding (WebAssembly) in `src/codec-worker.js`; includes the multithreaded build (`flashraw_simd_threads.wasm`, `flashraw_bindgen_threads.js`, `thread-worker.browser.js`), used only when the page is cross-origin isolated |

Everything else in this repository is original code, including the PSD/PSB reader and writer (`src/psd.js`) and the RAW develop pipeline (`src/raw.js`).

Dev-only (not shipped, not in `package.json`): `scripts/make-psd-fixtures.cjs` uses [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT) to write the third-party PSD/PSB fixtures in `test-assets/psd/`; the test RAW files come from [raw.pixls.us](https://raw.pixls.us/) under CC0 1.0 (`npm run fetch-raw`, see `test-assets/raw-samples.json`).
