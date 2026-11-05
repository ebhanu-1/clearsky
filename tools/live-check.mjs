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
    let ens = null, pathHours = null;
    try { ens = (await P.fetchEnsemble(place)).records; } catch (e) { failures++; console.log('  FAIL ensemble:', e.kind, e.message); }
    try {
      const path = await P.fetchPath(place, 45, 20);
      const lists = [hours].concat(path.weather.map((w, i) => C.mergeHourly(w, path.air[i] || [])));
      pathHours = C.mergePath(lists);
      if (pathHours.length !== hours.length) { failures++; console.log('  FAIL: path merge length'); }
    } catch (e) { failures++; console.log('  FAIL path:', e.kind, e.message); }
    let kp = null;
    try { kp = await P.fetchKp(); } catch (e) { console.log('  Kp failed (optional):', e.kind, e.message); }
    const ctx = { place, hours, nowMs: Date.now(), climo, second, ens };
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
    if (pathHours) {
      const pc = { ...ctx, hours: pathHours };
      const a = C.score(ctx, C.PROFILE_BY_ID.clarity, { windPrior: C.windPriorFor(place), distance: 'far', bearing: 45 });
      const b = C.score(pc, C.PROFILE_BY_ID.clarity, { windPrior: C.windPriorFor(place), distance: 'far', bearing: 45 });
      const best = (sc) => Math.max(...sc.filter((x) => x.scored && x.ms >= ctx.nowMs).map((x) => x.score));
      console.log(`  far + toward NE: best hour ${best(a).toFixed(0)} at your spot, ${best(b).toFixed(0)} along the line of sight (${pathHours[0].pathPoints} points)`);
    }
    if (ens) console.log(`  ensemble hours=${ens.length} with spread=${ens.filter((e) => e.loC != null).length}`);
    if (kp) console.log(`  Kp rows=${kp.length}, max forecast Kp ${Math.max(...kp.map((k) => k.kp))}`);
    const out = C.airMassOutlook(hours, ctx.nowMs, place.tz);
    console.log('  outlook events:', out.events.map((e) => e.kind + ' ' + e.day + ' (' + e.deltaF.toFixed(0) + 'F)').join(', ') || 'none');
    const dp = derived.find((d) => d.dpPercentile != null);
    console.log('  dew percentile sample:', dp ? dp.dpPercentile.toFixed(0) : 'n/a');
  } catch (e) {
    failures++;
    console.log(`\n${zip} FAILED: ${e.kind || ''} ${e.message}`);
  }
}
process.exit(failures ? 1 : 0);
