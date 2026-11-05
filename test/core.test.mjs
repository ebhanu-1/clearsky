import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const C = require('../src/core.js');
const P = require('../src/providers.js');
const fx = (n) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8'));

const ANDOVER = { lat: 42.66, lon: -71.15, tz: 'America/New_York', name: 'Andover' };
const F = (f) => ((f - 32) * 5) / 9; // °F to °C
const MPH = (m) => m / 2.2369363;
const MI = (m) => m * 1609.344;

// Hand-built hourly series. Fields not given stay null so a scenario only contains the inputs it names.
function series(startIso, n, fn) {
  const t0 = Date.parse(startIso);
  const hours = [];
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * 3600000;
    hours.push(Object.assign({
      t: new Date(ms).toISOString(), ms, tempC: null, dewC: null, rh: null, windMs: null, gustMs: null, windDirDeg: null,
      cloudTotal: null, cloudLow: null, cloudMid: null, cloudHigh: null, visM: null, precipMm: 0, pressHpa: null, pblM: null,
      isDay: true, pm25: null, pm10: null, aod: null, dust: null, aqiUs: null,
    }, fn(i)));
  }
  return hours;
}
const ctxOf = (hours, extra) => Object.assign({ place: ANDOVER, hours, nowMs: hours[0].ms, climo: null, second: null }, extra || {});
const profile = (id) => C.PROFILE_BY_ID[id];
const scoreAt = (ctx, id, i, opts) => C.score(ctx, profile(id), Object.assign({ windPrior: 'northeast' }, opts))[i];

/* ---------- curves ---------- */

test('curve: exact at every anchor, linear between, clamped outside', () => {
  for (const [name, anchors] of Object.entries(C.CURVES)) {
    for (const [x, y] of anchors) assert.ok(Math.abs(C.curve(anchors, x) - y) < 1e-9, name + ' at ' + x);
    const [x0, y0] = anchors[0], [x1, y1] = anchors[anchors.length - 1];
    assert.equal(C.curve(anchors, x0 - 1000), y0, name + ' low clamp');
    assert.equal(C.curve(anchors, x1 + 1000), y1, name + ' high clamp');
    for (let i = 1; i < anchors.length; i++) {
      const mid = (anchors[i][0] + anchors[i - 1][0]) / 2;
      const want = (anchors[i][1] + anchors[i - 1][1]) / 2;
      assert.ok(Math.abs(C.curve(anchors, mid) - want) < 1e-9, name + ' midpoint');
    }
  }
  assert.equal(C.curve([[0, 0], [1, 1]], null), null);
});

test('light-window bands match the design table', () => {
  const b = C.bandLookup;
  const L = (x) => b([[-90, -4, 0], [-4, 0, 0.8], [0, 6, 1], [6, 15, 0.8], [15, 30, 0.5], [30, 91, 0.2]], x);
  assert.deepEqual([-10, -2, 3, 10, 20, 50].map(L), [0, 0.8, 1, 0.8, 0.5, 0.2]);
});

/* ---------- profiles ---------- */

test('every profile loads, uses known factors, and sums to 100', () => {
  assert.equal(C.PROFILES.length, 6);
  for (const p of C.PROFILES) {
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9, p.id + ' sums to ' + sum);
    for (const k of Object.keys(p.weights)) assert.ok(C.FACTOR_IDS.includes(k), k);
  }
  assert.equal(C.PROFILE_BY_ID.clarity.weightSumDeclared, 100);
  assert.equal(C.PROFILE_BY_ID.reflections.weightSumDeclared, 145); // doc inconsistency, normalized on load
  assert.throws(() => C.loadProfile({ weights: { nonsense: 5 } }));
  assert.throws(() => C.loadProfile({ weights: {} }));
});

/* ---------- sun ---------- */

