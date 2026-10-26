'use strict';
/* Street map: MapLibre GL + OpenFreeMap vector tiles (OpenStreetMap data, OpenMapTiles schema), no key needed.
   Restyled for an additive display: black ground (= see-through), roads as light, your route brightest.
   Loaded only when you first switch to it. If WebGL or the library is unavailable, the app falls back
   to the plain route-line view. */

const StreetMap = (() => {
  const LIB_JS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
  const LIB_CSS = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css';
  const OFM_STYLE = 'https://tiles.openfreemap.org/styles/dark';
  const FALLBACK = {
    source: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    font: ['Noto Sans Regular'],
    fontBold: ['Noto Sans Bold'],
  };

  let map = null, el = null, loading = null, failed = false, ready = false, lastMove = 0, onLost = null;
  let youMarker = null, destMarker = null, youEl = null;

  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const line = (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

  // Check for WebGL once and cache it. (Creating a test context on every check exhausts the
  // browser's small pool of contexts, and then the street map's own context gets killed.)
  let glChecked = null;
  function webgl() {
    if (glChecked !== null) return glChecked;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      glChecked = !!gl;
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();   // hand the test context straight back
    } catch { glChecked = false; }
    return glChecked;
  }

  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LIB_CSS;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LIB_JS;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Map library failed to load'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('Map library timed out')), 12000);
    });
  }

  // Read tile source + fonts from OpenFreeMap's own style so we don't depend on guessed URLs
  async function base() {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(OFM_STYLE, { signal: ctrl.signal });
      const j = await r.json();
      const src = Object.values(j.sources || {}).find((s) => s && s.type === 'vector');
      const fonts = [];
      for (const L of j.layers || []) {
        const f = L.layout && L.layout['text-font'];
        if (Array.isArray(f) && f.length && f.every((x) => typeof x === 'string')) fonts.push(f);
      }
      return {
        source: src || FALLBACK.source,
        glyphs: j.glyphs || FALLBACK.glyphs,
        font: fonts.find((f) => /regular/i.test(f[0])) || fonts[0] || FALLBACK.font,
        fontBold: fonts.find((f) => /bold/i.test(f[0])) || FALLBACK.fontBold,
      };
    } catch { return FALLBACK; }
  }

  function style(b) {
    const O = 'omt';
    const w = (a, z) => ['interpolate', ['exponential', 1.6], ['zoom'], 13, a, 18, z];
    const cls = (list) => ['in', ['get', 'class'], ['literal', list]];
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    const name = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
    const road = (id, classes, color, width, minzoom = 0) => ({
      id, type: 'line', source: O, 'source-layer': 'transportation', minzoom, filter: cls(classes), layout: round,
      paint: { 'line-color': color, 'line-width': width },
    });
    return {
      version: 8,
      glyphs: b.glyphs,
      sources: { [O]: b.source, done: { type: 'geojson', data: empty() }, route: { type: 'geojson', data: empty() } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#000' } },
        { id: 'water', type: 'fill', source: O, 'source-layer': 'water', paint: { 'fill-color': 'rgba(63,224,255,0.10)' } },
        { id: 'waterway', type: 'line', source: O, 'source-layer': 'waterway', paint: { 'line-color': 'rgba(63,224,255,0.28)', 'line-width': 1.2 } },
        { id: 'park', type: 'fill', source: O, 'source-layer': 'park', paint: { 'fill-color': 'rgba(89,242,165,0.06)' } },
        { id: 'building', type: 'line', source: O, 'source-layer': 'building', minzoom: 15, paint: { 'line-color': 'rgba(120,220,255,0.16)', 'line-width': 1 } },
        { id: 'rail', type: 'line', source: O, 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'],
          paint: { 'line-color': 'rgba(169,194,207,0.38)', 'line-width': 1.4, 'line-dasharray': [3, 3] } },
        road('path', ['path', 'track'], 'rgba(169,194,207,0.5)', w(0.8, 2.2), 14),
        road('minor', ['minor', 'service'], 'rgba(120,220,255,0.30)', w(1, 9)),
        road('mid', ['secondary', 'tertiary'], 'rgba(120,220,255,0.48)', w(1.5, 13)),
        road('major', ['primary', 'trunk', 'motorway'], 'rgba(185,240,255,0.60)', w(2, 16)),
        { id: 'done', type: 'line', source: 'done', layout: round, paint: { 'line-color': 'rgba(63,224,255,0.35)', 'line-width': 4 } },
        { id: 'route-glow', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#3fe0ff', 'line-width': 16, 'line-blur': 9, 'line-opacity': 0.45 } },
        { id: 'route', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#3fe0ff', 'line-width': 6 } },
        { id: 'street-names', type: 'symbol', source: O, 'source-layer': 'transportation_name', minzoom: 13,
          layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': b.font,
            'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 17], 'text-max-angle': 30, 'symbol-spacing': 240 },
          paint: { 'text-color': '#e8f7fd', 'text-halo-color': '#000', 'text-halo-width': 2.2 } },
        { id: 'places', type: 'symbol', source: O, 'source-layer': 'place',
          filter: cls(['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet']),
          layout: { 'text-field': name, 'text-font': b.fontBold, 'text-size': 14, 'text-transform': 'uppercase', 'text-letter-spacing': 0.14 },
          paint: { 'text-color': '#a9c2cf', 'text-halo-color': '#000', 'text-halo-width': 2 } },
      ],
    };
  }

  function youSvg(arrow) {
    return arrow
      ? '<svg viewBox="0 0 30 30"><path d="M15 2 26 27 15 21 4 27Z" fill="#f4fbff"/></svg>'
      : '<svg viewBox="0 0 30 30"><circle cx="15" cy="15" r="9" fill="none" stroke="#f4fbff" stroke-width="3"/></svg>';
  }

  // Put the (single, reused) map into a slot element. Resolves when the style has loaded.
  function mount(slot) {
    if (failed) return Promise.reject(new Error('Street map unavailable'));
    if (!webgl()) { failed = true; return Promise.reject(new Error('WebGL not available on this device')); }
    if (!el) { el = document.createElement('div'); el.className = 'street'; el.setAttribute('aria-hidden', 'true'); }
    slot.appendChild(el);
    if (map) { map.resize(); return loading; }
    loading = (async () => {
      await loadLib();
      const b = await base();
      map = new maplibregl.Map({
        container: el,
        style: style(b),
        center: [-0.5715, 51.2362],
        zoom: 16,
        interactive: false,          // the Neural Band drives the app, not the map
        attributionControl: false,   // attribution is shown as plain text instead (no extra focus stops)
        fadeDuration: 0,
        maxPitch: 0,
      });
      map.getCanvas().tabIndex = -1;
      map.on('webglcontextlost', () => { failed = true; ready = false; if (typeof onLost === 'function') onLost(); });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Street map timed out')), 12000);
        map.once('load', () => { clearTimeout(t); ready = true; resolve(); });
      });
    })().catch((e) => { failed = true; throw e; });
    return loading;
  }

  function setRoute(r) {
    if (!map || !map.getSource('route')) return;
    const coords = r.coords.map(([lat, lon]) => [lon, lat]);
    map.getSource('route').setData(line(coords));
    map.getSource('done').setData(empty());
    const last = coords[coords.length - 1];
    if (!destMarker) {
      const d = document.createElement('div');
      d.className = 'dest-marker';
      destMarker = new maplibregl.Marker({ element: d });
    }
    destMarker.setLngLat(last).addTo(map);
  }

  // Split the route at your current segment so the part behind you dims
  function setProgress(r, seg) {
    if (!map || !map.getSource('route') || seg == null) return;
    const coords = r.coords.map(([lat, lon]) => [lon, lat]);
    map.getSource('done').setData(seg > 0 ? line(coords.slice(0, seg + 2)) : empty());
    map.getSource('route').setData(line(coords.slice(seg)));
  }

  function fit(r) {
    if (!map) return;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const [lat, lon] of r.coords) { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
    map.fitBounds([[x0, y0], [x1, y1]], { padding: 28, bearing: 0, duration: 0, maxZoom: 17 });
    if (youMarker) youMarker.remove();
  }

  // Follow you, heading-up when a heading is known. You sit in the lower part of the view.
  function follow(pos, heading, zoom, force) {
    if (!map) return;
    const now = performance.now();
    if (!force && now - lastMove < 250) return;
    lastMove = now;
    const arrow = heading != null;
    if (!youMarker) {
      youEl = document.createElement('div');
      youEl.className = 'you-marker';
      youMarker = new maplibregl.Marker({ element: youEl });
    }
    youEl.innerHTML = youSvg(arrow);
    youMarker.setLngLat([pos.lon, pos.lat]).addTo(map);
    const h = el.clientHeight || 280;
    map.easeTo({
      center: [pos.lon, pos.lat],
      bearing: arrow ? heading : 0,
      zoom,
      padding: { top: Math.round(h * 0.5), bottom: 0, left: 0, right: 0 },
      duration: force ? 0 : 700,
    });
  }

  return {
    supported: () => !failed && webgl(),
    ready: () => ready,
    onContextLost: (fn) => { onLost = fn; },
    failed: () => failed,
    mount, setRoute, setProgress, fit, follow,
  };
})();
