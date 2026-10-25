// Walking / cycling directions via openrouteservice (OpenStreetMap)
const { cleanKey, send, num, fetchT, upstreamError, allowed } = require('./_lib.js');

const PROFILES = new Set(['foot-walking', 'cycling-regular']);

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const key = cleanKey(process.env.ORS_API_KEY);
  if (!key) return send(res, 500, { error: 'ORS_API_KEY is not set in Vercel' });

  const q = req.query;
  const flat = num(q.flat, -90, 90), flon = num(q.flon, -180, 180);
  const tlat = num(q.tlat, -90, 90), tlon = num(q.tlon, -180, 180);
  if ([flat, flon, tlat, tlon].some((v) => v === null)) return send(res, 400, { error: 'Missing or invalid coordinates' });
  const profile = PROFILES.has(q.mode) ? q.mode : 'foot-walking';

  try {
    const r = await fetchT(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json' },
      body: JSON.stringify({
        coordinates: [[flon, flat], [tlon, tlat]],
        instructions: true,
        units: 'm',
        language: 'en',
        geometry_simplify: false,
      }),
    }, 15000);
    if (!r.ok) return send(res, 502, { error: await upstreamError(r, 'openrouteservice') });
    const j = await r.json();
    const f = j.features && j.features[0];
    if (!f) return send(res, 404, { error: 'No route found' });

    const coords = f.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(6), +lon.toFixed(6)]);
    const steps = [];
    for (const seg of f.properties.segments || []) {
      for (const s of seg.steps || []) {
        steps.push({
          type: s.type,
          text: s.instruction,
          name: s.name && s.name !== '-' ? s.name : '',
          dist: Math.round(s.distance || 0),
          time: Math.round(s.duration || 0),
          from: s.way_points[0],
          to: s.way_points[1],
        });
      }
    }
    const sum = f.properties.summary || {};
    send(res, 200, {
      distance: Math.round(sum.distance || 0),
      duration: Math.round(sum.duration || 0),
      coords,
      steps,
    });
  } catch (e) {
    send(res, 502, { error: e.message || 'Routing failed' });
  }
};