test('sun position: solstice noon elevation, sunrise and sunset times', () => {
  const lat = 42.36, lon = -71.06; // Boston
  const st = C.sunTimes(lat, lon, '2026-06-21', 'America/New_York');
  assert.ok(Math.abs(st.maxElev - (90 - lat + 23.44)) < 0.7, 'max elevation ' + st.maxElev);
  const hm = (ms) => { const p = C.localParts(ms, 'America/New_York'); return p.hour * 60 + p.minute; };
  assert.ok(Math.abs(hm(st.sunrise) - (5 * 60 + 7)) <= 6, 'sunrise ' + hm(st.sunrise));
  assert.ok(Math.abs(hm(st.sunset) - (20 * 60 + 25)) <= 6, 'sunset ' + hm(st.sunset));
  // az at morning is east-ish, evening west-ish
  const am = C.sunPosition(lat, lon, st.sunrise + 30 * 60000), pm = C.sunPosition(lat, lon, st.sunset - 30 * 60000);
  assert.ok(am.azDeg > 40 && am.azDeg < 90, 'am az ' + am.azDeg);
  assert.ok(pm.azDeg > 270 && pm.azDeg < 320, 'pm az ' + pm.azDeg);
});

test('sun edge cases: polar night, midnight sun, DST day lengths', () => {
  const night = C.sunTimes(69.65, 18.96, '2026-12-21', 'Europe/Oslo');
  assert.equal(night.sunrise, null); assert.equal(night.sunset, null); assert.ok(night.maxElev < 0);
  const midnight = C.sunTimes(69.65, 18.96, '2026-06-21', 'Europe/Oslo');
  assert.equal(midnight.sunrise, null); assert.ok(midnight.maxElev > 40);
  // US fall-back day has 25 hours, spring-forward day 23
  const len = (d) => C.zonedMidnight(C.nextDayKey(d), 'America/New_York') - C.zonedMidnight(d, 'America/New_York');
  assert.equal(len('2026-11-01') / 3600000, 25);
  assert.equal(len('2026-03-08') / 3600000, 23);
  assert.equal(len('2026-07-01') / 3600000, 24);
  assert.ok(C.sunTimes(42.66, -71.15, '2026-11-01', 'America/New_York').sunrise > 0);
});

/* ---------- golden scenarios from the build plan ---------- */

test('golden 1: crisp post-front day is Excellent for Clarity', () => {
  // index 24 is 13:00 local; the hour 24 earlier had a dew point 12°F higher
  const h = series('2026-10-09T17:00:00Z', 26, (i) => (i === 24
    ? { dewC: F(28), windMs: MPH(8), windDirDeg: 315, pm25: 4, visM: MI(12), cloudTotal: 0 }
    : i === 0 ? { dewC: F(40) } : { dewC: F(35) }));
  const s = scoreAt(ctxOf(h), 'clarity', 24);
  assert.ok(s.scored); assert.equal(s.band, 'excellent', 'score ' + s.score);
});

test('golden 2: muggy haze day is Skip for Clarity', () => {
  const h = series('2026-07-09T17:00:00Z', 3, () => ({ dewC: F(66), windMs: MPH(6), windDirDeg: 180, aod: 0.5, rh: 90 }));
  const s = scoreAt(ctxOf(h), 'clarity', 1);
  assert.equal(s.band, 'skip', 'score ' + s.score);
});

test('golden 3: smoke day cannot beat Fair despite dry air (caps)', () => {
  const h = series('2026-10-09T17:00:00Z', 3, () => ({ dewC: F(35), pm25: 60, aod: 1.0, visM: MI(3), windMs: MPH(8), windDirDeg: 315, cloudTotal: 0, rh: 40 }));
  const s = scoreAt(ctxOf(h), 'clarity', 1);
  assert.ok(s.capped, 'cap applied'); assert.ok(s.score <= 59, 'score ' + s.score);
  const uncapped = C.score(ctxOf(h), Object.assign({}, profile('clarity'), { caps: [] }), { windPrior: 'northeast' })[1];
  assert.ok(uncapped.score > 59, 'without caps it would hide the smoke: ' + uncapped.score);
});

