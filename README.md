# Nav Deck (Meta Ray-Ban Display)

Walking and cycling directions on OpenStreetMap (openrouteservice) with a switchable street map, plus live train and bus departures anywhere in Great Britain.
Plain HTML/CSS/JS, no build step. Secrets live only in Vercel environment variables and are used only by `api/`.

## Files

| File | What it does |
|---|---|
| `index.html`, `app.js` | The app (browser). No keys in here. |
| `style.css` | Your shared deck style, unchanged. |
| `nav.css` | Nav-specific layout on top of it. |
| `streetmap.js` | Street map (MapLibre + OpenFreeMap, no key). Loads only when you switch to it. |
| `places.js` | Your saved places, stations and bus stops — edit freely. |
| `api/route.js` | Directions (openrouteservice) |
| `api/geocode.js` | Search: postcodes via postcodes.io (no key), places/streets/addresses via openrouteservice |
| `api/nearby.js` | Nearby bus stops and stations from OpenStreetMap (Overpass, no key) |
| `api/trains.js` | Live trains (National Rail Darwin via Rail Data Marketplace) |
| `api/buses.js` | Live buses (TransportAPI, which now runs Traveline NextBuses) |
| `api/status.js` | Setup check — shows which keys are set, never their values |
| `api/_lib.js` | Shared helpers (not a route) |

## Keys to get

1. **openrouteservice** — sign up at openrouteservice.org, copy the token from the dashboard. Free tier.
2. **Rail Data Marketplace** — sign up at raildata.org.uk, subscribe to **"Live Departure Board"** (the LDBWS one, not "Fastest"), copy the **Consumer key**. Free.
   If the product page shows a different endpoint from `https://api1.raildata.org.uk/1010-live-departure-board-dep/LDBWS/api/20220120/GetDepBoardWithDetails`, put that full URL (ending in `GetDepBoardWithDetails`, no station code) into `RAILDATA_DEPARTURES_URL`.
3. **TransportAPI** (runs Traveline NextBuses since May 2026) — register at developer.transportapi.com. You get an **app ID** and **app key**; those cover bus times. The free plan allows **30 requests a day**, so the bus screen only checks when you press REFRESH, and each stop is cached for 90 s. On a paid plan, set `BUS_REFRESH_SECONDS` (e.g. `60`) to turn on auto-refresh.

## Vercel environment variables

| Name | Value |
|---|---|
| `ORS_API_KEY` | openrouteservice token |
| `RAILDATA_API_KEY` | Rail Data Marketplace consumer key |
| `RAILDATA_DEPARTURES_URL` | optional — only if your product URL differs |
| `TRANSPORTAPI_APP_ID` | TransportAPI app ID |
| `TRANSPORTAPI_APP_KEY` | TransportAPI app key |
| `BUS_REFRESH_SECONDS` | optional — paid plans only, turns on bus auto-refresh |

The server strips anything that isn't a letter or number from keys. Open `/api/status` after deploying:
`strippedChars: true` means characters were removed — fine for stray spaces, but if that key then fails, it genuinely contains a symbol.

Redeploy after adding or changing variables.

## Using it

- **Navigate** → pick a saved/recent place, or select the search box to write or speak a place, street, address or postcode (full postcodes like `GU1 4AA`, or areas like `GU1`). WALK/CYCLE tabs pick the mode.
- **Preview** → START, swap mode, or SAVE the place.
- **Guidance** → next turn, distance, remaining, ETA, heading-up map. **MAP** cycles ROUTE (route line only) → STREET (street map with names) → WIDE (zoomed out). If the glasses can't run the street map, it says so and stays on ROUTE. VOICE speaks turns; HEAD UP uses the glasses' compass if available (otherwise your direction of travel). Goes off-route → reroutes automatically.
- **Trains / Buses** → nearest stations/stops by GPS, plus saved ones. Train boards refresh every 30 s; bus stops refresh when you press REFRESH (30 free checks a day). Pinch a train to see calling points. ★ saves it.
- **Back** is the system Back gesture or the HUD back button.

Map data © OpenStreetMap contributors. Train data: National Rail Enquiries. Bus data: Traveline NextBuses via TransportAPI.
