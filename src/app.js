/* ClearSky app: UI layer. Builds DOM with textContent only (no innerHTML on data).
 * v2: clarity-first and mobile-first. Four tabs: Plan (best window, week ahead, your shot), Day (chart, why,
 * field notes), Layers (hour-by-hour haze, smoke, moisture and cloud layers) and More. */
(function () {
  'use strict';
  const C = window.ClearSkyCore, P = window.ClearSkyProviders, F = window.ClearSkyFormat;
  const HOUR = C.HOUR;
  const isNum = C.isNum;

  /* ---------- tiny helpers ---------- */

  const SVGNS = 'http://www.w3.org/2000/svg';
  function build(ns, tag, attrs, kids) {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of [].concat(kids || [])) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  }
  const h = (tag, attrs, ...kids) => build(null, tag, attrs, kids.flat());
  const s = (tag, attrs, ...kids) => build(SVGNS, tag, attrs, kids.flat());
  const $ = (sel, root) => (root || document).querySelector(sel);
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('csk:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('csk:' + k, JSON.stringify(v)); } catch (e) { /* private mode or full */ } },
  };

  /* ---------- state ---------- */

  const S = {
    units: 'us', // US units only (°F, mph, in, mi)
    tab: 'plan',
    profileId: store.get('profile', 'clarity'),
    windPrior: store.get('windPrior', 'auto'),
    distance: store.get('distance', 'mid'),       // subject distance: near | mid | far
    bearing: store.get('bearing', null),          // direction you are looking, degrees, or null for "any"
    input: '', place: null, hours: null, hourByMs: new Map(), climo: null, second: null, ens: null, kp: null, nowMs: 0,
    pathHours: null, pathState: 'idle', pathTok: 0, outlook: null,
    ctx: null, derived: null, scores: {}, windows: {}, dayKeys: [], day: null, sel: null,
    loading: false, error: null, notes: [], updatedAt: null, loadId: 0, climoState: 'idle', nwsState: 'idle', ensState: 'idle',
    recents: store.get('recents', []), saved: store.get('saved', []), log: store.get('log', []), logResults: store.get('logResults', {}),
    chart: null,
  };
  if (!C.PROFILE_BY_ID[S.profileId]) S.profileId = 'clarity';
  if (!C.DISTANCE[S.distance]) S.distance = 'mid';
  if (!isNum(S.bearing)) S.bearing = null;
  const fmt = () => F.makeFmt(S.units);
  const profile = () => C.PROFILE_BY_ID[S.profileId];
  const tz = () => (S.place ? S.place.tz : 'UTC');
  const isClarity = () => S.profileId === 'clarity';

  /* ---------- loading ---------- */

  const clim = (place) => 'climo:' + place.lat.toFixed(2) + ',' + place.lon.toFixed(2);

  async function loadClimo(place) {
    const key = clim(place);
    const hit = P.cache.get(key, 90 * 86400000);
    if (hit) return hit.v;
    const years = [2015, new Date().getUTCFullYear() - 1];
    const ser = await P.fetchClimateSeries(place, years);
    const table = C.buildClimatology(ser.timesMs, ser.dewC, years);
    P.cache.set(key, table);
    return table;
  }

  async function load(input) {
    input = String(input || '').trim();
    if (!input) return;
    const id = ++S.loadId;
    S.loading = true; S.error = null; S.notes = []; S.climo = null; S.second = null; S.ens = null; S.kp = null; S.pathHours = null;
    S.climoState = 'loading'; S.nwsState = 'loading'; S.ensState = 'loading'; S.pathState = 'idle';
    render();
    let place;
    try { place = await P.resolvePlace(input); }
    catch (e) { if (id === S.loadId) fail(e, input); return; }
    if (id !== S.loadId) return;
    S.place = place; S.input = input;

    const fcP = P.fetchForecast(place);
    const aqP = P.fetchAirQuality(place).then((r) => r, (e) => ({ error: e, records: [] }));
    loadClimo(place).then((c) => { if (id !== S.loadId) return; S.climo = c; S.climoState = 'ok'; refine(); }, () => { if (id === S.loadId) { S.climoState = 'failed'; render(); } });
    P.fetchSecondOpinion(place).then((r) => { if (id !== S.loadId) return; S.second = r.records; S.nwsState = 'ok'; refine(); }, () => { if (id === S.loadId) { S.nwsState = 'failed'; render(); } });
    P.fetchEnsemble(place).then((r) => { if (id !== S.loadId) return; S.ens = r.records; S.ensState = 'ok'; refine(); }, () => { if (id === S.loadId) { S.ensState = 'failed'; render(); } });
    P.fetchKp().then((k) => { if (id === S.loadId) { S.kp = k; if (S.hours) renderSun(); } }, () => { /* aurora hint is optional */ });

    let fc;
    try { fc = await fcP; } catch (e) { if (id === S.loadId) fail(e, input); return; }
    if (id !== S.loadId) return;
    const aq = await aqP;
    if (id !== S.loadId) return;

    S.hours = C.mergeHourly(fc.records, aq.records || []);
    S.hourByMs = new Map(S.hours.map((r) => [r.ms, r]));
    S.updatedAt = fc.at;
    if (fc.stale) S.notes.push({ kind: 'warn', text: "Couldn't reach Open-Meteo. Showing the saved forecast from " + F.ageLabel(fc.at, Date.now()) + '.' });
    else if (fc.fromCache && Date.now() - fc.at > 3 * 3600000) S.notes.push({ kind: 'warn', text: 'Forecast is ' + F.ageLabel(fc.at, Date.now()).replace(' ago', '') + ' old.' });
    if (!aq.records || !aq.records.length) S.notes.push({ kind: 'warn', text: 'Partial: smoke and particulates are not included, so scores use the remaining factors.' });
    else if (!aq.records.some((r) => r.pm25 != null)) S.notes.push({ kind: 'warn', text: 'Partial: no air-quality data for this location.' });
    S.nowMs = Math.floor(Date.now() / HOUR) * HOUR;
    S.loading = false;
    S.tab = 'plan';
    recompute();
    pickDay(true);
    remember(place, input);
    try { history.replaceState(null, '', '#' + encodeURIComponent(input)); } catch (e) { /* file:// or sandbox */ }
    render();
    $('#q').value = input;
    if (S.bearing != null) loadPath();
  }

  function fail(e, input) {
    S.loading = false;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    S.error = {
      input,
      text: offline ? "You're offline and this place has no saved forecast." : e && e.message ? e.message : 'Something went wrong.',
      kind: e && e.kind,
    };
    S.place = null; S.hours = null;
    render();
  }

  // The air along your line of sight: weather and air quality at points toward the subject, merged with your spot.
  async function loadPath() {
    const tok = ++S.pathTok;
    if (S.bearing == null || !S.place || !S.hours) { S.pathHours = null; S.pathState = 'idle'; return; }
    S.pathState = 'loading'; renderBanner();
    try {
      const p = await P.fetchPath(S.place, S.bearing, C.DISTANCE[S.distance].miles);
      if (tok !== S.pathTok) return;
      const lists = [S.hours].concat(p.weather.map((w, i) => C.mergeHourly(w, p.air[i] || [])));
      S.pathHours = C.mergePath(lists);
      S.pathState = 'ok';
    } catch (e) {
      if (tok !== S.pathTok) return;
      S.pathHours = null; S.pathState = 'failed';
    }
    refine();
  }

  function refine() { if (!S.hours) return; recompute(); const keepDay = S.day; pickDay(false); if (keepDay && S.dayKeys.includes(keepDay)) S.day = keepDay; render(); }

  function recompute() {
    const place = S.place;
    const ctx = { place, hours: S.hours, nowMs: S.nowMs, climo: S.climo, second: S.second, ens: S.ens };
    S.ctx = ctx;
    S.derived = C.derive(ctx);
    const prior = S.windPrior === 'auto' ? C.windPriorFor(place) : S.windPrior;
    for (const p of C.PROFILES) {
      let c = ctx, d = S.derived;
      // Only Clarity looks along the line of sight; the other shoot types are about the spot you stand on.
      if (p.id === 'clarity' && S.pathHours) { c = Object.assign({}, ctx, { hours: S.pathHours }); d = C.derive(c); }
      S.scores[p.id] = C.score(c, p, { derived: d, windPrior: prior, distance: S.distance, bearing: S.bearing });
      S.windows[p.id] = C.bestWindows(S.scores[p.id], { tz: place.tz, fromMs: S.nowMs });
    }
    S.outlook = C.airMassOutlook(S.hours, S.nowMs, place.tz);
    const keys = [];
    for (const r of S.hours) if (r.ms >= S.nowMs) { const k = C.localParts(r.ms, place.tz).date; if (!keys.includes(k)) keys.push(k); }
    S.dayKeys = keys.slice(0, 8);
  }

  function remember(place, input) {
    const label = place.name + (place.state ? ', ' + place.state : '');
    S.recents = [{ input, label }].concat(S.recents.filter((x) => x.input !== input)).slice(0, 5);
    store.set('recents', S.recents);
    store.set('last', input);
  }

  /* ---------- selection ---------- */

  const dayWindows = (pid, day) => (S.windows[pid] || []).filter((w) => w.day === day).sort((a, b) => a.rank - b.rank);
  function bestOverall(pid, maxLeadH) {
    let best = null;
    for (const w of S.windows[pid] || []) {
      if (w.rank !== 1) continue;
      if (maxLeadH != null && w.startMs - S.nowMs > maxLeadH * HOUR) continue;
      if (!best || w.score > best.score) best = w;
    }
    return best;
  }
  function pickDay(force) {
    const best = bestOverall(S.profileId);
    if (force || !S.day || !S.dayKeys.includes(S.day)) S.day = best ? best.day : S.dayKeys[0] || null;
    const w = S.day ? dayWindows(S.profileId, S.day)[0] : null;
    S.sel = w ? { kind: 'window', day: S.day, rank: w.rank } : null;
  }
  function selectProfile(pid, keepDay) {
    S.profileId = pid; store.set('profile', pid);
    if (keepDay && S.day) { const w = dayWindows(pid, S.day)[0]; S.sel = w ? { kind: 'window', day: S.day, rank: 1 } : null; }
    else pickDay(true);
    render();
  }
  function openDay(day, sel) {
    S.day = day;
    const w = dayWindows(S.profileId, day)[0];
    S.sel = sel || (w ? { kind: 'window', day, rank: w.rank } : null);
    S.tab = 'day';
    render();
    window.scrollTo(0, 0);
  }
  function setTab(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }
  function select(sel) {
    S.sel = sel;
    if (S.chart) S.chart.setSel(sel);
    renderWhy();
  }

  /* ---------- small UI parts ---------- */

  const BAND_LABEL = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', skip: 'Skip' };
  const bandChip = (band, text) => h('span', { class: 'chip band-' + band }, text || BAND_LABEL[band]);
  const verdictChip = (score) => { const v = F.verdict(score); return h('span', { class: 'verdict v-' + v.id }, v.label); };

  function dots(level) {
    const n = { high: 3, medium: 2, low: 1 }[level] || 0;
    return h('span', { class: 'dots', role: 'img', 'aria-label': level + ' confidence' },
      [0, 1, 2].map((i) => h('i', { class: i < n ? 'on' : '' })), h('span', { class: 'dots-text' }, level));
  }

  const hoursOfDay = (pid, day) => (S.scores[pid] || []).filter((x) => C.localParts(x.ms, tz()).date === day);
  const winLabel = (w) => F.rangeLabel(w.startMs, w.endMs, tz());
  const dayLabel = (ms) => F.weekday(ms, tz());
  const dayNoon = (day) => C.zonedMidnight(day, tz()) + 12 * HOUR;
  const dayTitle = (day) => dayLabel(dayNoon(day)) + ' ' + F.dateLabel(dayNoon(day), tz());
  const midOf = (w) => w.startMs + (w.endMs - w.startMs) / 2;

  function reasonText(r) { return F.describe(r.factor, r.sign, r.raw, fmt()); }

  const windowAgg = (w) => C.aggregate(S.scores[S.profileId].filter((x) => x.ms >= w.startMs && x.ms < w.endMs));
  function headline(w) {
    const agg = windowAgg(w);
    if (!agg) return '';
    const pos = agg.reasons.find((r) => r.sign > 0), neg = agg.reasons.find((r) => r.sign < 0);
    const r = w.score >= 50 ? pos || neg : neg || pos;
    return r ? F.shortReason(r.factor, r.sign, r.raw, fmt()) : '';
  }
  function heroReasons(w) {
    const agg = windowAgg(w);
    if (!agg) return [];
    return [agg.reasons.find((r) => r.sign > 0), agg.reasons.find((r) => r.sign < 0)].filter(Boolean)
      .map((r) => h('div', { class: 'hl ' + (r.sign > 0 ? 'pos' : 'neg') }, h('span', { class: 'sym', 'aria-hidden': 'true' }, r.sign > 0 ? '+' : '−'), h('span', null, reasonText(r))));
  }
  const sunAt = (ms) => C.sunPosition(S.place.lat, S.place.lon, ms);
  function sectorOf(ms) { const p = sunAt(ms); return C.bestViewSector(p.azDeg, p.elevDeg); }
  function pointLine(w) {
    const sec = sectorOf(midOf(w));
    if (!sec) return null;
    if (sec.any) return 'Sun is high: view direction matters little.';
    return 'Point away from the sun: ' + sec.from + ' to ' + sec.to + '. Polarizer best toward ' + sec.polarizer.join(' or ') + '.';
  }
  function dewRangeLine(w) {
    const sc = (S.scores[S.profileId] || []).find((x) => x.ms === w.startMs);
    if (!sc || !isNum(sc.dewLoC) || !isNum(sc.dewHiC)) return null;
    const lo = Math.round(C.cToF(sc.dewLoC)), hi = Math.round(C.cToF(sc.dewHiC));
    return lo === hi ? 'Forecast models agree on a ' + lo + '°F dew point.' : 'Dew point across forecast models: ' + lo + '–' + hi + '°F.';
  }

  const ICONS = {
    plan: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    day: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
  };
  const icon = (name) => s('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true', class: 'ico' }, s('path', { d: ICONS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

  /* ---------- render: top level ---------- */

  function render() {
    renderChips(); renderBanner();
    const app = clear($('#app'));
    const bar = $('#tabbar');
    if (bar) bar.hidden = true;
    document.body.classList.toggle('has-tabs', false);
    if (S.error) { app.appendChild(errorCard()); return; }
    if (S.loading && !S.hours) { app.appendChild(skeleton()); return; }
    if (!S.hours) { app.appendChild(welcome()); return; }
    renderTabbar();
    if (S.tab === 'day') renderDayTab(app);
    else if (S.tab === 'layers') renderLayersTab(app);
    else if (S.tab === 'more') renderMoreTab(app);
    else renderPlanTab(app);
  }

  function renderTabbar() {
    const bar = $('#tabbar');
    if (!bar) return;
    clear(bar);
    bar.hidden = false;
    document.body.classList.add('has-tabs');
    for (const [id, label] of [['plan', 'Plan'], ['day', 'Day'], ['layers', 'Layers'], ['more', 'More']]) {
      bar.appendChild(h('button', { type: 'button', class: 'tabbtn', 'aria-current': S.tab === id ? 'page' : null, onclick: () => setTab(id) }, icon(id), h('span', null, label)));
    }
  }

  function renderChips() {
    const el = clear($('#chips'));
    const seen = new Set();
    const add = (label, input, cls) => { if (seen.has(input)) return; seen.add(input); el.appendChild(h('button', { type: 'button', class: 'pill ' + (cls || ''), onclick: () => { $('#q').value = input; load(input); } }, label)); };
    for (const x of S.saved) add('★ ' + x.label, x.input, 'saved');
    for (const x of S.recents) add(x.label, x.input);
    el.hidden = !el.children.length;
  }

  function renderBanner() {
    const el = clear($('#banner'));
    const notes = S.notes.slice();
    if (S.hours && S.climoState === 'failed') notes.push({ kind: 'info', text: 'Climate comparison unavailable; dew point uses its absolute scale only.' });
    if (S.hours && S.nwsState === 'failed') notes.push({ kind: 'info', text: 'NWS cross-check unavailable; confidence uses forecast lead time only.' });
    if (S.hours && S.ensState === 'failed') notes.push({ kind: 'info', text: 'Forecast-spread data unavailable; confidence uses lead time only.' });
    if (S.hours && S.pathState === 'failed') notes.push({ kind: 'warn', text: "Couldn't load weather along your line of sight, so Clarity uses your spot only." });
    if (S.hours && S.pathState === 'loading') notes.push({ kind: 'info', text: 'Checking the air along your line of sight…' });
    else if (S.hours && (S.climoState === 'loading' || S.nwsState === 'loading' || S.ensState === 'loading')) notes.push({ kind: 'info', text: 'Refining with climate history, forecast spread and the NWS cross-check…' });
    for (const n of notes) el.appendChild(h('div', { class: 'banner ' + n.kind, role: n.kind === 'warn' ? 'status' : null }, n.text));
  }

  function skeleton() {
    return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
      h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk sk-chart' }), h('div', { class: 'sk sk-row' }));
  }

  function errorCard() {
    return h('section', { class: 'card error', role: 'alert' },
      h('h2', null, "Couldn't load that place"),
      h('p', null, S.error.text),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => load(S.error.input) }, 'Try again'),
        h('span', { class: 'muted' }, 'Use a 5-digit US zip code, or latitude and longitude like 42.65, -71.15.')));
  }

  function welcome() {
    const pts = [
      ['Haze, smoke and moisture', 'Dew point, aerosols, visibility and mixing height decide how far the eye and the lens can see.'],
      ['Your line of sight', 'Tell it how far and which way you shoot. It checks the air along that line, not just at your feet.'],
      ['Sun and shimmer', 'Which way to point so the sun is not veiling the view, and when heat shimmer softens long lenses.'],
      ['The week ahead', 'When dry air arrives behind a front, when haze returns, and how sure the forecast is.'],
    ];
    return h('section', { class: 'card welcome' },
      h('h2', null, 'Will the air be clear enough for distant shots?'),
      h('p', null, 'Enter a US zip code to see which hour this week gives the cleanest, sharpest view of far ridges, skylines and ranges, and why.'),
      h('div', { class: 'types' }, pts.map(([a, b]) => h('div', { class: 'type' }, h('strong', null, a), h('span', null, b)))),
      h('p', { class: 'muted' }, 'Try one:'),
      h('div', { class: 'chips' }, [['01810', 'Andover, MA'], ['80202', 'Denver, CO'], ['98101', 'Seattle, WA'], ['33101', 'Miami, FL']].map(([z, n]) =>
        h('button', { type: 'button', class: 'pill', onclick: () => { $('#q').value = z; load(z); } }, z + ' · ' + n))));
  }

  /* ---------- PLAN tab ---------- */

  function renderPlanTab(app) {
    app.appendChild(h('nav', { id: 'profiles', 'aria-label': 'Shoot type' }));
    app.appendChild(h('section', { id: 'hero', 'aria-label': 'Best time' }));
    if (isClarity()) app.appendChild(h('section', { id: 'yourshot', class: 'card', 'aria-label': 'Your shot' }));
    app.appendChild(h('section', { id: 'glance', 'aria-label': 'Week ahead' }));
    app.appendChild(h('section', { id: 'weeklist', 'aria-label': 'Days' }));
    renderProfiles(); renderHero(); if (isClarity()) renderYourShot(); renderGlance(); renderWeekList();
  }

  function renderProfiles() {
    const el = clear($('#profiles'));
    el.className = 'profiles';
    for (const p of C.PROFILES) {
      el.appendChild(h('button', { type: 'button', class: 'tab' + (p.id === 'clarity' ? ' primary' : ''), 'aria-pressed': String(p.id === S.profileId), title: p.description, onclick: () => selectProfile(p.id, true) }, p.name));
    }
  }

  function renderHero() {
    const el = clear($('#hero'));
    el.className = 'card hero';
    const pf = profile();
    const best = bestOverall(S.profileId);
    const near = bestOverall(S.profileId, 48);
    const place = S.place;
    const key = place.lat.toFixed(4) + ',' + place.lon.toFixed(4);
    const isSaved = S.saved.some((x) => x.input === key || x.input === place.zip);
    el.appendChild(h('div', { class: 'place' },
      h('div', { class: 'place-name' }, h('strong', null, place.name + (place.state ? ', ' + place.state : '')),
        h('span', { class: 'muted' }, ' · ' + (place.zip ? place.zip + ' · ' : '') + fmt().height(place.elevM))),
      h('button', { type: 'button', class: 'pill small', 'aria-pressed': String(isSaved), onclick: toggleSaved }, isSaved ? '★ Saved' : '☆ Save')));
    if (!best) {
      el.appendChild(h('p', { class: 'big-empty' }, 'No ' + pf.name.toLowerCase() + ' hours in the forecast for this place (sun never reaches the needed angle, or data is missing).'));
      return;
    }
    const point = isClarity() ? pointLine(best) : null;
    const range = isClarity() ? dewRangeLine(best) : null;
    el.appendChild(h('div', { class: 'hero-main' },
      h('div', { class: 'hero-score band-' + best.band }, h('span', { class: 'num' }, String(Math.round(best.score))), h('span', { class: 'lbl' }, BAND_LABEL[best.band])),
      h('div', { class: 'hero-text' },
        h('div', { class: 'eyebrow' }, 'Best ' + pf.name.toLowerCase() + ' window this week'),
        h('div', { class: 'when' }, dayLabel(best.startMs) + ' ' + F.dateLabel(best.startMs, tz()) + ', ' + winLabel(best)),
        h('div', { class: 'meta' }, verdictChip(best.score), dots(best.confidence), leadNote(best)))));
    el.appendChild(h('div', { class: 'why-lines' }, heroReasons(best)));
    if (point) el.appendChild(h('div', { class: 'hl dir' }, h('span', { class: 'sym', 'aria-hidden': 'true' }, '→'), h('span', null, point)));
    if (range) el.appendChild(h('p', { class: 'muted small tight' }, range));
    el.appendChild(h('div', { class: 'btnrow' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => openDay(best.day, { kind: 'window', day: best.day, rank: best.rank }) }, 'See that day'),
      h('button', { type: 'button', class: 'btn', onclick: () => addToCalendar(best) }, 'Add reminder')));
    if (near && near.startMs !== best.startMs) {
      el.appendChild(h('div', { class: 'near' },
        h('span', { class: 'muted' }, 'Next 48 hours: '),
        h('button', { type: 'button', class: 'linkish', onclick: () => openDay(near.day, { kind: 'window', day: near.day, rank: near.rank }) },
          dayLabel(near.startMs) + ' ' + winLabel(near)), ' ', bandChip(near.band, Math.round(near.score) + ' ' + BAND_LABEL[near.band])));
    }
    const pct = climateBadge(best);
    if (pct) el.appendChild(h('div', { class: 'badge-row' }, h('span', { class: 'chip neutral' }, pct)));
  }

  function leadNote(w) {
    const days = (w.startMs - S.nowMs) / (24 * HOUR);
    const t = days < 1 ? 'today or tomorrow' : 'about ' + Math.round(days) + ' day' + (Math.round(days) === 1 ? '' : 's') + ' out';
    return h('span', { class: 'muted' }, ' ' + t + (w.confidence === 'low' ? ': early guide' : ''));
  }

  function climateBadge(w) {
    const sc = (S.scores[S.profileId] || []).find((x) => x.ms === w.startMs);
    if (!sc || !S.derived) return null;
    const p = S.derived[sc.derivedIndex].dpPercentile;
    if (!isNum(p)) return null;
    const when = 'for this date';
    if (p <= 10) return 'Dew point among the driest 10% ' + when;
    if (p <= 30) return 'Drier than usual ' + when + ' (' + F.ordinal(p) + ' percentile)';
    if (p >= 90) return 'Dew point among the most humid 10% ' + when;
    if (p >= 70) return 'More humid than usual ' + when + ' (' + F.ordinal(p) + ' percentile)';
    return 'Dew point typical ' + when;
  }

  function toggleSaved() {
    const p = S.place;
    const key = p.lat.toFixed(4) + ',' + p.lon.toFixed(4);
    const input = p.zip && S.input === p.zip ? p.zip : key;
    const i = S.saved.findIndex((x) => x.input === input || x.input === key);
    if (i >= 0) S.saved.splice(i, 1);
    else S.saved.unshift({ input, label: p.name + (p.state ? ', ' + p.state : '') });
    S.saved = S.saved.slice(0, 8);
    store.set('saved', S.saved);
    renderChips(); renderHero();
  }

  // A good window becomes a calendar entry with a reminder an hour before. Built locally, downloaded on tap.
  function addToCalendar(w) {
    const pf = profile();
    const agg = windowAgg(w);
    const lines = [pf.name + ' score ' + Math.round(w.score) + ' (' + BAND_LABEL[w.band] + '), ' + w.confidence + ' confidence.'];
    if (agg) for (const r of agg.reasons.slice(0, 3)) lines.push((r.sign > 0 ? '+ ' : '- ') + reasonText(r));
    const point = isClarity() ? pointLine(w) : null;
    if (point) lines.push(point);
    lines.push('Forecasts move: re-check ClearSky the evening before.');
    const text = F.ics({ uid: 'cs-' + S.profileId + '-' + w.startMs, nowMs: Date.now(), startMs: w.startMs, endMs: w.endMs, title: 'ClearSky: ' + pf.name + ' window (' + Math.round(w.score) + ')', desc: lines.join('\n'), loc: S.place.name + (S.place.state ? ', ' + S.place.state : ''), alarmMin: 60 });
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
      const a = h('a', { href: url, download: 'clearsky-' + w.day + '.ics' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { S.notes = [{ kind: 'warn', text: "This browser couldn't create a calendar file." }]; renderBanner(); }
  }

  /* ---------- your shot: subject distance and view direction ---------- */

  function renderYourShot() {
    const el = clear($('#yourshot'));
    const d = C.DISTANCE[S.distance];
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Your shot'), h('span', { class: 'muted small' }, 'Clarity is judged for this')));
    el.appendChild(h('div', { class: 'ys-label' }, 'How far is the subject?'));
    el.appendChild(h('div', { class: 'seg3', role: 'group', 'aria-label': 'Subject distance' },
      C.DISTANCE_IDS.map((id) => h('button', { type: 'button', class: 'segbtn', 'aria-pressed': String(id === S.distance), onclick: () => setDistance(id) }, C.DISTANCE[id].name))));
    el.appendChild(h('p', { class: 'muted small tight' }, d.blurb + '. ' + (S.distance === 'far' ? 'Haze counts for more.' : S.distance === 'near' ? 'Haze counts for less.' : '')));
    el.appendChild(h('div', { class: 'ys-label' }, 'Which way are you looking?'));
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    el.appendChild(h('div', { class: 'dirs', role: 'group', 'aria-label': 'View direction' },
      h('button', { type: 'button', class: 'dirbtn any', 'aria-pressed': String(S.bearing == null), onclick: () => setBearing(null) }, 'Any'),
      dirs.map((n, i) => h('button', { type: 'button', class: 'dirbtn', 'aria-pressed': String(S.bearing === i * 45), onclick: () => setBearing(i * 45) }, n))));
    const st = S.bearing == null ? 'Pick a direction to include the haze and smoke along that line, out to about ' + d.miles + ' mi, and the sun-versus-view angle.'
      : S.pathState === 'loading' ? 'Checking the air toward ' + F.dirName(S.bearing) + '…'
        : S.pathState === 'ok' ? 'Included: air along the line toward ' + F.dirName(S.bearing) + ' (to ' + d.miles + ' mi), worst haze or smoke on the path counts.'
          : S.pathState === 'failed' ? "Couldn't load the line of sight; using your spot only." : '';
    el.appendChild(h('p', { class: 'muted small tight', 'aria-live': 'polite' }, st));
  }

  function setDistance(id) {
    S.distance = id; store.set('distance', id);
    if (S.bearing != null) { S.pathHours = null; recompute(); pickDay(false); render(); loadPath(); } else refine();
  }
  function setBearing(b) {
    S.bearing = b; store.set('bearing', b);
    S.pathHours = null; S.pathTok++;
    S.pathState = b == null ? 'idle' : 'loading';
    refine();
    if (b != null) loadPath();
  }

  /* ---------- the week ahead: air-mass outlook and day list ---------- */

  function outlookLines() {
    const o = S.outlook, f = fmt(), out = [];
    if (!o) return out;
    const today = C.localParts(S.nowMs, tz()).date;
    let lastDay = null, lastKind = null;
    for (const e of o.events) {
      // Back-to-back changes of the same kind are one story: report the first.
      if (lastKind === e.kind && lastDay && (C.zonedMidnight(e.day, tz()) - C.zonedMidnight(lastDay, tz())) <= 2 * 24 * HOUR) continue;
      lastDay = e.day; lastKind = e.kind;
      const when = e.day === today ? 'today' : dayTitle(e.day);
      const dry = C.cToF(e.toC) <= 45;
      out.push(e.kind === 'drying'
        ? { kind: 'good', text: (e.day === today ? 'Drier air moved in ' : 'Drier air arrives ') + when + ': dew point ' + f.temp(e.fromC) + ' to ' + f.temp(e.toC) + (dry ? '. The classic clear-air pattern after a front.' : '.') }
        : { kind: 'warn', text: 'Haze returns ' + when + ': dew point climbs from ' + f.temp(e.fromC) + ' to ' + f.temp(e.toC) + '.' });
      if (out.length >= 2) break;
    }
    if (!out.length && o.daily.length > 2) {
      const dry = o.daily.slice().sort((a, b) => a.dewC - b.dewC)[0];
      out.push({ kind: 'info', text: 'No big air-mass change this week. Driest air: ' + dayTitle(dry.day) + ' (dew point about ' + f.temp(dry.dewC) + ').' });
    }
    return out;
  }

  function renderGlance() {
    const el = clear($('#glance'));
    el.className = 'card glance';
    const days = S.dayKeys;
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'The week ahead'), h('span', { class: 'muted small' }, 'Bars: best ' + profile().name.toLowerCase() + ' window. Tap a day.')));
    const lines = outlookLines();
    if (lines.length) el.appendChild(h('div', { class: 'outlook' }, lines.map((l) => h('div', { class: 'ol ' + l.kind }, l.text))));
    if (!days.length) return;
    const W = 340, Ht = 190, padL = 8, padR = 8, padT = 58, padB = 40;
    const cw = (W - padL - padR) / days.length, ch = Ht - padT - padB;
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + Ht, class: 'glance-svg', role: 'group', 'aria-label': 'Best window score and dew point by day' });
    const dailyBy = new Map((S.outlook ? S.outlook.daily : []).map((d) => [d.day, d]));
    const dews = days.map((d) => (dailyBy.get(d) ? dailyBy.get(d).dewC : null));
    const dv = dews.filter((v) => v != null);
    const dmin = dv.length ? Math.min(...dv) : 0, dmax = dv.length ? Math.max(...dv) : 1, span = Math.max(dmax - dmin, 3);
    const best = bestOverall(S.profileId);
    for (const v of [0, 50, 100]) svg.appendChild(s('line', { x1: padL, x2: W - padR, y1: padT + ch - (v / 100) * ch, y2: padT + ch - (v / 100) * ch, class: 'grid' }));
    days.forEach((day, i) => {
      const w = dayWindows(S.profileId, day)[0];
      const x = padL + i * cw;
      const g = s('g', { class: 'gcol', tabindex: '0', role: 'button', 'aria-label': dayTitle(day) + (w ? ', best ' + Math.round(w.score) + ' ' + BAND_LABEL[w.band] + ', ' + winLabel(w) : ', no scored hours') });
      if (w) {
        const bh = Math.max(3, (w.score / 100) * ch);
        g.appendChild(s('rect', { x: x + 5, y: padT + ch - bh, width: cw - 10, height: bh, rx: 4, class: 'bar band-' + w.band, style: { opacity: w.confidence === 'low' ? 0.55 : w.confidence === 'medium' ? 0.85 : 1 } }));
        g.appendChild(s('text', { x: x + cw / 2, y: padT + ch - bh - 4, class: 'barlbl', 'text-anchor': 'middle' }, String(Math.round(w.score))));
        if (best && best.day === day) g.appendChild(s('rect', { x: x + 3, y: padT - 2, width: cw - 6, height: ch + 4, rx: 6, class: 'bestbox' }));
      } else g.appendChild(s('rect', { x: x + 5, y: padT + ch - 3, width: cw - 10, height: 3, rx: 1.5, class: 'bar stub' }));
      const first = dayNoon(day);
      g.appendChild(s('text', { x: x + cw / 2, y: padT + ch + 14, class: 'axis', 'text-anchor': 'middle' }, day === C.localParts(S.nowMs, tz()).date ? 'Today' : dayLabel(first)));
      g.appendChild(s('text', { x: x + cw / 2, y: padT + ch + 28, class: 'axis dim', 'text-anchor': 'middle' }, dews[i] != null ? fmt().temp(dews[i]) : ''));
      g.appendChild(s('rect', { x, y: padT - 4, width: cw, height: ch + 44, class: 'hit' }));
      g.addEventListener('click', () => openDay(day));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(day); } });
      svg.appendChild(g);
    });
    const pts = days.map((d, i) => (dews[i] == null ? null : [padL + i * cw + cw / 2, 22 + (1 - (dews[i] - dmin) / span) * 26])).filter(Boolean);
    if (pts.length > 1) svg.appendChild(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'dewline', fill: 'none' }));
    for (const p of pts) svg.appendChild(s('circle', { cx: p[0], cy: p[1], r: 3, class: 'dewdot' }));
    svg.appendChild(s('text', { x: padL, y: 8, class: 'axis dim', 'text-anchor': 'start' }, 'Dew point'));
    el.appendChild(svg);
  }

  function renderWeekList() {
    const el = clear($('#weeklist'));
    el.className = 'weeklist';
    const best = bestOverall(S.profileId);
    for (const day of S.dayKeys) {
      const w = dayWindows(S.profileId, day)[0];
      const isToday = day === C.localParts(S.nowMs, tz()).date;
      const isBest = best && best.day === day;
      const label = (isToday ? 'Today' : dayLabel(dayNoon(day)));
      el.appendChild(h('button', { type: 'button', class: 'dayrow' + (isBest ? ' best' : '') + (w && w.confidence === 'low' ? ' lowconf' : ''), 'aria-label': label + ' ' + day + (w ? ', ' + Math.round(w.score) + ' ' + BAND_LABEL[w.band] + ', ' + winLabel(w) : ', no scored hours'), onclick: () => openDay(day) },
        h('span', { class: 'dr-day' }, h('b', null, label), h('small', null, F.dateLabel(dayNoon(day), tz()))),
        h('span', { class: 'dr-mid' },
          w ? h('span', { class: 'dr-win' }, winLabel(w), isBest ? h('span', { class: 'tag-best' }, 'Best') : null) : h('span', { class: 'muted' }, 'No scored hours'),
          w ? h('span', { class: 'dr-why' }, headline(w)) : null),
        w ? h('span', { class: 'dr-score' }, h('span', { class: 'score band-' + w.band }, h('b', null, String(Math.round(w.score)))), dots(w.confidence)) : h('span', { class: 'dr-score' }, h('span', { class: 'score band-none' }, h('b', null, '–')))));
    }
  }

  /* ---------- DAY tab ---------- */

  function dayNav(app) {
    const i = S.dayKeys.indexOf(S.day);
    const go = (d) => { S.day = S.dayKeys[i + d]; const w = dayWindows(S.profileId, S.day)[0]; S.sel = w ? { kind: 'window', day: S.day, rank: w.rank } : null; render(); };
    return h('div', { class: 'daynav' },
      h('button', { type: 'button', class: 'navbtn', 'aria-label': 'Previous day', disabled: i <= 0, onclick: () => go(-1) }, '‹'),
      h('div', { class: 'daynav-title' }, h('strong', null, S.day === C.localParts(S.nowMs, tz()).date ? 'Today' : dayLabel(dayNoon(S.day))), ' ', F.dateLabel(dayNoon(S.day), tz()), h('span', { class: 'muted' }, ' · ' + profile().name)),
      h('button', { type: 'button', class: 'navbtn', 'aria-label': 'Next day', disabled: i < 0 || i >= S.dayKeys.length - 1, onclick: () => go(1) }, '›'));
  }

  function renderDayTab(app) {
    app.appendChild(h('nav', { id: 'profiles', 'aria-label': 'Shoot type' }));
    renderProfiles();
    if (!S.day) { app.appendChild(h('p', { class: 'muted pad' }, 'No day selected.')); return; }
    app.appendChild(dayNav());
    const hrs = hoursOfDay(S.profileId, S.day);
    const first = hrs[0] ? hrs[0].ms : S.nowMs;
    const panel = h('div', { class: 'day-panel' });
    panel.appendChild(h('div', { class: 'card chart-card' },
      h('div', { class: 'card-head' }, h('h2', null, dayLabel(first) + ' ' + F.dateLabel(first, tz())), h('span', { class: 'muted small' }, 'Tap a bar for the reasons')),
      h('div', { id: 'chartbox', class: 'chartbox' }),
      h('p', { class: 'legend' }, 'Bars: hourly score by band. Orange line: dew point. Faded bars: past hours or a less certain forecast.')));
    panel.appendChild(h('div', { class: 'side' }, h('div', { id: 'why', class: 'card' }), h('div', { id: 'notes', class: 'card' }), h('div', { id: 'sun', class: 'card' })));
    app.appendChild(panel);
    drawChart(); renderWhy(); renderSun();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.hours && $('#chartbox')) drawChart(); }, 150); });

  function drawChart() {
    const box = clear($('#chartbox'));
    const all = hoursOfDay(S.profileId, S.day);
    const idx = all.map((x, i) => (x.scored ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) { box.appendChild(h('p', { class: 'muted pad' }, 'No ' + profile().name.toLowerCase() + ' hours on this day (the sun is too low or too high for this shoot type, or inputs are missing).')); S.chart = null; return; }
    const lo = Math.max(0, idx[0] - 1), hi = Math.min(all.length - 1, idx[idx.length - 1] + 1);
    const hs = all.slice(lo, hi + 1);
    const f = fmt();
    const W = Math.max(300, Math.floor(box.clientWidth || 340)), Ht = W < 520 ? 270 : 300;
    const padL = 30, padR = 10, padT = 24, padB = 70;
    const cw = W - padL - padR, ch = Ht - padT - padB;
    const n = hs.length, bw = cw / n;
    const x0 = hs[0].ms;
    const xOf = (ms) => padL + ((ms - x0) / HOUR) * bw;
    const yOf = (v) => padT + ch - (v / 100) * ch;
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + Ht, width: W, height: Ht, role: 'group', 'aria-label': profile().name + ' score by hour for ' + S.day, class: 'chart' });

    const st = C.sunTimes(S.place.lat, S.place.lon, S.day, tz());
    const endX = padL + cw;
    const nightRect = (a, b) => { const xa = Math.max(padL, a), xb = Math.min(endX, b); if (xb > xa) svg.appendChild(s('rect', { x: xa, y: padT, width: xb - xa, height: ch, class: 'night' })); };
    if (st.sunrise != null && st.sunset != null) { nightRect(padL, xOf(st.sunrise)); nightRect(xOf(st.sunset), endX); }
    else if (st.maxElev < -0.833) nightRect(padL, endX);

    for (const v of [0, 20, 40, 60, 80, 100]) {
      svg.appendChild(s('line', { x1: padL, x2: endX, y1: yOf(v), y2: yOf(v), class: 'grid' }));
      svg.appendChild(s('text', { x: padL - 5, y: yOf(v) + 4, class: 'axis', 'text-anchor': 'end' }, String(v)));
    }

    const barEls = new Map();
    hs.forEach((hr, i) => {
      const x = padL + i * bw;
      const past = hr.ms < S.nowMs;
      const g = s('g', { class: 'hour', tabindex: '0', role: 'button', 'data-ms': hr.ms,
        'aria-label': F.weekday(hr.ms, tz()) + ' ' + F.hourLabel(hr.ms, tz()) + ': ' + (hr.scored ? Math.round(hr.score) + ' ' + BAND_LABEL[hr.band] + ', ' + hr.confidence + ' confidence' : 'not scored for this shoot type') });
      if (hr.scored) {
        const hgt = Math.max(2, (hr.score / 100) * ch);
        const op = past ? 0.35 : hr.confidence === 'low' ? 0.5 : hr.confidence === 'medium' ? 0.8 : 1;
        g.appendChild(s('rect', { x: x + 1.5, y: padT + ch - hgt, width: Math.max(2, bw - 3), height: hgt, rx: 2, class: 'bar band-' + hr.band, style: { opacity: op } }));
        if (bw >= 22) g.appendChild(s('text', { x: x + bw / 2, y: padT + ch - hgt - 4, class: 'barlbl', 'text-anchor': 'middle' }, String(Math.round(hr.score))));
        if (hr.flags.includes('fog')) g.appendChild(s('path', { d: 'M' + (x + bw / 2 - 4) + ' ' + (padT + ch - 3) + ' l4 -7 l4 7 z', class: 'fogmark' }));
      } else g.appendChild(s('rect', { x: x + 1.5, y: padT + ch - 3, width: Math.max(2, bw - 3), height: 3, rx: 1.5, class: 'bar stub' }));
      g.appendChild(s('rect', { x, y: padT, width: bw, height: ch + 4, class: 'hit' }));
      g.addEventListener('click', () => select({ kind: 'hour', ms: hr.ms }));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: 'hour', ms: hr.ms }); } });
      g.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') select({ kind: 'hour', ms: hr.ms }); });
      svg.appendChild(g);
      barEls.set(hr.ms, g);
    });

    const recs = hs.map((hr) => S.hourByMs.get(hr.ms));
    const dews = recs.map((r) => (r && isNum(r.dewC) ? r.dewC : null));
    const dv = dews.filter((v) => v != null);
    if (dv.length > 1) {
      const dmin = Math.min(...dv), dmax = Math.max(...dv), span = Math.max(dmax - dmin, 2);
      const yd = (v) => padT + 8 + (1 - (v - dmin) / span) * (ch - 16);
      const pts = dews.map((v, i) => (v == null ? null : [padL + i * bw + bw / 2, yd(v)])).filter(Boolean);
      svg.appendChild(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'dewline', fill: 'none' }));
      const lp = pts[pts.length - 1], lv = dews[dews.length - 1] != null ? dews[dews.length - 1] : dv[dv.length - 1];
      svg.appendChild(s('text', { x: Math.min(lp[0], endX - 2), y: Math.max(padT + 10, lp[1] - 8), class: 'dewlbl', 'text-anchor': 'end' }, 'Dew ' + f.temp(lv)));
    }

    const sunLine = (ms, label) => {
      if (ms == null) return;
      const x = xOf(ms);
      if (x < padL || x > endX) return;
      svg.appendChild(s('line', { x1: x, x2: x, y1: padT - 6, y2: padT + ch, class: 'sunline' }));
      svg.appendChild(s('text', { x: Math.min(Math.max(x, padL + 18), endX - 18), y: padT - 9, class: 'sunlbl', 'text-anchor': 'middle' }, label + ' ' + F.clockLabel(ms, tz()).replace(' ', '')));
    };
    sunLine(st.sunrise, 'Rise'); sunLine(st.sunset, 'Set');

    const every = Math.max(1, Math.ceil(30 / bw));
    hs.forEach((hr, i) => {
      if (i % every) return;
      const p = F.parts(hr.ms, tz());
      svg.appendChild(s('text', { x: padL + i * bw + bw / 2, y: padT + ch + 14, class: 'axis', 'text-anchor': 'middle' }, h12s(p.hour)));
    });

    const wins = dayWindows(S.profileId, S.day);
    const winEls = new Map();
    wins.forEach((w) => {
      if (w.endMs <= x0 || w.startMs >= x0 + n * HOUR) return;
      const xa = xOf(w.startMs), xb = xOf(w.endMs);
      const g = s('g', { class: 'win', tabindex: '0', role: 'button', 'aria-label': 'Window ' + w.rank + ': ' + winLabel(w) + ', score ' + Math.round(w.score) + ' ' + BAND_LABEL[w.band] });
      g.appendChild(s('rect', { x: xa + 1, y: padT + ch + 22, width: Math.max(8, xb - xa - 2), height: 20, rx: 5, class: 'winrect band-' + w.band }));
      g.appendChild(s('text', { x: (xa + xb) / 2, y: padT + ch + 36, class: 'winlbl band-' + w.band, 'text-anchor': 'middle' }, '#' + w.rank + ' ' + Math.round(w.score)));
      const pick = () => select({ kind: 'window', day: S.day, rank: w.rank });
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      svg.appendChild(g);
      winEls.set(w.rank, g);
    });
    svg.appendChild(s('text', { x: padL, y: Ht - 8, class: 'axis', 'text-anchor': 'start' }, 'Best windows (3 hours, ranked)'));

    box.appendChild(svg);
    const selRect = s('rect', { class: 'selbox', rx: 4, height: ch + 6, y: padT - 1, width: 0 });
    svg.insertBefore(selRect, svg.firstChild.nextSibling || null);
    S.chart = {
      setSel(sel) {
        for (const g of barEls.values()) g.classList.remove('sel');
        for (const g of winEls.values()) g.classList.remove('sel');
        selRect.setAttribute('width', 0);
        if (!sel) return;
        let a, b;
        if (sel.kind === 'hour') { const g = barEls.get(sel.ms); if (g) g.classList.add('sel'); a = xOf(sel.ms); b = a + bw; }
        else { const w = wins.find((x) => x.rank === sel.rank); if (w) { a = xOf(w.startMs); b = xOf(w.endMs); const g = winEls.get(w.rank); if (g) g.classList.add('sel'); } }
        if (a != null) { selRect.setAttribute('x', Math.max(padL, a)); selRect.setAttribute('width', Math.max(0, Math.min(endX, b) - Math.max(padL, a))); }
      },
    };
    S.chart.setSel(S.sel);
  }
  const h12s = (hr) => (hr === 0 ? '12a' : hr < 12 ? hr + 'a' : hr === 12 ? '12p' : hr - 12 + 'p');

  /* ---------- why panel and field notes ---------- */

  function selectedScores() {
    const sel = S.sel;
    const list = S.scores[S.profileId] || [];
    if (!sel) return null;
    if (sel.kind === 'hour') {
      const sc = list.find((x) => x.ms === sel.ms);
      return sc ? { title: dayLabel(sc.ms) + ' ' + F.hourLabel(sc.ms, tz()), hours: [sc], isWindow: false, ms: sc.ms } : null;
    }
    const w = dayWindows(S.profileId, sel.day).find((x) => x.rank === sel.rank);
    if (!w) return null;
    return { title: (w.rank === 1 ? 'Best window' : 'Window #' + w.rank) + ' · ' + dayLabel(w.startMs) + ' ' + winLabel(w), hours: list.filter((x) => x.ms >= w.startMs && x.ms < w.endMs), isWindow: true, ms: w.startMs, midMs: midOf(w) };
  }

  function renderWhy() {
    const el = $('#why');
    if (!el) return;
    clear(el);
    const sel = selectedScores();
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Why')));
    renderNotes(null);
    if (!sel) { el.appendChild(h('p', { class: 'muted' }, 'Pick an hour or a window to see what drives its score.')); return; }
    const one = sel.hours[0];
    if (!one || !one.scored) { el.appendChild(h('p', null, sel.title), h('p', { class: 'muted' }, 'This hour is not scored for ' + profile().name.toLowerCase() + '. ' + (profile().id === 'fog' ? 'Fog is scored from 3 am to 9 am local time.' : 'The sun is too far below the horizon.'))); return; }
    const agg = sel.isWindow ? C.aggregate(sel.hours) : C.aggregate([one]);
    const score = agg.score, band = C.bandOf(score);
    el.appendChild(h('div', { class: 'why-top' },
      h('div', { class: 'why-score band-' + band }, h('span', { class: 'num' }, String(Math.round(score))), h('span', { class: 'lbl' }, BAND_LABEL[band])),
      h('div', null, h('div', { class: 'why-title' }, sel.title), h('div', { class: 'meta' }, verdictChip(score), dots(agg.confidence), sel.isWindow ? h('span', { class: 'muted' }, ' ' + sel.hours.length + '-hour average') : null))));
    if (agg.capped) el.appendChild(h('p', { class: 'flag warn' }, 'Capped at Fair: a limiting factor (haze, smoke or humid air) is poor even though others look good.'));
    const good = agg.reasons.filter((r) => r.sign > 0), bad = agg.reasons.filter((r) => r.sign < 0);
    const list = (title, items, cls, sym) => items.length ? h('div', { class: 'reasons ' + cls }, h('h3', null, title), h('ul', null, items.map((r) => h('li', null, h('span', { class: 'sym', 'aria-hidden': 'true' }, sym), h('span', null, reasonText(r)))))) : null;
    for (const blk of [list('Helping', good, 'good', '+'), list('Hurting', bad, 'bad', '−')]) if (blk) el.appendChild(blk);
    if (!good.length && !bad.length) el.appendChild(h('p', { class: 'muted' }, 'All factors sit near neutral for this hour.'));
    const flagText = { fog: 'Fog likely (spread within 3°F, humidity 95% or more)', smoke: 'Smoke or heavy haze in the air', dust: 'Dust in the air', rain: 'Rain in this hour', shimmer: 'Heat shimmer likely for telephoto work', lowvis: 'Visibility under 3 miles' };
    if (agg.flags.length) el.appendChild(h('div', { class: 'flags' }, agg.flags.map((k) => h('span', { class: 'chip flag-' + k }, flagText[k] || k))));
    const miss = (one.missing || []).filter((id) => !(id === 'ventilation' || id === 'heatShimmer' || id === 'airmass' || id === 'rainScrub' || id === 'viewLight'));
    if (miss.length) el.appendChild(h('p', { class: 'flag warn' }, 'Scored without ' + miss.map((id) => F.MISSING_TEXT[id] || id).join(', ') + ' (not available for this hour).'));
    el.appendChild(h('p', { class: 'muted small' }, 'Confidence: ' + one.confidenceNote + '.'));
    const det = h('details', { class: 'factors' }, h('summary', null, 'All factors in this score'));
    const tbl = h('div', { class: 'ftable' });
    for (const fc of agg.factors.slice().sort((a, b) => b.weight - a.weight)) {
      const parts = F.describeParts(fc.id, 0, fc.raw, fmt());
      tbl.appendChild(h('div', { class: 'frow' },
        h('div', { class: 'fname' }, C.FACTOR_LABELS[fc.id], h('small', null, Math.round(fc.weight) + '% weight')),
        h('div', { class: 'fbar', role: 'img', 'aria-label': Math.round(fc.score * 100) + ' out of 100' }, h('i', { style: { width: Math.round(fc.score * 100) + '%' }, class: 'fill' })),
        h('div', { class: 'fval' }, parts.value)));
    }
    det.appendChild(tbl);
    el.appendChild(det);
    renderNotes({ sel, agg, one });
  }

  // Practical advice for the selected hour or window (clarity: direction, haze, shimmer, wind).
  function renderNotes(ctx) {
    const el = $('#notes');
    if (!el) return;
    clear(el);
    if (!ctx || !isClarity()) { el.hidden = true; return; }
    const { sel, agg } = ctx;
    const fac = {};
    for (const fc of agg.factors) fac[fc.id] = { score: fc.score, raw: fc.raw };
    const ms = sel.isWindow ? sel.midMs : sel.ms;
    const notes = F.fieldNotes({ fac, flags: agg.flags, sector: sectorOf(ms), bearing: S.bearing }, fmt());
    if (!notes.length) { el.hidden = true; return; }
    el.hidden = false;
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Field notes')));
    el.appendChild(h('ul', { class: 'notes' }, notes.map((n) => h('li', { class: 'note ' + n.kind },
      h('span', { class: 'sym', 'aria-hidden': 'true' }, n.kind === 'warn' ? '!' : n.kind === 'good' ? '✓' : 'i'), h('span', null, n.text)))));
  }

  /* ---------- sun, moon, aurora card ---------- */

  function renderSun() {
    const el = $('#sun');
    if (!el) return;
    clear(el);
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Sun and sky')));
    const st = C.sunTimes(S.place.lat, S.place.lon, S.day, tz());
    const t = (ms) => F.clockLabel(ms, tz());
    if (st.sunrise == null || st.sunset == null) {
      el.appendChild(h('p', { class: 'muted' }, st.maxElev > 0 ? 'The sun stays up all day at this latitude, so there is no sunrise or sunset.' : 'The sun stays below the horizon all day (polar night).'));
    } else {
      const gw = dayWindows('golden', S.day);
      const am = gw.find((w) => w.startMs < st.sunrise + 4 * HOUR && w.startMs < zonedNoon()), pm = gw.find((w) => w.startMs >= zonedNoon());
      const row = (label, ms, w) => {
        const rec = S.hourByMs.get(Math.floor(ms / HOUR) * HOUR);
        return h('div', { class: 'sunrow' },
          h('div', null, h('strong', null, label + ' ' + t(ms)), rec && isNum(rec.cloudLow) ? h('div', { class: 'muted small' }, 'Cloud then: low ' + fmt().pct(rec.cloudLow) + ', mid ' + fmt().pct(rec.cloudMid) + ', high ' + fmt().pct(rec.cloudHigh)) : null),
          w ? h('button', { type: 'button', class: 'pill small', onclick: () => { S.profileId = 'golden'; store.set('profile', 'golden'); S.sel = { kind: 'window', day: S.day, rank: w.rank }; render(); } }, bandChip(w.band, Math.round(w.score) + ' ' + BAND_LABEL[w.band]), ' golden light') : null);
      };
      el.appendChild(row('Sunrise', st.sunrise, am));
      el.appendChild(row('Sunset', st.sunset, pm));
      el.appendChild(h('p', { class: 'muted small' }, 'Golden hour: ' + (st.goldenAM[0] != null && st.goldenAM[1] != null ? t(st.goldenAM[0]) + ' to ' + t(st.goldenAM[1]) : '–') + ' and ' + (st.goldenPM[0] != null && st.goldenPM[1] != null ? t(st.goldenPM[0]) + ' to ' + t(st.goldenPM[1]) : '–') + ' (sun between −4° and 6°).'));
    }
    const fw = dayWindows('fog', S.day)[0];
    if (fw && fw.score >= 40) {
      el.appendChild(h('div', { class: 'sunrow' },
        h('div', null, h('strong', null, 'Fog possible'), h('div', { class: 'muted small' }, 'Area-level estimate for 3 to 9 am. Fog also hides distant views until it lifts.')),
        h('button', { type: 'button', class: 'pill small', onclick: () => { S.profileId = 'fog'; store.set('profile', 'fog'); S.sel = { kind: 'window', day: S.day, rank: fw.rank }; render(); } }, bandChip(fw.band, Math.round(fw.score) + ' ' + BAND_LABEL[fw.band]), ' ' + winLabel(fw))));
    }
    const mo = C.moonInfo(dayNoon(S.day));
    el.appendChild(h('p', { class: 'muted small' }, 'Moon: ' + mo.name + ', ' + Math.round(mo.illum * 100) + '% lit.'));
    const au = auroraNote();
    if (au) el.appendChild(h('p', { class: 'aurora small' }, au));
  }
  function zonedNoon() { return dayNoon(S.day); }

  // Only shown when the NOAA Kp forecast reaches your latitude that day: a hint, not a forecast of what you will see.
  function auroraNote() {
    if (!S.kp || !S.kp.length || !S.place) return null;
    const lo = C.zonedMidnight(S.day, tz()), hi = lo + 24 * HOUR;
    const ks = S.kp.filter((k) => k.ms >= lo - 3 * HOUR && k.ms < hi).map((k) => k.kp);
    if (!ks.length) return null;
    const kp = Math.max(...ks);
    const a = C.auroraHint(S.place.lat, S.place.lon, kp);
    if (!a || !a.level) return null;
    return 'Aurora watch: NOAA forecasts Kp ' + kp.toFixed(1) + ' that night, so aurora is ' + a.level + ' on the northern horizon at your latitude if skies are clear and dark.';
  }

  /* ---------- LAYERS tab ---------- */

  // One column per hour, one row per layer of the atmosphere. Cells are tinted by how good that layer is for
  // a clear distant view, so the layer that is spoiling an hour stands out.
  function renderLayersTab(app) {
    app.appendChild(h('nav', { id: 'profiles', 'aria-label': 'Shoot type' }));
    renderProfiles();
    if (!S.day) return;
    app.appendChild(dayNav());
    const all = hoursOfDay(S.profileId, S.day);
    const idx = all.map((x, i) => (x.scored ? i : -1)).filter((i) => i >= 0);
    let hs;
    if (idx.length) hs = all.slice(Math.max(0, idx[0] - 1), Math.min(all.length, idx[idx.length - 1] + 2));
    else hs = all.filter((x) => { const hr = C.localParts(x.ms, tz()).hour; return hr >= 6 && hr <= 20; });
    const f = fmt();
    const cv = C.CURVES;
    const scoreCls = (v) => (isNum(v) ? 'band-' + C.bandOf(v * 100) : 'band-none');
    const rec = (ms) => S.hourByMs.get(ms);
    const pathBy = S.pathHours ? new Map(S.pathHours.map((r) => [r.ms, r])) : null;
    const num = (v, d) => (isNum(v) ? v.toFixed(d || 0) : '–');
    const cloud = (v) => ({ t: isNum(v) ? String(Math.round(v)) : '–', style: isNum(v) ? { background: 'rgba(54,84,128,' + (0.06 + 0.8 * v / 100).toFixed(2) + ')', color: v > 55 ? '#fff' : '#1c2a3a' } : null, cls: 'cloud' });
    const rows = [
      { label: profile().name, sub: 'score', cell: (x) => ({ t: x.scored ? String(Math.round(x.score)) : '–', cls: x.scored ? 'band-' + x.band : 'band-none', strong: true }) },
      { label: 'Sun', sub: 'degrees', cell: (x) => { const e = S.derived && S.derived[x.derivedIndex] ? S.derived[x.derivedIndex].sunElevDeg : null; return { t: isNum(e) ? String(Math.round(e)) : '–', cls: isNum(e) && e < 0 ? 'night' : 'sunc' }; } },
      { label: 'High cloud', sub: '%', cell: (x) => cloud((rec(x.ms) || {}).cloudHigh) },
      { label: 'Mid cloud', sub: '%', cell: (x) => cloud((rec(x.ms) || {}).cloudMid) },
      { label: 'Low cloud', sub: '%', cell: (x) => cloud((rec(x.ms) || {}).cloudLow) },
      { label: 'Dew point', sub: '°F', cell: (x) => { const r = rec(x.ms) || {}; return { t: isNum(r.dewC) ? String(Math.round(C.cToF(r.dewC))) : '–', cls: scoreCls(isNum(r.dewC) ? C.curve(cv.dewAbsF, C.cToF(r.dewC)) : null) }; } },
      { label: 'Humidity', sub: '%', cell: (x) => { const r = rec(x.ms) || {}; return { t: num(r.rh), cls: scoreCls(C.curve(cv.humidity, r.rh)) }; } },
      { label: 'Visibility', sub: 'mi', cell: (x) => { const r = rec(x.ms) || {}; return { t: isNum(r.visM) ? (C.mToMi(r.visM) >= 10 ? String(Math.round(C.mToMi(r.visM))) : C.mToMi(r.visM).toFixed(1)) : '–', cls: scoreCls(isNum(r.visM) ? C.curve(cv.visMi, C.mToMi(r.visM)) : null) }; } },
      { label: 'Smoke', sub: 'PM2.5', cell: (x) => { const r = rec(x.ms) || {}; return { t: num(r.pm25), cls: scoreCls(C.curve(cv.pm25, r.pm25)) }; } },
      { label: 'Haze', sub: 'aerosol', cell: (x) => { const r = rec(x.ms) || {}; return { t: isNum(r.aod) ? r.aod.toFixed(2).replace(/^0/, '') : '–', cls: scoreCls(C.curve(cv.aod, r.aod)) }; } },
      { label: 'Mixing', sub: 'ft', cell: (x) => { const r = rec(x.ms) || {}; const day = S.derived && S.derived[x.derivedIndex] && S.derived[x.derivedIndex].sunElevDeg > 10; return { t: isNum(r.pblM) ? String(Math.round((r.pblM * 3.28084) / 100) * 100) : '–', cls: day ? scoreCls(C.curve(cv.pblM, r.pblM)) : 'band-none' }; } },
      { label: 'Wind', sub: 'mph', cell: (x) => { const r = rec(x.ms) || {}; return { t: isNum(r.windMs) ? Math.round(C.msToMph(r.windMs)) + (isNum(r.windDirDeg) ? ' ' + C.compass(r.windDirDeg) : '') : '–', cls: scoreCls(C.curve(cv.windSpeedMph, C.msToMph(r.windMs))), small: true }; } },
      { label: 'Rain', sub: 'in', cell: (x) => { const r = rec(x.ms) || {}; return { t: r.precipMm > 0.05 ? (r.precipMm / 25.4).toFixed(2).replace(/^0/, '') : '–', cls: scoreCls(isNum(r.precipMm) ? C.curve(cv.precipMm, r.precipMm) : null) }; } },
      { label: 'Temp', sub: '°F', cell: (x) => ({ t: isNum((rec(x.ms) || {}).tempC) ? String(Math.round(C.cToF(rec(x.ms).tempC))) : '–', cls: 'plain' }) },
    ];
    if (pathBy && isClarity()) {
      rows.push({ label: 'Path dew', sub: '°F', group: 'Along your line of sight', cell: (x) => { const r = pathBy.get(x.ms) || {}; return { t: isNum(r.dewC) ? String(Math.round(C.cToF(r.dewC))) : '–', cls: scoreCls(isNum(r.dewC) ? C.curve(cv.dewAbsF, C.cToF(r.dewC)) : null) }; } });
      rows.push({ label: 'Path vis', sub: 'mi', cell: (x) => { const r = pathBy.get(x.ms) || {}; return { t: isNum(r.visM) ? (C.mToMi(r.visM) >= 10 ? String(Math.round(C.mToMi(r.visM))) : C.mToMi(r.visM).toFixed(1)) : '–', cls: scoreCls(isNum(r.visM) ? C.curve(cv.visMi, C.mToMi(r.visM)) : null) }; } });
      rows.push({ label: 'Path smoke', sub: 'PM2.5', cell: (x) => { const r = pathBy.get(x.ms) || {}; return { t: num(r.pm25), cls: scoreCls(C.curve(cv.pm25, r.pm25)) }; } });
    }
    const n = hs.length;
    const grid = h('div', { class: 'lgrid', style: { gridTemplateColumns: '84px repeat(' + n + ', 46px)' }, role: 'table', 'aria-label': 'Hourly layers for ' + S.day });
    grid.appendChild(h('div', { class: 'lh lab', role: 'columnheader' }, ''));
    hs.forEach((x) => grid.appendChild(h('div', { class: 'lh' + (x.ms < S.nowMs ? ' past' : ''), role: 'columnheader' }, h12s(F.parts(x.ms, tz()).hour))));
    for (const row of rows) {
      if (row.group) grid.appendChild(h('div', { class: 'lgroup', style: { gridColumn: '1 / -1' } }, row.group));
      grid.appendChild(h('div', { class: 'lab', role: 'rowheader' }, row.label, h('small', null, row.sub)));
      hs.forEach((x) => {
        const c = row.cell(x);
        grid.appendChild(h('div', { class: 'lc ' + (c.cls || '') + (c.strong ? ' strong' : '') + (c.small ? ' sm' : '') + (x.ms < S.nowMs ? ' past' : ''), style: c.style || null, role: 'cell' }, c.t));
      });
    }
    app.appendChild(h('div', { class: 'card layers' },
      h('div', { class: 'card-head' }, h('h2', null, 'Layers by hour'), h('span', { class: 'muted small' }, 'Swipe sideways')),
      h('div', { class: 'lscroll', tabindex: '0', role: 'region', 'aria-label': 'Layers table, scrolls sideways' }, grid),
      h('p', { class: 'legend' }, 'Darker blue is better for a clear view: dry air, clean air, long visibility, a deep mixed layer. Cloud rows are shaded by how much sky they cover. Gray is night or not applicable.'),
      pathBy ? h('p', { class: 'legend' }, 'The “along your line of sight” rows are the average dew point and the worst visibility and smoke between you and the subject.') : null));
  }

  /* ---------- MORE tab ---------- */

  function renderMoreTab(app) {
    app.appendChild(h('section', { id: 'compare' }));
    app.appendChild(h('details', { id: 'raw', class: 'card' }));
    app.appendChild(h('details', { id: 'logsec', class: 'card' }));
    renderCompare(); renderRaw(); renderLog();
  }

  function renderCompare() {
    const el = clear($('#compare'));
    el.className = 'compare';
    el.appendChild(h('div', { class: 'compare-head' }, h('strong', null, 'Best this week by shoot type')));
    const list = h('div', { class: 'compare-list' });
    for (const p of C.PROFILES) {
      const w = bestOverall(p.id);
      list.appendChild(h('button', { type: 'button', class: 'cmp' + (p.id === S.profileId ? ' current' : ''), onclick: () => { S.profileId = p.id; store.set('profile', p.id); if (w) { S.day = w.day; S.sel = { kind: 'window', day: w.day, rank: w.rank }; } S.tab = 'plan'; render(); window.scrollTo(0, 0); } },
        h('span', { class: 'cmp-name' }, p.name),
        w ? h('span', { class: 'cmp-when' }, dayLabel(w.startMs) + ' ' + winLabel(w)) : h('span', { class: 'cmp-when muted' }, 'none'),
        w ? bandChip(w.band, String(Math.round(w.score))) : null));
    }
    el.appendChild(list);
  }

  function renderRaw() {
    const el = clear($('#raw'));
    el.appendChild(h('summary', null, 'Raw hourly data for ' + (S.day || '') + ' (cross-check against any weather app)'));
    if (!S.day) return;
    const f = fmt();
    const secondBy = new Map((S.second || []).map((r) => [r.ms, r]));
    const rows = S.hours.filter((r) => C.localParts(r.ms, tz()).date === S.day);
    const sc = new Map((S.scores[S.profileId] || []).map((x) => [x.ms, x]));
    const cols = ['Time', 'Temp', 'Dew', 'NWS dew', 'RH', 'Wind', 'Cloud L/M/H', 'Vis', 'PM2.5', 'AOD', 'Rain', profile().name];
    const table = h('table', { class: 'raw' },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, rows.map((r) => {
        const x = sc.get(r.ms), n = secondBy.get(r.ms);
        return h('tr', { class: r.ms < S.nowMs ? 'past' : '' },
          h('th', { scope: 'row' }, F.hourLabel(r.ms, tz())), h('td', null, f.temp(r.tempC)), h('td', null, f.temp(r.dewC)), h('td', null, n && isNum(n.dewC) ? f.temp(n.dewC) : '–'),
          h('td', null, f.pct(r.rh)), h('td', null, f.speed(r.windMs) + (isNum(r.windDirDeg) ? ' ' + C.compass(r.windDirDeg) : '')),
          h('td', null, [r.cloudLow, r.cloudMid, r.cloudHigh].map((v) => (isNum(v) ? Math.round(v) : '–')).join('/')),
          h('td', null, isNum(r.visM) ? f.dist(r.visM) : '–'), h('td', null, isNum(r.pm25) ? r.pm25.toFixed(0) : '–'), h('td', null, isNum(r.aod) ? r.aod.toFixed(2) : '–'),
          h('td', null, r.precipMm > 0 ? f.precip(r.precipMm) : '–'),
          h('td', { class: x && x.scored ? 'sc band-' + x.band : '' }, x && x.scored ? String(Math.round(x.score)) : '–'));
      })));
    el.appendChild(h('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Raw hourly table' }, table));
  }

  /* ---------- shot log ---------- */

  function renderLog() {
    const el = clear($('#logsec'));
    el.appendChild(h('summary', null, 'Shot log: teach the model what clear means for you (' + S.log.length + ' entries)'));
    const today = C.localParts(Date.now(), tz()).date;
    const date = h('input', { type: 'date', id: 'lg-date', value: today, max: today, 'aria-label': 'Date shot' });
    const h0 = h('select', { id: 'lg-h0', 'aria-label': 'Start hour' }, hourOptions(7));
    const h1 = h('select', { id: 'lg-h1', 'aria-label': 'End hour' }, hourOptions(10));
    const pf = h('select', { id: 'lg-pf', 'aria-label': 'Shoot type' }, C.PROFILES.map((p) => h('option', { value: p.id, selected: p.id === S.profileId }, p.name)));
    const rate = h('select', { id: 'lg-r', 'aria-label': 'Clarity rating of the keepers' }, [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, n + (n === 5 ? ' (crisp)' : n === 1 ? ' (hazy)' : ''))));
    el.appendChild(h('p', { class: 'muted' }, 'After a shoot, log where and when and how clear the keepers were at 100%. With enough entries the app compares your ratings with its scores and shows which factors matter for you. Each outing is scored from the archived Open-Meteo forecast for that day (without the previous-day trend or climate history). Entries stay on this device.'));
    el.appendChild(h('form', { class: 'logform', onsubmit: (e) => { e.preventDefault(); addLog({ date: date.value, h0: +h0.value, h1: +h1.value, profile: pf.value, rating: +rate.value }); } },
      h('label', null, 'Date', date), h('label', null, 'From', h0), h('label', null, 'To', h1), h('label', null, 'Shoot type', pf), h('label', null, 'Rating', rate),
      h('button', { type: 'submit', class: 'btn primary' }, 'Add to log for ' + S.place.name)));
    if (S.log.length) {
      el.appendChild(h('div', { class: 'logs' }, S.log.map((e) => {
        const r = S.logResults[e.id];
        return h('div', { class: 'logrow' },
          h('div', null, h('strong', null, e.date + ' ' + F.hourLabel(Date.UTC(2000, 0, 1, e.h0), 'UTC') + '–' + F.hourLabel(Date.UTC(2000, 0, 1, e.h1 + 1), 'UTC')), h('div', { class: 'muted small' }, e.place + ' · ' + C.PROFILE_BY_ID[e.profile].name)),
          h('div', null, 'Rated ' + e.rating + '/5'), h('div', { class: r && r.error ? 'muted small' : '' }, r && r.score != null ? 'Model: ' + Math.round(r.score) + ' ' + BAND_LABEL[C.bandOf(r.score)] : r && r.error ? r.error : '–'),
          h('button', { type: 'button', class: 'pill small', 'aria-label': 'Delete entry', onclick: () => { S.log = S.log.filter((x) => x.id !== e.id); store.set('log', S.log); renderLog(); $('#logsec').open = true; } }, 'Delete'));
      })));
      el.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', id: 'lg-an', onclick: analyzeLog }, 'Compare my ratings with the model'), h('span', { id: 'lg-status', class: 'muted', 'aria-live': 'polite' })));
      el.appendChild(h('div', { id: 'lg-out' }));
      renderLogAnalysis();
    }
  }
  const hourOptions = (sel) => Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === sel }, h12s(i)));

  function addLog(v) {
    if (!v.date || v.h1 < v.h0) { $('#lg-status') && ($('#lg-status').textContent = 'End hour must be after the start hour.'); return; }
    const p = S.place;
    S.log.unshift({ id: Date.now().toString(36), date: v.date, h0: v.h0, h1: v.h1, profile: v.profile, rating: v.rating, place: p.name, lat: p.lat, lon: p.lon, tz: p.tz, elevM: p.elevM });
    store.set('log', S.log);
    renderLog();
    $('#logsec').open = true;
  }

  // Scores each logged outing as the app would have seen it, from Open-Meteo's archived forecast for that day.
  async function analyzeLog() {
    const status = $('#lg-status'), btn = $('#lg-an');
    btn.disabled = true; status.textContent = 'Fetching weather for each outing…';
    let done = 0;
    for (const e of S.log) {
      if (S.logResults[e.id] && S.logResults[e.id].score != null) { done++; continue; }
      try {
        const place = { lat: e.lat, lon: e.lon, tz: e.tz, elevM: e.elevM, name: e.place };
        const past = await P.fetchPast(place, e.date);
        const hours = C.mergeHourly(past.weather, past.air);
        const ctx = { place, hours, nowMs: hours[0].ms, climo: null, second: null };
        const prior = S.windPrior === 'auto' ? C.windPriorFor(place) : S.windPrior;
        const sc = C.score(ctx, C.PROFILE_BY_ID[e.profile], { windPrior: prior });
        const inRange = sc.filter((x) => { const lp = C.localParts(x.ms, e.tz); return lp.date === e.date && lp.hour >= e.h0 && lp.hour <= e.h1 && x.scored; });
        const agg = C.aggregate(inRange);
        const pf = C.PROFILE_BY_ID[e.profile];
        const when = pf.id === 'golden' ? 'near sunrise and sunset' : pf.id === 'fog' ? 'from 3 to 9 am' : 'in daylight';
        S.logResults[e.id] = agg ? { score: agg.score, factors: Object.fromEntries(agg.factors.map((f) => [f.id, f.score])) } : { error: pf.name + ' only scores hours ' + when + ', and none fall in that range.' };
      } catch (err) { S.logResults[e.id] = { error: err.message || 'failed' }; }
      done++; status.textContent = 'Scored ' + done + ' of ' + S.log.length + '…';
    }
    store.set('logResults', S.logResults);
    btn.disabled = false; status.textContent = '';
    renderLog(); $('#logsec').open = true;
  }

  function renderLogAnalysis() {
    const out = $('#lg-out');
    if (!out) return;
    const done = S.log.filter((e) => S.logResults[e.id] && S.logResults[e.id].score != null);
    if (!done.length) return;
    const ratings = done.map((e) => e.rating), preds = done.map((e) => S.logResults[e.id].score);
    const r = C.spearman(preds, ratings);
    out.appendChild(h('p', null, done.length + ' scored outing' + (done.length === 1 ? '' : 's') + '. ' +
      (r == null ? 'Add varied ratings to see how well the model tracks them.' : 'Rank correlation between model score and your rating: ' + r.toFixed(2) + (done.length < 8 ? ' (too few entries to trust yet).' : r >= 0.6 ? ' (the model tracks your eye well).' : r >= 0.3 ? ' (partly tracks your eye).' : ' (weak: your keepers follow something else).'))));
    if (done.length >= 8) {
      const ids = C.FACTOR_IDS.filter((id) => done.filter((e) => S.logResults[e.id].factors[id] != null).length >= 8);
      const rows = ids.map((id) => {
        const sub = done.filter((e) => S.logResults[e.id].factors[id] != null);
        return { id, r: C.spearman(sub.map((e) => S.logResults[e.id].factors[id]), sub.map((e) => e.rating)), n: sub.length };
      }).filter((x) => x.r != null).sort((a, b) => b.r - a.r);
      if (rows.length) out.appendChild(h('div', { class: 'ftable' }, rows.map((x) => h('div', { class: 'frow' }, h('div', { class: 'fname' }, C.FACTOR_LABELS[x.id], h('small', null, x.n + ' outings')), h('div', { class: 'fbar' }, h('i', { class: 'fill', style: { width: Math.round(Math.abs(x.r) * 100) + '%', opacity: x.r < 0 ? 0.35 : 1 } })), h('div', { class: 'fval' }, (x.r >= 0 ? '+' : '−') + Math.abs(x.r).toFixed(2))))));
    }
    out.appendChild(h('p', { class: 'muted small' }, done.length < 30 ? 'Weight refitting needs at least 30 labeled outings (' + done.length + ' so far), so the default weights stay in use.' : 'You have 30+ outings; automatic weight refitting is planned but not built yet.'));
  }

  /* ---------- wiring ---------- */

  function init() {
    $('#form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#q').value.trim(); if (v) load(v); });
    $('#locate').addEventListener('click', () => {
      if (!navigator.geolocation) { S.notes = [{ kind: 'warn', text: 'This browser cannot share your location. Enter a zip code instead.' }]; renderBanner(); return; }
      $('#locate').disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => { $('#locate').disabled = false; const v = pos.coords.latitude.toFixed(3) + ', ' + pos.coords.longitude.toFixed(3); $('#q').value = v; load(v); },
        () => { $('#locate').disabled = false; S.notes = [{ kind: 'warn', text: 'Location is blocked or unavailable. Enter a zip code instead.' }]; renderBanner(); },
        { timeout: 10000, maximumAge: 600000 });
    });
    const wp = $('#windprior');
    if (wp) { wp.value = S.windPrior; wp.addEventListener('change', () => { S.windPrior = wp.value; store.set('windPrior', S.windPrior); if (S.hours) { recompute(); pickDay(false); render(); } }); }
    window.addEventListener('online', () => { if (S.error && S.error.input) load(S.error.input); });
    registerSW();
    setTimeout(() => checkForUpdate(true), 1500);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(true); });
    const verEl = $('#ver'); if (verEl) { verEl.setAttribute('role', 'button'); verEl.tabIndex = 0; verEl.addEventListener('click', () => checkForUpdate(false, true)); }
    const fromHash = decodeURIComponent((location.hash || '').slice(1));
    const start = fromHash || store.get('last', '');
    if (start) { $('#q').value = start; load(start); } else render();
  }


  /* ---------- versioning, self-update, offline launch ----------
     Same protocol as Studio Phone: the service worker serves the cached page first; the live-version probe (?u=)
     and the update load (?v=) always go to the network. Every build bumps VERSION (build.mjs). */
  const APP_VERSION = '__APP_VERSION__';
  async function checkForUpdate(auto, manual) {
    const bar = $('#updatebar');
    const say = (t) => { if (!bar) return; clear(bar); if (t) bar.appendChild(h('div', { class: 'banner info', role: 'status' }, t)); };
    try {
      if (!/^https?:$/.test(location.protocol)) return;
      const r = await fetch(location.pathname + '?u=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const m = (await r.text()).match(/const APP_VERSION = 'v([\d.]+)'/);
      if (!m) return;
      const live = m[1], mine = (APP_VERSION.match(/^v([\d.]+)$/) || [])[1];
      if (!live || live === mine) { if (manual) { say('You have the latest version (v' + mine + ').'); setTimeout(() => say(''), 3000); } return; }
      const go = () => location.replace(location.pathname + '?v=' + live + location.hash);
      if (auto && !S.hours && !S.loading) { go(); return; }   // nothing on screen to lose: update at once
      clear(bar);
      bar.appendChild(h('div', { class: 'banner info update', role: 'status' }, 'ClearSky v' + live + ' is available. ',
        h('button', { type: 'button', class: 'upd', onclick: go }, 'Update now')));
    } catch (e) { if (manual) { say('Could not check. Are you online?'); setTimeout(() => say(''), 3000); } }
  }
  function registerSW() {
    try {
      if (!('serviceWorker' in navigator)) return;
      if (!(location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) return;
      navigator.serviceWorker.register('sw.js?p=' + encodeURIComponent(location.pathname), { scope: location.pathname }).catch(() => {});
    } catch (e) { /* offline launch is optional */ }
  }

  window.ClearSkyApp = { S, load, recompute, render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