test('golden 4: fog morning is Excellent for Fog and Skip for Clarity', () => {
  // 06:00 local on 2026-06-20 (sun already up), spread 1°F, rh 98, wind 1 mph, clear, visibility 400 m
  const h = series('2026-06-20T09:00:00Z', 3, () => ({ tempC: F(53), dewC: F(52), rh: 98, windMs: MPH(1), cloudTotal: 0, visM: 400 }));
  assert.equal(C.localParts(h[1].ms, ANDOVER.tz).hour, 6);
  const fog = scoreAt(ctxOf(h), 'fog', 1), clar = scoreAt(ctxOf(h), 'clarity', 1);
  assert.equal(fog.band, 'excellent', 'fog ' + fog.score);
  assert.equal(clar.band, 'skip', 'clarity ' + clar.score);
  assert.ok(fog.flags.includes('fog'));
});

test('golden 5: wet overcast day is Excellent for Soft light and Fair or worse for Clarity', () => {
  // 5 mm fell during the hour ending 4 hours before the target; target at index 40 (afternoon)
  const base = Date.parse('2026-10-09T01:00:00Z');
  const h = series('2026-10-09T01:00:00Z', 42, (i) => {
    const o = { tempC: 12, dewC: 10, rh: 85, windMs: MPH(3), cloudTotal: 100 };
    if (i === 40 - 5) o.precipMm = 5;
    return o;
  });
  assert.equal(C.localParts(h[40].ms, ANDOVER.tz).hour, 13); // 17:00Z, afternoon
  const soft = scoreAt(ctxOf(h), 'soft', 40), clar = scoreAt(ctxOf(h), 'clarity', 40);
  assert.equal(soft.band, 'excellent', 'soft ' + soft.score);
  assert.ok(clar.score < 60, 'clarity ' + clar.score);
  assert.ok(base < h[40].ms);
});

test('golden light scores only hours with the sun near the horizon', () => {
  const h = series('2026-10-09T00:00:00Z', 48, () => ({ cloudMid: 50, cloudHigh: 50, cloudLow: 5, dewC: 5, windMs: 2 }));
  const sc = C.score(ctxOf(h), profile('golden'));
  const scored = sc.filter((s) => s.scored);
  assert.ok(scored.length >= 4 && scored.length <= 12, 'scored ' + scored.length);
  const d = C.derive(ctxOf(h));
  for (const s of scored) { const e = d[s.derivedIndex].sunElevDeg; assert.ok(e > -4 && e <= 10, 'elev ' + e); }
  // both a sunrise run and a sunset run exist on each day, so ranked windows split across them
  const wins = C.bestWindows(sc, { tz: ANDOVER.tz }).filter((w) => w.day === '2026-10-09');
  assert.ok(wins.length >= 2, 'sunrise and sunset windows: ' + wins.length);
});

/* ---------- property tests ---------- */

test('properties: monotone in dew point and PM2.5, bounded, deterministic, renormalizing', () => {
  const mk = (dewF, pm25) => series('2026-10-09T17:00:00Z', 30, (i) => ({
    tempC: 15, dewC: F(dewF), rh: 60, windMs: 3, windDirDeg: 300, cloudTotal: 20, visM: MI(10), pm25, aod: 0.15, pblM: 1000, precipMm: 0,
  }));
  let last = Infinity;
  for (let dew = 20; dew <= 75; dew += 5) {
    const s = scoreAt(ctxOf(mk(dew, 8)), 'clarity', 26).score;
    assert.ok(s <= last + 1e-9, 'dew ' + dew + ': ' + s + ' > ' + last);
    last = s;
  }
  last = -Infinity;
  for (let pm = 80; pm >= 0; pm -= 5) {
    const s = scoreAt(ctxOf(mk(40, pm)), 'clarity', 26).score;
    assert.ok(s >= last - 1e-9, 'pm ' + pm);
    last = s;
  }
  // bounded + deterministic on random inputs; dropping any single input never yields NaN
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let k = 0; k < 200; k++) {
    const h = series('2026-10-09T10:00:00Z', 40, () => ({
      tempC: rnd() * 40 - 5, dewC: rnd() * 30 - 10, rh: rnd() * 100, windMs: rnd() * 15, gustMs: rnd() * 25, windDirDeg: rnd() * 360,
      cloudTotal: rnd() * 100, cloudLow: rnd() * 100, cloudMid: rnd() * 100, cloudHigh: rnd() * 100, visM: rnd() * 40000,
      precipMm: rnd() < 0.3 ? rnd() * 6 : 0, pressHpa: 990 + rnd() * 40, pblM: rnd() * 2500, pm25: rnd() * 100, aod: rnd() * 1.5, dust: rnd() * 80,
    }));
    const ctx = ctxOf(h);
    for (const p of C.PROFILES) {
      const a = C.score(ctx, p), b = C.score(ctx, p);
      assert.deepEqual(a, b);
      for (const s of a) if (s.scored) { assert.ok(s.score >= 0 && s.score <= 100 && !Number.isNaN(s.score), p.id + ' ' + s.score); }
    }
    if (k % 20 === 0) {
      for (const key of ['dewC', 'rh', 'windMs', 'cloudTotal', 'visM', 'pm25', 'aod', 'pblM', 'tempC']) {
        const h2 = h.map((r) => Object.assign({}, r, { [key]: null }));
        for (const p of C.PROFILES) for (const s of C.score(ctxOf(h2), p)) if (s.scored) assert.ok(!Number.isNaN(s.score), key);
      }
    }
  }
});

