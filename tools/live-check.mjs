// Live end-to-end check against the real APIs (no keys). Run: node tools/live-check.mjs [zip ...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../src/core.js');
const P = require('../src/providers.js');

const zips = process.argv.slice(2).length ? process.argv.slice(2) : ['01810', '80202', '33101', '98101'];
const fmt = (ms, tz) => { const p = C.localParts(ms, tz); return p.weekday + ' ' + String(p.hour).padStart(2, '0') + ':00'; };
let failures = 0;

for (const zip of zips) {
  const t0 = Date.now();
  try {
    const place = await P.resolvePlace(zip);
    const [fc, aq] = await Promise.all([P.fetchForecast(place), P.fetchAirQuality(place)]);
    const hours = C.mergeHourly(fc.records, aq.records);
    let climo = null, second = null;
    try { const s = await P.fetchClimateSeries(place, [2015, 2025]); climo = C.buildClimatology(s.timesMs, s.dewC, [2015, 2025]); } catch (e) { console.log('  climatology failed:', e.kind, e.message); }
    try {
      const nws = await P.fetchSecondOpinion(place, { headers: { 'User-Agent': 'ClearSky/0.1 live-check (ebhanu@gmail.com)' } });
      second = nws.records;
    } catch (e) { console.log('  NWS failed:', e.kind, e.message); }
    const ctx = { place, hours, nowMs: Date.now(), climo, second };
    const derived = C.derive(ctx);
    const gaps = hours.filter((h, i) => i && h.ms - hours[i - 1].ms !== 3600000).length;
    const nullAir = hours.filter((h) => h.pm25 == null).length;
    console.log(`\n${zip} ${place.name}, ${place.state}  (${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}) tz=${place.tz} elev=${place.elevM}m  ${Date.now() - t0} ms`);
    console.log(`  hours=${hours.length} gaps=${gaps} airNull=${nullAir} climo=${climo ? 'yes' : 'no'} nws=${second ? second.length + ' h' : 'no'}`);
    if (gaps) { failures++; console.log('  FAIL: gaps in merged series'); }
    for (const p of C.PROFILES) {
      const sc = C.score(ctx, p, { derived, windPrior: C.windPriorFor(place) });
      const wins = C.bestWindows(sc, { tz: place.tz, fromMs: ctx.nowMs - 3600000 }).filter((w) => w.rank === 1).sort((a, b) => b.score - a.score);
      const top = wins[0];
      const scored = sc.filter((s) => s.scored);
      if (scored.some((s) => !(s.score >= 0 && s.score <= 100))) { failures++; console.log('  FAIL: score out of range for', p.id); }
      console.log(`  ${p.name.padEnd(13)} best ${top ? fmt(top.startMs, place.tz) + '-' + fmt(top.endMs, place.tz).slice(4) + '  ' + top.score.toFixed(0) + ' ' + top.band + ' (' + top.confidence + ')' : 'none'}   scored hours: ${scored.length}`);
    }
    const dp = derived.find((d) => d.dpPercentile != null);
    console.log('  dew percentile sample:', dp ? dp.dpPercentile.toFixed(0) : 'n/a');
  } catch (e) {
    failures++;
    console.log(`\n${zip} FAILED: ${e.kind || ''} ${e.message}`);
  }
}
process.exit(failures ? 1 : 0);
