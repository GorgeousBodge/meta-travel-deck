'use strict';
/* Demo mode: sample data generated on the glasses, so the app can be tried without an access code.
   Nothing here calls your server or uses your API keys. Open the app with ?demo to force it. */

const NavDemo = (() => {
  const START = { lat: 51.2369, lon: -0.5803 }; // Guildford station
  const R = Math.PI / 180;
  const metres = (a, b) => {
    const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * R) * 111320;
    const y = (b.lat - a.lat) * 110540;
    return Math.hypot(x, y);
  };

  const PLACES = [
    { name: 'Guildford Cathedral', sub: 'Stag Hill, Guildford', lat: 51.2421, lon: -0.5902 },
    { name: 'Guildford Castle', sub: 'Castle Street, Guildford', lat: 51.2346, lon: -0.5724 },
    { name: 'G Live', sub: 'London Road, Guildford', lat: 51.2393, lon: -0.5689 },
    { name: 'Stoke Park', sub: 'London Road, Guildford', lat: 51.2468, lon: -0.5641 },
  ];
  const STATIONS = [
    { crs: 'GLD', name: 'Guildford', lat: 51.2369, lon: -0.5803 },
    { crs: 'LRD', name: 'London Road (Guildford)', lat: 51.2466, lon: -0.5603 },
    { crs: 'WOK', name: 'Woking', lat: 51.3185, lon: -0.5569 },
  ];
  const STOPS = [
    { atco: 'DEMO00000001', name: 'Friary Bus Station', ind: 'Stand 4', bearing: 'N', lat: 51.2365, lon: -0.5772 },
    { atco: 'DEMO00000002', name: 'North Street', ind: 'Stop B', bearing: 'E', lat: 51.2371, lon: -0.5733 },
    { atco: 'DEMO00000003', name: 'Onslow Street', ind: 'Stop C', bearing: 'S', lat: 51.2360, lon: -0.5788 },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => {
    const s = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    return s.length === 5 ? s : pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const inMin = (m) => new Date(Date.now() + m * 60000);

  // Points every ~25 m between two places
  function leg(a, b) {
    const n = Math.max(1, Math.round(metres(a, b) / 25));
    const pts = [];
    for (let i = 1; i <= n; i++) pts.push([a.lat + ((b.lat - a.lat) * i) / n, a.lon + ((b.lon - a.lon) * i) / n]);
    return pts;
  }

  // An L-shaped route: east/west first, then north/south, with sensible turn instructions
  function route(p) {
    const from = { lat: +p.flat, lon: +p.flon }, to = { lat: +p.tlat, lon: +p.tlon };
    const corner = { lat: from.lat, lon: to.lon };
    const ew = to.lon >= from.lon ? 'east' : 'west';
    const ns = to.lat >= from.lat ? 'north' : 'south';
    const d1 = metres(from, corner), d2 = metres(corner, to);
    const coords = [[from.lat, from.lon]];
    const steps = [];
    if (d1 > 15) {
      coords.push(...leg(from, corner));
      steps.push({ type: 11, text: `Head ${ew} on Bridge Street`, dist: Math.round(d1), from: 0, to: coords.length - 1 });
    }
    if (d2 > 15) {
      const start = coords.length - 1;
      coords.push(...leg(start ? corner : from, to));
      const left = (ew === 'east') === (ns === 'north');
      steps.push(start
        ? { type: left ? 0 : 1, text: `Turn ${left ? 'left' : 'right'} onto North Street`, dist: Math.round(d2), from: start, to: coords.length - 1 }
        : { type: 11, text: `Head ${ns} on North Street`, dist: Math.round(d2), from: 0, to: coords.length - 1 });
    }
    if (coords.length < 2) coords.push([to.lat, to.lon]);
    const last = coords.length - 1;
    if (!steps.length) steps.push({ type: 11, text: 'Head to your destination', dist: Math.round(d1 + d2), from: 0, to: last });
    steps.push({ type: 10, text: 'Arrive at your destination', dist: 0, from: last, to: last });
    const distance = Math.round(d1 + d2);
    const speed = p.mode === 'cycling-regular' ? 4.5 : 1.35;
    return { distance, duration: Math.round(distance / speed), coords, steps };
  }

  function trains(crs) {
    const st = STATIONS.find((s) => s.crs === crs) || { crs, name: crs };
    const svc = (m, dest, op, plat, extra = {}) => ({ id: crs + m, std: hm(inMin(m)), etd: 'On time', plat, op, dest, canc: false, reason: '', calls: [], ...extra });
    return {
      crs: st.crs, name: st.name,
      messages: ['Demo mode: these are sample departures, not live times.'],
      services: [
        svc(4, 'London Waterloo via Woking', 'South Western Railway', '3', {
          calls: [{ n: 'Woking', st: hm(inMin(15)), et: 'On time' }, { n: 'Clapham Junction', st: hm(inMin(36)), et: 'On time' }, { n: 'London Waterloo', st: hm(inMin(44)), et: 'On time' }],
        }),
        svc(9, 'Reading', 'Great Western Railway', '', { etd: 'Cancelled', canc: true, reason: 'This train has been cancelled because of a fault on this train' }),
        svc(13, 'Gatwick Airport', 'Great Western Railway', '5', { etd: hm(inMin(19)), reason: 'This train has been delayed by a late running train' }),
        svc(21, 'Portsmouth Harbour', 'South Western Railway', '1', { calls: [{ n: 'Godalming', st: hm(inMin(28)), et: 'On time' }, { n: 'Haslemere', st: hm(inMin(39)), et: 'On time' }] }),
        svc(27, 'Ascot', 'South Western Railway', '8'),
      ],
    };
  }

  function buses(atco) {
    const s = STOPS.find((x) => x.atco === atco) || STOPS[0];
    const dep = (m, line, dest, op, live) => ({ line, dest, op, aimed: inMin(m).toISOString(), expected: live ? inMin(m + 1).toISOString() : '' });
    return {
      atco, name: s.name, refresh: 0,
      departures: [dep(2, '36', 'Merrow', 'Stagecoach', true), dep(8, '3', 'Onslow Village', 'Arriva', false), dep(14, '4', 'Park Barn', 'Stagecoach', true), dep(23, '26', 'Woking', 'Arriva', false)],
    };
  }

  function geocode(text) {
    const t = String(text || '').trim();
    const list = [...PLACES];
    if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(t)) list.unshift({ name: t.toUpperCase(), sub: 'Demo · postcode centre', lat: 51.2361, lon: -0.5715 });
    return { results: list };
  }

  async function api(path, params = {}) {
    await new Promise((r) => setTimeout(r, 250));
    switch (path) {
      case 'status': return { demo: true };
      case 'geocode': return geocode(params.text);
      case 'route': return route(params);
      case 'nearby': return { results: params.type === 'rail' ? STATIONS : STOPS };
      case 'trains': return trains(String(params.crs || 'GLD').toUpperCase());
      case 'buses': return buses(params.atco);
      default: throw new Error('Not available in demo mode');
    }
  }

  return { api, start: START };
})();