test('missing input drops its factor instead of scoring zero', () => {
  const h = series('2026-10-09T17:00:00Z', 3, () => ({ dewC: F(30), windMs: MPH(8), windDirDeg: 315, cloudTotal: 0, visM: MI(10), pm25: 4 }));
  const full = scoreAt(ctxOf(h), 'clarity', 1);
  const noVis = scoreAt(ctxOf(h.map((r) => Object.assign({}, r, { visM: null }))), 'clarity', 1);
  assert.ok(full.factors.find((f) => f.id === 'visibility'));
  assert.ok(!noVis.factors.find((f) => f.id === 'visibility'));
  assert.ok(noVis.missing.includes('visibility'));
  assert.ok(Math.abs(noVis.score - full.score) < 2, 'all-ones stay near-equal: ' + full.score + ' vs ' + noVis.score);
});

/* ---------- derived features ---------- */

test('derived: trends, rain scrub features, short series', () => {
  const h = series('2026-10-01T00:00:00Z', 60, (i) => ({
    dewC: 10 - i * 0.1, pressHpa: 1000 + i * 0.5, precipMm: i >= 20 && i < 22 ? 2 : 0,
  }));
  const d = C.derive(ctxOf(h));
  assert.equal(d[10].dpTrend24C, null); // fewer than 24 hours of history
  assert.ok(Math.abs(d[40].dpTrend24C - -2.4) < 1e-9);
  assert.ok(Math.abs(d[40].pTrend12 - 6) < 1e-9);
  assert.equal(d[21].hoursSinceRain, 0);
  assert.equal(d[25].hoursSinceRain, 4);
  assert.ok(Math.abs(d[25].precip24 - 4) < 1e-9);
  assert.equal(d[59].hoursSinceRain, 38);
  const dry = C.derive(ctxOf(series('2026-10-01T00:00:00Z', 60, () => ({}))));
  assert.equal(dry[59].hoursSinceRain, 99); // checked 36+ hours back, no rain
  assert.equal(d[10].hoursSinceRain, null); // unknown, not "none"
});

test('rain scrub factor shape', () => {
  const mkAt = (hoursAfter, mm) => {
    const h = series('2026-10-01T00:00:00Z', 70, (i) => ({ precipMm: i === 30 ? mm : 0 }));
    const d = C.derive(ctxOf(h));
    const i = 30 + hoursAfter;
    return C.FACTORS.rainScrub({ r: h[i], d: d[i], p: profile('clarity') }).score;
  };
  assert.ok(Math.abs(mkAt(0, 3) - 0.3) < 1e-9, 'raining now');
  assert.ok(Math.abs(mkAt(1, 3) - 0.5) < 1e-9, 'just stopped');
  assert.ok(Math.abs(mkAt(3, 3) - 1) < 1e-9, '3 h after 3 mm');
  assert.ok(Math.abs(mkAt(36, 3) - 0.5) < 1e-9, '36 h after');
  assert.ok(mkAt(10, 3) > mkAt(10, 0.5), 'more rain scrubs more');
});

/* ---------- climatology ---------- */

