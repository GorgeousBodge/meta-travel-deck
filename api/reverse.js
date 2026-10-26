// Nearest address for a position, used to suggest a name when saving "where I am".
// Street/house from openrouteservice (OpenStreetMap); postcode from postcodes.io (official ONS data, no key).
const { cleanKey, send, num, fetchT, allowed } = require('./_lib.js');

async function orsReverse(lat, lon, key) {
  if (!key) return null;
  const p = new URLSearchParams({ 'point.lat': String(lat), 'point.lon': String(lon), size: '3', layers: 'address,street,venue', 'boundary.country': 'GB' });
  const r = await fetchT('https://api.openrouteservice.org/geocode/reverse?' + p, { headers: { Authorization: key, Accept: 'application/json' } }, 8000);
  if (!r.ok) return null;
  const j = await r.json();
  const f = (j.features || [])[0];
  if (!f) return null;
  const pr = f.properties || {};
  return {
    layer: pr.layer,
    name: pr.name || '',
    housenumber: pr.housenumber || '',
    street: pr.street || (pr.layer === 'street' ? pr.name : ''),
    locality: pr.locality || pr.localadmin || '',
    distance: pr.distance != null ? Math.round(pr.distance * 1000) : null, // km -> m
  };
}

async function postcodeReverse(lat, lon) {
  const r = await fetchT(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1&radius=200`, {}, 8000);
  if (!r.ok) return null;
  const j = await r.json();
  const p = (j.result || [])[0];
  return p ? { postcode: p.postcode, area: p.admin_ward || p.admin_district || '' } : null;
}

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const lat = num(req.query.lat, -90, 90), lon = num(req.query.lon, -180, 180);
  if (lat === null || lon === null) return send(res, 400, { error: 'Missing location' });

  const [o, pc] = await Promise.allSettled([orsReverse(lat, lon, cleanKey(process.env.ORS_API_KEY)), postcodeReverse(lat, lon)]);
  const a = o.status === 'fulfilled' ? o.value : null;
  const p = pc.status === 'fulfilled' ? pc.value : null;

  let line = '';
  if (a) {
    if (a.layer === 'address' && a.housenumber && a.street && (a.distance == null || a.distance <= 25)) line = `${a.housenumber} ${a.street}`;
    else if (a.layer === 'venue' && a.name && (a.distance == null || a.distance <= 25)) line = a.name;
    else if (a.street) line = a.street;
    else if (a.name) line = a.name;
  }
  const suggestion = [line, p && p.postcode].filter(Boolean).join(', ') || 'Saved place';
  const sub = [line, a && a.locality, p && p.postcode].filter(Boolean).join(', ');
  send(res, 200, { suggestion, sub, postcode: p ? p.postcode : '', street: a ? a.street : '' });
};
