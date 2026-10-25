// Nearby bus stops (with NaPTAN ATCO codes) and railway stations (with CRS codes) from OpenStreetMap via Overpass.
// No key needed.
const { send, num, fetchT, allowed } = require('./_lib.js');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Ask all mirrors at once and take the first good answer, so one slow or busy server
// can't hold the app up (the whole lookup is capped at about 9 seconds).
async function overpass(query) {
  const tries = ENDPOINTS.map(async (url) => {
    const r = await fetchT(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'NavDeck/1.0 (personal smart-glasses app)' },
      body: 'data=' + encodeURIComponent(query),
    }, 9000);
    if (!r.ok) throw new Error('Map data service busy (' + r.status + ')');
    const j = await r.json();
    if (!j || !Array.isArray(j.elements)) throw new Error('Map data service returned nothing');
    return j;
  });
  try {
    return await Promise.any(tries);
  } catch (e) {
    const first = e && e.errors && e.errors[0];
    throw new Error((first && first.message) || 'Map data service unavailable — try again in a moment');
  }
}

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180);
  if (lat === null || lon === null) return send(res, 400, { error: 'Missing location' });
  const type = req.query.type === 'rail' ? 'rail' : 'bus';

  try {
    if (type === 'bus') {
      const j = await overpass(`[out:json][timeout:8];
(
  node(around:700,${lat},${lon})["highway"="bus_stop"];
  node(around:700,${lat},${lon})["public_transport"="platform"]["bus"="yes"];
);
out body 80;`);
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
      return send(res, 200, { results }, 86400);
    }

    const j = await overpass(`[out:json][timeout:8];
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
    send(res, 200, { results: results.slice(0, 8) }, 86400);
  } catch (e) {
    send(res, 502, { error: e.message || 'Nearby search failed' });
  }
};
