/* ClearSky core: pure scoring engine. No I/O, no network, no DOM.
 * Internal values are SI and UTC. Anchors follow the design doc (US units) and are converted
 * at the factor boundary; display conversion lives in the UI layer (describe() is the one helper
 * that formats reasons for either unit system).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClearSkyCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOUR = 3600000;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const cToF = (c) => (c * 9) / 5 + 32;
  const msToMph = (m) => m * 2.2369363;
  const mToMi = (m) => m / 1609.344;

  /* ---------- curves ---------- */

  // Piecewise linear through ascending anchors, clamped at both ends.
  function curve(anchors, x) {
    if (!isNum(x)) return null;
    const n = anchors.length;
    if (x <= anchors[0][0]) return anchors[0][1];
    if (x >= anchors[n - 1][0]) return anchors[n - 1][1];
    for (let i = 1; i < n; i++) {
      const [x1, y1] = anchors[i];
      if (x <= x1) {
        const [x0, y0] = anchors[i - 1];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return anchors[n - 1][1];
  }

  // Constant-per-band lookup: bands are [lo, hi, value) in ascending order.
  function bandLookup(bands, x) {
    if (!isNum(x)) return null;
    for (const [lo, hi, v] of bands) if (x >= lo && x < hi) return v;
    return bands[bands.length - 1][2];
  }

  /* ---------- curves, from the design doc ---------- */

  const CURVES = {
    dewAbsF: [[30, 1], [40, 0.85], [50, 0.5], [60, 0.15], [65, 0]],
    dewPct: [[10, 1], [50, 0.5], [90, 0]],
    pm25: [[5, 1], [12, 0.75], [35, 0.2], [55, 0]],
    aod: [[0.1, 1], [0.3, 0.6], [0.6, 0.2], [1.0, 0]],
    visMi: [[1, 0], [3, 0.25], [6, 0.6], [10, 1]],
    pblM: [[200, 0.1], [400, 0.35], [800, 0.7], [1500, 1]],
    dpTrendF: [[-10, 1], [-5, 0.75], [0, 0.5], [5, 0.2], [10, 0.05]],
    windSpeedMph: [[2.5, 0.8], [3.5, 1], [15, 1], [16, 0.9], [25, 0.9], [26, 0.7]],
    humidity: [[40, 1], [50, 0.85], [70, 0.4], [85, 0.1], [95, 0]],
    sky: [[70, 1], [85, 0.8], [100, 0.6]],
    skyColor: [[0, 0.3], [20, 0.6], [40, 1], [60, 1], [80, 0.5], [100, 0.15]],
    lowCloud: [[10, 1], [30, 0.6], [60, 0.2], [80, 0]],
    fogSpreadF: [[3, 1], [6, 0.5], [10, 0]],
    fogRh: [[75, 0], [85, 0.4], [95, 1]],
    fogWindMph: [[4, 1], [8, 0.4], [12, 0]],
    fogCloud: [[60, 1], [100, 0.5]],
    calmMph: [[2, 1], [4, 0.8], [7, 0.4], [10, 0]],
    precipMm: [[0.05, 1], [0.3, 0.5], [1, 0.15]],
    shimmerF: [[70, 1], [80, 0.8], [90, 0.5]],
    // overrides
    softSky: [[10, 0.1], [40, 0.5], [70, 1]],
    softHumidity: [[30, 0.1], [50, 0.5], [70, 1]],
    wildSky: [[60, 1], [100, 0.7]],
  };

  const LIGHT_BANDS = {
    default: [[-90, -4, 0], [-4, 0, 0.8], [0, 6, 1], [6, 15, 0.8], [15, 30, 0.5], [30, 91, 0.2]],
    fog: [[-90, -4, 0.5], [-4, 8, 1], [8, 15, 0.6], [15, 91, 0.2]],
    wildlife: [[-90, 3, 0.6], [3, 25, 1], [25, 40, 0.6], [40, 91, 0.2]],
  };

  // Wind direction priors (direction wind blows FROM -> 0.4..1.0). Config, not code logic.
  const WIND_PRIORS = {
    neutral: null,
    northeast: { N: 0.9, NE: 0.4, E: 0.25, SE: 0.2, S: 0.2, SW: 0.35, W: 0.8, NW: 1.0 },
  };
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  function windPriorFor(place) {
    // Auto: the New England tuned table only where it was tuned (Northeast US).
    if (place && place.lat >= 38 && place.lat <= 48 && place.lon >= -80 && place.lon <= -66) return 'northeast';
    return 'neutral';
  }

  /* ---------- profiles ---------- */

  const FACTOR_IDS = [
    'dewpoint', 'particulates', 'visibility', 'ventilation', 'airmass', 'rainScrub', 'windRegime', 'humidity',
    'skyCover', 'skyColor', 'lowCloudClear', 'fogPotential', 'calm', 'precipGate', 'lightWindow', 'heatShimmer',
  ];

  const FACTOR_LABELS = {
    dewpoint: 'Dew point', particulates: 'Particulates', visibility: 'Visibility', ventilation: 'Mixing height',
    airmass: 'Air-mass change', rainScrub: 'Rain scrub', windRegime: 'Wind regime', humidity: 'Humidity',
    skyCover: 'Sky cover', skyColor: 'Sky color', lowCloudClear: 'Low cloud', fogPotential: 'Fog potential',
    calm: 'Calm air', precipGate: 'Precipitation', lightWindow: 'Light window', heatShimmer: 'Heat shimmer',
  };

  const PROFILE_DEFS = [
    {
      id: 'clarity', name: 'Clarity', description: 'Distant landscape and telephoto work',
      weights: { dewpoint: 30, particulates: 18, visibility: 10, ventilation: 8, airmass: 10, rainScrub: 6, windRegime: 8, humidity: 4, skyCover: 6 },
      // fogGate restores draft 1's "M x 0.4 for clarity" in fog; golden scenario 4 needs it (Clarity: Skip).
      gate: { floor: 0.15, fog: 0.4 },
      caps: [{ factors: ['dewpoint', 'particulates', 'visibility'], below: 0.2, max: 59 }],
      hours: { minSunElevDeg: -4 }, curves: {},
    },
    {
      id: 'golden', name: 'Golden light', description: 'Sunrise and sunset color',
      weights: { dewpoint: 10, particulates: 10, visibility: 10, airmass: 10, rainScrub: 5, skyColor: 35, lowCloudClear: 15, calm: 5 },
      gate: { floor: 0.15 },
      caps: [{ factors: ['particulates', 'visibility'], below: 0.2, max: 59 }],
      // The doc's Golden weights contain no sun-position factor, so without an hours rule a clear
      // midday would score like sunrise. D15 says windows come from "the profile's relevant hours".
      hours: { sunElevRange: [-4, 10] }, curves: {},
    },
    {
      id: 'fog', name: 'Fog and mist', description: 'Morning fog in valleys and over water (area-level)',
      weights: { fogPotential: 70, calm: 15, lightWindow: 15 },
      gate: { floor: 0.3 }, caps: [],
      hours: { localHours: [3, 9] }, curves: { lightWindow: 'fog' },
    },
    {
      id: 'reflections', name: 'Reflections', description: 'Still water and mirror-like scenes',
      weights: { dewpoint: 5, particulates: 5, visibility: 5, airmass: 5, humidity: 10, skyCover: 35, skyColor: 10, calm: 45, precipGate: 5, lightWindow: 20 },
      gate: { floor: 0.15 }, caps: [],
      hours: { minSunElevDeg: -4 }, curves: {},
    },
    {
      id: 'soft', name: 'Soft light', description: 'Overcast, damp days for foliage and waterfalls',
      weights: { rainScrub: 15, skyCover: 15, fogPotential: 10, calm: 15, precipGate: 15 },
      gate: { floor: 0.6 }, caps: [],
      hours: { minSunElevDeg: -4 },
      curves: { skyCover: 'soft', humidity: 'soft', rainScrub: 'soft' },
    },
    {
      id: 'wildlife', name: 'Wildlife', description: 'Low sun, calm air, long lenses',
      weights: { dewpoint: 5, visibility: 5, calm: 20, precipGate: 20, lightWindow: 25, heatShimmer: 10 },
      gate: { floor: 0.15 }, caps: [],
      hours: { minSunElevDeg: -4 },
      curves: { lightWindow: 'wildlife', skyCover: 'wildlife' },
    },
  ];

  // Validates and normalizes a profile. The design doc says weights sum to 100 per profile, but three of
  // its six columns do not (Reflections 145, Soft light 70, Wildlife 85). Scores already renormalize over
  // available factors, so scaling to 100 keeps relative weights and satisfies the invariant.
  function loadProfile(json) {
    if (!json || typeof json !== 'object') throw new Error('profile must be an object');
    const w = {};
    let sum = 0;
    for (const [k, v] of Object.entries(json.weights || {})) {
      if (!FACTOR_IDS.includes(k)) throw new Error('unknown factor ' + k);
      if (!isNum(v) || v < 0) throw new Error('bad weight for ' + k);
      sum += v;
    }
    if (sum <= 0) throw new Error('weights sum to zero');
    for (const [k, v] of Object.entries(json.weights)) if (v > 0) w[k] = (v * 100) / sum;
    return Object.assign({}, json, { weights: w, weightSumDeclared: sum });
  }

  const PROFILES = PROFILE_DEFS.map(loadProfile);
  const PROFILE_BY_ID = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

  /* ---------- bands ---------- */

  const BANDS = [
    { id: 'excellent', name: 'Excellent', min: 80 },
    { id: 'good', name: 'Good', min: 60 },
    { id: 'fair', name: 'Fair', min: 40 },
    { id: 'poor', name: 'Poor', min: 20 },
    { id: 'skip', name: 'Skip', min: -1 },
  ];
  function bandOf(score) {
    if (!isNum(score)) return null;
    for (const b of BANDS) if (score >= b.min) return b.id;
    return 'skip';
  }
  const bandName = (id) => (BANDS.find((b) => b.id === id) || { name: '' }).name;

  /* ---------- time zones ---------- */

  const dtfCache = {};
  function dtf(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    }
    return dtfCache[tz];
  }
  function localParts(ms, tz) {
    const o = {};
    for (const p of dtf(tz || 'UTC').formatToParts(new Date(ms))) o[p.type] = p.value;
    return {
      date: o.year + '-' + o.month + '-' + o.day, hour: +o.hour % 24, minute: +o.minute,
      year: +o.year, month: +o.month, day: +o.day, weekday: o.weekday,
    };
  }
  function tzOffsetMs(ms, tz) {
    const p = localParts(ms, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    return asUtc - Math.floor(ms / 60000) * 60000;
  }
  // UTC ms of local midnight for 'YYYY-MM-DD' in tz (handles DST days).
  function zonedMidnight(dayKey, tz) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    let t = guess - tzOffsetMs(guess, tz);
    t = guess - tzOffsetMs(t, tz);
    return t;
  }
  function nextDayKey(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    return t.toISOString().slice(0, 10);
  }

  /* ---------- sun position (NOAA equations) ---------- */

  function sunPosition(lat, lon, t) {
    const ms = t instanceof Date ? t.getTime() : t;
    const rad = Math.PI / 180;
    const jd = ms / 86400000 + 2440587.5;
    const T = (jd - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C =
      Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * rad);
    const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
    const y = Math.tan((eps * rad) / 2) ** 2;
    const eqTime =
      (4 / rad) *
      (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) -
        0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
    const d = new Date(ms);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    let tst = (minutes + eqTime + 4 * lon) % 1440;
    if (tst < 0) tst += 1440;
    let ha = tst / 4 - 180;
    if (ha < -180) ha += 360;
    const latR = lat * rad;
    const cosZen = clamp(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha * rad), -1, 1);
    const zen = Math.acos(cosZen);
    let elev = 90 - zen / rad;
    // atmospheric refraction (NOAA)
    const te = Math.tan(elev * rad);
    let refr = 0;
    if (elev > 85) refr = 0;
    else if (elev > 5) refr = (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600;
    else if (elev > -0.575) refr = (1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))) / 3600;
    else refr = -20.772 / te / 3600;
    elev += refr;
    const sinZen = Math.sin(zen);
    let az;
    if (sinZen < 1e-6) az = 180;
    else {
      const cosAz = clamp((Math.sin(latR) * cosZen - Math.sin(decl)) / (Math.cos(latR) * sinZen), -1, 1);
      const a = Math.acos(cosAz) / rad;
      az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { elevDeg: elev, azDeg: az };
  }

  // Sunrise, sunset and golden-hour windows for a local day, scanned at 5-minute steps.
  function sunTimes(lat, lon, dayKey, tz) {
    const start = zonedMidnight(dayKey, tz);
    const end = zonedMidnight(nextDayKey(dayKey), tz);
    const step = 5 * 60000;
    const out = { sunrise: null, sunset: null, goldenAM: [null, null], goldenPM: [null, null], blueAM: null, blueBefore: null, maxElev: -90 };
    let prev = sunPosition(lat, lon, start).elevDeg;
    for (let t = start + step; t <= end; t += step) {
      const e = sunPosition(lat, lon, t).elevDeg;
      if (e > out.maxElev) out.maxElev = e;
      const cross = (lvl) => (prev < lvl && e >= lvl ? 1 : prev >= lvl && e < lvl ? -1 : 0);
      const at = (lvl) => t - step + ((lvl - prev) / (e - prev)) * step;
      if (cross(-0.833) === 1 && out.sunrise == null) out.sunrise = at(-0.833);
      if (cross(-0.833) === -1) out.sunset = at(-0.833);
      if (cross(-4) === 1 && out.goldenAM[0] == null) out.goldenAM[0] = at(-4);
      if (cross(6) === 1 && out.goldenAM[1] == null) out.goldenAM[1] = at(6);
      if (cross(6) === -1) out.goldenPM[0] = at(6);
      if (cross(-4) === -1) out.goldenPM[1] = at(-4);
      prev = e;
    }
    return out;
  }

  /* ---------- normal distribution + climatology ---------- */

  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

  const CLIMO_BUCKETS = 53;
  function doyOf(ms) {
    const d = new Date(ms);
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000) - 1;
  }
  // Reduces an hourly dew point series (UTC) to count/sum/sumsq per (7-day bucket, UTC hour).
  function buildClimatology(timesMs, dewC, years) {
    const n = new Array(CLIMO_BUCKETS * 24).fill(0);
    const s = new Array(CLIMO_BUCKETS * 24).fill(0);
    const q = new Array(CLIMO_BUCKETS * 24).fill(0);
    for (let i = 0; i < timesMs.length; i++) {
      const v = dewC[i];
      if (!isNum(v)) continue;
      const d = new Date(timesMs[i]);
      const k = Math.min(CLIMO_BUCKETS - 1, Math.floor(doyOf(timesMs[i]) / 7)) * 24 + d.getUTCHours();
      n[k]++; s[k] += v; q[k] += v * v;
    }
    const r = (a) => a.map((x) => Math.round(x * 100) / 100);
    return { years, n, s: r(s), q: r(q) };
  }
  // Mean and standard deviation for a time, pooling the neighboring buckets (about 3 weeks).
  function climoStats(climo, ms) {
    if (!climo) return null;
    const b = Math.min(CLIMO_BUCKETS - 1, Math.floor(doyOf(ms) / 7));
    const h = new Date(ms).getUTCHours();
    let n = 0, s = 0, q = 0;
    for (const db of [-1, 0, 1]) {
      const k = ((b + db + CLIMO_BUCKETS) % CLIMO_BUCKETS) * 24 + h;
      n += climo.n[k]; s += climo.s[k]; q += climo.q[k];
    }
    if (n < 30) return null;
    const mean = s / n;
    const sd = Math.sqrt(Math.max(q / n - mean * mean, 0.25));
    return { mean, sd, n };
  }
  function dewPercentile(climo, ms, dewC) {
    const st = climoStats(climo, ms);
    if (!st || !isNum(dewC)) return null;
    return 100 * normCdf((dewC - st.mean) / st.sd);
  }

  /* ---------- merge ---------- */

  // Aligns on UTC hour; never fabricates a missing value (it stays null).
  function mergeHourly(weather, air) {
    const byT = new Map();
    for (const a of air || []) byT.set(a.ms, a);
    return weather.map((w) => {
      const a = byT.get(w.ms);
      return Object.assign({}, w, {
        pm25: a && isNum(a.pm25) ? a.pm25 : null,
        pm10: a && isNum(a.pm10) ? a.pm10 : null,
        aod: a && isNum(a.aod) ? a.aod : null,
        dust: a && isNum(a.dust) ? a.dust : null,
        aqiUs: a && isNum(a.aqiUs) ? a.aqiUs : null,
      });
    });
  }

  /* ---------- derived features ---------- */

  // ctx: { place:{lat,lon,tz}, hours:[HourlyRecord sorted by ms], nowMs, climo, second }
  function derive(ctx) {
    const H = ctx.hours;
    const out = new Array(H.length);
    const { lat, lon } = ctx.place;
    for (let i = 0; i < H.length; i++) {
      const r = H[i];
      const sun = sunPosition(lat, lon, r.ms);
      const prev24 = i >= 24 ? H[i - 24] : null;
      const prev12 = i >= 12 ? H[i - 12] : null;
      let precip24 = 0;
      for (let j = Math.max(0, i - 24); j < i; j++) precip24 += H[j].precipMm || 0;
      let hsr = null;
      if ((r.precipMm || 0) >= 0.2) hsr = 0;
      else {
        for (let j = i - 1; j >= 0; j--) if ((H[j].precipMm || 0) >= 0.2) { hsr = i - j; break; }
        if (hsr == null && i >= 36) hsr = 99; // checked at least 36 h back, none
      }
      out[i] = {
        dpTrend24C: prev24 && isNum(prev24.dewC) && isNum(r.dewC) ? r.dewC - prev24.dewC : null,
        pTrend12: prev12 && isNum(prev12.pressHpa) && isNum(r.pressHpa) ? r.pressHpa - prev12.pressHpa : null,
        precip24, hoursSinceRain: hsr,
        spreadC: isNum(r.tempC) && isNum(r.dewC) ? r.tempC - r.dewC : null,
        sunElevDeg: sun.elevDeg, sunAzDeg: sun.azDeg,
        dpPercentile: dewPercentile(ctx.climo, r.ms, r.dewC),
        leadHours: ctx.nowMs != null ? Math.max(0, (r.ms - ctx.nowMs) / HOUR) : 0,
      };
    }
    return out;
  }

  /* ---------- factors ---------- */

  // Each factor takes x = { r (record), d (derived), p (profile), prior (wind prior table|null) }
  // and returns { score 0..1, raw } or null when its input is missing (it then drops out).
  function curveFor(p, key, dflt) {
    const o = p.curves && p.curves[key];
    if (key === 'skyCover') return o === 'soft' ? CURVES.softSky : o === 'wildlife' ? CURVES.wildSky : dflt;
    if (key === 'humidity') return o === 'soft' ? CURVES.softHumidity : dflt;
    return dflt;
  }

  const FACTORS = {
    dewpoint(x) {
      const { r, d } = x;
      if (!isNum(r.dewC)) return null;
      const abs = curve(CURVES.dewAbsF, cToF(r.dewC));
      if (isNum(d.dpPercentile)) {
        const pct = curve(CURVES.dewPct, d.dpPercentile);
        return { score: 0.6 * abs + 0.4 * pct, raw: { dewC: r.dewC, pct: d.dpPercentile } };
      }
      return { score: abs, raw: { dewC: r.dewC, pct: null } };
    },
    particulates(x) {
      const { r } = x;
      const parts = [];
      if (isNum(r.pm25)) parts.push(curve(CURVES.pm25, r.pm25));
      if (isNum(r.aod)) parts.push(curve(CURVES.aod, r.aod));
      if (!parts.length) return null;
      return { score: Math.min(...parts), raw: { pm25: r.pm25, aod: r.aod } };
    },
    visibility(x) {
      const { r } = x;
      if (!isNum(r.visM)) return null;
      return { score: curve(CURVES.visMi, mToMi(r.visM)), raw: { visM: r.visM } };
    },
    ventilation(x) {
      const { r, d } = x;
      if (!isNum(r.pblM) || d.sunElevDeg <= 10) return null;
      return { score: curve(CURVES.pblM, r.pblM), raw: { pblM: r.pblM } };
    },
    airmass(x) {
      const { d } = x;
      if (!isNum(d.dpTrend24C)) return null;
      let s = curve(CURVES.dpTrendF, d.dpTrend24C * 1.8);
      if (isNum(d.pTrend12) && d.pTrend12 >= 3) s = Math.min(1, s + 0.1);
      return { score: s, raw: { dpTrendC: d.dpTrend24C, pTrend12: d.pTrend12 } };
    },
    rainScrub(x) {
      const { r, d, p } = x;
      if (d.hoursSinceRain == null && !(r.precipMm >= 0.2)) {
        // not enough history to know; only the "no rain in window" case is unknown
        return null;
      }
      const hsr = d.hoursSinceRain;
      const raw = { precip24: d.precip24, hoursSinceRain: hsr, nowMm: r.precipMm };
      let s;
      if (p.curves && p.curves.rainScrub === 'soft') {
        if (hsr === 0) s = 0.3;
        else if (d.precip24 >= 1 && hsr >= 1 && hsr <= 12) s = 1;
        else if (d.precip24 >= 1 && hsr > 12 && hsr <= 36) s = 0.6;
        else s = 0.3;
        return { score: s, raw };
      }
      if (hsr === 0) s = 0.3;
      else if (d.precip24 >= 0.2 && hsr < 3) s = 0.5;
      else if (d.precip24 >= 0.2 && hsr <= 36) {
        const full = 1 - (0.5 * (hsr - 3)) / 33; // 1.0 at 3 h falling to 0.5 at 36 h
        const strength = clamp((d.precip24 - 0.2) / 1.8, 0, 1); // 2 mm or more = full effect
        s = 0.5 + (full - 0.5) * strength;
      } else s = 0.5;
      return { score: s, raw };
    },
    windRegime(x) {
      const { r, prior } = x;
      if (!isNum(r.windMs)) return null;
      const mult = curve(CURVES.windSpeedMph, msToMph(r.windMs));
      let dir = 1;
      let dirName = null;
      if (isNum(r.windDirDeg)) {
        dirName = compass(r.windDirDeg);
        if (prior) dir = 0.4 + 0.6 * prior[dirName];
      }
      return { score: mult * dir, raw: { windMs: r.windMs, dirDeg: r.windDirDeg, dirName, prior: !!prior } };
    },
    humidity(x) {
      const { r, p } = x;
      if (!isNum(r.rh)) return null;
      return { score: curve(curveFor(p, 'humidity', CURVES.humidity), r.rh), raw: { rh: r.rh } };
    },
    skyCover(x) {
      const { r, p } = x;
      if (!isNum(r.cloudTotal)) return null;
      return { score: curve(curveFor(p, 'skyCover', CURVES.sky), r.cloudTotal), raw: { cloud: r.cloudTotal } };
    },
    skyColor(x) {
      const { r } = x;
      if (!isNum(r.cloudMid) && !isNum(r.cloudHigh)) return null;
      const v = Math.max(r.cloudMid || 0, r.cloudHigh || 0);
      return { score: curve(CURVES.skyColor, v), raw: { midHigh: v, mid: r.cloudMid, high: r.cloudHigh } };
    },
    lowCloudClear(x) {
      const { r } = x;
      if (!isNum(r.cloudLow)) return null;
      return { score: curve(CURVES.lowCloud, r.cloudLow), raw: { low: r.cloudLow } };
    },
    fogPotential(x) {
      const { r, d } = x;
      if (!isNum(d.spreadC) || !isNum(r.rh) || !isNum(r.windMs) || !isNum(r.cloudTotal)) return null;
      const s =
        curve(CURVES.fogSpreadF, d.spreadC * 1.8) * curve(CURVES.fogRh, r.rh) *
        curve(CURVES.fogWindMph, msToMph(r.windMs)) * curve(CURVES.fogCloud, r.cloudTotal);
      return { score: s, raw: { spreadC: d.spreadC, rh: r.rh, windMs: r.windMs, cloud: r.cloudTotal } };
    },
    calm(x) {
      const { r } = x;
      if (!isNum(r.windMs)) return null;
      const w = msToMph(r.windMs);
      let s = curve(CURVES.calmMph, w);
      const g = isNum(r.gustMs) ? msToMph(r.gustMs) : null;
      if (g != null && g > 2 * w && g > 8) s *= 0.7;
      return { score: s, raw: { windMs: r.windMs, gustMs: r.gustMs } };
    },
    precipGate(x) {
      const { r } = x;
      if (!isNum(r.precipMm)) return null;
      return { score: curve(CURVES.precipMm, r.precipMm), raw: { mm: r.precipMm } };
    },
    lightWindow(x) {
      const { d, p } = x;
      const key = (p.curves && p.curves.lightWindow) || 'default';
      return { score: bandLookup(LIGHT_BANDS[key], d.sunElevDeg), raw: { elev: d.sunElevDeg } };
    },
    heatShimmer(x) {
      const { r, d } = x;
      if (!isNum(r.tempC) || d.sunElevDeg <= 35) return null;
      return { score: curve(CURVES.shimmerF, cToF(r.tempC)), raw: { tempC: r.tempC, elev: d.sunElevDeg } };
    },
  };

  /* ---------- scoring ---------- */

  function hourIsScored(profile, r, d, tz) {
    const h = profile.hours || {};
    if (h.localHours) {
      const lh = localParts(r.ms, tz).hour;
      return lh >= h.localHours[0] && lh <= h.localHours[1];
    }
    if (h.sunElevRange) return d.sunElevDeg > h.sunElevRange[0] && d.sunElevDeg <= h.sunElevRange[1];
    return d.sunElevDeg > (h.minSunElevDeg != null ? h.minSunElevDeg : -4);
  }

  function flagsFor(r, d) {
    const f = [];
    if (isNum(d.spreadC) && d.spreadC * 1.8 <= 3 && isNum(r.rh) && r.rh >= 95) f.push('fog');
    if ((isNum(r.pm25) && r.pm25 > 35) || (isNum(r.aod) && r.aod > 0.6)) f.push('smoke');
    if (isNum(r.dust) && r.dust > 50) f.push('dust');
    if ((r.precipMm || 0) >= 0.2) f.push('rain');
    if (isNum(r.tempC) && cToF(r.tempC) > 70 && d.sunElevDeg > 35) f.push('shimmer');
    if (isNum(r.visM) && mToMi(r.visM) < 3) f.push('lowvis');
    return f;
  }

  function confidence(lead, r, second) {
    let tier = lead <= 48 ? 2 : lead <= 96 ? 1 : 0;
    let note = lead <= 48 ? 'near-term forecast' : lead <= 96 ? 'forecast 2 to 4 days out' : 'forecast more than 4 days out';
    if (second && isNum(second.dewC) && isNum(r.dewC) && Math.abs(second.dewC - r.dewC) * 1.8 >= 5) {
      tier -= 1; note += '; NWS dew point differs by 5°F or more';
    } else if (second && isNum(second.cloudTotal) && isNum(r.cloudTotal) && Math.abs(second.cloudTotal - r.cloudTotal) >= 40) {
      tier -= 1; note += '; NWS cloud cover differs by 40 points or more';
    }
    tier = Math.max(0, tier);
    return { level: ['low', 'medium', 'high'][tier], note };
  }

  // Scores every hour of ctx for one profile.
  function score(ctx, profileIn, opts) {
    opts = opts || {};
    const profile = profileIn.weightSumDeclared != null ? profileIn : loadProfile(profileIn);
    const derived = opts.derived || derive(ctx);
    const prior = WIND_PRIORS[opts.windPrior || 'neutral'] || null;
    const secondByMs = new Map((ctx.second || []).map((s) => [s.ms, s]));
    const floor = profile.gate && isNum(profile.gate.floor) ? profile.gate.floor : 0.15;
    return ctx.hours.map((r, i) => {
      const d = derived[i];
      const base = { t: r.t, ms: r.ms, profile: profile.id, derivedIndex: i };
      const flags = flagsFor(r, d);
      const conf = confidence(d.leadHours, r, secondByMs.get(r.ms));
      if (!hourIsScored(profile, r, d, ctx.place.tz)) {
        return Object.assign(base, { scored: false, score: null, band: null, factors: [], flags, confidence: conf.level, confidenceNote: conf.note, reasons: [] });
      }
      const factors = [];
      let sumW = 0, sumWS = 0;
      for (const [id, w] of Object.entries(profile.weights)) {
        const res = FACTORS[id]({ r, d, p: profile, prior });
        if (!res) continue;
        const s = clamp(res.score, 0, 1);
        factors.push({ id, raw: res.raw, score: s, weight: w, contribution: 0 });
        sumW += w; sumWS += w * s;
      }
      if (!factors.length) {
        return Object.assign(base, { scored: false, score: null, band: null, factors: [], flags, confidence: conf.level, confidenceNote: conf.note, reasons: [] });
      }
      for (const f of factors) f.contribution = (f.weight * (f.score - 0.5)) / sumW;
      const sPrecip = isNum(r.precipMm) ? curve(CURVES.precipMm, r.precipMm) : 1;
      const gate = floor + (1 - floor) * sPrecip;
      let val = 100 * (sumWS / sumW) * gate;
      if (profile.gate && isNum(profile.gate.fog) && flags.includes('fog')) val *= profile.gate.fog;
      let capped = false;
      for (const c of profile.caps || []) {
        const hit = factors.some((f) => c.factors.includes(f.id) && f.score < c.below);
        if (hit && val > c.max) { val = c.max; capped = true; }
      }
      val = clamp(val, 0, 100);
      const reasons = pickReasons(factors);
      return Object.assign(base, {
        scored: true, score: val, band: bandOf(val), factors, flags, capped, gate,
        missing: Object.keys(profile.weights).filter((id) => !factors.some((f) => f.id === id)),
        confidence: conf.level, confidenceNote: conf.note, reasons,
      });
    });
  }

  function pickReasons(factors) {
    const pos = factors.filter((f) => f.contribution > 0.004).sort((a, b) => b.contribution - a.contribution).slice(0, 2);
    const neg = factors.filter((f) => f.contribution < -0.004).sort((a, b) => a.contribution - b.contribution).slice(0, 2);
    return pos.map((f) => ({ factor: f.id, sign: 1, contribution: f.contribution, raw: f.raw }))
      .concat(neg.map((f) => ({ factor: f.id, sign: -1, contribution: f.contribution, raw: f.raw })));
  }

  // Average a set of hour scores into one record (used for a window): mean score, mean factor scores.
  function aggregate(hours) {
    const hs = hours.filter((h) => h && h.scored);
    if (!hs.length) return null;
    const map = new Map();
    for (const h of hs) for (const f of h.factors) {
      const e = map.get(f.id) || { id: f.id, weight: f.weight, scoreSum: 0, contribSum: 0, n: 0, raws: [] };
      e.scoreSum += f.score; e.contribSum += f.contribution; e.n++; e.raws.push(f.raw);
      map.set(f.id, e);
    }
    const factors = [...map.values()].map((e) => ({
      id: e.id, weight: e.weight, score: e.scoreSum / e.n, contribution: e.contribSum / e.n, raw: e.raws[Math.floor(e.raws.length / 2)],
    }));
    const flags = [...new Set(hs.flatMap((h) => h.flags))];
    const rank = { low: 0, medium: 1, high: 2 };
    const conf = hs.reduce((m, h) => (rank[h.confidence] < rank[m] ? h.confidence : m), 'high');
    return {
      score: hs.reduce((a, h) => a + h.score, 0) / hs.length, factors, flags, confidence: conf,
      reasons: pickReasons(factors), hours: hs.length, capped: hs.some((h) => h.capped),
    };
  }

  /* ---------- windows and days ---------- */

  // Best runs of consecutive scored hours per local day. 3-hour runs, falling back to shorter ones.
  function bestWindows(scores, opts) {
    const o = Object.assign({ hours: 3, perDay: 3, tz: 'UTC', fromMs: -Infinity }, opts || {});
    const byDay = new Map();
    for (const s of scores) {
      if (s.ms < o.fromMs) continue;
      const k = localParts(s.ms, o.tz).date;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    }
    const result = [];
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.ms - b.ms);
      const chosen = [];
      const used = new Set();
      for (let rank = 0; rank < o.perDay; rank++) {
        let best = null;
        for (let len = o.hours; len >= 1 && !best; len--) {
          for (let i = 0; i + len <= list.length; i++) {
            const run = list.slice(i, i + len);
            if (!run.every((s) => s.scored && !used.has(s.ms))) continue;
            if (!run.every((s, j) => j === 0 || s.ms - run[j - 1].ms === HOUR)) continue;
            const avg = run.reduce((a, s) => a + s.score, 0) / len;
            if (!best || avg > best.score) best = { score: avg, run };
          }
        }
        if (!best) break;
        for (const s of best.run) used.add(s.ms);
        chosen.push({
          day, rank: rank + 1, score: best.score, band: bandOf(best.score), startMs: best.run[0].ms,
          endMs: best.run[best.run.length - 1].ms + HOUR, hours: best.run.length, profile: best.run[0].profile,
          confidence: best.run.reduce((m, s) => ({ low: 0, medium: 1, high: 2 }[s.confidence] < { low: 0, medium: 1, high: 2 }[m] ? s.confidence : m), 'high'),
        });
      }
      result.push(...chosen);
    }
    return result;
  }

  /* ---------- stats (shot-log diagnostics) ---------- */

  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return null;
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa === 0 || sbb === 0 ? null : sab / Math.sqrt(saa * sbb);
  }
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }
  const spearman = (a, b) => pearson(ranks(a), ranks(b));

  return {
    pearson, ranks, spearman,
    HOUR, CURVES, PROFILES, PROFILE_BY_ID, FACTOR_IDS, FACTOR_LABELS, BANDS, WIND_PRIORS, FACTORS,
    clamp, isNum, cToF, msToMph, mToMi, compass, windPriorFor,
    curve, bandLookup, loadProfile, bandOf, bandName,
    localParts, tzOffsetMs, zonedMidnight, nextDayKey,
    sunPosition, sunTimes, normCdf, buildClimatology, climoStats, dewPercentile,
    mergeHourly, derive, score, aggregate, bestWindows, confidence, flagsFor,
  };
});
