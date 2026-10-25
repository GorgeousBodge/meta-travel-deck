// Nearby bus stops (with NaPTAN ATCO codes) and railway stations (with CRS codes) from OpenStreetMap via Overpass.
// No key needed.
const { send, num, fetchT } = require('./_lib.js');

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(query) {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GlassesNav/1.0 (personal project)' },
        body: 'data=' + encodeURIComponent(query),
      }, 20000);
      if (r.ok) return await r.json();
      lastErr = new Error('Map data service busy (' + r.status + ')');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Map data service unavailable');
}

module.exports = async (req, res) => {
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180);
  if (lat === null || lon === null) return send(res, 400, { error: 'Missing location' });
  const type = req.query.type === 'rail' ? 'rail' : 'bus';

  try {
    if (type === 'bus') {
      const j = await overpass(`[out:json][timeout:20];
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

    const j = await overpass(`[out:json][timeout:20];
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
