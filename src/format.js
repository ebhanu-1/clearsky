/* ClearSky format: unit conversion for display, time labels, and plain-language reasons.
 * Pure. Reasons are rebuilt from the same raw SI values for either unit system, so toggling units
 * changes the text and never the scores.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClearSkyFormat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const round = Math.round;

  function makeFmt(units) {
    const us = units !== 'si';
    return {
      units: us ? 'us' : 'si',
      temp: (c) => (isNum(c) ? (us ? round((c * 9) / 5 + 32) + '°F' : round(c) + '°C') : '–'),
      dTemp: (c) => (isNum(c) ? (us ? round(Math.abs(c) * 1.8) + '°F' : round(Math.abs(c)) + '°C') : '–'),
      speed: (ms) => (isNum(ms) ? (us ? round(ms * 2.2369363) + ' mph' : round(ms * 3.6) + ' km/h') : '–'),
      dist: (m) => {
        if (!isNum(m)) return '–';
        const v = us ? m / 1609.344 : m / 1000;
        return (v >= 10 ? round(v) : v.toFixed(1)) + (us ? ' mi' : ' km');
      },
      height: (m) => (isNum(m) ? (us ? round((m * 3.28084) / 10) * 10 + ' ft' : round(m / 10) * 10 + ' m') : '–'),
      precip: (mm) => (isNum(mm) ? (us ? (mm / 25.4).toFixed(2) + ' in' : mm.toFixed(1) + ' mm') : '–'),
      pres: (h) => (isNum(h) ? (us ? (h * 0.029530).toFixed(2) + ' inHg' : round(h) + ' hPa') : '–'),
      pct: (v) => (isNum(v) ? round(v) + '%' : '–'),
      num: (v, d) => (isNum(v) ? v.toFixed(d == null ? 0 : d) : '–'),
    };
  }

  const ordinal = (n) => {
    n = round(n);
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  /* ---------- reasons ---------- */

  // value = what was measured; note = the plain-language reading of it. sign: 1 helps, -1 hurts, 0 neutral.
  function describeParts(id, sign, raw, f) {
    const pos = sign > 0;
    switch (id) {
      case 'dewpoint': {
        const note = (pos ? 'dry' : 'humid') + ' air' + (isNum(raw.pct) ? ', ' + ordinal(raw.pct) + ' percentile' : '');
        return { value: 'Dew point ' + f.temp(raw.dewC), note };
      }
      case 'particulates': {
        const bits = [];
        if (isNum(raw.pm25)) bits.push('PM2.5 ' + round(raw.pm25) + ' µg/m³');
        if (isNum(raw.aod)) bits.push('aerosol depth ' + raw.aod.toFixed(2));
        return { value: bits.join(', '), note: pos ? 'clean air' : 'smoke, dust or pollution' };
      }
      case 'visibility':
        return { value: 'Visibility ' + f.dist(raw.visM), note: pos ? 'long sight lines' : 'reduced sight lines' };
      case 'ventilation':
        return { value: 'Mixing height ' + f.height(raw.pblM), note: pos ? 'haze disperses' : 'haze can pool near the ground' };
      case 'airmass': {
        const up = raw.dpTrendC > 0.3, down = raw.dpTrendC < -0.3;
        const value = down ? 'Dew point down ' + f.dTemp(raw.dpTrendC) + ' in 24 h' : up ? 'Dew point up ' + f.dTemp(raw.dpTrendC) + ' in 24 h' : 'Dew point steady over 24 h';
        const p = isNum(raw.pTrend12) && raw.pTrend12 >= 3 ? ', pressure rising' : '';
        return { value: value + p, note: down ? 'drier air arriving' : up ? 'moisture building' : 'no air-mass change' };
      }
      case 'rainScrub': {
        if (isNum(raw.nowMm) && raw.nowMm >= 0.2) return { value: 'Raining now', note: 'rain in the air' };
        if (raw.precip24 >= 0.2) {
          return pos
            ? { value: 'Rain ' + raw.hoursSinceRain + ' h ago, ' + f.precip(raw.precip24) + ' in 24 h', note: 'air washed clean' }
            : { value: 'Rain ended ' + raw.hoursSinceRain + ' h ago', note: 'air still damp' };
        }
        return { value: 'No rain in the last 24 h', note: 'nothing has cleared the air' };
      }
      case 'windRegime': {
        const mph = raw.windMs * 2.2369363;
        const dir = raw.dirName ? ' from ' + raw.dirName : '';
        const note = pos ? 'favorable flow' : mph < 3 ? 'calm air lets haze pool' : mph > 15 ? 'strong wind shakes long lenses' : 'unfavorable direction';
        return { value: 'Wind ' + f.speed(raw.windMs) + dir, note };
      }
      case 'humidity':
        return { value: 'Humidity ' + f.pct(raw.rh), note: pos ? 'dry' : 'moist' };
      case 'skyCover': {
        const c = raw.cloud;
        return { value: 'Cloud cover ' + f.pct(c), note: c >= 85 ? 'overcast' : c <= 30 ? 'open sky' : 'broken cloud' };
      }
      case 'skyColor':
        return { value: 'Mid and high cloud ' + f.pct(raw.midHigh), note: pos ? 'cloud to catch the color' : raw.midHigh < 20 ? 'little cloud to light up' : 'thick cloud blocks the color' };
      case 'lowCloudClear':
        return { value: 'Low cloud ' + f.pct(raw.low), note: pos ? 'clear horizon' : 'blocks the horizon' };
      case 'fogPotential':
        return pos
          ? { value: 'Dew point within ' + f.dTemp(raw.spreadC) + ' of temperature, humidity ' + f.pct(raw.rh), note: 'fog likely with light wind' }
          : { value: 'Spread ' + f.dTemp(raw.spreadC) + ', humidity ' + f.pct(raw.rh) + ', wind ' + f.speed(raw.windMs), note: 'fog unlikely' };
      case 'calm': {
        const g = isNum(raw.gustMs) && raw.gustMs > 2 * raw.windMs && raw.gustMs * 2.2369 > 8 ? ', gusts ' + f.speed(raw.gustMs) : '';
        return { value: 'Wind ' + f.speed(raw.windMs) + g, note: pos ? 'still air' : 'ripples water and shakes gear' };
      }
      case 'precipGate':
        return raw.mm > 0.05 ? { value: 'Precipitation ' + f.precip(raw.mm) + ' per hour', note: 'wet lens and soft detail' } : { value: 'No precipitation', note: 'dry' };
      case 'lightWindow': {
        const e = raw.elev;
        const value = e >= 0 ? 'Sun ' + round(e) + '° above the horizon' : 'Sun ' + round(-e) + '° below the horizon';
        return { value, note: pos ? 'good light angle' : e > 30 ? 'harsh overhead light' : e < 0 ? 'before sunrise or after sunset' : 'not the best angle' };
      }
      case 'heatShimmer':
        return { value: 'Temperature ' + f.temp(raw.tempC) + ' with high sun', note: pos ? 'little shimmer' : 'heat shimmer softens long lenses' };
      default:
        return { value: id, note: '' };
    }
  }
  function describe(id, sign, raw, f) {
    const p = describeParts(id, sign, raw, f);
    return p.note ? p.value + ' (' + p.note + ')' : p.value;
  }

  // One short line for tight spaces: signed, no explanatory note.
  function shortReason(id, sign, raw, f) {
    let v = describeParts(id, sign, raw, f).value;
    if (id === 'particulates') v = v.split(',')[0];
    return (sign > 0 ? '+ ' : sign < 0 ? '− ' : '') + v;
  }

  const MISSING_TEXT = {
    particulates: 'smoke and particulate data', visibility: 'visibility', ventilation: 'mixing height (night or low sun)',
    airmass: 'the 24-hour air-mass trend', rainScrub: 'recent rain history', windRegime: 'wind', humidity: 'humidity',
    skyCover: 'cloud cover', skyColor: 'mid and high cloud', lowCloudClear: 'low cloud', fogPotential: 'fog inputs',
    calm: 'wind', precipGate: 'precipitation', lightWindow: 'sun position', heatShimmer: 'heat shimmer (sun too low)', dewpoint: 'dew point',
  };

  /* ---------- time labels ---------- */

  function parts(ms, tz) {
    const d = new Date(ms);
    const o = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric', minute: '2-digit', weekday: 'short', month: 'short', day: 'numeric' }).formatToParts(d)) o[p.type] = p.value;
    return { hour: +o.hour % 24, minute: +o.minute, weekday: o.weekday, month: o.month, day: o.day };
  }
  const h12 = (h) => ((h + 11) % 12) + 1;
  const ampm = (h) => (h % 24 < 12 ? 'am' : 'pm');

  function hourLabel(ms, tz) {
    const p = parts(ms, tz);
    return h12(p.hour) + ' ' + ampm(p.hour);
  }
  function clockLabel(ms, tz) {
    if (ms == null) return '–';
    const p = parts(ms, tz);
    return h12(p.hour) + ':' + String(p.minute).padStart(2, '0') + ' ' + ampm(p.hour);
  }
  // "7–10 am", "11 am–2 pm"; end is the exclusive end of the last hour.
  function rangeLabel(startMs, endMs, tz) {
    const a = parts(startMs, tz), b = parts(endMs, tz);
    if (endMs - startMs <= 3600000) return h12(a.hour) + ' ' + ampm(a.hour);
    return ampm(a.hour) === ampm(b.hour) ? h12(a.hour) + '–' + h12(b.hour) + ' ' + ampm(b.hour) : h12(a.hour) + ' ' + ampm(a.hour) + '–' + h12(b.hour) + ' ' + ampm(b.hour);
  }
  const weekday = (ms, tz) => parts(ms, tz).weekday;
  const dateLabel = (ms, tz) => { const p = parts(ms, tz); return p.month + ' ' + p.day; };
  function ageLabel(ms, nowMs) {
    const m = Math.max(0, Math.round((nowMs - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }

  return { makeFmt, ordinal, describe, describeParts, shortReason, MISSING_TEXT, hourLabel, clockLabel, rangeLabel, weekday, dateLabel, ageLabel, parts };
});
