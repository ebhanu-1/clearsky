/* ClearSky providers: network adapters that emit normalized SI/UTC records.
 * Imports nothing from core. Works in browsers and in Node 18+ (global fetch).
 * Every function throws ProviderError{kind: timeout|rate-limit|http|shape|network} and is cache-aware.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClearSkyProviders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  class ProviderError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.name = 'ProviderError';
      this.kind = kind;
      this.status = status || null;
    }
  }

  /* ---------- cache (localStorage when present, memory otherwise) ---------- */

  const mem = new Map();
  const hasLS = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  const cache = {
    get(key, ttlMs) {
      let raw = null;
      try { raw = hasLS() ? localStorage.getItem('cs:' + key) : mem.get(key) || null; } catch (e) { raw = mem.get(key) || null; }
      if (!raw) return null;
      try {
        const o = JSON.parse(raw);
        if (ttlMs != null && Date.now() - o.at > ttlMs) return null;
        return o;
      } catch (e) { return null; }
    },
    set(key, value) {
      const raw = JSON.stringify({ at: Date.now(), v: value });
      try { if (hasLS()) localStorage.setItem('cs:' + key, raw); else mem.set(key, raw); } catch (e) { mem.set(key, raw); }
    },
  };

  /* ---------- http ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 8 s timeout per request; 429 and 5xx retry after 1, 2, 4 s, then throw so callers fall back to cache.
  async function http(url, opts) {
    const o = Object.assign({ timeoutMs: 8000, retries: 3, as: 'json', headers: undefined }, opts || {});
    let lastErr;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ProviderError('network', 'You are offline');
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs) : null;
      try {
        const res = await fetch(url, { signal: ctl ? ctl.signal : undefined, headers: o.headers });
        if (timer) clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new ProviderError(res.status === 429 ? 'rate-limit' : 'http', 'HTTP ' + res.status + ' from ' + hostOf(url), res.status);
          if (attempt < o.retries) { await sleep(1000 * 2 ** attempt); continue; }
          throw lastErr;
        }
        if (!res.ok) throw new ProviderError('http', 'HTTP ' + res.status + ' from ' + hostOf(url), res.status);
        try { return o.as === 'text' ? await res.text() : await res.json(); }
        catch (e) { throw new ProviderError('shape', 'Unreadable response from ' + hostOf(url)); }
      } catch (e) {
        if (timer) clearTimeout(timer);
        if (e instanceof ProviderError) throw e;
        const timedOut = e && e.name === 'AbortError';
        lastErr = new ProviderError(timedOut ? 'timeout' : 'network', timedOut ? 'Timed out calling ' + hostOf(url) : 'Network error calling ' + hostOf(url));
        // A dropped connection retries once after 1 s; offline users should reach their cached copy quickly.
        if (attempt < Math.min(o.retries, 1) && !timedOut) { await sleep(1000); continue; }
        throw lastErr;
      }
    }
    throw lastErr;
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }

  /* ---------- geocoding ---------- */

  const zipOk = (z) => /^\d{5}$/.test(String(z).trim());

  function parseLatLon(s) {
    const m = String(s).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  // Zippopotam.us first (CORS, keyless), Nominatim when it has no record for the zip.
  async function geocodeZip(zip) {
    zip = String(zip).trim();
    if (!zipOk(zip)) throw new ProviderError('shape', 'Enter a 5-digit US zip code, or "lat, lon".');
    const hit = cache.get('zip:' + zip, null);
    if (hit) return hit.v;
    let place = null;
    try {
      const j = await http('https://api.zippopotam.us/us/' + zip, { retries: 1 });
      const p = j && j.places && j.places[0];
      if (!p) throw new ProviderError('shape', 'Zippopotam returned no places');
      place = { zip, lat: +p.latitude, lon: +p.longitude, name: p['place name'], state: p['state abbreviation'] };
    } catch (e) {
      if (e.kind === 'http' && e.status === 404) { /* fall through to Nominatim */ }
      else if (e.kind === 'timeout' || e.kind === 'network' || e.kind === 'rate-limit' || e.kind === 'http' || e.kind === 'shape') { /* fall through */ }
      else throw e;
    }
    if (!place) {
      const j = await http('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=1&postalcode=' + zip, { retries: 1 });
      if (!Array.isArray(j) || !j.length) throw new ProviderError('shape', 'No place found for zip ' + zip + '. Try "lat, lon".');
      const a = j[0].address || {};
      place = {
        zip, lat: +j[0].lat, lon: +j[0].lon,
        name: a.city || a.town || a.village || a.county || String(j[0].display_name || zip).split(',')[1] || zip,
        state: a['ISO3166-2-lvl4'] ? a['ISO3166-2-lvl4'].replace('US-', '') : a.state || '',
      };
    }
    cache.set('zip:' + zip, place);
    return place;
  }

  async function reverseName(lat, lon) {
    try {
      const j = await http('https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&addressdetails=1&lat=' + lat + '&lon=' + lon, { retries: 0, timeoutMs: 5000 });
      const a = (j && j.address) || {};
      return { name: a.city || a.town || a.village || a.county || null, state: a['ISO3166-2-lvl4'] ? a['ISO3166-2-lvl4'].replace('US-', '') : a.state || '' };
    } catch (e) { return { name: null, state: '' }; }
  }

  // Time zone id (and elevation) for a coordinate, via a tiny Open-Meteo call.
  async function resolveTimezone(lat, lon) {
    const key = 'tz:' + lat.toFixed(2) + ',' + lon.toFixed(2);
    const hit = cache.get(key, null);
    if (hit) return hit.v;
    const j = await http('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&daily=sunrise&forecast_days=1&timezone=auto', { retries: 1 });
    if (!j || !j.timezone) throw new ProviderError('shape', 'No time zone in response');
    const v = { tz: j.timezone, elevM: isNum(j.elevation) ? j.elevation : 0 };
    cache.set(key, v);
    return v;
  }

  // Zip or "lat, lon" -> Place with tz.
  async function resolvePlace(input) {
    const s = String(input).trim();
    const ll = parseLatLon(s);
    let place;
    if (ll) {
      const rn = await reverseName(ll.lat, ll.lon);
      place = { zip: null, lat: ll.lat, lon: ll.lon, name: rn.name || ll.lat.toFixed(3) + ', ' + ll.lon.toFixed(3), state: rn.state };
    } else place = await geocodeZip(s);
    const t = await resolveTimezone(place.lat, place.lon);
    return Object.assign({}, place, { tz: t.tz, elevM: t.elevM });
  }

  /* ---------- Open-Meteo forecast and air quality ---------- */

  const FORECAST_VARS = [
    'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation', 'surface_pressure', 'cloud_cover',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'wind_speed_10m', 'wind_direction_10m',
    'wind_gusts_10m', 'boundary_layer_height', 'is_day',
  ];
  const AIR_VARS = ['pm2_5', 'pm10', 'aerosol_optical_depth', 'dust', 'us_aqi'];

  const msOf = (t) => Date.parse(t.length === 16 ? t + ':00Z' : t.endsWith('Z') ? t : t + 'Z');
  const num = (a, i) => (a && isNum(a[i]) ? a[i] : null);

  function normalizeForecast(j) {
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time) || !h.time.length) throw new ProviderError('shape', 'Forecast response has no hourly data');
    return h.time.map((t, i) => {
      const ms = msOf(t);
      return {
        t: new Date(ms).toISOString(), ms,
        tempC: num(h.temperature_2m, i), dewC: num(h.dew_point_2m, i), rh: num(h.relative_humidity_2m, i),
        windMs: num(h.wind_speed_10m, i), gustMs: num(h.wind_gusts_10m, i), windDirDeg: num(h.wind_direction_10m, i),
        cloudTotal: num(h.cloud_cover, i), cloudLow: num(h.cloud_cover_low, i), cloudMid: num(h.cloud_cover_mid, i), cloudHigh: num(h.cloud_cover_high, i),
        visM: num(h.visibility, i), precipMm: num(h.precipitation, i) == null ? 0 : h.precipitation[i], pressHpa: num(h.surface_pressure, i),
        pblM: num(h.boundary_layer_height, i), isDay: h.is_day ? h.is_day[i] === 1 : null,
        pm25: null, pm10: null, aod: null, dust: null, aqiUs: null,
        src: { weather: 'open-meteo', air: null },
      };
    });
  }

  function normalizeAir(j) {
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time)) throw new ProviderError('shape', 'Air-quality response has no hourly data');
    return h.time.map((t, i) => ({
      ms: msOf(t), pm25: num(h.pm2_5, i), pm10: num(h.pm10, i), aod: num(h.aerosol_optical_depth, i), dust: num(h.dust, i), aqiUs: num(h.us_aqi, i),
    }));
  }

  async function cachedJson(key, ttlMs, url, opts) {
    const hit = cache.get(key, ttlMs);
    if (hit) return { json: hit.v, at: hit.at, fromCache: true };
    try {
      const json = await http(url, opts);
      cache.set(key, json);
      return { json, at: Date.now(), fromCache: false };
    } catch (e) {
      const stale = cache.get(key, null);
      if (stale) return { json: stale.v, at: stale.at, fromCache: true, stale: true, error: e };
      throw e;
    }
  }

  const ckey = (p) => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);

  async function fetchForecast(place, range) {
    const r = Object.assign({ pastDays: 2, forecastDays: 7 }, range || {});
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=' + FORECAST_VARS.join(',') + '&past_days=' + r.pastDays + '&forecast_days=' + r.forecastDays + '&timezone=GMT&wind_speed_unit=ms';
    const res = await cachedJson('fc:' + ckey(place), 60 * 60000, url);
    return { records: normalizeForecast(res.json), at: res.at, fromCache: res.fromCache, stale: !!res.stale, error: res.error || null, elevM: isNum(res.json.elevation) ? res.json.elevation : null };
  }

  async function fetchAirQuality(place, range) {
    const r = Object.assign({ pastDays: 2, forecastDays: 7 }, range || {});
    const url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=' + AIR_VARS.join(',') + '&past_days=' + r.pastDays + '&forecast_days=' + r.forecastDays + '&timezone=GMT';
    const res = await cachedJson('aq:' + ckey(place), 60 * 60000, url);
    return { records: normalizeAir(res.json), at: res.at, fromCache: res.fromCache, stale: !!res.stale, error: res.error || null };
  }

  /* ---------- ERA5 climate series (reduced to a table by core.buildClimatology) ---------- */

  async function fetchClimateSeries(place, years) {
    const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + place.lat.toFixed(2) + '&longitude=' + place.lon.toFixed(2) +
      '&start_date=' + years[0] + '-01-01&end_date=' + years[1] + '-12-31&hourly=dew_point_2m&timezone=GMT';
    const j = await http(url, { timeoutMs: 25000, retries: 1 });
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h.dew_point_2m)) throw new ProviderError('shape', 'Archive response has no dew point series');
    return { timesMs: h.time.map(msOf), dewC: h.dew_point_2m };
  }

  /* ---------- NWS second opinion ---------- */

  // ISO 8601 duration to milliseconds (only the PnDTnHnM subset the NWS grid uses).
  function durationMs(d) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
    if (!m) return 3600000;
    return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60) * 1000;
  }
  function expandLayer(layer) {
    const out = new Map();
    if (!layer || !Array.isArray(layer.values)) return out;
    for (const v of layer.values) {
      if (!isNum(v.value)) continue;
      const [start, dur] = String(v.validTime).split('/');
      const s = Date.parse(start);
      const n = Math.min(Math.max(1, Math.round(durationMs(dur) / 3600000)), 24 * 7);
      for (let i = 0; i < n; i++) out.set(s + i * 3600000, v.value);
    }
    return out;
  }

  function normalizeNwsGrid(j) {
    const p = j && j.properties;
    if (!p) throw new ProviderError('shape', 'NWS grid response has no properties');
    const dew = expandLayer(p.dewpoint), sky = expandLayer(p.skyCover), vis = expandLayer(p.visibility);
    const keys = [...new Set([...dew.keys(), ...sky.keys()])].sort((a, b) => a - b);
    return keys.map((ms) => ({
      ms, t: new Date(ms).toISOString(), dewC: dew.has(ms) ? dew.get(ms) : null, cloudTotal: sky.has(ms) ? sky.get(ms) : null,
      visM: vis.has(ms) ? vis.get(ms) : null,
    }));
  }

  // US only. Browsers refuse to set a custom User-Agent, and setting one would force a CORS preflight,
  // so the browser's own UA identifies the request. Node callers may pass opts.headers.
  async function fetchSecondOpinion(place, opts) {
    const headers = (opts && opts.headers) || undefined;
    const kp = 'nws:grid:' + ckey(place);
    let gridUrl = (cache.get(kp, 24 * 3600000) || {}).v;
    if (!gridUrl) {
      const pts = await http('https://api.weather.gov/points/' + place.lat.toFixed(4) + ',' + place.lon.toFixed(4), { retries: 1, headers });
      gridUrl = pts && pts.properties && pts.properties.forecastGridData;
      if (!gridUrl) throw new ProviderError('shape', 'NWS /points gave no forecastGridData');
      cache.set(kp, gridUrl);
    }
    const res = await cachedJson('nws:' + ckey(place), 60 * 60000, gridUrl, { retries: 1, timeoutMs: 10000, headers });
    return { records: normalizeNwsGrid(res.json), at: res.at, fromCache: res.fromCache };
  }

  /* ---------- historical forecast, for the shot log ---------- */

  async function fetchPast(place, dayKey) {
    const w = 'https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=' + FORECAST_VARS.join(',') + '&start_date=' + dayKey + '&end_date=' + dayKey + '&timezone=GMT&wind_speed_unit=ms';
    const a = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=' + AIR_VARS.join(',') + '&start_date=' + dayKey + '&end_date=' + dayKey + '&timezone=GMT';
    const [wj, aj] = await Promise.all([
      cachedJson('past:' + ckey(place) + ':' + dayKey, 365 * 86400000, w),
      cachedJson('pastaq:' + ckey(place) + ':' + dayKey, 365 * 86400000, a).catch(() => null),
    ]);
    return { weather: normalizeForecast(wj.json), air: aj ? normalizeAir(aj.json) : [] };
  }

  /* ---------- view path: weather along the line of sight ---------- */

  // Points at 50% and 100% of the distance along a compass bearing (great-circle destination).
  function pathPoints(place, bearingDeg, miles) {
    const R = 6371, rad = Math.PI / 180;
    const out = [];
    for (const frac of [0.5, 1]) {
      const d = (miles * 1.609344 * frac) / R, th = bearingDeg * rad, la = place.lat * rad, lo = place.lon * rad;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(th));
      const lo2 = lo + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      out.push({ lat: Math.round((la2 / rad) * 1000) / 1000, lon: Math.round((((lo2 / rad) + 540) % 360 - 180) * 1000) / 1000 });
    }
    return out;
  }

  // One weather call and one air-quality call, each with both points. Returns arrays aligned with `points`.
  async function fetchPath(place, bearingDeg, miles, range) {
    const r = Object.assign({ pastDays: 2, forecastDays: 7 }, range || {});
    const pts = pathPoints(place, bearingDeg, miles);
    const lat = pts.map((p) => p.lat).join(','), lon = pts.map((p) => p.lon).join(',');
    const wUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&hourly=' + FORECAST_VARS.join(',') +
      '&past_days=' + r.pastDays + '&forecast_days=' + r.forecastDays + '&timezone=GMT&wind_speed_unit=ms';
    const aUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat + '&longitude=' + lon + '&hourly=' + AIR_VARS.join(',') +
      '&past_days=' + r.pastDays + '&forecast_days=' + r.forecastDays + '&timezone=GMT';
    const key = ckey({ lat: pts[0].lat, lon: pts[0].lon }) + ',' + ckey({ lat: pts[1].lat, lon: pts[1].lon });
    const [w, a] = await Promise.all([
      cachedJson('pathw:' + key, 60 * 60000, wUrl),
      cachedJson('patha:' + key, 60 * 60000, aUrl).catch(() => null),
    ]);
    const list = (j) => (Array.isArray(j) ? j : [j]);
    return {
      points: pts, at: w.at,
      weather: list(w.json).map(normalizeForecast),
      air: a ? list(a.json).map((x) => { try { return normalizeAir(x); } catch (e) { return []; } }) : pts.map(() => []),
    };
  }

  /* ---------- forecast ensemble: how much the models disagree about dew point ---------- */

  // Reduces all ensemble members to hourly 10th/90th percentiles and a standard deviation (deg C).
  function reduceEnsemble(j) {
    const h = j && j.hourly;
    if (!h || !Array.isArray(h.time)) throw new ProviderError('shape', 'Ensemble response has no hourly data');
    const keys = Object.keys(h).filter((k) => k.indexOf('dew_point_2m') === 0);
    if (keys.length < 5) throw new ProviderError('shape', 'Ensemble response has too few members');
    const q = (sorted, p) => { const x = (sorted.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x); return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo); };
    return h.time.map((t, i) => {
      const v = keys.map((k) => h[k][i]).filter(isNum).sort((a, b) => a - b);
      if (v.length < 5) return { ms: msOf(t), loC: null, hiC: null, meanC: null, sdC: null, n: v.length };
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
      return { ms: msOf(t), loC: q(v, 0.1), hiC: q(v, 0.9), meanC: mean, sdC: sd, n: v.length };
    });
  }
  async function fetchEnsemble(place) {
    const url = 'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=' + place.lat + '&longitude=' + place.lon +
      '&hourly=dew_point_2m&models=gfs025&forecast_days=7&timezone=GMT';
    const res = await cachedJson('ens:' + ckey(place), 3 * 60 * 60000, url, { timeoutMs: 10000, retries: 1 });
    return { records: reduceEnsemble(res.json), at: res.at };
  }

  /* ---------- NOAA SWPC planetary K forecast (aurora hint) ---------- */

  async function fetchKp() {
    const res = await cachedJson('kp', 30 * 60000, 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', { retries: 1 });
    const rows = Array.isArray(res.json) ? res.json : [];
    return rows.filter((x) => x && isNum(+x.kp) && x.time_tag).map((x) => ({ ms: Date.parse(x.time_tag + 'Z'), kp: +x.kp, observed: x.observed }));
  }

  return {
    pathPoints, fetchPath, reduceEnsemble, fetchEnsemble, fetchKp,
    ProviderError, cache, http, zipOk, parseLatLon, geocodeZip, reverseName, resolveTimezone, resolvePlace,
    normalizeForecast, normalizeAir, normalizeNwsGrid, durationMs, expandLayer,
    fetchForecast, fetchAirQuality, fetchClimateSeries, fetchSecondOpinion, fetchPast, FORECAST_VARS, AIR_VARS,
  };
});
