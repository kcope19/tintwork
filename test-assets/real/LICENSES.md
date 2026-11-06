# Real test photos: sources and licences

All files come from Wikimedia Commons and are public domain or CC0. They are used unmodified (only downscaled where noted) to test Object select and Auto upright on real photos. The ground-truth masks (`*-gt.png`) are Commons' own cut-out versions of the same photos, reduced to an 8-bit alpha mask.

| File | Commons file | Licence | Author |
|---|---|---|---|
| portrait-usda.jpg | File:20171027-AMS-LSC-1021 (38037045472).jpg | Public domain (US government work) | USDA |
| evers-scene.jpg | File:Tony Evers 191109-Z-HD478-486.jpg | Public domain (US government work) | Senior Airman Cameron Lewis |
| evers-gt.png | File:Tony Evers 191109-Z-HD478-486 (transparent).png | Public domain | derived from the above |
| macaque.jpg | File:Macaca nigra self-portrait large.jpg | Public domain (no human author) | the macaque |
| macaque-gt.png | File:Macaca nigra self-portrait transparent.png | CC0 | WeaponizingArchitecture |
| c4.jpg | File:Cross among skyscrapers (Unsplash).jpg | CC0 | Louis Moncouyoux |
| c6.jpg | File:Apartment High Rise Building (Unsplash).jpg | CC0 | Jimmy Chang |
| c1.jpg | File:Copley Place, Boston, United States (Unsplash).jpg | CC0 | Tom Skarbek-Wazynski |
| tower.jpg | File:White office building (Unsplash).jpg (Commons' 1280 px thumbnail) | CC0 | Michael Moloney |
| library.jpg | File:Trinity College Dublin (Unsplash).jpg (Commons' 1280 px thumbnail) | CC0 | Dmitrij Paskevic |
| brick.jpg | File:Old brick building (Unsplash).jpg (Commons' 1280 px thumbnail) | CC0 | Michael Browning |
| geneva.jpg | File:Facade in Geneva (Unsplash).jpg (Commons' 1280 px thumbnail) | CC0 | Samuel Zeller |

Upright "truth" edges used by the benchmark (jobs 16–18) are straight architectural edges measured by a sub-pixel least-squares edge fit on the original photo; only edges where at least half of the rows support the fit are used (see docs/WORKFLOW_BENCHMARK.md). `tower.jpg`, `library.jpg` and `brick.jpg` (v1.10) were added after the v1.10 upright change was written and were not used to tune it (held out); their edges were measured once with the same fit and checked by eye on an overlay. On `library.jpg` the leaning ladder is not a vertical and is not used. In v1.11 `library.jpg` and `brick.jpg` were used to tune the Full upright change (no longer held out); `geneva.jpg` (v1.11) is the new held-out photo: its five edges were fixed with the same fit before Tintwork was first run on it, and nothing was tuned on it.

| hongkong.jpg | Building Facade in Hong Kong.jpg | CC0 | Wikimedia Commons / Unsplash-style CC0 upload | https://commons.wikimedia.org/wiki/File:Building_Facade_in_Hong_Kong.jpg | Held-out for v1.12 Full upright (downloaded after the do-no-harm change; seeds fixed before first Tintwork run). |

## v1.17 held-out upright set (downloaded 2026-11-06, America/New_York)

Downloaded **after** planning the v1.17 measurement pass; seed edges fixed before any Tintwork tuning on these files.

| File | Commons file | Licence | Author | Role |
|---|---|---|---|---|
| v117-lowangle.jpg | File:Fade away. (Unsplash).jpg | CC0 | Jonathan Denney jdenney | held-out: low-angle tall building |
| | https://commons.wikimedia.org/wiki/File%3AFade_away._%28Unsplash%29.jpg | orig 3769x5653; stored as 1280 long-edge thumb | | |
| v117-interior.jpg | File:White passage leading to hallway (Unsplash).jpg | CC0 | Drew Patrick Miller drewpatrickmiller | held-out: interior converging verticals |
| | https://commons.wikimedia.org/wiki/File%3AWhite_passage_leading_to_hallway_%28Unsplash%29.jpg | orig 6016x4000; stored as 1280 long-edge thumb | | |
| v117-flat.jpg | File:Bright white building facade (Unsplash).jpg | CC0 | Matthew Hamilton thatsmrbio | held-out: flat facade |
| | https://commons.wikimedia.org/wiki/File%3ABright_white_building_facade_%28Unsplash%29.jpg | orig 5472x3648; stored as 1280 long-edge thumb | | |
| v117-geo.jpg | File:Geometric gray facade (Unsplash).jpg | CC0 | WonHo Sung whsung | held-out: geometric facade (strong V+H) |
| | https://commons.wikimedia.org/wiki/File%3AGeometric_gray_facade_%28Unsplash%29.jpg | orig 7952x5304; stored as 1280 long-edge thumb | | |
| v117-lookup.jpg | File:Looking up (Unsplash).jpg | CC0 | Patrick Baum gecko81de | held-out: looking-up / converging verticals |
| | https://commons.wikimedia.org/wiki/File%3ALooking_up_%28Unsplash%29.jpg | orig 4288x2848; stored as 1280 long-edge thumb | | |
| v117-frame.jpg | File:Framed wall art (Unsplash).jpg | CC0 | Crew crew | held-out: framed art (skewed rectangle) |
| | https://commons.wikimedia.org/wiki/File%3AFramed_wall_art_%28Unsplash%29.jpg | orig 6449x4705; stored as 1280 long-edge thumb | | |
| v117-cathedral.jpg | File:Cathedral facade (Unsplash).jpg | CC0 | Markus Gombocz cernoel | held-out: cathedral facade |
| | https://commons.wikimedia.org/wiki/File%3ACathedral_facade_%28Unsplash%29.jpg | orig 2597x1964; stored as 1280 long-edge thumb | | |
| v117-curvy.jpg | File:Curvy metal facade (Unsplash).jpg | CC0 | Scott Webb scottwebb | held-out: curvy metal (wide-angle / non-planar cue) |
| | https://commons.wikimedia.org/wiki/File%3ACurvy_metal_facade_%28Unsplash%29.jpg | orig 4288x2848; stored as 1280 long-edge thumb | | |
| v117-station.jpg | File:Interior of a train station (Unsplash).jpg | CC0 | Jared Erondu erondu | held-out: station interior / wide converging |
| | https://commons.wikimedia.org/wiki/File%3AInterior_of_a_train_station_%28Unsplash%29.jpg | | | |

