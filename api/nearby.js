// Nearby bus stops (with NaPTAN ATCO codes) and railway stations (with CRS codes).
// Main source: OpenStreetMap via Overpass (free, no key). Overpass is a busy public service and
// sometimes slow from cloud servers, so:
//   - the app snaps your position to a grid, so nearby requests share one cached answer (kept for a week);
//   - all mirrors are asked at once and the first good answer wins;
//   - for bus stops, if every mirror fails, TransportAPI's stop finder is used instead
//     (this uses 1 of your 30 free daily bus checks, and only happens when OpenStreetMap is down).
const { cleanKey, send, num, fetchT, allowed } = require('./_lib.js');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];
const WEEK = 7 * 86400;

async function overpass(query) {
  const tries = ENDPOINTS.map(async (url) => {
    const r = await fetchT(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NavDeck/1.0 (personal smart-glasses app)' },
      body: 'data=' + encodeURIComponent(query),
    }, 18000);
    if (!r.ok) throw new Error('Map data service busy (' + r.status + ')');
    const j = await r.json();
    if (!j || !Array.isArray(j.elements)) throw new Error('Map data service returned nothing');
    if (j.remark && /runtime error|timed out/i.test(j.remark) && !j.elements.length) throw new Error('Map data service busy');
    return j;
  });
  try {
    return await Promise.any(tries);
  } catch (e) {
    const errs = (e && e.errors) || [];
    const timedOut = errs.some((x) => /timed out/i.test(x.message || ''));
    throw new Error(timedOut ? 'OpenStreetMap lookup is slow right now' : 'OpenStreetMap lookup is busy right now');
  }
}

// Fallback for bus stops: TransportAPI's own stop finder
async function transportApiStops(lat, lon) {
  const appId = cleanKey(process.env.TRANSPORTAPI_APP_ID);
  const appKey = cleanKey(process.env.TRANSPORTAPI_APP_KEY);
  if (!appId || !appKey) return null;
  const url = `https://transportapi.com/v3/uk/places.json?lat=${lat}&lon=${lon}&type=bus_stop`;
  const r = await fetchT(url, { headers: { 'X-App-Id': appId, 'X-App-Key': appKey, Accept: 'application/json' } }, 10000);
  if (!r.ok) return null;
  const j = await r.json();
  const list = Array.isArray(j.member) ? j.member : Array.isArray(j.members) ? j.members : [];
  return list
    .filter((m) => m && m.atcocode && m.latitude != null && m.longitude != null)
    .map((m) => ({
      atco: String(m.atcocode),
      name: m.name || 'Bus stop',
      ind: m.indicator || '',
      bearing: m.bearing || '',
      lat: +m.latitude,
      lon: +m.longitude,
    }));
}

function busFromOsm(j) {
  const seen = new Set();
  const results = [];
  for (const el of j.elements || []) {
    const t = el.tags || {};
    const atco = t['naptan:AtcoCode'];
    if (!atco || seen.has(atco)) continue;
    seen.add(atco);
    results.push({
      atco,
      name: t.name || t['naptan:CommonName'] || 'Bus stop',
      ind: t['naptan:Indicator'] || t.local_ref || '',
      bearing: t['naptan:Bearing'] || '',
      lat: el.lat,
      lon: el.lon,
    });
  }
  return results;
}

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180);
  if (lat === null || lon === null) return send(res, 400, { error: 'Missing location' });
  const type = req.query.type === 'rail' ? 'rail' : 'bus';

  if (type === 'bus') {
    let osmError;
    try {
      // 900 m around the grid point covers everything within ~650 m of you
      const j = await overpass(`[out:json][timeout:15];
(
  node(around:900,${lat},${lon})["highway"="bus_stop"];
  node(around:900,${lat},${lon})["public_transport"="platform"]["bus"="yes"];
);
out body 150;`);
      return send(res, 200, { results: busFromOsm(j), source: 'osm' }, WEEK);
    } catch (e) { osmError = e; }

    try {
      const alt = await transportApiStops(lat, lon);
      if (alt && alt.length) return send(res, 200, { results: alt, source: 'transportapi' }, WEEK);
    } catch { /* fall through */ }
    return send(res, 502, { error: ((osmError && osmError.message) || 'Stop finder unavailable') + ' — try again in a moment' });
  }

  try {
    const j = await overpass(`[out:json][timeout:15];
nwr(around:25000,${lat},${lon})["railway"="station"]["ref:crs"];
out center;`);
    const seen = new Set();
    const results = [];
    for (const el of j.elements || []) {
      const t = el.tags || {};
      const crs = String(t['ref:crs'] || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(crs) || seen.has(crs)) continue;
      seen.add(crs);
      const la = el.lat ?? (el.center && el.center.lat), lo = el.lon ?? (el.center && el.center.lon);
      if (la == null || lo == null) continue;
      results.push({ crs, name: t.name || crs, lat: la, lon: lo });
    }
    const d2 = (s) => (s.lat - lat) ** 2 + ((s.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    results.sort((a, b) => d2(a) - d2(b));
    send(res, 200, { results: results.slice(0, 12) }, WEEK);
  } catch (e) {
    send(res, 502, { error: (e.message || 'Station finder unavailable') + ' — try again in a moment' });
  }
};
