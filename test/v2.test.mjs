// v2.0: clarity-first additions. Subject distance, view direction vs the sun, view-path merge, ensemble
// confidence, air-mass outlook, field notes, moon and aurora extras, new provider adapters. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/core.js');
const P = require('../src/providers.js');
const F = require('../src/format.js');

const ANDOVER = { lat: 42.66, lon: -71.15, tz: 'America/New_York', name: 'Andover' };
const f2c = (f) => ((f - 32) * 5) / 9;
const mph = (m) => m / 2.2369363;
const mi = (m) => m * 1609.344;

function series(startIso, n, fn) {
  const t0 = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => {
    const ms = t0 + i * 3600000;
    return Object.assign({
      t: new Date(ms).toISOString(), ms, tempC: null, dewC: null, rh: null, windMs: null, gustMs: null, windDirDeg: null,
      cloudTotal: null, cloudLow: null, cloudMid: null, cloudHigh: null, visM: null, precipMm: 0, pressHpa: null, pblM: null,
      isDay: true, pm25: null, pm10: null, aod: null, dust: null, aqiUs: null,
    }, fn(i));
  });
}
const ctxOf = (hours, extra) => Object.assign({ place: ANDOVER, hours, nowMs: hours[0].ms, climo: null, second: null }, extra || {});
// A hazy-ish mid-morning with a moderate dew point, so distance has something to change.
const humid = () => series('2026-06-10T14:00:00Z', 1, () => ({ tempC: f2c(72), dewC: f2c(61), rh: 70, windMs: mph(6), windDirDeg: 315, cloudTotal: 20, cloudLow: 0, visM: mi(7), pm25: 14, aod: 0.3, pblM: 1200 }));
const dry = () => series('2026-06-10T14:00:00Z', 1, () => ({ tempC: f2c(60), dewC: f2c(28), rh: 35, windMs: mph(6), windDirDeg: 315, cloudTotal: 10, cloudLow: 0, visM: mi(25), pm25: 3, aod: 0.05, pblM: 1500 }));

test('profiles: clarity weights sum to 100 and viewLight is a known factor', () => {
  const p = C.PROFILE_BY_ID.clarity;
  assert.equal(p.weightSumDeclared, 100);
  assert.ok(p.weights.heatShimmer > 0 && p.weights.viewLight > 0 && p.weights.lowCloudClear > 0);
  assert.ok(C.FACTOR_IDS.includes('viewLight'));
});

test('distance: far punishes humid air more than near; dry air is unaffected; mid is the plain profile', () => {
  const h = humid(), d = dry();
  const at = (hours, distance) => C.score(ctxOf(hours), C.PROFILE_BY_ID.clarity, { windPrior: 'neutral', distance })[0].score;
  const [n, m, fr] = ['near', 'mid', 'far'].map((x) => at(h, x));
  assert.ok(n > m && m > fr, `humid: near ${n} mid ${m} far ${fr}`);
  assert.equal(at(h, 'mid'), at(h, undefined), 'mid equals no distance');
  const [dn, dm, df] = ['near', 'mid', 'far'].map((x) => at(d, x));
  assert.ok(Math.abs(dn - df) < 12 && df > 80, `dry: near ${dn} mid ${dm} far ${df}`);
  const w = C.score(ctxOf(h), C.PROFILE_BY_ID.clarity, { distance: 'far' })[0].factors.reduce((a, x) => a + x.weight, 0);
  assert.ok(Math.abs(w - 100) < 1e-9 || w <= 100, 'weights stay normalized');
});

