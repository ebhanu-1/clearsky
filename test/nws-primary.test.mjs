import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// NWS is the primary weather source (decision D2 revised in v2.1); Open-Meteo is the second source.
const require = createRequire(import.meta.url);
const C = require('../src/core.js');
const P = require('../src/providers.js');
const fx = (n) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8'));

const ANDOVER = { lat: 42.66, lon: -71.15, tz: 'America/New_York', name: 'Andover' };

test('NWS hourly: SI units, full record shape, no gaps, fields the grid lacks stay null', () => {
  const rec = P.normalizeNwsHourly(fx('nws-grid-box.json'));
  assert.ok(rec.length > 150);
  for (let i = 1; i < rec.length; i++) assert.equal(rec[i].ms - rec[i - 1].ms, 3600000, 'gap at ' + i);
  const at = rec.find((r) => r.t === '2026-11-04T09:00:00.000Z');
  assert.ok(Math.abs(at.windMs - 9.26 / 3.6) < 1e-9, 'km/h converted to m/s');
  assert.ok(Math.abs(at.tempC - 12.2222) < 1e-3, 'temperature stays in degrees C');
  assert.ok(Math.abs(at.pblM - 129.54) < 1e-9, 'mixing height in metres');
  assert.ok(rec.every((r) => r.cloudLow === null && r.cloudMid === null && r.cloudHigh === null && r.pressHpa === null));
  assert.ok(rec.every((r) => r.pm25 === null && r.aod === null));
  assert.ok(rec.some((r) => r.dewC != null && r.rh != null && r.cloudTotal != null && r.windDirDeg != null && r.visM != null));
  assert.equal(rec[0].src.weather, 'nws');
});

test('NWS hourly: precipitation accumulations are spread over their hours; units follow the layer', () => {
  const grid = {
    properties: {
      temperature: { uom: 'wmoUnit:degF', values: [{ validTime: '2026-11-07T00:00:00+00:00/PT2H', value: 50 }] },
      dewpoint: { uom: 'wmoUnit:degC', values: [{ validTime: '2026-11-07T00:00:00+00:00/PT2H', value: 4 }] },
      quantitativePrecipitation: { uom: 'wmoUnit:mm', values: [{ validTime: '2026-11-07T00:00:00+00:00/PT6H', value: 6 }] },
      windSpeed: { uom: 'wmoUnit:km_h-1', values: [{ validTime: '2026-11-07T00:00:00+00:00/PT1H', value: 36 }] },
    },
  };
  const rec = P.normalizeNwsHourly(grid);
  assert.equal(rec.length, 2);
  assert.ok(Math.abs(rec[0].tempC - 10) < 1e-9, '50 F is 10 C');
  assert.equal(rec[0].windMs, 10);
  assert.equal(rec[1].windMs, null, 'a value is not carried past its interval');
  assert.equal(P.expandLayer(grid.properties.quantitativePrecipitation, true).size, 6);
  assert.ok([...P.expandLayer(grid.properties.quantitativePrecipitation, true).values()].every((v) => v === 1));
  assert.throws(() => P.normalizeNwsHourly({ properties: {} }), /no temperature, dew point or sky cover/);
  assert.throws(() => P.normalizeNwsHourly({}), /no properties/);
});

function omHours() {
  const t0 = Date.parse('2026-11-04T00:00:00Z');
  return Array.from({ length: 6 }, (_, i) => ({
    t: new Date(t0 + i * 3600000).toISOString(), ms: t0 + i * 3600000,
    tempC: 10, dewC: 5, rh: 70, windMs: 2, gustMs: 3, windDirDeg: 270, cloudTotal: 30, cloudLow: 20, cloudMid: 10, cloudHigh: 30,
    visM: 20000, precipMm: 0, pressHpa: 1010, pblM: 800, isDay: true, pm25: null, pm10: null, aod: null, dust: null, aqiUs: null,
    src: { weather: 'open-meteo', air: null },
  }));
}

