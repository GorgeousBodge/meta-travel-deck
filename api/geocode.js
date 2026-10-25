// Place search: postcodes via postcodes.io (official ONS data, no key), everything else via
// openrouteservice (Pelias geocoder on OpenStreetMap). Searches all of Great Britain, nearest first.
const { cleanKey, send, num, fetchT, upstreamError, allowed } = require('./_lib.js');

// Full postcode anywhere in the text (e.g. "12 High St GU1 3AA"), or an outward code on its own ("GU1")
const FULL_PC = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const OUTWARD_ONLY = /^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*$/i;

async function postcodeLookup(text) {
  const full = text.match(FULL_PC);
  try {
    if (full) {
      const pc = (full[1] + ' ' + full[2]).toUpperCase();
      const r = await fetchT('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc), {}, 8000);
      if (!r.ok) return [];
      const j = await r.json();
      const p = j.result;
      if (!p || p.latitude == null) return [];
      const rest = text.replace(full[0], '').replace(/[,\s]+$/, '').trim();
      return [{
        name: rest ? `${rest}, ${p.postcode}` : p.postcode,
        sub: [p.admin_ward, p.admin_district].filter(Boolean).join(', ') + ' · postcode centre',
        lat: p.latitude,
        lon: p.longitude,
      }];
    }
    const out = text.match(OUTWARD_ONLY);
    if (out) {
      const oc = out[1].toUpperCase();
      const r = await fetchT('https://api.postcodes.io/outcodes/' + encodeURIComponent(oc), {}, 8000);
      if (!r.ok) return [];
      const j = await r.json();
      const p = j.result;
      if (!p || p.latitude == null) return [];
      return [{
        name: oc + ' area',
        sub: [].concat(p.admin_district || []).slice(0, 2).join(', ') + ' · area centre',
        lat: p.latitude,
        lon: p.longitude,
      }];
    }
  } catch { /* fall through to place search */ }
  return [];
}

async function placeSearch(text, lat, lon, key) {
  const p = new URLSearchParams({
    text,
    size: '8',
    'boundary.country': 'GB',
    'focus.point.lat': String(lat),
    'focus.point.lon': String(lon),
  });
  const r = await fetchT('https://api.openrouteservice.org/geocode/search?' + p, {
    headers: { Authorization: key, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(await upstreamError(r, 'openrouteservice'));
  const j = await r.json();
  return (j.features || [])
    .filter((f) => f.geometry && Array.isArray(f.geometry.coordinates))
    .map((f) => {
      const pr = f.properties || {};
      const isAddress = pr.layer === 'address';
      const sub = [
        !isAddress && pr.street && pr.name !== pr.street ? pr.street : '',
        pr.locality || pr.localadmin || pr.county,
        pr.postalcode,
        isAddress ? 'address' : pr.layer === 'street' ? 'street' : '',
      ].filter(Boolean).join(', ');
      return { name: pr.name || pr.label || 'Unnamed place', sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    });
}

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const key = cleanKey(process.env.ORS_API_KEY);
  const text = String(req.query.text || '').trim().slice(0, 120);
  if (text.length < 2) return send(res, 400, { error: 'Search text too short' });

  const lat = num(req.query.lat, -90, 90) ?? 51.2362;
  const lon = num(req.query.lon, -180, 180) ?? -0.5715;

  const [pcRes, placeRes] = await Promise.allSettled([
    postcodeLookup(text),
    key ? placeSearch(text, lat, lon, key) : Promise.reject(new Error('ORS_API_KEY is not set in Vercel')),
  ]);
  const pcs = pcRes.status === 'fulfilled' ? pcRes.value : [];
  const places = placeRes.status === 'fulfilled' ? placeRes.value : [];

  if (!pcs.length && placeRes.status === 'rejected') {
    return send(res, 502, { error: placeRes.reason.message || 'Search failed' });
  }
  // Postcode match first, then places (minus near-duplicates of it)
  const results = [...pcs, ...places.filter((p) => !pcs.some((q) => Math.abs(q.lat - p.lat) < 1e-4 && Math.abs(q.lon - p.lon) < 1e-4))];
  send(res, 200, { results: results.slice(0, 10) }, 3600);
};
