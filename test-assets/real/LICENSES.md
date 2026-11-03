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
