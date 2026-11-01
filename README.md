# Grandad's Compass

A family dashboard for keeping track of Grandad around Sahakarnagar, Bengaluru. It shows where he is on a live map and tracks a safe zone around home. It alerts the family if he leaves the zone, has a possible fall, or stops moving while out. It also builds a ready-to-send description for police or neighbours if he goes missing.

Location comes from an old phone sewn into his jacket.

## What's here

- `index.html`: the whole app (one static page, no build step). The street map is embedded in it.
- `manifest.webmanifest` and the icons let family members add it to their phone's home screen.
- `tools/build_map.py` regenerates the embedded street data from OpenStreetMap exports.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

The site is static, so Vercel serves it as-is. Import this repo at vercel.com/new and keep the default settings ("Other" framework, no build command). Every push to `main` redeploys.

## Add to a phone's home screen

- iPhone: open the site in Safari, tap Share, then "Add to Home Screen".
- Android: open the site in Chrome, tap the ⋮ menu, then "Add to Home screen".

Home location and settings are stored only in each person's browser.

Map data © OpenStreetMap contributors, available under the ODbL.