test('mergePrimary: NWS wins field by field, the second source fills the rest, nothing is fabricated', () => {
  const om = omHours();
  const nws = [
    { ms: om[2].ms, dewC: 8, tempC: 12, rh: null, windMs: 4, gustMs: null, windDirDeg: 300, cloudTotal: 10, visM: null, precipMm: 0.4, pblM: 250 },
    { ms: om[3].ms, dewC: null, tempC: null, rh: null, windMs: null, gustMs: null, windDirDeg: null, cloudTotal: null, visM: null, precipMm: null, pblM: null },
  ];
  const before = JSON.stringify(om);
  const out = C.mergePrimary(nws, om);
  assert.equal(JSON.stringify(om), before, 'inputs are not mutated');
  assert.equal(out.length, om.length);
  assert.equal(out[0], om[0], 'hours the NWS lacks pass through untouched');
  assert.equal(out[2].dewC, 8); assert.equal(out[2].windMs, 4); assert.equal(out[2].precipMm, 0.4); assert.equal(out[2].pblM, 250);
  assert.equal(out[2].rh, 70, 'a null NWS field falls back to the second source');
  assert.equal(out[2].gustMs, 3); assert.equal(out[2].visM, 20000);
  assert.equal(out[2].pressHpa, 1010, 'pressure only comes from the second source');
  assert.equal(out[2].src.weather, 'nws');
  assert.equal(out[3].dewC, 5, 'an all-null NWS hour changes nothing');
  assert.equal(out[3].src.weather, 'open-meteo');
  assert.equal(C.mergePrimary([], om)[2].dewC, 5);
  assert.equal(C.mergePrimary(null, om).length, om.length);
});

test('mergePrimary: layer cloud cover is capped at the NWS total', () => {
  const om = omHours();
  const out = C.mergePrimary([{ ms: om[1].ms, dewC: 5, cloudTotal: 15 }], om);
  assert.deepEqual([out[1].cloudLow, out[1].cloudMid, out[1].cloudHigh], [15, 10, 15]);
  assert.deepEqual([out[0].cloudLow, out[0].cloudHigh], [20, 30], 'other hours keep their own layers');
});

test('recorded week: NWS primary over the recorded Open-Meteo hours scores every profile and cross-checks', () => {
  const om = C.mergeHourly(P.normalizeForecast(fx('forecast-andover.json')), P.normalizeAir(fx('air-andover.json')));
  const nws = P.normalizeNwsHourly(fx('nws-grid-box.json'));
  const merged = C.mergePrimary(nws, om);
  assert.equal(merged.length, om.length);
  const fromNws = merged.filter((r) => r.src && r.src.weather === 'nws').length;
  assert.ok(fromNws > 100, 'most of the week comes from the NWS: ' + fromNws);
  assert.ok(merged.filter((r) => r.src.weather === 'open-meteo').length > 0, 'past hours stay with the second source');
  assert.ok(merged.every((r) => r.pressHpa != null && r.cloudLow != null), 'cloud layers and pressure survive the merge');
  const second = om.map((r) => ({ ms: r.ms, dewC: r.dewC, cloudTotal: r.cloudTotal, visM: r.visM }));
  const ctx = { place: ANDOVER, hours: merged, nowMs: Date.parse('2026-11-04T15:00:00Z'), climo: null, second, ens: null };
  const derived = C.derive(ctx);
  for (const p of C.PROFILES) {
    const scores = C.score(ctx, p, { derived, windPrior: 'northeast' });
    const scored = scores.filter((s) => s.scored);
    assert.ok(scored.length > 10, p.id + ' scored hours ' + scored.length);
    assert.ok(scored.every((s) => s.score >= 0 && s.score <= 100), p.id);
  }
  // Scores agree with an all-Open-Meteo run to within a reasonable band; a sourcing swap must not wreck the model.
  const base = C.score({ place: ANDOVER, hours: om, nowMs: ctx.nowMs, climo: null, second: null, ens: null }, C.PROFILE_BY_ID.clarity, { windPrior: 'northeast' });
  const next = C.score(ctx, C.PROFILE_BY_ID.clarity, { derived, windPrior: 'northeast' });
  const pairs = base.map((b, i) => [b, next[i]]).filter(([b, n]) => b.scored && n.scored);
  const meanAbs = pairs.reduce((a, [b, n]) => a + Math.abs(b.score - n.score), 0) / pairs.length;
  assert.ok(meanAbs < 15, 'mean absolute score shift ' + meanAbs.toFixed(1));
});

