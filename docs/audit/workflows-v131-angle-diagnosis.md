# v1.31 diagnosis: `v130-angle.jpg` leftover stays ~18.6° (not shipped)

Date: 2026-11-19, America/New_York. App: **v1.30.0** (no Suggest code change).
Evidence: `workflows-v131-holdout-baseline.json`, `_v131-angle-diag.json`.

**Decision:** do not bump to 1.31.0. Measurements do not support a leftover win on angle without loosening gates or changing the leftover metric. Fresh held-outs were recorded only.

## v1.30.0 Suggest baseline (before any v1.31 change)

New CC0 looking-up held-outs (not used to tune):

| Photo | Suggest | Leftover | Notes |
|---|---|---|---|
| v131-canyon.jpg | pure-V 2V+0H | **~12.8°** | mix refused (overall +0.12° only; H residual would worsen 3.41°→4.29°) |
| v131-willis.jpg | mixed 2V+2H | **~23.6°** | `lastSuggestGate` is null: every pure-V pair (`top2` / `sugV` / `ranked`) returns `uprightFromGuides` null, so Suggest falls through to the mixed candidate **without** `acceptMix` |
| v131-white.jpg | pure-V 2V+0H | **~27.3°** | VP-V probe empty (`mV` non-finite); best refused mix 26.57° vs 27.33° (short of the 0.25° overall bar) |

Regression rows on this tree match the v1.30 scorecard (angle ~18.6°, highrise ~23.5°, below ~0.4°, towers ~25.8°, glass ~12.6°, interior ~3.8°, c4 ~1.7°, etc.).

## Why angle stays at ~18.6°

Suggest picks **2V+0H**. Verticals are already excellent: VP-V residual **0.65°**. The ~18.6° status figure is the **worst residual of the broad H probe** (top 6 horizontals at `minLenFrac` 0.12), not a remaining vertical tilt.

Those six H-probe lines do **not** share one vanishing point. Left-to-right slopes on the left tower alone run from about **+18° to −16°** (upper lines vs lower lines). The full detector's H `estimateUpright` is `keystone` with only **3 inliers** out of 14. Full upright **refuses** this photo: using the detected lines would make horizontals worse.

How current H mixes behave (105 exhaustive 2H pairs with the same pure-V pair):

- **103 / 105** are silent no-ops. `uprightFromGuides` needs `estimateUpright` to return a VP when there are two H guides. Conflicting H pairs get `mode: 'none'`, `vh` is dropped, and the homography is identical to pure-V (`ptsDiff = 0`, leftover unchanged at 18.579°). This is why “current H mixes don’t move it.”
- The **2** pairs that do agree on a VP actually change the transform, but they **worsen** broad leftover (20.5° and 25.3°). One also fails `vOk` (0.65°→2.03°). The other improves H-inlier residual 12.4°→0.88° while the worst conflicting probe line gets worse, so `hBetter` / `overallBetter` stay false and the mix is correctly refused.
- Single-H mixes (parallel-family fallback) worsen leftover by about 8–12°.

So the leftover is a **multi-VP / worst-edge measurement**, not a missing candidate in the current H pool, and not a status typo. A 2V+2H guide set can fix only one H vanishing point. Scoring the worst edge across two (or more) H VPs cannot reach ~0.5° on this photo, and the mixes that really apply an H VP make that worst-edge number worse. Gates were not loosened.

`v130-angle` was a v1.30 held-out. It was used only as a diagnosis target here and was **not** tuned; it remains a fair held-out relative to v1.30. If a later round tunes on it, disclose that it becomes in-sample.

## Why 1.31.0 was not shipped

A version bump requires the new v131 held-outs to improve on net with none worse, after a real code change. No such change was made: there is no measured way to cut angle’s reported leftover under the current leftover definition and acceptMix gates. Changing leftover to ignore disagreeing H lines, or loosening `vOk` / `noOverallHarm` / the 1° mix-refusal rule, was out of scope.

## Next target

- **Do not chase angle’s 18.6°** by changing the worst-edge leftover metric or loosening gates. Verticals are already tight; Full also refuses.
- **v131-white (~27.3°)** is a single looking-up grid facade and may have honest same-VP H room, but it is a held-out — do not tune on it. Re-measure only after a general change locked on other photos.
- **v131-willis (~23.6°)**: investigate why pure-V guide pairs fail `uprightFromGuides`, and whether the un-gated mixed fallback should require the same acceptMix gates. Do not tune on this held-out.
- **v131-canyon (~12.8°)** is the third held-out check for whatever general change comes next.
- Library Full ≤0.5° is still not a Distortion-only target. Auto radial stays gated.

