# ClearSky

Pick the day and hour before you drive. Enter a US zip code (or "lat, lon", or tap the location button) and get an
hour-by-hour 0 to 100 score for the next 7 days, for six shoot types: **Clarity**, **Golden light**, **Fog and mist**,
**Reflections**, **Soft light** and **Wildlife**. Every score comes with the reasons behind it, a confidence level, and
the raw numbers so you can cross-check against any weather app.

No accounts, no API keys. Data comes straight from the browser to Open-Meteo (forecast, air quality, ERA5 history),
the National Weather Service (cross-check), Zippopotam.us and OpenStreetMap Nominatim (places).

## Use it

- **Desktop:** open `index.html`. It is one self-contained file.
- **Phone, same Wi-Fi:** `npm run serve`, then open `http://<your-computer-ip>:5173` on the phone.
- **Phone, anywhere:** put `index.html` (plus `manifest.webmanifest`, `sw.js` and the icons) on any static host, such as
  GitHub Pages or Netlify Drop. Over https the browser offers Add to Home Screen, the app caches itself for offline use,
  and the location button works.

## Develop

```bash
npm test          # 21 tests, no network
npm run build     # writes index.html
npm run live      # hits the real APIs for four zips
```

Open-Meteo's free tier is for personal, non-commercial use. See docs/spikes.md before publishing this more widely.