test('NWS alone (Open-Meteo down) still scores: cloud layers, air quality and pressure drop out', () => {
  const nws = C.mergeHourly(P.normalizeNwsHourly(fx('nws-grid-box.json')), []);
  const ctx = { place: ANDOVER, hours: nws, nowMs: nws[10].ms, climo: null, second: null, ens: null };
  const scores = C.score(ctx, C.PROFILE_BY_ID.clarity, { windPrior: 'northeast' });
  const scored = scores.filter((s) => s.scored);
  assert.ok(scored.length > 20);
  assert.ok(scored.every((s) => Number.isFinite(s.score)));
  assert.ok(scored.every((s) => !s.factors.some((f) => f.id === 'particulates')), 'missing air quality drops the factor, never scores it');
});

test('confidence: the second source disagreeing pulls the tier down and says so', () => {
  const r = { dewC: 10, cloudTotal: 20 };
  assert.equal(C.confidence(10, r, { dewC: 10.5, cloudTotal: 25 }, null).level, 'high');
  const dew = C.confidence(10, r, { dewC: 15, cloudTotal: 20 }, null);
  assert.equal(dew.level, 'medium');
  assert.match(dew.note, /second forecast source differs on dew point/);
  const cloud = C.confidence(10, r, { dewC: 10, cloudTotal: 80 }, null);
  assert.equal(cloud.level, 'medium');
  assert.match(cloud.note, /second forecast source differs on cloud cover/);
});

test('providers: NWS answers time zone, elevation and the forecast with two requests; Open-Meteo is the fallback', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const layer = (uom, v) => ({ uom, values: [{ validTime: '2026-11-07T00:00:00+00:00/PT3H', value: v }] });
  const grid = { properties: { elevation: { unitCode: 'wmoUnit:m', value: 123 }, temperature: layer('wmoUnit:degC', 9), dewpoint: layer('wmoUnit:degC', 3), skyCover: layer('wmoUnit:percent', 40) } };
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('api.weather.gov/points/')) return { ok: true, status: 200, json: async () => ({ properties: { forecastGridData: 'https://api.weather.gov/gridpoints/BOX/1,2', timeZone: 'America/New_York' } }) };
      if (u.includes('api.weather.gov/gridpoints')) return { ok: true, status: 200, json: async () => grid };
      throw new Error('unexpected ' + u);
    };
    const place = { lat: 41.1111, lon: -72.2222 };
    const t = await P.resolveTimezone(place.lat, place.lon);
    assert.deepEqual(t, { tz: 'America/New_York', elevM: 123 });
    const nws = await P.fetchNwsHourly(place);
    assert.equal(nws.records.length, 3);
    assert.equal(nws.records[0].dewC, 3);
    assert.equal(calls.filter((u) => u.includes('/points/')).length, 1, 'one /points call');
    assert.equal(calls.filter((u) => u.includes('/gridpoints')).length, 1, 'the grid is fetched once and reused');
    assert.ok(!calls.some((u) => u.includes('open-meteo')), 'no Open-Meteo call for a US point');

    // Outside NWS coverage (404): the time zone comes from Open-Meteo and the NWS fetch throws.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('api.weather.gov')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ timezone: 'America/Halifax', elevation: 40 }) };
    };
    assert.deepEqual(await P.resolveTimezone(45.5555, -62.5555), { tz: 'America/Halifax', elevM: 40 });
    await assert.rejects(() => P.fetchNwsHourly({ lat: 45.5555, lon: -62.5555 }), (e) => e.kind === 'http' && e.status === 404);
  } finally { globalThis.fetch = realFetch; }
});
