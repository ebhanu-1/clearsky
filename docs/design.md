# Photo Clarity App: Product & Technical Spec

**Status: draft 1.** The four tabs after this one supersede it where they differ. Start with Design decisions; the Milestones table in the Build plan replaces the roadmap in section 8, and Data and history plus Scoring and profiles replace sections 3 and 5. Sections 1, 2 and 6 (goals, use cases, UI) still stand, with scope widened to every US zip and every shoot type.

## 1. Overview

The app takes a US zip code and returns an hour-by-hour score for how clear the air will be for photography, so you can pick the day and hour before driving anywhere. No existing app gives a general haze and clarity score for landscape and telephoto work; sunrise-color apps and astronomy cloud apps cover adjacent needs only.

**Problem.** Distant scenes shot in humid or hazy air come out flat, and dehaze in post adds contrast and noise without recovering detail. The fix is choosing the right day and hour, which today means manually reading dew point, wind direction, fronts, visibility and smoke across several weather sites.

**Goal.** One screen: enter zip, see a 0-100 Clarity Score per hour for the next 7 days, the best shooting windows, and a plain-language reason for each score.

**In scope for v1.** Clarity score, best-window finder, sunrise/sunset color and fog sub-scores, per-factor breakdown, US zip codes only, single-file HTML.

**Out of scope for v1.** Accounts, photo upload, non-US locations, push notifications, astronomy (Milky Way, aurora), and an iPhone build. These come in later phases.

## 2. Users and use cases

The primary user is one serious hobbyist photographer (you) shooting landscape and telephoto work from the Boston area, with the app generalizable to any US zip code.

| # | Use case | Question the app answers | Output |
| --- | --- | --- | --- |
| 1 | Pick the day | Which of the next 7 days is clearest? | Daily best score and best hour |
| 2 | Pick the hour | When exactly should I be on location? | Hourly score bars with top 3 windows highlighted |
| 3 | Understand why | Why is Saturday a 38 and Sunday a 82? | Factor breakdown and a one-line reason |
| 4 | Sunrise or sunset | Will the light have color, or will haze flatten it? | Sunrise and sunset sub-scores |
| 5 | Fog hunt | Will there be morning fog in valleys and over water? | Fog potential sub-score |
| 6 | Learn | Are my thresholds right for my gear and subjects? | Shot log and calibration view (Phase 3) |

**Design principle.** Every number shown has a stated reason. A score with no explanation would not teach you what to look for in a raw forecast, which is half the value.

## 3. Data sources

All v1 inputs are free and keyless. The NWS does not take a zip code, so the app first converts the zip to coordinates, then resolves the NWS grid.

