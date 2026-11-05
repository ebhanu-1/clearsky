# ClearSky

Single-file web app that scores hourly photography conditions for any US zip code, per shoot type (profile), from
Open-Meteo weather and air quality plus ERA5 weather history, with an NWS cross-check.
The design doc is docs/design.md (export of the "Photo Clarity App" spec): Design decisions D1-D22, Data and history,
Scoring and profiles, Build plan. docs/spikes.md records live API results and where the build departs from the doc.
Source doc: https://claude.ai/artifact/81eMqtWrzcZwTudCqTHvEd

## Commands
- npm test                 # node --test, no network, recorded fixtures only
- npm run build            # inlines src/ into ./index.html (and ./dist), syntax-checks, enforces the size budget
- npm run serve            # static server on :5173 (also reachable from a phone on the same Wi-Fi)
- npm run live             # live end-to-end check against the real APIs (zips 01810, 80202, 33101, 98101)

## Layout
- src/core.js       pure scoring engine: curves, sun position, derived features, 16 factors, 6 profiles, windows
- src/providers.js  network adapters, typed ProviderError, localStorage cache, retry and timeout rules
- src/format.js     unit formatting, time labels, plain-language reasons (rebuilt from raw SI values per unit system)
- src/app.js        UI (DOM built with textContent only), src/style.css, src/index.template.html
- test/             node:test suites; fixtures in test/fixtures; golden scenarios mirror the Build plan
- public/           manifest, icons, sw.js (copied next to index.html on build)

## Rules
- core.js has no I/O and no DOM; providers.js never imports core. Only app.js uses both.
- Internal values are SI and UTC. Anchors in the doc are US units and are converted at the factor boundary.
- No thresholds in the UI. Curves and weights live in core.js (CURVES, PROFILE_DEFS); tests read them.
- A missing input drops its factor and renormalizes the weights. Never score missing as 0 or 1.
- Changing a curve or weight means updating curve tests and golden scenarios in the same commit, with the reason.
- Tests never call live APIs. `npm run live` is the only networked check.
- UI: light background, one HTML file, no runtime CDN. Build must stay under 200 KB gzipped.
- Ask before changing any decision D1-D22. Deviations so far are listed in docs/spikes.md.

## Definition of done
Tests green, `npm run build` green, `npm run live` shows all four zips scoring with no gaps, and the page checked in a
browser at phone width (375 px) and desktop width.