test('viewLight: low sun, looking into it is worst; side-on is best; overhead sun and no bearing drop out', () => {
  const hours = series('2026-06-10T23:00:00Z', 1, () => ({ tempC: f2c(60), dewC: f2c(40), rh: 50, windMs: mph(5), cloudTotal: 10, visM: mi(20) }));
  const d = C.derive(ctxOf(hours))[0];
  assert.ok(d.sunElevDeg > 0 && d.sunElevDeg < 15, 'late-day sun ' + d.sunElevDeg);
  const va = (bearing) => C.FACTORS.viewLight({ d, bearing });
  const into = va(d.sunAzDeg), side = va((d.sunAzDeg + 90) % 360), behind = va((d.sunAzDeg + 180) % 360);
  assert.ok(into.score < 0.3 && side.score > 0.95 && behind.score > 0.8 && into.score < behind.score);
  assert.equal(C.FACTORS.viewLight({ d, bearing: null }), null);
  const high = C.FACTORS.viewLight({ d: Object.assign({}, d, { sunElevDeg: 60 }), bearing: d.sunAzDeg });
  assert.ok(Math.abs(high.score - 1) < 1e-9, 'overhead sun has no directional effect');
  assert.equal(C.FACTORS.viewLight({ d: Object.assign({}, d, { sunElevDeg: -10 }), bearing: 0 }), null);
  // Through the full score: looking into the low sun scores lower than looking away.
  const sc = (b) => C.score(ctxOf(hours), C.PROFILE_BY_ID.clarity, { windPrior: 'neutral', bearing: b })[0].score;
  assert.ok(sc(d.sunAzDeg) < sc((d.sunAzDeg + 180) % 360));
});

test('bestViewSector: away from the sun, polarizer at right angles, any direction when the sun is high', () => {
  const s = C.bestViewSector(270, 8); // sun in the west
  assert.equal(s.centerDeg, 90);
  assert.deepEqual([s.from, s.to], ['NE', 'SE']);
  assert.deepEqual(s.polarizer.slice().sort(), ['N', 'S']);
  assert.equal(C.bestViewSector(180, 62).any, true);
  assert.equal(C.bestViewSector(180, -20), null);
});

test('mergePath: dew and humidity average, visibility and particulates take the worst point', () => {
  const mk = (o) => series('2026-06-10T12:00:00Z', 2, () => o);
  const origin = mk({ dewC: 10, rh: 50, visM: 20000, pm25: 5, aod: 0.1, cloudLow: 0, tempC: 20, windMs: 3 });
  const mid = mk({ dewC: 14, rh: 70, visM: 8000, pm25: 30, aod: 0.2, cloudLow: 40, tempC: 99 });
  const far = mk({ dewC: 12, rh: 60, visM: null, pm25: null, aod: 0.7, cloudLow: 10 });
  const m = C.mergePath([origin, mid, far]);
  assert.equal(m.length, 2);
  assert.equal(m[0].dewC, 12); assert.equal(m[0].rh, 60);
  assert.equal(m[0].visM, 8000, 'worst visibility, null ignored');
  assert.equal(m[0].pm25, 30); assert.equal(m[0].aod, 0.7); assert.equal(m[0].cloudLow, 40);
  assert.equal(m[0].tempC, 20, 'everything else stays from the origin');
  assert.equal(m[0].windMs, 3);
  assert.equal(m[0].pathPoints, 3);
  // A smoke plume on the path lowers the score even when the origin is clean.
  const clean = mk({ dewC: f2c(30), rh: 35, visM: mi(25), pm25: 3, aod: 0.05, tempC: f2c(60), windMs: mph(5), cloudTotal: 10 });
  const smoky = mk({ dewC: f2c(30), rh: 35, visM: mi(25), pm25: 60, aod: 1, tempC: f2c(60), windMs: mph(5), cloudTotal: 10 });
  const sc = (hours) => C.score(ctxOf(hours), C.PROFILE_BY_ID.clarity, { windPrior: 'neutral' })[0].score;
  assert.ok(sc(C.mergePath([clean, smoky])) < sc(clean) - 15);
  // Missing path data never fabricates values: a one-list merge is the origin.
  assert.equal(C.mergePath([clean])[0].pm25, 3);
});

test('confidence: wide ensemble spread lowers a tier; agreement is noted and never raises it', () => {
  const r = { dewC: 5 };
  const base = C.confidence(24, r, null, null);
  assert.equal(base.level, 'high');
  const wide = C.confidence(24, r, null, { loC: 0, hiC: 8 }); // 14.4 F spread
  assert.equal(wide.level, 'medium');
  assert.match(wide.note, /spread the dew point/);
  const tight = C.confidence(24, r, null, { loC: 4, hiC: 5 });
  assert.equal(tight.level, 'high');
  assert.match(tight.note, /agree/);
  assert.equal(C.confidence(120, r, null, { loC: 0, hiC: 8 }).level, 'low');
  assert.equal(C.confidence(24, r, { dewC: 0 }, { loC: 0, hiC: 8 }).level, 'low', 'NWS and ensemble stack');
});

