# Spike results (M0)

Run on 2026-11-04 from a Mac with plain `curl` (no accounts, no keys) and then from a real browser tab served at
`http://localhost:5173`. Raw responses are in `tools/spikes/out/`; the small ones are also test fixtures in `test/fixtures/`.

## Decision A: no proxy needed

Every host answers a cross-origin request with `access-control-allow-origin: *`, checked with `Origin: https://example.com`
and `Origin: null` (what a page opened from a local file sends). The built app then made all of these calls itself from a
browser tab with no CORS error. **Call the APIs directly from the browser. No Cloudflare Worker.**

| Spike | Question | Result |
| --- | --- | --- |
| S1 | Do the APIs answer browser requests? | Pass for Zippopotam.us, Nominatim, Open-Meteo forecast / air quality / archive / historical-forecast / previous-runs, NWS `/points` and `/gridpoints`, and IEM ASOS. All send `access-control-allow-origin: *`. |
| S2 | Which fields are populated, do the hostnames resolve? | Forecast for Andover MA: 0 nulls in all 15 hourly variables over 216 h, including `visibility` and `boundary_layer_height`. Air quality: 0 nulls for about 5 forecast days; the last 47 of 216 hours (day 6 to 7) are null, so the app treats air quality as missing there and renormalizes. `archive-api`, `previous-runs-api` and `historical-forecast-api` hostnames all resolve. NWS grid carries `dewpoint`, `skyCover`, `windDirection`, `mixingHeight` (dense) and `visibility` (sparse: 7 long intervals). |
| S3 | Size and time of the 2015 to 2025 hourly dew point pull | 96,432 values, 2.3 MB raw, **344 KB gzipped, 1.4 s**, no nulls. Reduced to a 53 x 24 mean/sd table (about 30 KB) cached in the browser for 90 days. |
| S4 | IEM ASOS from a browser | CORS open. One station-year of `vsby` and `dwpf` (Boston 2025): 105,751 rows, 3.4 MB, 3.8 s. Fast enough for the offline tool; not used by the web app yet. |
| S5 | Previous Runs variable names | `dew_point_2m_previous_day1` to `_day7` and `cloud_cover_previous_day1` to `_day7` all return full series (0 nulls over a 5-day window). Not used by the web app yet. |

## Zip lookup

Zippopotam.us returns 200 for real zips and `404` with `{}` for unknown ones; Nominatim's `postalcode=` search fills the
gap (it returns a centroid, sometimes a different one: 01810 is 42.6496, -71.1565 on Zippopotam and 42.6419, -71.1344 on
Nominatim). The app tries Zippopotam first, then Nominatim.

## NWS notes

Browsers refuse to set a custom `User-Agent`, and setting one would trigger a CORS preflight, so the browser's own UA
identifies the request in the app. The Node live check sets a descriptive UA. NWS did not rate-limit during testing.

## Where the design doc and the build differ

- **Profile weights.** The Profiles table in the design doc does not sum to 100 for three profiles: Reflections 145,
  Soft light 70, Wildlife 85. The model renormalizes over available factors anyway, so `loadProfile` scales each profile
  to 100 and records the declared sum (`weightSumDeclared`). Relative weights are unchanged.
- **Golden light hours.** The doc's Golden light weights include no sun-position factor, so a clear midday scored as high
  as sunrise. The profile now scores only hours with the sun between -4 and 10 degrees (`hours.sunElevRange`).
- **Fog gate for Clarity.** Golden scenario 4 needs "Clarity: Skip" in fog, but the new tabs define only a precipitation
  gate. Draft 1's fog multiplier (x 0.4) is restored for Clarity as `gate.fog`.
- **Stack.** Plain JavaScript, no framework, no build dependencies: `src/core.js` (scoring), `src/providers.js`,
  `src/format.js`, `src/app.js`, inlined into one `index.html` by `build.mjs`. This replaces the planned pnpm / Preact /
  Vite monorepo; the import rule (core has no I/O, providers never import core) is kept.
- **Climatology cache** is in localStorage (about 30 KB per place), not IndexedDB.

## v2.0 additions (2026-11-05)

Ensemble, multi-point forecast and SWPC Kp calls were checked with curl (CORS header, size, time); results are in
docs/v2.md. All three answer `access-control-allow-origin: *`. Clarity now uses `heatShimmer`, `lowCloudClear` and
`viewLight`, so its weights differ from the design doc's Profiles table (decision V5); golden scenarios 1 to 5 pass unchanged.

## v2.1: NWS is the primary weather source (2026-11-07)

Decisions D2 (primary weather: Open-Meteo) and D3 (second opinion: NWS) are **reversed**: the NWS forecast grid is now the
primary and Open-Meteo is the second source. The owner wanted US government sources; this is the hybrid, because the
rest of what the score needs has no browser-friendly government API (smoke and aerosol depth, the ensemble and ERA5
history are GRIB2 files or European data, and decoding them needs a server, which the single static page does not have).

| Data | Source now | Why |
| --- | --- | --- |
| Temperature, dew point, humidity, wind and gusts, total cloud, visibility, precipitation, mixing height | NWS gridpoints | Dense hourly layers, about 7.8 days, CORS open. Checked live 2026-11-07 (BOX/66,114): all of these non-null over 188 h. |
| Time zone, elevation | NWS `/points` and the grid | Same two requests that feed the forecast, so zero extra calls; Open-Meteo answers outside NWS coverage. |
| Cloud layers (low, mid, high), pressure | Open-Meteo | The NWS grid has no cloud layers and its `pressure` layer is empty. |
| Hours before now (two days) and the tail of the week | Open-Meteo | The grid starts a few hours before now and ends about 7.8 days out. |
| Smoke, PM2.5, aerosol depth, ensemble, ERA5, shot-log history, line-of-sight second points | Open-Meteo | No simple government equivalent. Unchanged. |
| Kp | NOAA SWPC | Unchanged. |

How it is built: `providers.normalizeNwsHourly` turns the grid into hourly records in the same shape as Open-Meteo's, and
`core.mergePrimary` takes the NWS value field by field when it is a number and the Open-Meteo value otherwise. Layer cloud
cover is capped at the NWS total. Open-Meteo's own dew point and cloud cover become `ctx.second`, so confidence still drops
one step when the two sources disagree by 5°F of dew point or 40 points of cloud. If the NWS fails the app runs on
Open-Meteo alone (banner warns); if Open-Meteo fails it runs on the NWS alone (cloud layers, air quality and pressure drop out and
their factors renormalize away). Line-of-sight points get the same merge. NWS layer units are converted by the layer's own unit code.

Measured on the recorded Andover week: the two sources differ by 2.3°F of dew point on average, and Clarity hour scores
move by 6.4 points on average (test: `nws-primary.test.mjs`). Weights and curves are unchanged.

Not verified: that NWS dew point is a better predictor of real clarity than Open-Meteo's (needs the shot log, M5). The 24-hour
post-front signal compares NWS hours with Open-Meteo hours for the first day of the grid, a seam of about 2°F of noise.