test('climatology percentile agrees with an empirical calculation', { skip: !fs.existsSync(new URL('../tools/spikes/out/era.json', import.meta.url)) }, () => {
  const j = JSON.parse(fs.readFileSync(new URL('../tools/spikes/out/era.json', import.meta.url), 'utf8'));
  const times = j.hourly.time.map((t) => Date.parse(t + ':00Z'));
  const dew = j.hourly.dew_point_2m;
  const climo = C.buildClimatology(times, dew, [2015, 2025]);
  assert.equal(climo.n.length, 53 * 24);
  const target = Date.parse('2026-07-15T18:00:00Z');
  const st = C.climoStats(climo, target);
  assert.ok(st.mean > 12 && st.mean < 20, 'July mean dew ' + st.mean);
  // empirical percentile of a 21°C dew point for mid-July, 18 UTC, +-10 days
  const vals = [];
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i]);
    if (d.getUTCHours() === 18 && Math.abs(C.sunPosition ? ((Date.UTC(2000, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2000, 6, 15)) / 86400000) : 0) <= 10 && dew[i] != null) vals.push(dew[i]);
  }
  for (const probe of [8, 14, 18, 21]) {
    const emp = (100 * vals.filter((v) => v <= probe).length) / vals.length;
    const mod = C.dewPercentile(climo, target, probe);
    assert.ok(Math.abs(emp - mod) <= 8, 'dew ' + probe + ': empirical ' + emp.toFixed(1) + ' model ' + mod.toFixed(1));
  }
  assert.equal(C.dewPercentile(null, target, 10), null);
});

/* ---------- recorded real responses ---------- */

function recordedCtx() {
  const wx = P.normalizeForecast(fx('forecast-andover.json'));
  const air = P.normalizeAir(fx('air-andover.json'));
  const hours = C.mergeHourly(wx, air);
  const nowMs = Date.parse('2026-11-04T15:00:00Z');
  return ctxOf(hours, { nowMs, second: P.normalizeNwsGrid(fx('nws-grid-box.json')) });
}

test('provider normalization: SI units, hourly, no gaps; merge never fabricates', () => {
  const wx = P.normalizeForecast(fx('forecast-andover.json'));
  assert.equal(wx.length, 216);
  for (let i = 1; i < wx.length; i++) assert.equal(wx[i].ms - wx[i - 1].ms, 3600000);
  assert.ok(wx[0].tempC < 40 && wx[0].tempC > -40);
  assert.ok(wx[0].visM > 100);
  const air = P.normalizeAir(fx('air-andover.json'));
  const merged = C.mergeHourly(wx, air);
  assert.equal(merged.length, wx.length);
  const airNull = air.filter((a) => a.pm25 == null).length;
  assert.equal(merged.filter((m) => m.pm25 == null).length, airNull);
  assert.equal(C.mergeHourly(wx, []).filter((m) => m.pm25 == null).length, wx.length);
});

test('NWS grid expansion: durations, hourly series', () => {
  assert.equal(P.durationMs('PT3H'), 3 * 3600000);
  assert.equal(P.durationMs('P1DT3H'), 27 * 3600000);
  assert.equal(P.durationMs('PT30M'), 30 * 60000);
  const rec = P.normalizeNwsGrid(fx('nws-grid-box.json'));
  assert.ok(rec.length > 100);
  for (let i = 1; i < rec.length; i++) assert.equal(rec[i].ms - rec[i - 1].ms, 3600000, 'gap at ' + i);
  assert.ok(rec.some((r) => r.dewC != null) && rec.some((r) => r.cloudTotal != null));
});

