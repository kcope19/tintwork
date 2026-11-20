# v1.31 diagnosis: ungated mixed fallback when pure-V fails

Date: 2026-11-20, America/New_York. App after the fix: **v1.31.0**. Baseline: v1.30.0 (`workflows-v131-holdout-baseline.json`). After: `workflows-v131-after.json`.

## Why official pure-V pairs fail on v131-willis

`v131-willis` was inspected for diagnosis only and was **not used to tune** any threshold.

- `estimateUpright` on the official `top2` / `sugV` / `ranked` pairs returns `mode: 'none'`. Those two verticals intersect **inside the frame** (top2 VP ≈ (655, 73) on a 1280×853 photo; sugV VP ≈ (621, −28), still inside the 5% margin). The function correctly skips an in-frame VP so automatic Full does not treat crossing lines as a vertical vanishing point.
- `uprightFromGuides` then falls back to a 2-point “plumb each line independently” homography. The two lines lean about 22° in opposite directions, so that map folds the mesh: some corners get `w < 0`. The official result is `uprightFromGuides` null.
- All 15 detected verticals together do fit a keystone VP at about (665, 44) — also in-frame, only ~0.45 image-heights from the centre. Forcing that VP is not a safe general fix: top2 still folds, and sugV produces a valid mesh with leftover **~71°** (far worse than identity ~24.5°).
- Of 105 detected vertical pairs, only 3 produce a valid mesh, and those score ~37–55° (worse than doing nothing). Horizontals on this photo are already excellent (~0.29°).

The mixed 2V+2H candidate still returns a mesh because the V estimate stays `none` and only the H vanishing point is used (nearly a no-op: leftover **~23.6°** vs identity **~24.5°**). In v1.30 that mix was applied **without** `acceptMix`, and `lastSuggestGate` was null (`else if (mixedList[0]) best = mixedList[0]`).

## Decision

Do **not** loosen the in-frame VP rejection in `estimateUpright` (used by Full) and do **not** force in-frame VPs for guided upright (measured harm). Close the safety hole instead: when no usable pure-V baseline exists, run the **same** acceptMix bars against the uncorrected photo. If a mix clearly wins, apply it and record `v2src=identity`. If not, refuse with both leftover numbers and ask the user to draw guides.

A synthetic looking-up facade (in-frame VP, level floors) reproduces the hole without using the held-out photo to tune: the mix is not clearly better (~16.0° vs ~16.1°), so v1.31 refuses. On willis the existing mix already passes those bars, so leftover and mode stay ~23.6° 2V+2H, now gated.

canyon (~12.8°) and white (~27.3°) still have a real pure-V baseline and are unchanged. Every other row on the 21-photo set is unchanged.

## Next target

- Willis ~23.6° still trails. A later general fix would need a valid upright pair (or a different guide set) that actually straightens the tower without folding the mesh — developed on new photos, not on willis, which is now in-sample for this diagnosis/gate path.
- white ~27.3° and canyon ~12.8° remain fair held-outs relative to this safety change (they were not used to shape it).
- Do not chase angle’s 18.6° by changing the leftover metric or loosening gates.
- Library Full ≤0.5° is still not a Distortion-only target. Auto radial stays gated.
