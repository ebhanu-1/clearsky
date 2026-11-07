# ClearSky status

Last updated 2026-11-07. Read this first when picking the project up in a new chat, then CLAUDE.md.

## Where it stands

- **Released: v2.1** (NWS is now the primary weather source, see docs/spikes.md "v2.1"); v2.0 was commit 525a51e, live at https://ebhanu-1.github.io/clearsky/ (GitHub Pages, repo ebhanu-1/clearsky).
- Working tree clean after the release. 46 tests pass (`npm test`), `npm run live` scores all four zips with no gaps,
  size 172.5 KB (50.7 KB gzipped, budget 200 KB gzipped).
- Product focus: **clarity for distant landscape shots** (sharp, clean, no haze, smoke or shimmer). Moon, aurora and the
  other five profiles are small extras and stay out of Clarity scores. See docs/v2.md for the assessment and V1-V13.

## Shipped in v2.0

Subject distance (near/mid/far) and view direction (8 points) in "Your shot"; line-of-sight air from two points along the
bearing; sun-vs-view factor; heat shimmer and low cloud in Clarity; ensemble dew-point spread feeding confidence;
air-mass outlook sentences and week chart; Layers grid tab; field notes; .ics reminder; moon phase and Kp aurora line;
mobile-first tabs (Plan, Day, Layers, More).

## Not verified

- v2.1: that NWS data predicts real clarity better than Open-Meteo did (needs rated shots); the NWS/Open-Meteo seam in the
  24-hour post-front signal; NWS rate limits under heavy use (none seen in testing).
- On a real phone: the "Update now" flow from 1.1 to 2.0, Add to Home Screen, offline launch.
- Clarity weights (V5) are starting values, not tuned against real shots.
- Line of sight is two weather points, not terrain.

## Ideas for the next iteration (none started)

Ordered by how much they help distant shots:

1. **Check on a real phone** and fix whatever the 375 px browser check missed (tap targets, tab bar, safe-area insets).
2. **Tune weights from the shot log** (design milestone M5): rate real shots, fit Clarity weights, update curve tests
   and golden scenarios in the same commit.
3. **Terrain-aware line of sight**: elevation along the bearing (Open-Meteo elevation API) to flag valley haze pooling
   and ridges blocking the view; add points beyond two.
4. **Better subject-distance input**: pick the subject on a map or type a landmark, derive miles and bearing.
5. **Haze-specific signals**: AOD trend, smoke plume direction (HRRR smoke if a usable free source exists), inversion
   strength from the temperature profile.
6. **Backup-plan view**: if the best window is poor, show the next-best day or the best direction instead.
7. Extras only if asked: Night sky/Bortle, rainbow and storm-clearing detection.

## How to release (unchanged)

`npm test`, `node build.mjs --version X.Y` (a plain `npm run build` bumps it), commit, `git push origin main`, confirm the
live page serves the new `APP_VERSION`. In the browser preview load `/?v=X.Y` to bypass the service worker cache.
The owner wants changes finished and released without check-in questions.
