# ClearSky

Single-file, mobile-first web app that answers one question for distant landscape photographers: will the air be clear
enough for sharp, clean far shots, and when and which way should I shoot? Scores hourly conditions for any US zip code
from Open-Meteo weather, air quality, ensemble spread and ERA5 history, with an NWS cross-check. Clarity is the primary
profile (subject distance, view direction, line of sight); five other shoot types are secondary.
The design doc is docs/design.md (export of the "Photo Clarity App" spec): Design decisions D1-D22, Data and history,
Scoring and profiles, Build plan. docs/spikes.md records live API results and where the build departs from the doc. docs/v2.md is the v2.0 assessment,
the research behind it and decisions V1-V13 (additions inside D9, D15, D16).
Source doc: https://claude.ai/artifact/81eMqtWrzcZwTudCqTHvEd

## Commands
- npm test                 # node --test, no network, recorded fixtures only
- npm run build            # bumps VERSION (1.1 -> 1.2), inlines src/ into ./index.html (and ./dist), syntax-checks, enforces the size budget
- npm run serve            # static server on :5173 (also reachable from a phone on the same Wi-Fi)
- npm run live             # live end-to-end check against the real APIs (zips 01810, 80202, 33101, 98101)

## Versioning and release (same scheme as Studio Phone)
- VERSION file holds e.g. `1.1`; every `npm run build` bumps the last part. `node build.mjs --version 2.0` pins a bigger one.
- Shown top right of the app (tap it to check for an update). The app probes the live page (`?u=`) at launch and each time it
  returns to the foreground; with nothing on screen it reloads to the new version (`?v=`), otherwise it shows "Update now".
- public/sw.js: cache-first page for offline launch; `?u=` always goes to the network, `?v=` fetches fresh and replaces the cache.
- Release: `npm run build`, commit, `git push`. GitHub Pages serves main at https://ebhanu-1.github.io/clearsky/ (repo ebhanu-1/clearsky).
- US units only (°F, mph, in, mi); the metric toggle was removed.

## Layout
- src/core.js       pure scoring engine: curves, sun position, derived features, 17 factors, 6 profiles, windows, subject
                    distance, view path merge, sun-vs-view direction, air-mass outlook, moon and aurora helpers
- src/providers.js  network adapters, typed ProviderError, localStorage cache, retry and timeout rules; line-of-sight points,
                    forecast ensemble, SWPC Kp
- src/format.js     unit formatting, time labels, plain-language reasons, field notes, verdicts, .ics reminders
- src/app.js        UI (DOM built with textContent only; tabs Plan / Day / Layers / More), src/style.css, src/index.template.html
- test/             node:test suites; fixtures in test/fixtures; golden scenarios mirror the Build plan
- public/           manifest, icons, sw.js (copied next to index.html on build)

## Rules
- core.js has no I/O and no DOM; providers.js never imports core. Only app.js uses both.
- Internal values are SI and UTC. Anchors in the doc are US units and are converted at the factor boundary.
- No thresholds in the UI. Curves and weights live in core.js (CURVES, PROFILE_DEFS); tests read them.
- A missing input drops its factor and renormalizes the weights. Never score missing as 0 or 1.
- Changing a curve or weight means updating curve tests and golden scenarios in the same commit, with the reason.
- Tests never call live APIs. `npm run live` is the only networked check.
- Clarity first: new work is judged by whether it makes distant shots sharper or cleaner. Moon, aurora and the other
  profiles are extras. Distance and direction are named choices in the UI; their numbers live in core.js (DISTANCE, CURVES).
- Mobile first: design at 375 px, tap targets 44 px or more, desktop is the same layout with room.
- UI: light background, one HTML file, no runtime CDN. Build must stay under 200 KB gzipped.
- Ask before changing any decision D1-D22. Deviations so far are listed in docs/spikes.md.

## Definition of done
Tests green, `npm run build` green, `npm run live` shows all four zips scoring with no gaps (it also exercises the ensemble, line-of-sight path and Kp calls),
and the page checked in a browser at phone width (375 px) and desktop width.
