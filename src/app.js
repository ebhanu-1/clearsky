/* ClearSky app: UI layer. Builds DOM with textContent only (no innerHTML on data). */
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
    units: store.get('units', 'us'),
    profileId: store.get('profile', 'clarity'),
    windPrior: store.get('windPrior', 'auto'),
    input: '', place: null, hours: null, hourByMs: new Map(), climo: null, second: null, nowMs: 0,
    ctx: null, derived: null, scores: {}, windows: {}, dayKeys: [], day: null, sel: null,
    loading: false, error: null, notes: [], updatedAt: null, loadId: 0, climoState: 'idle', nwsState: 'idle',
    recents: store.get('recents', []), saved: store.get('saved', []), log: store.get('log', []), logResults: store.get('logResults', {}),
    chart: null,
  };
  if (!C.PROFILE_BY_ID[S.profileId]) S.profileId = 'clarity';
  const fmt = () => F.makeFmt(S.units);
  const profile = () => C.PROFILE_BY_ID[S.profileId];
  const tz = () => (S.place ? S.place.tz : 'UTC');

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
    S.loading = true; S.error = null; S.notes = []; S.climo = null; S.second = null; S.climoState = 'loading'; S.nwsState = 'loading';
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
    recompute();
    pickDay(true);
    remember(place, input);
    try { history.replaceState(null, '', '#' + encodeURIComponent(input)); } catch (e) { /* file:// or sandbox */ }
    render();
    $('#q').value = input;
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

  function refine() { if (!S.hours) return; recompute(); const keepDay = S.day; pickDay(false); if (keepDay && S.dayKeys.includes(keepDay)) S.day = keepDay; render(); }

  function recompute() {
    const place = S.place;
    const ctx = { place, hours: S.hours, nowMs: S.nowMs, climo: S.climo, second: S.second };
    S.ctx = ctx;
    S.derived = C.derive(ctx);
    const prior = S.windPrior === 'auto' ? C.windPriorFor(place) : S.windPrior;
    for (const p of C.PROFILES) {
      S.scores[p.id] = C.score(ctx, p, { derived: S.derived, windPrior: prior });
      S.windows[p.id] = C.bestWindows(S.scores[p.id], { tz: place.tz, fromMs: S.nowMs });
    }
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
  function selectDay(day) {
    S.day = day;
    const w = dayWindows(S.profileId, day)[0];
    S.sel = w ? { kind: 'window', day, rank: w.rank } : null;
    renderWeek(); renderDay();
  }
  function select(sel) {
    S.sel = sel;
    if (S.chart) S.chart.setSel(sel);
    renderWhy();
  }

  /* ---------- small UI parts ---------- */

  const BAND_LABEL = { excellent: 'Excellent', good: 'Good', fair: 'Fair', poor: 'Poor', skip: 'Skip' };
  const bandChip = (band, text) => h('span', { class: 'chip band-' + band }, text || BAND_LABEL[band]);

  function dots(level) {
    const n = { high: 3, medium: 2, low: 1 }[level] || 0;
    return h('span', { class: 'dots', role: 'img', 'aria-label': level + ' confidence' },
      [0, 1, 2].map((i) => h('i', { class: i < n ? 'on' : '' })), h('span', { class: 'dots-text' }, level));
  }

  const hoursOfDay = (pid, day) => (S.scores[pid] || []).filter((x) => C.localParts(x.ms, tz()).date === day);
  const winLabel = (w) => F.rangeLabel(w.startMs, w.endMs, tz());
  const dayLabel = (ms) => F.weekday(ms, tz());

  function reasonText(r) { return F.describe(r.factor, r.sign, r.raw, fmt()); }

  const windowAgg = (w) => C.aggregate(S.scores[S.profileId].filter((x) => x.ms >= w.startMs && x.ms < w.endMs));
  // Short single line for day cards: the reason that explains the score most.
  function headline(w) {
    const agg = windowAgg(w);
    if (!agg) return '';
    const pos = agg.reasons.find((r) => r.sign > 0), neg = agg.reasons.find((r) => r.sign < 0);
    const r = w.score >= 50 ? pos || neg : neg || pos;
    return r ? F.shortReason(r.factor, r.sign, r.raw, fmt()) : '';
  }
  // Hero lines: strongest helper and strongest hurter, in full words.
  function heroReasons(w) {
    const agg = windowAgg(w);
    if (!agg) return [];
    return [agg.reasons.find((r) => r.sign > 0), agg.reasons.find((r) => r.sign < 0)].filter(Boolean)
      .map((r) => h('div', { class: 'hl ' + (r.sign > 0 ? 'pos' : 'neg') }, h('span', { class: 'sym', 'aria-hidden': 'true' }, r.sign > 0 ? '+' : '−'), h('span', null, reasonText(r))));
  }

  /* ---------- render: top level ---------- */

  function render() {
    renderChips(); renderBanner();
    const app = clear($('#app'));
    for (const b of document.querySelectorAll('[data-units]')) b.setAttribute('aria-pressed', String(b.dataset.units === S.units));
    if (S.error) { app.appendChild(errorCard()); return; }
    if (S.loading && !S.hours) { app.appendChild(skeleton()); return; }
    if (!S.hours) { app.appendChild(welcome()); return; }
    app.appendChild(h('section', { id: 'hero', 'aria-label': 'Best time' }));
    app.appendChild(h('nav', { id: 'profiles', 'aria-label': 'Shoot type' }));
    app.appendChild(h('section', { id: 'compare' }));
    app.appendChild(h('section', { id: 'week', 'aria-label': 'Week' }));
    app.appendChild(h('div', { id: 'day' }));
    app.appendChild(h('details', { id: 'raw', class: 'card' }));
    app.appendChild(h('details', { id: 'logsec', class: 'card' }));
    renderHero(); renderProfiles(); renderCompare(); renderWeek(); renderDay(); renderRaw(); renderLog();
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
    if (S.hours && (S.climoState === 'loading' || S.nwsState === 'loading')) notes.push({ kind: 'info', text: 'Refining with climate history and the NWS cross-check…' });
    for (const n of notes) el.appendChild(h('div', { class: 'banner ' + n.kind, role: n.kind === 'warn' ? 'status' : null }, n.text));
  }

  function skeleton() {
    return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
      h('div', { class: 'sk sk-hero' }), h('div', { class: 'sk sk-row' }), h('div', { class: 'sk-days' }, [0, 1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'sk sk-day' }))), h('div', { class: 'sk sk-chart' }));
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
    return h('section', { class: 'card welcome' },
      h('h2', null, 'Which hour is clearest this week?'),
      h('p', null, 'Enter a US zip code to get an hour-by-hour score for the next 7 days, the best shooting windows, and the reason behind each number.'),
      h('div', { class: 'types' }, C.PROFILES.map((p) => h('div', { class: 'type' }, h('strong', null, p.name), h('span', null, p.description)))),
      h('p', { class: 'muted' }, 'Try one:'),
      h('div', { class: 'chips' }, [['01810', 'Andover, MA'], ['80202', 'Denver, CO'], ['98101', 'Seattle, WA'], ['33101', 'Miami, FL']].map(([z, n]) =>
        h('button', { type: 'button', class: 'pill', onclick: () => { $('#q').value = z; load(z); } }, z + ' · ' + n))));
  }

  /* ---------- hero ---------- */

  function renderHero() {
    const el = clear($('#hero'));
    el.className = 'card hero';
    const pf = profile();
    const best = bestOverall(S.profileId);
    const near = bestOverall(S.profileId, 48);
    const place = S.place;
    const key = place.lat.toFixed(4) + ',' + place.lon.toFixed(4);
    const isSaved = S.saved.some((x) => x.input === key || x.input === place.zip);
    const placeRow = h('div', { class: 'place' },
      h('div', null, h('strong', null, place.name + (place.state ? ', ' + place.state : '')),
        h('span', { class: 'muted' }, ' · ' + (place.zip ? place.zip + ' · ' : '') + F.makeFmt(S.units).height(place.elevM) + ' elevation')),
      h('button', { type: 'button', class: 'pill small', 'aria-pressed': String(isSaved), onclick: toggleSaved }, isSaved ? '★ Saved' : '☆ Save spot'));
    el.appendChild(placeRow);
    if (!best) {
      el.appendChild(h('p', { class: 'big-empty' }, 'No ' + pf.name.toLowerCase() + ' hours in the forecast for this place (sun never reaches the needed angle, or data is missing).'));
      return;
    }
    el.appendChild(h('div', { class: 'hero-main' },
      h('div', { class: 'hero-score band-' + best.band }, h('span', { class: 'num' }, String(Math.round(best.score))), h('span', { class: 'lbl' }, BAND_LABEL[best.band])),
      h('div', { class: 'hero-text' },
        h('div', { class: 'eyebrow' }, 'Best ' + pf.name.toLowerCase() + ' window this week'),
        h('div', { class: 'when' }, dayLabel(best.startMs) + ' ' + F.dateLabel(best.startMs, tz()) + ', ' + winLabel(best)),
        h('div', { class: 'why-lines' }, heroReasons(best)),
        h('div', { class: 'meta' }, dots(best.confidence), leadNote(best)),
        h('button', { type: 'button', class: 'btn', onclick: () => { S.day = best.day; S.sel = { kind: 'window', day: best.day, rank: best.rank }; renderWeek(); renderDay(); $('#day').scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'See that day'))));
    if (near && best && near.startMs !== best.startMs) {
      el.appendChild(h('div', { class: 'near' },
        h('span', { class: 'muted' }, 'Next 48 hours: '),
        h('button', { type: 'button', class: 'linkish', onclick: () => { S.day = near.day; S.sel = { kind: 'window', day: near.day, rank: near.rank }; renderWeek(); renderDay(); } },
          dayLabel(near.startMs) + ' ' + winLabel(near)), ' ', bandChip(near.band, Math.round(near.score) + ' ' + BAND_LABEL[near.band])));
    }
    const pct = climateBadge(best);
    if (pct) el.appendChild(h('div', { class: 'badge-row' }, h('span', { class: 'chip neutral' }, pct)));
  }

  function leadNote(w) {
    const days = (w.startMs - S.nowMs) / (24 * HOUR);
    const t = days < 1 ? 'today or tomorrow' : 'about ' + Math.round(days) + ' day' + (Math.round(days) === 1 ? '' : 's') + ' out';
    return h('span', { class: 'muted' }, ' ' + t + (w.confidence === 'low' ? ': an early guide, it will move' : ''));
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

  /* ---------- profile switcher and comparison ---------- */

  function renderProfiles() {
    const el = clear($('#profiles'));
    el.className = 'profiles';
    for (const p of C.PROFILES) {
      el.appendChild(h('button', { type: 'button', class: 'tab', 'aria-pressed': String(p.id === S.profileId), title: p.description, onclick: () => selectProfile(p.id, true) }, p.name));
    }
  }

  function renderCompare() {
    const el = clear($('#compare'));
    el.className = 'compare';
    el.appendChild(h('div', { class: 'compare-head' }, h('strong', null, 'Best this week by shoot type')));
    const list = h('div', { class: 'compare-list' });
    for (const p of C.PROFILES) {
      const w = bestOverall(p.id);
      list.appendChild(h('button', { type: 'button', class: 'cmp' + (p.id === S.profileId ? ' current' : ''), onclick: () => { S.profileId = p.id; store.set('profile', p.id); S.day = w ? w.day : S.day; S.sel = w ? { kind: 'window', day: w.day, rank: w.rank } : null; render(); } },
        h('span', { class: 'cmp-name' }, p.name),
        w ? h('span', { class: 'cmp-when' }, dayLabel(w.startMs) + ' ' + winLabel(w)) : h('span', { class: 'cmp-when muted' }, 'none'),
        w ? bandChip(w.band, String(Math.round(w.score))) : null));
    }
    el.appendChild(list);
  }

  /* ---------- week strip ---------- */

  function renderWeek() {
    const el = clear($('#week'));
    el.className = 'week';
    const best = bestOverall(S.profileId);
    for (const day of S.dayKeys) {
      const w = dayWindows(S.profileId, day)[0];
      const first = (S.scores[S.profileId].find((x) => C.localParts(x.ms, tz()).date === day) || {}).ms;
      const label = first != null ? dayLabel(first) : '';
      const isToday = day === C.localParts(S.nowMs, tz()).date;
      const isBest = best && best.day === day;
      const btn = h('button', { type: 'button', class: 'day' + (S.day === day ? ' active' : '') + (isBest ? ' best' : '') + (w && w.confidence === 'low' ? ' lowconf' : ''), 'aria-pressed': String(S.day === day), 'aria-label': label + ' ' + day + (w ? ', ' + Math.round(w.score) + ' ' + BAND_LABEL[w.band] + ', ' + winLabel(w) : ', no scored hours'), onclick: () => selectDay(day) },
        isBest ? h('span', { class: 'tag-best' }, 'Best') : null,
        h('span', { class: 'dow' }, isToday ? 'Today' : label),
        h('span', { class: 'dte' }, first != null ? F.dateLabel(first, tz()) : day.slice(5)),
        w ? h('span', { class: 'score band-' + w.band }, h('b', null, String(Math.round(w.score))), h('i', null, BAND_LABEL[w.band])) : h('span', { class: 'score band-none' }, h('b', null, '–'), h('i', null, 'none')),
        w ? h('span', { class: 'win' }, winLabel(w)) : null,
        w ? dots(w.confidence) : null,
        w ? h('span', { class: 'rs' }, headline(w)) : null);
      el.appendChild(btn);
    }
  }

  /* ---------- day panel: chart + why + sun ---------- */

  function renderDay() {
    const el = clear($('#day'));
    el.className = 'day-panel';
    if (!S.day) return;
    const hrs = hoursOfDay(S.profileId, S.day);
    const first = hrs[0] ? hrs[0].ms : S.nowMs;
    el.appendChild(h('div', { class: 'card chart-card' },
      h('div', { class: 'card-head' }, h('h2', null, dayLabel(first) + ' ' + F.dateLabel(first, tz()) + ' · ' + profile().name), h('span', { class: 'muted' }, 'Tap a bar or a window for the reasons')),
      h('div', { id: 'chartbox', class: 'chartbox' }),
      h('p', { class: 'legend' }, 'Bars: hourly score, colored by band. Line: dew point. Triangle: fog likely. Gray band: night. Faded bars: low-confidence forecast or past hours.')));
    el.appendChild(h('div', { class: 'side' }, h('div', { id: 'why', class: 'card' }), h('div', { id: 'sun', class: 'card' })));
    drawChart();
    renderWhy();
    renderSun();
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

    // night shading and sun lines
    const st = C.sunTimes(S.place.lat, S.place.lon, S.day, tz());
    const endX = padL + cw;
    const nightRect = (a, b) => { const xa = Math.max(padL, a), xb = Math.min(endX, b); if (xb > xa) svg.appendChild(s('rect', { x: xa, y: padT, width: xb - xa, height: ch, class: 'night' })); };
    if (st.sunrise != null && st.sunset != null) { nightRect(padL, xOf(st.sunrise)); nightRect(xOf(st.sunset), endX); }
    else if (st.maxElev < -0.833) nightRect(padL, endX);

    // gridlines at band thresholds
    for (const v of [0, 20, 40, 60, 80, 100]) {
      svg.appendChild(s('line', { x1: padL, x2: endX, y1: yOf(v), y2: yOf(v), class: 'grid' }));
      svg.appendChild(s('text', { x: padL - 5, y: yOf(v) + 4, class: 'axis', 'text-anchor': 'end' }, String(v)));
    }

    // bars
    const barEls = new Map();
    const sc = hs;
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

    // dew point line with a direct label
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

    // sun lines
    const sunLine = (ms, label) => {
      if (ms == null) return;
      const x = xOf(ms);
      if (x < padL || x > endX) return;
      svg.appendChild(s('line', { x1: x, x2: x, y1: padT - 6, y2: padT + ch, class: 'sunline' }));
      svg.appendChild(s('text', { x: Math.min(Math.max(x, padL + 18), endX - 18), y: padT - 9, class: 'sunlbl', 'text-anchor': 'middle' }, label + ' ' + F.clockLabel(ms, tz()).replace(' ', '')));
    };
    sunLine(st.sunrise, 'Rise'); sunLine(st.sunset, 'Set');

    // x labels
    const every = Math.max(1, Math.ceil(30 / bw));
    hs.forEach((hr, i) => {
      if (i % every) return;
      const p = F.parts(hr.ms, tz());
      svg.appendChild(s('text', { x: padL + i * bw + bw / 2, y: padT + ch + 14, class: 'axis', 'text-anchor': 'middle' }, h12s(p.hour)));
    });

    // windows
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

  /* ---------- why panel ---------- */

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
    return { title: (w.rank === 1 ? 'Best window' : 'Window #' + w.rank) + ' · ' + dayLabel(w.startMs) + ' ' + winLabel(w), hours: list.filter((x) => x.ms >= w.startMs && x.ms < w.endMs), isWindow: true, ms: w.startMs };
  }

  function renderWhy() {
    const el = $('#why');
    if (!el) return;
    clear(el);
    const sel = selectedScores();
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Why')));
    if (!sel) { el.appendChild(h('p', { class: 'muted' }, 'Pick an hour or a window to see what drives its score.')); return; }
    const one = sel.hours[0];
    if (!one || !one.scored) { el.appendChild(h('p', null, sel.title), h('p', { class: 'muted' }, 'This hour is not scored for ' + profile().name.toLowerCase() + '. ' + (profile().id === 'fog' ? 'Fog is scored from 3 am to 9 am local time.' : 'The sun is too far below the horizon.'))); return; }
    const agg = sel.isWindow ? C.aggregate(sel.hours) : C.aggregate([one]);
    const score = agg.score, band = C.bandOf(score);
    el.appendChild(h('div', { class: 'why-top' },
      h('div', { class: 'why-score band-' + band }, h('span', { class: 'num' }, String(Math.round(score))), h('span', { class: 'lbl' }, BAND_LABEL[band])),
      h('div', null, h('div', { class: 'why-title' }, sel.title), h('div', { class: 'meta' }, dots(agg.confidence), sel.isWindow ? h('span', { class: 'muted' }, ' ' + sel.hours.length + '-hour average') : null))));
    if (agg.capped) el.appendChild(h('p', { class: 'flag warn' }, 'Capped at Fair: a limiting factor (haze, smoke or humid air) is poor even though others look good.'));
    const good = agg.reasons.filter((r) => r.sign > 0), bad = agg.reasons.filter((r) => r.sign < 0);
    const list = (title, items, cls, sym) => items.length ? h('div', { class: 'reasons ' + cls }, h('h3', null, title), h('ul', null, items.map((r) => h('li', null, h('span', { class: 'sym', 'aria-hidden': 'true' }, sym), h('span', null, reasonText(r)))))) : null;
    for (const blk of [list('Helping', good, 'good', '+'), list('Hurting', bad, 'bad', '−')]) if (blk) el.appendChild(blk);
    if (!good.length && !bad.length) el.appendChild(h('p', { class: 'muted' }, 'All factors sit near neutral for this hour.'));
    const flagText = { fog: 'Fog likely (spread within 3°F, humidity 95% or more)', smoke: 'Smoke or heavy haze in the air', dust: 'Dust in the air', rain: 'Rain in this hour', shimmer: 'Heat shimmer likely for telephoto work', lowvis: 'Visibility under 3 miles' };
    const fl = h('div', { class: 'flags' }, agg.flags.map((k) => h('span', { class: 'chip flag-' + k }, flagText[k] || k)));
    if (agg.flags.length) el.appendChild(fl);
    const miss = (one.missing || []).filter((id) => !(id === 'ventilation' || id === 'heatShimmer' || id === 'airmass' || id === 'rainScrub'));
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
  }

  /* ---------- sunrise and sunset card ---------- */

  function renderSun() {
    const el = $('#sun');
    if (!el) return;
    clear(el);
    el.appendChild(h('div', { class: 'card-head' }, h('h2', null, 'Sunrise and sunset')));
    const st = C.sunTimes(S.place.lat, S.place.lon, S.day, tz());
    const t = (ms) => F.clockLabel(ms, tz());
    if (st.sunrise == null || st.sunset == null) {
      el.appendChild(h('p', { class: 'muted' }, st.maxElev > 0 ? 'The sun stays up all day at this latitude, so there is no sunrise or sunset.' : 'The sun stays below the horizon all day (polar night).'));
      return;
    }
    const gw = dayWindows('golden', S.day);
    const am = gw.find((w) => w.startMs < st.sunrise + 4 * HOUR && w.startMs < zonedNoon()), pm = gw.find((w) => w.startMs >= zonedNoon());
    const row = (label, ms, w, hourMs) => {
      const rec = S.hourByMs.get(Math.floor(ms / HOUR) * HOUR);
      return h('div', { class: 'sunrow' },
        h('div', null, h('strong', null, label + ' ' + t(ms)), rec && isNum(rec.cloudLow) ? h('div', { class: 'muted small' }, 'Cloud at that hour: low ' + fmt().pct(rec.cloudLow) + ', mid ' + fmt().pct(rec.cloudMid) + ', high ' + fmt().pct(rec.cloudHigh)) : null),
        w ? h('button', { type: 'button', class: 'pill small', onclick: () => { S.profileId = 'golden'; store.set('profile', 'golden'); S.sel = { kind: 'window', day: S.day, rank: w.rank }; render(); } }, bandChip(w.band, Math.round(w.score) + ' ' + BAND_LABEL[w.band]), ' golden light') : null);
    };
    el.appendChild(row('Sunrise', st.sunrise, am));
    el.appendChild(row('Sunset', st.sunset, pm));
    el.appendChild(h('p', { class: 'muted small' }, 'Golden hour: ' + (st.goldenAM[0] != null && st.goldenAM[1] != null ? t(st.goldenAM[0]) + ' to ' + t(st.goldenAM[1]) : '–') + ' and ' + (st.goldenPM[0] != null && st.goldenPM[1] != null ? t(st.goldenPM[0]) + ' to ' + t(st.goldenPM[1]) : '–') + ' (sun between −4° and 6°).'));
    const fw = dayWindows('fog', S.day)[0];
    el.appendChild(h('div', { class: 'sunrow' },
      h('div', null, h('strong', null, 'Fog potential'), h('div', { class: 'muted small' }, 'Area-level estimate for 3 to 9 am. Valleys and water can differ from this grid point.')),
      fw ? h('button', { type: 'button', class: 'pill small', onclick: () => { S.profileId = 'fog'; store.set('profile', 'fog'); S.sel = { kind: 'window', day: S.day, rank: fw.rank }; render(); } }, bandChip(fw.band, Math.round(fw.score) + ' ' + BAND_LABEL[fw.band]), ' ' + winLabel(fw)) : h('span', { class: 'muted' }, 'none')));
  }
  function zonedNoon() { return C.zonedMidnight(S.day, tz()) + 12 * HOUR; }

  /* ---------- raw table ---------- */

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
    for (const b of document.querySelectorAll('[data-units]')) b.addEventListener('click', () => { S.units = b.dataset.units; store.set('units', S.units); if (S.hours) { render(); } else render(); });
    const wp = $('#windprior');
    if (wp) { wp.value = S.windPrior; wp.addEventListener('change', () => { S.windPrior = wp.value; store.set('windPrior', S.windPrior); if (S.hours) { recompute(); pickDay(false); render(); } }); }
    window.addEventListener('online', () => { if (S.error && S.error.input) load(S.error.input); });
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) navigator.serviceWorker.register('./sw.js').catch(() => {});
    const fromHash = decodeURIComponent((location.hash || '').slice(1));
    const start = fromHash || store.get('last', '');
    if (start) { $('#q').value = start; load(start); } else render();
  }

  window.ClearSkyApp = { S, load, recompute, render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