test('recorded week: every profile scores sanely, windows and reasons exist, within the time budget', () => {
  const ctx = recordedCtx();
  const derived = C.derive(ctx);
  const t0 = Date.now();
  const all = {};
  for (const p of C.PROFILES) all[p.id] = C.score(ctx, p, { derived, windPrior: 'northeast' });
  const ms = Date.now() - t0;
  assert.ok(ms < 50, 'scoring 6 profiles took ' + ms + ' ms');
  for (const [id, list] of Object.entries(all)) {
    const scored = list.filter((s) => s.scored);
    assert.ok(scored.length > (id === 'golden' ? 10 : 20), id + ' scored hours ' + scored.length);
    for (const s of scored) {
      assert.ok(s.score >= 0 && s.score <= 100, id);
      if (s.reasons.length) assert.ok(s.reasons.every((r) => ['dewpoint', ...C.FACTOR_IDS].includes(r.factor)));
    }
    const wins = C.bestWindows(list, { tz: ctx.place.tz, fromMs: ctx.nowMs });
    assert.ok(wins.length >= 3, id + ' windows ' + wins.length);
    for (const w of wins) { assert.ok(w.endMs > w.startMs); assert.ok(w.hours <= 3); }
  }
  // lead-time confidence tiers
  const clar = all.clarity.filter((s) => s.scored);
  const near = clar.find((s) => s.ms > ctx.nowMs && s.ms < ctx.nowMs + 24 * 3600000);
  const far = clar.filter((s) => s.ms > ctx.nowMs + 120 * 3600000)[0];
  assert.ok(['high', 'medium'].includes(near.confidence));
  assert.equal(far.confidence, 'low');
  // day profiles skip night hours; fog profile scores only 03:00-09:00 local
  for (const s of all.fog.filter((x) => x.scored)) { const h = C.localParts(s.ms, ctx.place.tz).hour; assert.ok(h >= 3 && h <= 9, 'fog hour ' + h); }
  for (const s of all.clarity.filter((x) => !x.scored)) assert.equal(s.score, null);
});

test('windows: best run per day, ranks do not overlap, short runs fall back', () => {
  const h = series('2026-10-09T10:00:00Z', 30, (i) => ({ dewC: F(30 + (i % 24) * 1.2), windMs: 2, windDirDeg: 300, cloudTotal: 0, rh: 40, pm25: 3 }));
  const sc = C.score(ctxOf(h), profile('clarity'), { windPrior: 'northeast' });
  const w = C.bestWindows(sc, { tz: ANDOVER.tz });
  const byDay = {};
  for (const x of w) (byDay[x.day] = byDay[x.day] || []).push(x);
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].score <= list[0].score + 1e-9);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      assert.ok(list[i].endMs <= list[j].startMs || list[j].endMs <= list[i].startMs, 'overlap');
  }
});

/* ---------- provider failure modes (mocked fetch) ---------- */

test('provider failure table: timeout, rate limit, http, shape, network', async () => {
  const realFetch = globalThis.fetch;
  const mock = (impl) => { globalThis.fetch = impl; };
  try {
    mock(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'timeout');
    mock(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}) }));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'rate-limit');
    mock(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'http' && e.status === 503);
    mock(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'http' && e.status === 404);
    mock(() => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'shape');
    mock(() => Promise.reject(new TypeError('fetch failed')));
    await assert.rejects(P.http('https://x.test/a', { retries: 0 }), (e) => e.kind === 'network');
    assert.throws(() => P.normalizeForecast({}), (e) => e.kind === 'shape');
    assert.throws(() => P.normalizeAir({ hourly: {} }), (e) => e.kind === 'shape');
    await assert.rejects(P.geocodeZip('abc'), (e) => e.kind === 'shape');

    // zip lookup: Zippopotam 404 falls back to Nominatim
    const calls = [];
    mock((url) => {
      calls.push(String(url));
      if (String(url).includes('zippopotam')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => fx('nominatim-01810.json') });
    });
    const place = await P.geocodeZip('98199');
    assert.ok(calls.some((u) => u.includes('nominatim')));
    assert.ok(Math.abs(place.lat - 42.64) < 0.01);
    // success path through Zippopotam
    mock(() => Promise.resolve({ ok: true, status: 200, json: async () => fx('zippo-01810.json') }));
    const p2 = await P.geocodeZip('01810');
    assert.equal(p2.name, 'Andover'); assert.equal(p2.state, 'MA');
    assert.deepEqual(P.parseLatLon('42.65, -71.15'), { lat: 42.65, lon: -71.15 });
    assert.equal(P.parseLatLon('91, 0'), null);
  } finally { globalThis.fetch = realFetch; }
});