test('ensemble spread flows through derive and score', () => {
  const hours = dry();
  const ens = [{ ms: hours[0].ms, loC: -4, hiC: 6, meanC: 1, sdC: 3 }];
  const d = C.derive(ctxOf(hours, { ens }))[0];
  assert.equal(d.dewLoC, -4); assert.equal(d.dewHiC, 6);
  const s = C.score(ctxOf(hours, { ens }), C.PROFILE_BY_ID.clarity, { windPrior: 'neutral' })[0];
  assert.equal(s.dewLoC, -4);
  assert.notEqual(s.confidence, 'high');
});

test('airMassOutlook: finds the drying day after a front and the moistening day after', () => {
  // Four local days of dew points: 62, 62, 34, 34, 52 (F) at midday hours; night hours ignored.
  const dewF = { '2026-06-09': 62, '2026-06-10': 62, '2026-06-11': 34, '2026-06-12': 34, '2026-06-13': 52 };
  const hours = series('2026-06-09T04:00:00Z', 5 * 24, (i) => {
    const day = new Date(Date.parse('2026-06-09T04:00:00Z') + i * 3600000 - 4 * 3600000).toISOString().slice(0, 10);
    return { dewC: f2c(dewF[day] || 50) };
  });
  const now = Date.parse('2026-06-10T12:00:00Z');
  const o = C.airMassOutlook(hours, now, 'America/New_York');
  assert.ok(o.daily.every((d) => d.day >= '2026-06-10'));
  const kinds = o.events.map((e) => e.kind + ':' + e.day);
  assert.deepEqual(kinds, ['drying:2026-06-11', 'moistening:2026-06-13']);
  assert.ok(o.events[0].deltaF < -20);
});

test('airMassOutlook: a 7 F change is not an event', () => {
  const dewF = { '2026-06-09': 50, '2026-06-10': 50, '2026-06-11': 43, '2026-06-12': 50 };
  const hours = series('2026-06-09T04:00:00Z', 4 * 24, (i) => {
    const day = new Date(Date.parse('2026-06-09T04:00:00Z') + i * 3600000 - 4 * 3600000).toISOString().slice(0, 10);
    return { dewC: f2c(dewF[day] || 50) };
  });
  assert.deepEqual(C.airMassOutlook(hours, Date.parse('2026-06-10T12:00:00Z'), 'America/New_York').events, []);
});

test('moonInfo: known phases', () => {
  assert.equal(C.moonInfo(Date.UTC(2000, 0, 6, 18, 14)).name, 'New moon');
  const full = C.moonInfo(Date.UTC(2024, 5, 22, 1, 0)); // full moon 2024-06-22
  assert.ok(full.illum > 0.97, 'illum ' + full.illum);
  assert.equal(full.name, 'Full moon');
  const q = C.moonInfo(Date.UTC(2024, 5, 14, 5, 18)); // first quarter 2024-06-14
  assert.ok(Math.abs(q.illum - 0.5) < 0.1);
});

test('auroraHint: Kp and geomagnetic latitude', () => {
  assert.equal(C.auroraHint(25.8, -80.2, 7).level, null, 'Miami never');
  assert.equal(C.auroraHint(45.5, -69, 7).level, 'likely', 'Maine at Kp 7');
  assert.equal(C.auroraHint(45.5, -69, 5).level, 'possible', 'Maine at Kp 5');
  assert.equal(C.auroraHint(45.5, -69, 2).level, null);
  assert.equal(C.auroraHint(45.5, -69, null), null);
});

