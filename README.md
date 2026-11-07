# ClearSky

Clear air for distant shots. Enter a US zip code (or "lat, lon", or tap the location button) and get an hour-by-hour
0 to 100 Clarity score for the next 7 days: will far ridges, skylines and ranges look sharp and clean, and when?
Tell it how far the subject is and which way you are looking, and it checks the air along that line and which way to
point relative to the sun. It also shows when dry air arrives or haze returns, how much the forecast models agree, an
hour-by-hour layers grid (cloud layers, dew point, smoke, visibility, mixing height, wind), field notes, and a calendar
reminder for the best window. Five other shoot types (**Golden light**, **Fog and mist**, **Reflections**,
**Soft light**, **Wildlife**) are one tap away. Every score comes with the reasons behind it and a confidence level.
See docs/v2.md for the assessment and design decisions.

No accounts, no API keys. Data comes straight from the browser to the National Weather Service (the forecast: temperature,
dew point, humidity, wind, cloud cover, visibility, rain), Open-Meteo (cloud layers, air quality, forecast ensemble, ERA5
history and a second-source cross-check), NOAA SWPC (Kp), Zippopotam.us and OpenStreetMap Nominatim (places).

## Use it

- **Desktop:** open `index.html`. It is one self-contained file.
- **Phone, same Wi-Fi:** `npm run serve`, then open `http://<your-computer-ip>:5173` on the phone.
- **Phone, anywhere:** put `index.html` (plus `manifest.webmanifest`, `sw.js` and the icons) on any static host, such as
  GitHub Pages or Netlify Drop. Over https the browser offers Add to Home Screen, the app caches itself for offline use,
  and the location button works.

## Develop

```bash
npm test          # 46 tests, no network
npm run build     # writes index.html
npm run live      # hits the real APIs for four zips
```

Open-Meteo's free tier is for personal, non-commercial use. See docs/spikes.md before publishing this more widely.