| Need | Source | Call | Notes |
| --- | --- | --- | --- |
| Zip to lat/lon | [Zippopotam.us](https://docs.zippopotam.us/docs/getting-started/) | `GET api.zippopotam.us/us/{zip}` | Free, no key, CORS enabled. Has gaps for some real zips, so fall back to Nominatim (needs User-Agent, 1 req/sec). |
| Grid lookup | [NWS /points](https://www.weather.gov/documentation/services-web-api) | `GET api.weather.gov/points/{lat},{lon}` | Returns `forecastGridData` URL. Cache per zip; re-check periodically as grid values can change. |
| Raw hourly weather | [NWS gridpoints](https://weather-gov.github.io/api/gridpoints) | `GET` the `forecastGridData` URL | Layers used: temperature, dewpoint, relativeHumidity, skyCover, windDirection, windSpeed, visibility, mixingHeight, transportWindSpeed, ceilingHeight. Values are time-interval series (ISO 8601 `validTime` with duration), so expand to hourly. |
| Text forecast, cross-check | NWS `forecastHourly` | URL from `/points` | Easier to read; use for short-forecast labels and sanity checks. |
| Smoke and particulates | [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) | `air-quality-api.open-meteo.com/v1/air-quality?hourly=pm2_5,pm10,aerosol_optical_depth,dust,us_aqi&forecast_days=7` | Free for non-commercial use, no key. Aerosol optical depth is the best single haze proxy. |
| Sun times | Computed locally | NOAA solar equations in JS | No network call; also gives golden-hour and blue-hour windows. |

**Requirements.** Every NWS request must carry a User-Agent that identifies the app, ideally with a contact email. NWS rate limits are not published, so cache the grid response for 1 hour and the zip lookup indefinitely.

**Open items to test on day one.** (1) Whether api.weather.gov responds with CORS headers to browser requests; if not, a 20-line proxy (Cloudflare Worker) is needed and a browser-only v1 is not possible. (2) How often the NWS `visibility` layer is populated for your grid; if sparse, derive visibility from dew point spread, aerosol optical depth and PM2.5 instead. (3) Open-Meteo CORS behavior from a local file versus a hosted page.

## 4. Architecture

v1 is one static HTML file with no backend and no build step: the browser fetches, scores and draws everything, so it runs from a local file or any static host.

> [Diagram omitted: v1 architecture · 6 modules, 3 external APIs]

The scoring engine is the only module with real logic and is written as pure functions of an hourly record, so the same code can be reused unchanged in the iPhone version.

**v1 stack.** Plain JavaScript (ES modules), inline SVG for the chart, no framework, light background per your preference. Files: `index.html` with sections for `geo.js`, `fetch.js`, `score.js`, `ui.js` inlined for single-file delivery.

**Caching.** Zip to coordinates cached forever; NWS grid cached 1 hour; air quality cached 1 hour; recent zips and shot log in `localStorage`.

**Error handling.** Each data source fails independently. If air quality is down, the score is computed without the particulate term and flagged as partial; if NWS visibility is missing, it is derived (section 5).

**iPhone path.** Phase 4 rebuilds the UI in SwiftUI and ports `score.js` to Swift against the same test fixtures. Phase 4 also adds a WeatherKit or background-refresh push alert for windows scoring above a threshold. A backend is only added if NWS CORS or rate limits force it.

## 5. Scoring model

Each hour gets a Clarity Score from 0 to 100: a weighted sum of seven factor scores, multiplied by penalties for rain and fog. Thresholds below are starting heuristics from the weather discussion in this chat, not published standards; section 7 is how they get tuned against your own keepers.

```latex
S_h = \left(\sum_{i=1}^{7} w_i \, s_i(x_{i,h})\right) \times M_h, \qquad \sum_i w_i = 100,\; s_i \in [0,1]
```

Each `s_i` is piecewise linear between the anchor points listed. Anything beyond the first or last anchor holds that anchor's value.

### Factor table

| # | Factor | Weight | Input (source) | Anchors: value to factor score | Why it matters |
| --- | --- | --- | --- | --- | --- |
| 1 | Dew point | 30 | dewpoint, °F (NWS) | 30 or less: 1.0; 40: 0.85; 50: 0.5; 60: 0.15; 65 or more: 0 | Absolute moisture in the air; the best single haze predictor. |
| 2 | Particulates | 20 | PM2.5 µg/m³ and aerosol optical depth (Open-Meteo) | PM2.5: 5: 1.0; 12: 0.75; 35: 0.2; 55: 0. AOD: 0.1: 1.0; 0.3: 0.6; 0.6: 0.2; 1.0: 0. Factor = the lower of the two | Smoke and pollution wash out distance even on dry days. |
| 3 | Wind regime | 15 | windDirection, windSpeed (NWS) | Direction: NW 1.0, N 0.9, W 0.8, NE 0.4, SW 0.35, E 0.25, S 0.2, SE 0.2. Speed multiplier: under 3 mph 0.8; 3 to 15: 1.0; 15 to 25: 0.9; over 25: 0.7 | NW flow brings dry continental air in New England; calm air lets haze pool; strong wind shakes telephoto. |
| 4 | Visibility | 10 | visibility, miles (NWS) | 10 or more: 1.0; 6: 0.6; 3: 0.25; 1 or less: 0 | Direct check on the above. Saturates near 10 miles, so it only catches bad cases. |
| 5 | Post-front signal | 10 | Dew point change over prior 24 h plus wind direction (NWS) | Dew point down 10°F or more with N to W wind: 1.0; down 5 to 10: 0.75; flat: 0.5; up 5 or more: 0.2 | First full day after a cold front is the classic clear-air day. |
| 6 | Sky cover | 10 | skyCover, % (NWS) | 0 to 70%: 1.0; 85%: 0.8; 100%: 0.6 | Full overcast flattens contrast; scattered cloud does not hurt distant clarity. |
| 7 | Humidity | 5 | relativeHumidity, % (NWS) | 40 or less: 1.0; 50: 0.85; 70: 0.4; 85: 0.1; 95 or more: 0 | Secondary to dew point but keeps the score honest when forecasts disagree. |

### Multipliers and flags

| Condition | Effect |
| --- | --- |
| Probability of precipitation over 30% | M × 0.5; over 60%: × 0.25 |
| Fog: temperature minus dew point 3°F or less and humidity 95% or more | M × 0.4 for clarity; raises the Fog sub-score instead |
| Sun elevation under 0° (night) | Hour not scored for clarity; shown as grey |
| Heat shimmer: 11:00 to 16:00, temperature over 70°F, sun elevation over 35° | Flag only, not in score: warns that telephoto work will soften |

Bands: 80 to 100 Excellent, 60 to 79 Good, 40 to 59 Fair, 20 to 39 Poor, under 20 Skip.

### Sub-scores

**Sunrise and sunset color.** Computed for the hour at sunrise and sunset: 50% cloud shape, 25% horizon clarity, 25% dryness. Cloud shape peaks at 40 to 60% sky cover (1.0), falls to 0.6 at 20%, 0.4 at 0%, 0.5 at 80% and 0.1 at 100%. Horizon clarity is the average of visibility and particulate factors. Dryness is the dew point factor. v1 only has total sky cover; Phase 2 adds layered cloud cover (low, mid, high), which Open-Meteo's forecast API appears to offer and should be confirmed before building, since high and mid cloud is what actually lights up.

**Fog potential.** Scored for 03:00 to 09:00 local: product of spread factor (3°F or less: 1.0; 6: 0.5; 10 or more: 0), humidity factor (95% or more: 1.0; 85: 0.4; 75 or less: 0), wind factor (under 4 mph: 1.0; 8: 0.4; 12 or more: 0), and sky factor (0 to 60% cover: 1.0; 100%: 0.5).

### Reason generator

For each hour and day, compute each factor's contribution as weight × (factor score minus 0.5). The two largest positives and two largest negatives become plain-language reasons from templates, for example: "Dew point 34°F (dry air, +)" and "PM2.5 at 28 µg/m³ (smoke, −)". Daily score = the best 3-hour consecutive window average within daylight, with the window shown.

## 6. UI specification

v1 is a single scrolling page on a light background with a zip box at the top and three stacked panels. Design is data-first: one chart, one list, one explanation.

| Panel | Contents | Behavior |
| --- | --- | --- |
| Header | Zip input, resolved place name, "data as of" time, units toggle (°F/°C, mph/km/h) | Enter or button triggers fetch; last 5 zips saved as chips; invalid zip shows an inline message |
| Week strip | 7 day cards: date, best-window score with band color, best window time, one-line reason | Click selects the day; best day outlined |
| Hourly chart | Bars for each daylight hour colored by band, a line for dew point, shading for sunrise and sunset, markers for fog hours | Hover shows all seven factor values for that hour; top 3 windows labeled |
| Why panel | Top two positives and two negatives for the selected hour or window, plus flags (fog, shimmer, smoke, rain) | Updates on hover or click |
| Sunrise and sunset card | Color score, fog potential, sun and golden-hour times for the selected day | Shows "cloud layers not available" note until Phase 2 |
| Raw data table | Collapsible table of the hourly inputs and factor scores | Lets you cross-check the score against a normal weather app |

**Visual rules.** White or off-white background, single sequential color ramp for bands (no red-green only encoding, so it works for color-blind readers), tabular numerals, minimum 12 px type. Per the dataviz conventions, use direct labels on the chart over a legend where possible.

**States.** Loading skeleton per panel; partial-data banner when a source is down; empty state asks for a zip; offline shows the last cached result with its timestamp.

**Acceptance checks for v1.** (1) Entering 01810 returns a 7-day view in under 5 seconds on a normal connection. (2) Every score has at least two reasons. (3) Changing units changes every displayed value with no recalculation drift. (4) Works with no data from Open-Meteo, flagged as partial.

## 7. Calibration loop

The starting weights are educated guesses; the app earns its value by learning which conditions gave you clean files. Calibration is a simple regression problem, not machine learning.

**Shot log.** After a shoot, log date, hour range, zip, subject type (distant ridgeline, mid-distance, close subject, sunrise or sunset), and a 1 to 5 clarity rating of the keepers at 100% in your editor. The app stores the hourly inputs and factor scores that were forecast for those hours, and ideally the observed values afterward.

| Step | What happens |
| --- | --- |
| 1. Capture | Each log entry snapshots all seven factor scores and the overall score for the matching hours |
| 2. Compare | Scatter of predicted score against your rating, with correlation and a residual list |
| 3. Diagnose | Per-factor correlation with rating; flags a factor whose weight looks too high or too low |
| 4. Refit | After 30 or more entries, fit weights by constrained least squares (non-negative, sum to 100) and show old versus new weights for approval |
| 5. Version | Weights saved as a named profile (for example "Telephoto landscape") so subject types can have different tunings |

**Why subject profiles.** A close-subject portrait cares little about 20-mile visibility, while a ridgeline at 30 miles cares about almost nothing else. Separate weight sets per subject avoid one compromise score.

**Forecast versus observation.** Forecast error in dew point and wind is part of the signal. Phase 3 also pulls the nearest NWS observation station reading for the shoot hour, so you can tell a bad forecast apart from a bad model.

**Cold start.** Until 30 entries exist, show the default model and a note that it is untuned. Import from a CSV (date, hour, zip, rating) so past New Hampshire trips can seed the log.

## 8. Phases, risks and open questions

Build order is HTML v1 first, then richer light modeling, then calibration, then the iPhone app; no phase starts until the gate before it passes.

> [Diagram omitted: roadmap · 4 phases, 3 gates, not to scale]

Phase 1 is the only one to commit to now. Its gate has two parts: the browser can call the NWS directly, and the scores for five past days you remember well agree with your own memory of how clear they were.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| NWS blocks browser calls (no CORS) | A pure static page cannot work | Small proxy (Cloudflare Worker, about 20 lines) added in Phase 1 |
| NWS visibility layer sparse | Visibility factor unreliable | Derive from dew point spread, aerosol depth and PM2.5; reweight |
| Zippopotam.us missing some zips | Lookup fails for valid zips | Fall back to Nominatim with User-Agent and 1 request per second |
| Forecast skill falls after day 3 | Days 5 to 7 overstated | Fade those days visually and label "low confidence" |
| Small-sample overfit in calibration | Weights chase noise | Require 30 entries, show old vs new weights, non-negative constrained fit |
| Open-Meteo free tier is non-commercial | Limits public or App Store release | Personal use is fine; check terms before any public release in Phase 4 |
| Thresholds are New England tuned | Wrong in the West or Southwest | Wind-direction table and dew point anchors are config, not code |

### Open questions for you

- [ ] Home region only (Boston area) for now, or any US zip from day one? This decides how much of the wind table needs to be configurable.
- [ ] Which subject types should get separate weight profiles first (distant ridgelines, sunrise and sunset, telephoto wildlife)?
- [ ] Will you open the page from a local file or host it? Local files can hit extra browser restrictions on API calls.
- [ ] Units: °F and miles by default, with a toggle, correct?
- [ ] Do you want a name for it before we write any code?


---

# Design decisions

Twenty-two decisions fix the stack, data sources, scoring approach and scope, so Claude Code can build without re-deciding them; each row says what would reopen it.

## Decision log

| ID | Decision | Alternative rejected | Why | Reopen if |
| --- | --- | --- | --- | --- |
| D1 | Scope: any US zip and every shoot type, via profiles; non-US later | Home region only; one score | You want it for everything; profiles stop one score from being a compromise | Non-US demand (the blocker is geocoding, not weather) |
| D2 | Primary weather: Open-Meteo Forecast API | NWS grid as primary | One keyless call returns dew point, visibility, low/mid/high cloud, boundary layer height, pressure, precipitation and wind, plus 92 past days and up to 16 forecast days | Free-use limits prove too low, or accuracy is poor in a test region |
| D3 | Second opinion: NWS gridpoints adapter in Phase 2 | NWS only; no second source | Official forecaster-edited US grid; disagreement with Open-Meteo feeds the confidence rating | Browsers cannot call NWS and no proxy is wanted |
| D4 | Smoke and haze: Open-Meteo Air Quality (PM2.5, PM10, aerosol optical depth, dust) | AirNow; PurpleAir | Same API family, keyless, hourly; aerosol depth is a direct haze proxy | Smoke forecasts prove too coarse in a wildfire test |
| D5 | History: ERA5 via Open-Meteo Archive for climate; IEM ASOS for observed visibility; Open-Meteo Previous Runs for forecast skill | NOAA ISD direct; Meteostat | ERA5 reaches back to 1940 but has no visibility; IEM adds observed visibility; Previous Runs gives fixed-lead forecasts from January 2024 | A source changes its terms |
| D6 | Location: zip first, then raw lat/lon and saved spots in Phase 2 | Zip only | A zip centroid misses terrain; photographers shoot at specific spots | None |
| D7 | Geocoding: Zippopotam.us, Nominatim as fallback | Census geocoder | CORS enabled and keyless; known gaps covered by the fallback | Fallback gets rate-limited in practice |
| D8 | Dew point scored as 0.6 absolute plus 0.4 anomaly against same-date local climatology | Absolute only | A 55°F dew point is dry in Florida in July and humid in Montana; the anomaly term makes the model national | Backtest shows the anomaly term adds nothing |
| D9 | Profiles: weight sets and factor subsets in JSON, user-cloneable | One global score | Foliage wants humid soft light, distant ridgelines want dry air; the weights are opposite | None |
| D10 | Stack: TypeScript, Preact, Vite, Vitest; build to one HTML file with vite-plugin-singlefile | Plain JS; React; Svelte | Types protect the scoring math; small bundle; single file meets your standalone-HTML preference | Bundle exceeds 200 KB gzipped |
| D11 | Core library: dependency-free pure functions with JSON golden fixtures | Logic inside UI components | The same fixtures verify the Swift port later | None |
| D12 | Backend: none in v1; Cloudflare Worker proxy only if spike S1 shows browsers are blocked | Always proxy | Fewer moving parts; the Worker later hosts alerts | Spike S1 fails |
| D13 | Distribution: web page, then installable PWA; native decision deferred to Gate D (Capacitor vs SwiftUI) | Native first | Fastest path to daily use; iOS can install web apps to the home screen | Background alerts become a must-have |
| D14 | Internal units SI; display toggle with °F, mph, miles as default | Store display units | Avoids conversion bugs | None |
| D15 | Score is 0 to 100 per hour with five bands; daily value is the best 3-hour window within the profile's relevant hours | Daily mean | You shoot windows, not days | None |
| D16 | Confidence shown separately from score, from lead time, provider disagreement and forecast spread | Fold into score | A 90 on day 6 should not look like a 90 on day 1 | None |
| D17 | Recent history rides the main call with past_days=2 for trend and rain features | Separate history call | One fewer request; same model run | None |
| D18 | Calibration: ridge-regularized non-negative least squares shrunk toward default weights, per profile, at least 30 labeled hours | Free regression; manual tuning | Prevents overfitting small samples | Over 500 labeled hours exist |
| D19 | Labels: image-derived haze metrics from your photo library (offline Python tool) plus optional 1 to 5 rating | Manual rating only | Years of dated, geotagged photos become training data at no effort | Image metric tracks scene content more than air clarity |
| D20 | Privacy: local only, no accounts, no analytics; only coordinates leave the device, to the weather APIs | Accounts and sync | Personal tool | Multi-user release |
| D21 | Time: store UTC, render in the location's time zone; compute sun position locally with NOAA equations | Provider sunrise times | Tested for DST and polar edge cases; no network dependency | None |
| D22 | Licensing: personal non-commercial use; show Open-Meteo and Copernicus ERA5 credits | Ignore terms | Open-Meteo separates non-commercial and commercial licences | Any public or paid release |

## What changed from draft 1

The first tab stays as the product-level draft; where it disagrees with this tab or the three after it, these tabs win.

| Topic | Draft 1 | Now | Reason |
| --- | --- | --- | --- |
| Primary data | NWS grid plus Open-Meteo air quality | Open-Meteo forecast and air quality; NWS as second opinion | One call gives visibility, layered clouds, boundary layer height and recent history, and covers every US zip |
| Wind | Compass table tuned to New England | Air-mass change signal plus a small regional wind prior | A northwest wind is not a clear-air signal everywhere in the country |
| Dew point | Absolute thresholds | Absolute plus anomaly against local climatology | Makes the same model work in Florida and Montana |
| Score | One clarity score | Profiles: Clarity, Golden light, Fog and mist, Reflections, Soft light (more later) | "Everything" means opposite weights for different shots |
| Sunrise color | Total cloud cover only | Low, mid and high cloud layers from day one | The forecast API lists all three, and mid and high cloud is what lights up |
| History | Shot log only | Seven uses: trends, rain scrub, climate anomaly, climatology, forecast skill, backtest, trip planner | You asked for prior weather to be part of the model |
| Calibration | Manual ratings, plain regression | Image-derived haze labels from your library, ridge-regularized fit | Years of past photos become labeled data |
| Stack | Plain JavaScript in one file | TypeScript monorepo built to one HTML file | Safer math and a clean port path to iPhone |

## Open questions

- [ ] What should the app be called? It becomes the repo name and page title.
- [ ] Region priors: ship five wind presets (Northeast, Southeast, Midwest, Mountain West, Pacific) now, or start Northeast only and add others after field tests?
- [ ] Where do your past photos live (Lightroom catalog, folders of NEF files, Apple Photos) and roughly how many years of geotagged shots exist? This decides the design of the photo-history tool in milestone 5.
- [ ] Is it acceptable to skip the Night sky and Aurora profiles until a later phase? Night sky needs a light-pollution dataset that is not yet chosen.
- [ ] Where will the page be opened from: a local file or a hosted address? A local file runs with an opaque origin, which can change whether browser calls to the APIs are allowed.
- [ ] Do you want push alerts enough to justify a native app, or is checking the page each morning fine?
- [ ] Confirm personal use only for now, since Open-Meteo's free tier is non-commercial.


---

# Data and history

Open-Meteo supplies the forecast, the last 92 days and climate history back to 1940 from one keyless API family, with IEM adding observed visibility and NWS acting as a second opinion.

## Source catalog

Ten inputs, nine of them network sources. The status column separates what the provider documentation confirms from what spike S1 to S5 must prove by a live call.

| Purpose | Source and endpoint | Variables used | Range and limits | Status |
| --- | --- | --- | --- | --- |
| Zip to coordinates | [Zippopotam.us](https://docs.zippopotam.us/docs/getting-started/): `api.zippopotam.us/us/{zip}` | lat, lon, place, state | CORS enabled per its docs; some real zips return 404 | Docs confirmed; fallback needed |
| Zip fallback | Nominatim (OpenStreetMap): `nominatim.openstreetmap.org/search` | lat, lon | Needs a User-Agent; 1 request per second | Test in S1 |
| Forecast plus recent past | [Open-Meteo Forecast](https://open-meteo.com/en/docs): `api.open-meteo.com/v1/forecast` | temperature_2m, relative_humidity_2m, dew_point_2m, precipitation, surface_pressure, cloud_cover, cloud_cover_low, cloud_cover_mid, cloud_cover_high, visibility, wind_speed_10m, wind_direction_10m, wind_gusts_10m, boundary_layer_height, is_day | past_days 0 to 92; forecast_days 0 to 16 (default 7) | Docs confirm visibility, cloud layers, dew point, pressure, boundary layer, precipitation, wind direction, is_day; confirm the rest in S2 |
| Air quality and smoke | [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api): `air-quality-api.open-meteo.com/v1/air-quality` | pm2_5, pm10, aerosol_optical_depth, dust, us_aqi | forecast_days 0 to 7, default 5 | Docs confirmed |
| Climate history | [Open-Meteo Historical Weather](https://open-meteo.com/en/docs/historical-weather-api) (ERA5): `archive-api.open-meteo.com/v1/archive` | dew_point_2m, relative_humidity_2m, precipitation, surface_pressure, wind_direction_10m, cloud_cover_low, cloud_cover_mid, cloud_cover_high | ERA5 from 1940 at about 25 km; 5-day delay; visibility not available | Docs confirmed |
| Observed history, including visibility | [IEM ASOS archive](https://mesonet.agron.iastate.edu/request/download.phtml): `mesonet.agron.iastate.edu/cgi-bin/request/asos.py` | vsby, dwpf, relh, drct, sknt, gust, skyc1 to skyc4, skyl1 to skyl4, p01i, alti, mslp, wxcodes | Data through the last day; 1,000 station-years per request when stations are named; archive is as-is with little quality control | Docs confirmed; CORS unknown (S4) |
| Forecast skill | [Open-Meteo Previous Runs](https://open-meteo.com/en/docs/historical-forecast-api): `previous-runs-api.open-meteo.com/v1/forecast` | Same variables at fixed 1 to 7 day lead | From January 2024 (GFS from March 2021) | Docs confirmed; host check in S5 |
| What the forecast said | Open-Meteo Historical Forecast: `historical-forecast-api.open-meteo.com/v1/forecast` | Same as forecast | From about 2022; stitches each run's first hours into one series | Docs confirmed |
| Second opinion (US) | [NWS API](https://www.weather.gov/documentation/services-web-api): `api.weather.gov/points/{lat},{lon}`, then the `forecastGridData` URL | dewpoint, relativeHumidity, skyCover, windDirection, visibility, mixingHeight | Needs an identifying User-Agent; limits unpublished | CORS unknown (S1) |
| Sun and moon | Local computation (NOAA solar equations or the SunCalc library) | Sun elevation and azimuth, golden and blue hour, moon phase and altitude | No network | Build and test |

Hostnames other than the main forecast API follow Open-Meteo's URL pattern and are confirmed by a live call in spike S2.

**Example request, Andover MA, ready for Claude Code to try first.**

```text
https://api.open-meteo.com/v1/forecast?latitude=42.66&longitude=-71.15&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,surface_pressure,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,boundary_layer_height,is_day&past_days=2&forecast_days=7&timezone=auto&wind_speed_unit=ms
```

**Licensing.** Open-Meteo's documentation lists non-commercial, commercial and self-hosted licences and requires an API key for commercial use. I did not read the pricing or terms pages, so the exact free call limits and attribution wording must be checked before any release beyond personal use.

## How weather history is used

History enters the model in seven ways, from a free by-product of the main call to a full backtest against your own photos.

| # | Use | Source | Feature computed | Feeds | Milestone |
| --- | --- | --- | --- | --- | --- |
| H1 | Air-mass trend: did a front just pass? | Forecast call with past_days=2 | dpTrend24 (dew point change over 24 h), pTrend12 (pressure change over 12 h), wind shift | Air-mass change factor | M4 |
| H2 | Rain scrub: rain washes particles out of the air | Same call | precip24 (mm in the last 24 h), hoursSinceRain (since the last hour at or above 0.2 mm) | Post-rain scrub factor; wet-foliage term in Soft light | M4 |
| H3 | Climate anomaly: how unusual is this air for the date? | ERA5 dew point at this location, 2015 to last full year, same calendar window and hour | dpPercentile (0 to 100) | Dew point factor (40% of it) | M4 |
| H4 | Climate context shown to the user | Same ERA5 pull | Share of days at this date with dry air; typical best hour by season | Badge such as "driest 10% for this date" | M4 |
| H5 | Forecast skill by lead time | Previous Runs against ERA5 | Bias and mean absolute error of dew point and cloud at lead days 1 to 7 | Confidence tiers (D16) | M5 |
| H6 | Backtest against your photos | ERA5 and IEM observed visibility at each photo's time and place | Factor scores as-if, correlated with image haze metrics | Weight refit | M5 |
| H7 | Trip planner | ERA5, reduced factor set | Share of past years' days at a place and date range that reach Good or better under a profile | Planner screen | M6 |

**Reduced factor set.** ERA5 has no visibility and no air quality, so any score computed from history alone (H6 without IEM, H7) renormalizes the weights over the factors available and is labeled "history estimate" in the UI.

**Climatology payload.** One hourly dew point series from 2015 to the last full year is about 90,000 values per location. The app downloads it once, reduces it to a table of mean and standard deviation by day-of-year window and hour, and caches the table for 90 days. Spike S3 measures the real download size and time.

**Forecast verification loop.** Each time the app loads, it stores the dew point, cloud and visibility forecast for the next 72 hours. A day later it compares them with Open-Meteo's analysis for those hours and, for visibility, with the nearest IEM station. Over weeks this gives a personal error table per location without any external dataset.

## Normalized data model

Every provider adapter outputs the same hourly record, so the scoring core never sees provider-specific field names. Values are SI and timestamps are UTC.

```typescript
export type ProviderId = 'open-meteo' | 'nws' | 'iem' | 'era5';
export type Band = 'excellent' | 'good' | 'fair' | 'poor' | 'skip';
export type ProfileId = 'clarity' | 'golden' | 'fog' | 'reflections' | 'soft' | 'wildlife' | 'night' | 'aurora';
export type FactorId =
  | 'dewpoint' | 'particulates' | 'visibility' | 'ventilation' | 'airmass' | 'rainScrub'
  | 'windRegime' | 'humidity' | 'skyCover' | 'skyColor' | 'lowCloudClear' | 'fogPotential'
  | 'calm' | 'precipGate' | 'lightWindow' | 'heatShimmer';

export interface HourlyRecord {
  t: string;                // ISO 8601 UTC, top of the hour
  tempC: number;
  dewC: number;
  rh: number;               // 0-100
  windMs: number;
  gustMs: number | null;
  windDirDeg: number;       // direction wind blows FROM
  cloudTotal: number;       // 0-100
  cloudLow: number; cloudMid: number; cloudHigh: number;
  visM: number | null;      // null when the provider omits it
  precipMm: number;
  pressHpa: number;
  pblM: number | null;      // boundary layer height
  isDay: boolean;
  pm25: number | null; pm10: number | null; aod: number | null;
  dust: number | null; aqiUs: number | null;
  src: { weather: ProviderId; air: ProviderId | null };
}

export interface Place {
  zip: string | null; lat: number; lon: number;
  name: string; state: string; tz: string; elevM: number;
}

export interface Climatology {      // from ERA5, cached 90 days
  years: [number, number];
  dew: Record<string, { mean: number; sd: number }>;  // key: dayWindow-hour
}

export interface Context {
  place: Place;
  past: HourlyRecord[];             // last 48 h
  future: HourlyRecord[];           // next 7 to 16 days
  climo: Climatology | null;
  secondOpinion: HourlyRecord[] | null;
  sun: { t: string; elevDeg: number; azDeg: number }[];
}

export interface Derived {          // computed per hour from Context
  dpTrend24: number | null; pTrend12: number | null;
  precip24: number; hoursSinceRain: number | null;
  spreadC: number; sunElevDeg: number; sunAzDeg: number;
  dpPercentile: number | null; leadHours: number;
}

export interface FactorResult {
  id: FactorId; raw: number | null; score: number;   // score 0..1
  weight: number; contribution: number;
}

export interface HourScore {
  t: string; profile: ProfileId; score: number; band: Band;
  factors: FactorResult[]; flags: string[];
  confidence: 'high' | 'medium' | 'low';
  reasons: { factor: FactorId; sign: 1 | -1; text: string }[];
}

export interface ShootWindow {
  start: string; end: string; score: number; profile: ProfileId;
}
```

## Caching, limits and failure handling

Each source fails on its own, and a failure lowers detail rather than blocking the page.

| Item | Rule |
| --- | --- |
| Zip lookup | Cache forever in localStorage |
| Forecast and air quality | Cache 60 minutes; refetch on focus when older |
| Climatology table | Cache 90 days in IndexedDB |
| NWS second opinion | Cache 60 minutes |
| IEM observations for past days | Cache 24 hours; old days never change |
| Forecast snapshots for verification | Keep 120 days |
| Request timeout | 8 seconds each |
| HTTP 429 or 5xx | Retry after 1 s, 2 s, 4 s, then fall back to cache |

| Failure | Behavior |
| --- | --- |
| Zip not found | Try Nominatim, then ask for lat/lon |
| Forecast call fails | Show the last cached result with its age; with no cache, show an error and a retry button |
| Air quality fails | Score without particulates, renormalize the weights, show "partial: smoke not included" |
| Visibility is null | Drop the visibility factor and renormalize; a calibrated proxy arrives in milestone 5 |
| Climatology fails | Drop the anomaly term; dew point uses its absolute term only |
| Second opinion fails | Confidence falls back to lead-time tiers only |
| Polar night or midnight sun | No golden window; show the sun-elevation curve and skip sun-dependent factors |
| Daylight-saving change days | Covered by tests; all storage is UTC |
| Offline | Show the cached result with its timestamp |


---

# Scoring and profiles

Scoring is a library of 16 factors combined by shoot-type profiles, so the same weather can score high for fog and low for distant clarity.

## Model structure

For each hour and each profile, the core computes derived features, scores each factor from 0 to 1 with a piecewise-linear curve, takes the profile's weighted average over the factors that have data, and multiplies by gates.

```latex
S_h = \mathrm{clamp}_{[0,100]}\left(100 \cdot \frac{\sum_{i \in A_h} w_i\, s_i}{\sum_{i \in A_h} w_i} \cdot G_h\right), \qquad G_h = \mathrm{floor} + (1-\mathrm{floor})\, s_{precip}
```

`A_h` is the set of factors with data for that hour, so a missing visibility or air-quality value renormalizes the weights instead of scoring as zero. `floor` is set per profile.

```latex
s_{dew} = 0.6\, s_{abs}(T_d) + 0.4\, s_{anom}(P_d), \qquad P_d = 100\,\Phi\!\left(\frac{T_d - \mu_{d,h}}{\sigma_{d,h}}\right)
```

`μ` and `σ` come from the cached ERA5 climatology for the same day-of-year window and hour. The normal approximation is rough for dew point, so milestone 5 checks it against empirical percentiles.

| Derived feature | Definition |
| --- | --- |
| dpTrend24 | Dew point now minus dew point 24 hours earlier |
| pTrend12 | Pressure now minus pressure 12 hours earlier |
| precip24 | Sum of hourly precipitation over the previous 24 hours |
| hoursSinceRain | Hours since the last hour with 0.2 mm or more |
| spread | Temperature minus dew point |
| sunElev, sunAz | Computed locally for the place and hour |
| leadHours | Hours between the forecast issue time and the target hour |

**Scoring hours.** Day profiles score hours with sun elevation above −4°, which includes the light before sunrise; other hours show grey. Fog scores 03:00 to 09:00 local. Bands: 80 to 100 Excellent, 60 to 79 Good, 40 to 59 Fair, 20 to 39 Poor, below 20 Skip.

**Caps.** A weighted average lets strong scores elsewhere hide smoke or thick haze, so profiles can declare limiting factors: if any listed factor scores below 0.2, the hour cannot exceed 59 (Fair). Clarity caps on dewpoint, particulates and visibility; Golden light caps on particulates and visibility; the other profiles declare none. Golden scenario 3 in the Build plan tests this.

**Windows.** The daily headline is the best 3-hour run of consecutive scored hours, shown with its start and end.

**Reasons.** Contribution of factor i = w_i × (s_i − 0.5) ÷ sum of weights. The two largest positive and two largest negative contributions become reasons from text templates keyed by factor and sign, with the raw value filled in.

## Factor library

Sixteen factors. Anchors are shown in US units for readability and stored in SI in the profile JSON. Between anchors the curve is linear; outside them it holds the end value. These are starting heuristics, to be tuned by backtest (below).

| # | Factor | Input | Anchors (value: score) | Notes |
| --- | --- | --- | --- | --- |
| 1 | dewpoint | Dew point, plus climate percentile | Absolute °F: 30 or less: 1.0; 40: 0.85; 50: 0.5; 60: 0.15; 65 or more: 0. Percentile: 10 or less: 1.0; 50: 0.5; 90 or more: 0 | 0.6 absolute plus 0.4 percentile; absolute only if no climatology |
| 2 | particulates | PM2.5 and aerosol optical depth | PM2.5 µg/m³: 5: 1.0; 12: 0.75; 35: 0.2; 55: 0. AOD: 0.1: 1.0; 0.3: 0.6; 0.6: 0.2; 1.0: 0 | Lower of the two; dust above 50 µg/m³ raises the dust flag |
| 3 | visibility | Visibility | Miles: 10 or more: 1.0; 6: 0.6; 3: 0.25; 1 or less: 0 | Saturates near 10 miles; catches bad cases |
| 4 | ventilation | Boundary layer height | Metres: 1500 or more: 1.0; 800: 0.7; 400: 0.35; 200 or less: 0.1 | Used only when sun elevation is above 10°; a deep mixed layer disperses haze |
| 5 | airmass | dpTrend24, pTrend12 | Dew point change °F: −10 or lower: 1.0; −5: 0.75; 0: 0.5; +5: 0.2; +10 or more: 0.05. Add 0.1 if pressure rose 3 hPa or more in 12 h (cap 1) | The post-front signal, with no compass assumption |
| 6 | rainScrub | precip24, hoursSinceRain | 2 mm or more in 24 h and 3 to 36 h since rain: 1.0 falling to 0.5 at 36 h; under 0.2 mm: 0.5; raining now: 0.3 | Rain removes particles from the air |
| 7 | windRegime | Speed, direction | Speed multiplier (mph): under 3: 0.8; 3 to 15: 1.0; 15 to 25: 0.9; over 25: 0.7. Score = multiplier × direction prior d, with d in 0.4 to 1.0 from a regional preset and d = 1 with no preset | Direction is a prior, not a rule |
| 8 | humidity | Relative humidity | %: 40 or less: 1.0; 50: 0.85; 70: 0.4; 85: 0.1; 95 or more: 0 | Secondary to dew point |
| 9 | skyCover | Total cloud | %: 70 or less: 1.0; 85: 0.8; 100: 0.6 | Clarity curve; profiles may override |
| 10 | skyColor | Larger of mid and high cloud | %: 0: 0.3; 20: 0.6; 40 to 60: 1.0; 80: 0.5; 100: 0.15 | Mid and high cloud catches sunrise and sunset light |
| 11 | lowCloudClear | Low cloud | %: 10 or less: 1.0; 30: 0.6; 60: 0.2; 80 or more: 0 | Low cloud blocks the horizon |
| 12 | fogPotential | Spread, humidity, wind, sky cover | Product of: spread °F (3 or less: 1.0; 6: 0.5; 10 or more: 0), humidity % (95 or more: 1.0; 85: 0.4; 75 or less: 0), wind mph (under 4: 1.0; 8: 0.4; 12 or more: 0), cloud % (60 or less: 1.0; 100: 0.5) | Scored 03:00 to 09:00 local only |
| 13 | calm | Wind and gusts | Wind mph: 2 or less: 1.0; 4: 0.8; 7: 0.4; 10 or more: 0. Multiply by 0.7 if gust exceeds twice the wind and 8 mph | For reflections, macro, long exposure |
| 14 | precipGate | Hourly precipitation | mm: 0.05 or less: 1.0; 0.3: 0.5; 1.0 or more: 0.15 | Also applied as gate G with a per-profile floor |
| 15 | lightWindow | Sun elevation | Degrees: −4 to 0: 0.8; 0 to 6: 1.0; 6 to 15: 0.8; 15 to 30: 0.5; above 30: 0.2; below −4: 0 | Profiles may override, for example wildlife |
| 16 | heatShimmer | Temperature when sun elevation is above 35° | °F: 70 or less: 1.0; 80: 0.8; 90 or more: 0.5 | Telephoto softening; also raised as a flag |

## Profiles

A profile is a weight vector over the 16 factors, a gate floor and optional curve overrides, stored as JSON. Weights in each column sum to 100. The same weather scores very differently by profile: dry air lifts Clarity and lowers Soft light.

| Factor | Clarity | Golden light | Fog and mist | Reflections | Soft light | Wildlife |
| --- | --- | --- | --- | --- | --- | --- |
| dewpoint | 30 | 10 |  | 5 |  | 5 |
| particulates | 18 | 10 |  | 5 |  |  |
| visibility | 10 | 10 |  | 5 |  | 5 |
| ventilation | 8 |  |  |  |  |  |
| airmass | 10 | 10 |  | 5 |  |  |
| rainScrub | 6 | 5 |  |  | 15 |  |
| windRegime | 8 |  |  |  |  |  |
| humidity | 4 |  |  | 10 |  |  |
| skyCover | 6 |  |  | 35 | 15 |  |
| skyColor |  | 35 |  | 10 |  |  |
| lowCloudClear |  | 15 |  |  |  |  |
| fogPotential |  |  | 70 |  | 10 |  |
| calm |  | 5 | 15 | 45 | 15 | 20 |
| precipGate |  |  |  | 5 | 15 | 20 |
| lightWindow |  |  | 15 | 20 |  | 25 |
| heatShimmer |  |  |  |  |  | 10 |
| Gate floor | 0.15 | 0.15 | 0.30 | 0.15 | 0.60 | 0.15 |
| Ships in | v1 | v1 | v1 | v1 | v1 | Phase 2 |

**Curve overrides.**

- Soft light: skyCover 70% or more: 1.0, 40%: 0.5, 10% or less: 0.1. humidity 70% or more: 1.0, 50%: 0.5, 30% or less: 0.1. rainScrub 1.0 when at least 1 mm fell in the last 24 h and 1 to 12 h have passed since rain, 0.6 from 12 to 36 h, otherwise 0.3 (wet foliage saturates).
- Fog and mist: lightWindow sun elevation −4° to 8°: 1.0, 8° to 15°: 0.6, above 15°: 0.2, below −4°: 0.5.
- Wildlife: lightWindow 3° to 25°: 1.0, 25° to 40°: 0.6, above 40°: 0.2, below 3°: 0.6. skyCover 60% or less: 1.0, 100%: 0.7.

**Profile file format.**

```json
{
  "id": "clarity",
  "name": "Clarity",
  "description": "Distant landscape and telephoto work",
  "weights": { "dewpoint": 30, "particulates": 18, "visibility": 10, "ventilation": 8,
               "airmass": 10, "rainScrub": 6, "windRegime": 8, "humidity": 4, "skyCover": 6 },
  "gate": { "floor": 0.15 },
  "caps": [{ "factors": ["dewpoint", "particulates", "visibility"], "below": 0.2, "max": 59 }],
  "hours": { "minSunElevDeg": -4 },
  "curves": {}
}
```

**Not yet specified.** Night sky (cloud cover, transparency, moon altitude and phase, light pollution) and Aurora (geomagnetic Kp forecast, cloud, darkness) need data sources that have not been verified. NOAA's Space Weather Prediction Center is the likely source for Kp. Both are Phase 4 candidates and have no weights yet.

**Terrain.** Fog and ridge-top inversions depend on valleys, water and elevation, which a zip centroid cannot represent. The Fog profile is labeled "area-level" until saved spots with exact coordinates arrive in Phase 2.

## Confidence

Confidence is a separate three-level rating shown beside each score as dots, and it never changes the score. A day-6 score of 85 and a day-1 score of 85 should look different.

| Input | Rule | Effect |
| --- | --- | --- |
| Lead time | Up to 48 h: high; 49 to 96 h: medium; beyond 96 h: low | Starting tier |
| Provider disagreement | Open-Meteo and NWS dew point differ by 5°F or more, or cloud cover differs by 40 points or more | Down one tier |
| Measured local skill | Verification table shows dew point error above 6°F at that lead | Down one tier |

The numeric cutoffs are placeholders. Milestone 5 replaces them with values measured from the Previous Runs API against ERA5, by lead day, for dew point and cloud cover. Low-confidence bars render faded in the hourly chart.

## Backtest and calibration

The default weights are hypotheses. Three layers of evidence test them, from cheapest to richest, and the photo layer is what makes the model yours.

| Layer | Evidence | Needs | What it tests |
| --- | --- | --- | --- |
| 1. Weather-only check | Computed Clarity score from ERA5 against observed visibility at the nearest ASOS airport (IEM), over 10 or more years | Nothing from you | Whether low scores really coincide with low observed visibility; the 10-mile cap on reported visibility means this catches bad days well and tells little at the top end |
| 2. Photo-history backtest | Image haze metrics from your own dated, geotagged photos against weather at the capture hour | Your library, one offline tool run | Which factors predict clean files for your camera, lenses and subjects |
| 3. Outing log | A 1 to 5 rating and hour range after each shoot | 30 seconds per outing | Anchors the image metrics to your judgment and covers shots not in the library |

### Photo-history tool (milestone 5)

An offline Python command-line tool, run on the computer that holds the photos. It reads files read-only, uploads nothing, and writes one CSV.

1. **Read metadata** with exiftool: capture time with offset, GPS, focal length, aperture, ISO, flash, lens.
2. **Filter** to daylight frames (sun elevation above 0°), with GPS, no flash, ISO 800 or lower, aperture f/5.6 to f/16, and focal length 24 mm or longer. These keep landscape-like frames and drop portraits and macro.
3. **Extract a preview**: the embedded JPEG from each NEF, downscaled to 1024 px on the long edge, so thousands of files process in minutes.
4. **Compute metrics** per frame: dark-channel haze index over non-sky pixels; mean luminance gradient in the mid-frame band; 1st to 99th percentile luminance spread; 90th percentile saturation.
5. **Remove scene effects**: cluster frames by location within 500 m, require at least 8 frames over at least 3 different days, and convert each metric to a z-score within its cluster. The label then means "clearer or hazier than usual at this spot".
6. **Join weather**: ERA5 at the capture hour for the location, plus observed visibility from the nearest IEM station within 50 km when one exists; compute factor scores as-if with the reduced factor set.
7. **Write** `labeled.csv`; the app's Calibration screen imports it.

```csv
photo_id,time_utc,lat,lon,cluster,haze_dc,grad_mid,lum_spread,sat_p90,label_z,dewpoint,particulates,visibility,airmass,rainScrub,humidity,skyCover
DSC_0412,2026-10-04T11:42:00Z,43.9,-71.6,c07,0.21,0.044,0.81,0.62,1.3,0.9,,0.8,0.9,0.5,0.9,1.0
```

### Fitting

Per profile, minimize the squared error between the label and the weighted factor sum, plus a penalty pulling the weights toward the defaults, subject to weights at least 0 and summing to 100. The penalty strength is chosen by leave-one-cluster-and-day-out cross-validation. New weights are offered only with at least 30 labeled hours, and only when cross-validated Spearman correlation beats the defaults by 0.05 or more (a placeholder margin). The screen shows old and new weights, per-factor partial correlation, and the two baselines to beat: dew point alone and visibility alone.

### Known limits

- Image metrics partly reflect scene content, light direction and lens flare, so labels are relative and noisy; the within-location z-score and the manual ratings are the defense.
- Photographers shoot when conditions are good, so hazy hours are under-represented in any library. The tool reports the label spread so a narrow range is visible.
- The backtest uses reanalysis weather but the app scores forecasts. Forecast error blurs the relationship, which is why confidence (previous section) is measured separately.


---

# Build plan for Claude Code

Build in eight milestones, starting with a half-day spike that settles browser access to every API before any UI exists.

## Repo and stack

A pnpm workspace with three packages and one Python tool. The scoring core has no dependencies and no network access, so it can be tested without mocks and ported to Swift later.

```text
photo-clarity/
  CLAUDE.md
  package.json                 pnpm workspace root
  docs/
    design.md                  export of this document
    spikes.md                  results of spikes S1 to S5
  packages/
    core/                      pure TypeScript, zero dependencies
      src/ types.ts curves.ts sun.ts derived.ts score.ts windows.ts
           reasons.ts confidence.ts factors/*.ts profiles/*.json index.ts
      test/ *.test.ts
      fixtures/ scenarios/*.json   inputs plus expected bands
    providers/                 network adapters that emit HourlyRecord
      src/ http.ts cache.ts geocode.ts openmeteo.ts airquality.ts
           archive.ts iem.ts nws.ts merge.ts index.ts
      test/ recorded/*.json        saved real responses
  apps/
    web/                       Preact app, builds to one HTML file
      index.html vite.config.ts src/
  tools/
    spikes/                    M0 scripts and the browser test page
    photo-backtest/            Python tool (milestone 5)
```

| Concern | Choice |
| --- | --- |
| Language | TypeScript, strict mode |
| Workspace | pnpm workspaces |
| UI | Preact with hand-written SVG charts, light theme |
| Build | Vite with vite-plugin-singlefile, output `apps/web/dist/index.html` |
| Tests | Vitest; recorded API responses instead of live calls |
| Lint and format | ESLint and Prettier |
| CI | GitHub Actions running typecheck, test and build |
| Python tool | Python 3.11, exiftool, Pillow, NumPy |

Import rule: `core` imports nothing from the other packages, and `providers` never imports `core`. Only `apps/web` depends on both.

## Module interfaces

The public surface of each package, as signatures Claude Code can implement against. Types are defined in the data model section of the Data and history tab.

```typescript
// packages/core
export function curve(anchors: [number, number][], x: number): number;           // piecewise linear, clamped
export function sunPosition(lat: number, lon: number, t: Date): { elevDeg: number; azDeg: number };
export function derive(ctx: Context): Derived[];                                    // one per future hour
export function loadProfile(json: unknown): Profile;                                // validates weights sum to 100
export function score(ctx: Context, profile: Profile): HourScore[];
export function bestWindows(scores: HourScore[], opts: { hours: number; perDay: number }): ShootWindow[];
export function confidence(h: HourScore, d: Derived, second?: HourlyRecord, skill?: SkillTable): 'high' | 'medium' | 'low';
export function fitWeights(labeled: LabeledHour[], profile: Profile, opts: { lambda: number }): FitResult;

// packages/providers
export interface WeatherProvider {
  id: ProviderId;
  hourly(place: Place, range: { pastDays: number; forecastDays: number }): Promise<HourlyRecord[]>;
}
export function geocodeZip(zip: string): Promise<Place>;                          // Zippopotam.us, then Nominatim
export function fetchForecast(place: Place, range: Range): Promise<HourlyRecord[]>;
export function fetchAirQuality(place: Place, range: Range): Promise<Partial<HourlyRecord>[]>;
export function mergeHourly(w: HourlyRecord[], a: Partial<HourlyRecord>[]): HourlyRecord[];
export function fetchClimatology(place: Place, years: [number, number]): Promise<Climatology>;
export function fetchObserved(station: string, from: Date, to: Date): Promise<HourlyRecord[]>; // IEM
export function fetchSecondOpinion(place: Place): Promise<HourlyRecord[]>;           // NWS

// apps/web: state
// place, context, profileId, selectedHour, units; derived: scores per profile, windows, reasons
```

**Behavioral contracts.** `score` is pure and deterministic. `mergeHourly` aligns on UTC hour and never fabricates missing values; it leaves them null. Every provider function returns normalized SI records, throws a typed `ProviderError` with a `kind` of timeout, rate-limit, http or shape, and is cache-aware through `cache.ts`.

## Milestones

These replace the four-phase roadmap in the first tab. Each milestone ends with typecheck and tests green, and Claude Code stops for your review at every gate.

| ID | Milestone | Deliverables | Acceptance criteria | Gate |
| --- | --- | --- | --- | --- |
| M0 | Spikes | `tools/spikes` scripts, a browser test page, `docs/spikes.md` | Pass or fail recorded for S1 to S5 below; raw responses saved as fixtures; written recommendation on direct browser calls versus a Worker proxy | A: proxy decision |
| M1 | Core engine | Types, curves, sun position, 16 factors, 6 profile JSON files, score, windows, reasons, caps | Curve tests at every anchor and between; weights sum to 100 per profile; five scenario fixtures land in the expected bands; property tests pass; scoring 16 days across 6 profiles stays under 50 ms on a laptop (budget) | |
| M2 | Providers | Geocode, forecast, air quality, merge, cache, typed errors | Zips 01810, 80202, 33101 and 98101 resolve; a merged 7-day array has no gaps; every row of the failure table has a mocked-failure test | |
| M3 | UI v1 | Header, week strip, hourly chart, why panel, profile switcher, raw table, states, units, single-file build | Meets section 6 of the first tab: 7-day view for 01810 in under 5 seconds, at least two reasons per score, unit toggle, partial-data banner; built file under 200 KB gzipped; light theme; no critical accessibility violations | B: scores match your memory of five past days; usable daily |
| M4 | History features | Trend and rain-scrub features, ERA5 climatology and anomaly, context badge, caching of the climatology table | dpPercentile matches an independent calculation within 3 percentile points for three test places; rain-scrub cases tested; page still works when the archive call fails | |
| M5 | Verification and calibration | Forecast snapshot store, Previous Runs skill table, NWS second opinion and confidence, IEM check, Python photo tool, CSV import, fit screen | Photo tool runs end to end on a 1,000-photo test folder and reports throughput; fit refuses below 30 labeled hours; screen shows both baselines; confidence cutoffs replaced by measured values | C: fit beats dew-point-only baseline in cross-validation |
| M6 | Spots and planner | Saved lat/lon spots with elevation, Wildlife profile, trip planner (H7) | Planner reports, for a place and date range, the share of past years' days reaching Good or better; labeled "history estimate" | |
| M7 | iPhone | Installable web app with manifest and offline cache; native decision; Swift port of core if chosen | Core fixtures pass unchanged in Swift if ported; alerts only if a Worker cron is built | D: Capacitor versus SwiftUI, and Open-Meteo terms recheck |

### Spikes in M0

Node scripts cannot test browser access, because Node ignores cross-origin rules. S1 therefore needs a small HTML page that you open in a real browser, once served over https and once opened as a local file.

| Spike | Question | Pass condition |
| --- | --- | --- |
| S1 | Do Zippopotam.us, Nominatim, Open-Meteo (forecast, air quality, archive) and NWS `/points` answer a browser request from both origins? | Each returns JSON with no cross-origin error; any failure is listed with the proposed Worker route |
| S2 | Which fields are populated for Andover MA, Denver CO and Miami FL, and do the archive, previous-runs and historical-forecast hostnames resolve? | A table of field by place with null counts; hostnames confirmed |
| S3 | How big and how slow is a 2015 to last-year hourly dew point request? | Bytes and seconds recorded; decision to keep or shrink the window |
| S4 | Does IEM's ASOS CSV endpoint allow browser calls, and how fast is one station-year? | Pass or fail plus timing; if blocked, only the offline tool uses IEM |
| S5 | What are the exact variable names and availability for fixed-lead forecasts in Previous Runs? | Dew point and cloud cover fetched at lead days 1 to 7 for one location |

## Testing strategy

The scoring math is the product, so it carries the heaviest testing. Fixtures are JSON, so the Swift port can run the same cases.

| Layer | What it checks |
| --- | --- |
| Curve unit tests | Exact value at every anchor, linear between, clamped outside, for all factors and overrides |
| Derived-feature tests | dpTrend24, pTrend12, precip24, hoursSinceRain on hand-built series, including series shorter than 24 hours |
| Golden scenarios | Hand-built hourly inputs with expected bands per profile (list below) |
| Property tests | Lowering dew point never lowers Clarity; raising PM2.5 never raises it; scores stay within 0 to 100; weights sum to 100; dropping a factor renormalizes and never returns NaN; same input gives same output |
| Provider tests | Recorded real responses parsed to normalized records; each failure mode mocked |
| Edge fixtures | Polar night, midnight sun, DST change days, missing visibility, missing air quality, empty climatology |
| UI | Component tests for the reasons text and unit conversion; a manual visual check at 380 px and desktop widths |

**Golden scenarios.**

1. Crisp post-front day: dew point 28°F and 12°F lower than yesterday, northwest wind 8 mph, PM2.5 4, visibility over 10 miles, clear. Clarity: Excellent.
2. Muggy haze day: dew point 66°F, south wind 6 mph, aerosol depth 0.5, humidity 90%. Clarity: Skip.
3. Smoke day: dew point 35°F, PM2.5 60, aerosol depth 1.0, visibility 3 miles. Clarity: no better than Fair, despite dry air. This case is why the model has caps.
4. Fog morning at 06:00: spread 1°F, humidity 98%, wind 1 mph, clear sky. Fog and mist: Excellent. Clarity: Skip.
5. Wet overcast day: 5 mm of rain ended 4 hours ago, cloud 100%, humidity 85%, wind 3 mph. Soft light: Excellent. Clarity: Fair or worse.

## CLAUDE.md and kickoff prompt

Put this file at the repo root before the first session, and export this doc to `docs/design.md`.

```markdown
# Photo Clarity

TypeScript web app that scores hourly photography conditions for any US zip code, per shoot type
(profile), from Open-Meteo weather and air quality plus weather history.
The design doc is docs/design.md and is authoritative: Design decisions (D1-D22), Data and history,
Scoring and profiles, Build plan.

## Commands
- pnpm install
- pnpm typecheck
- pnpm test
- pnpm --filter web dev
- pnpm --filter web build     # single file at apps/web/dist/index.html

## Rules
- packages/core has zero runtime dependencies and no I/O. providers never import core.
- Internal values are SI and UTC. Convert to display units only in the UI layer.
- No thresholds in code. Curves and weights live in packages/core/src (factors and profiles/*.json);
  tests read them.
- A missing input drops its factor and renormalizes the weights. Never score missing as 0 or 1.
- Changing a curve or weight means updating curve tests and golden fixtures in the same commit,
  with the reason in the commit message.
- Tests never call live APIs; use recorded fixtures in packages/providers/test/recorded.
- Send an identifying User-Agent to NWS and Nominatim.
- UI: light background, standalone HTML output, no runtime CDN.
- Ask before changing any decision D1-D22.

## Definition of done
Typecheck and tests green, the milestone's acceptance criteria met, spike findings appended to
docs/spikes.md when relevant. Stop at each gate and summarize before continuing.
```

**Kickoff prompt for the first session.**

```text
Read docs/design.md and CLAUDE.md. Start with milestone M0. Build the spikes S1 to S5 in
tools/spikes, including an HTML page for S1 that I can open in my browser both over https and as a
local file. Run whatever can run in your environment, save raw responses as fixtures, and write
docs/spikes.md with pass or fail for each spike and a recommendation on direct browser calls versus
a Cloudflare Worker proxy. Stop after M0 and summarize. Do not start M1 until I confirm.
```


---