test('fieldNotes: advice follows the factors, problems first, capped at six', () => {
  const f = F.makeFmt('us');
  const sector = C.bestViewSector(270, 8);
  const hazy = F.fieldNotes({
    fac: { dewpoint: { score: 0.1, raw: { dewC: f2c(66), pct: null } }, particulates: { score: 0.1, raw: { pm25: 60, aod: 1 } }, heatShimmer: { score: 0.6, raw: {} }, airmass: { score: 0.1, raw: {} }, ventilation: { score: 0.2, raw: {} } },
    flags: ['smoke', 'shimmer'], sector, bearing: null,
  }, f);
  assert.ok(hazy.length <= 6 && hazy.length >= 4);
  assert.equal(hazy[0].kind, 'warn');
  assert.ok(hazy.some((n) => /Smoke/.test(n.text)) && hazy.some((n) => /shimmer/i.test(n.text)) && hazy.some((n) => /66°F/.test(n.text)));
  const good = F.fieldNotes({ fac: { dewpoint: { score: 0.95, raw: { dewC: f2c(28) } }, particulates: { score: 0.9, raw: {} }, airmass: { score: 0.9, raw: {} } }, flags: [], sector: { any: true, polarizer: [] } }, f);
  assert.ok(good.some((n) => n.kind === 'good' && /Dry, clean/.test(n.text)));
  assert.ok(good.some((n) => /sun is high/i.test(n.text)));
  const glare = F.fieldNotes({ fac: { viewLight: { score: 0.2, raw: {} } }, flags: [], sector, bearing: 270 }, f);
  assert.equal(glare[0].kind, 'warn');
  assert.match(glare[0].text, /toward the sun/);
  assert.deepEqual(F.fieldNotes({ fac: {}, flags: [] }, f), []);
});

test('verdict and viewLight text', () => {
  assert.equal(F.verdict(85).id, 'go'); assert.equal(F.verdict(55).id, 'maybe'); assert.equal(F.verdict(20).id, 'wait'); assert.equal(F.verdict(null).id, 'none');
  assert.equal(F.dirName(0), 'N'); assert.equal(F.dirName(225), 'SW'); assert.equal(F.dirName(359), 'N');
  const t = F.describe('viewLight', -1, { bearing: 270, sunAz: 280, elev: 9 }, F.makeFmt('us'));
  assert.match(t, /Looking W, sun W 9° up/);
});

test('provider: pathPoints go the right distance and direction', () => {
  const pts = P.pathPoints({ lat: 40, lon: -105 }, 90, 40); // due east
  assert.equal(pts.length, 2);
  assert.ok(pts[0].lon > -105 && pts[1].lon > pts[0].lon);
  assert.ok(Math.abs(pts[1].lat - 40) < 0.1);
  const km = (a, b) => { const R = 6371, r = Math.PI / 180, dl = (b.lon - a.lon) * r, dp = (b.lat - a.lat) * r; const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  assert.ok(Math.abs(km({ lat: 40, lon: -105 }, pts[1]) - 40 * 1.609344) < 1, 'far point at 40 miles');
  assert.ok(Math.abs(km({ lat: 40, lon: -105 }, pts[0]) - 20 * 1.609344) < 1, 'mid point at 20 miles');
  const n = P.pathPoints({ lat: 40, lon: -105 }, 0, 40);
  assert.ok(n[1].lat > 40.5 && Math.abs(n[1].lon + 105) < 0.01);
  const wrap = P.pathPoints({ lat: 0, lon: 179.9 }, 90, 60);
  assert.ok(wrap[1].lon < -170 || wrap[1].lon > 179, 'longitude wraps');
});

test('provider: ensemble reduces members to percentiles; rejects thin or malformed responses', () => {
  const time = ['2026-11-05T00:00', '2026-11-05T01:00'];
  const hourly = { time, dew_point_2m: [5, 5] };
  for (let m = 1; m <= 20; m++) hourly['dew_point_2m_member' + String(m).padStart(2, '0')] = [m % 10, null];
  const r = P.reduceEnsemble({ hourly });
  assert.equal(r.length, 2);
  assert.ok(r[0].hiC > r[0].loC && r[0].n === 21);
  assert.equal(r[1].n, 1); assert.equal(r[1].loC, null, 'too few members gives null, not a made-up range');
  assert.throws(() => P.reduceEnsemble({ hourly: { time, dew_point_2m: [1, 2] } }), (e) => e.kind === 'shape');
  assert.throws(() => P.reduceEnsemble({}), (e) => e.kind === 'shape');
  assert.equal(r[0].ms, Date.parse('2026-11-05T00:00:00Z'));
});

test('provider: path and kp adapters work against mocked fetch, and fail soft', async () => {
  const realFetch = globalThis.fetch;
  const wx = (n) => ({ hourly: { time: ['2026-11-05T00:00', '2026-11-05T01:00'], temperature_2m: [10 + n, 11 + n], dew_point_2m: [1, 2], relative_humidity_2m: [50, 50], precipitation: [0, 0], surface_pressure: [1000, 1000], cloud_cover: [0, 0], cloud_cover_low: [0, 0], cloud_cover_mid: [0, 0], cloud_cover_high: [0, 0], visibility: [20000, 20000], wind_speed_10m: [2, 2], wind_direction_10m: [0, 0], wind_gusts_10m: [3, 3], boundary_layer_height: [500, 500], is_day: [1, 1] } });
  const aq = (n) => ({ hourly: { time: ['2026-11-05T00:00', '2026-11-05T01:00'], pm2_5: [5 + n, 6 + n], pm10: [8, 8], aerosol_optical_depth: [0.1, 0.1], dust: [1, 1], us_aqi: [20, 20] } });
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('air-quality') ? [aq(0), aq(10)] : u.includes('swpc') ? [{ time_tag: '2026-11-05T00:00:00', kp: '3.67', observed: 'observed' }, { time_tag: '2026-11-06T00:00:00', kp: 5, observed: 'predicted' }, { time_tag: 'x', kp: 'bad' }] : [wx(0), wx(5)];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const p = await P.fetchPath({ lat: 40.001, lon: -105.001 }, 45, 30);
    assert.equal(p.points.length, 2); assert.equal(p.weather.length, 2); assert.equal(p.air.length, 2);
    assert.equal(p.weather[1][0].tempC, 15); assert.equal(p.air[1][1].pm25, 16);
    const merged = C.mergePath([p.weather[0].map((r, i) => Object.assign({}, r, { pm25: p.air[0][i].pm25 })), p.weather[1].map((r, i) => Object.assign({}, r, { pm25: p.air[1][i].pm25 }))]);
    assert.equal(merged[0].pm25, 15);
    const kp = await P.fetchKp();
    assert.deepEqual(kp.map((x) => x.kp), [3.67, 5], 'bad rows dropped');
    // Air quality failing still returns weather for the path.
    globalThis.fetch = async (url) => {
      if (String(url).includes('air-quality')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [wx(0), wx(5)] };
    };
    const p2 = await P.fetchPath({ lat: 41.002, lon: -104.002 }, 200, 30);
    assert.equal(p2.weather.length, 2); assert.deepEqual(p2.air, [[], []]);
  } finally { globalThis.fetch = realFetch; }
});

test('ics: valid calendar text with escaping and a reminder', () => {
  const t = F.ics({ uid: 'cs-clarity-1', nowMs: Date.UTC(2026, 10, 5, 12, 0), startMs: Date.UTC(2026, 10, 8, 20, 0), endMs: Date.UTC(2026, 10, 8, 23, 0), title: 'ClearSky: Clarity, window; (92)', desc: 'Line one\nLine two, with comma', loc: 'Denver, CO', alarmMin: 60 });
  const lines = t.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(lines.includes('DTSTART:20261108T200000Z'));
  assert.ok(lines.includes('DTEND:20261108T230000Z'));
  const B = String.fromCharCode(92); // one backslash
  assert.ok(lines.includes('SUMMARY:ClearSky: Clarity' + B + ', window' + B + '; (92)'), 'commas and semicolons are escaped');
  assert.ok(lines.includes('DESCRIPTION:Line one' + B + 'nLine two' + B + ', with comma'), 'newlines become backslash-n');
  assert.ok(lines.includes('LOCATION:Denver' + B + ', CO'));
  assert.ok(lines.includes('TRIGGER:-PT60M'));
  assert.equal(lines[lines.length - 2], 'END:VCALENDAR');
  assert.equal(lines.filter((l) => l.startsWith('BEGIN:')).length, 3);
});
