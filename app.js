'use strict';
/* Nav Deck — walking/cycling directions with a street map, plus live trains and buses (Great Britain).
   Input: the browser's own spatial navigation (swipes = arrow keys, pinch = Enter -> click).
   Back: the system Back gesture or the HUD back button, both walk browser history (host limit: 5 entries). */

// ---------------------------------------------------------------- basics
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CFG = window.NAV_CONFIG || {};
const CENTRE = CFG.centre || { lat: 51.2362, lon: -0.5715 };

const MODES = {
  'foot-walking':    { label: 'WALK',  far: 80,  near: 20, view: 160, zStreet: 16.3, zWide: 15 },
  'cycling-regular': { label: 'CYCLE', far: 200, near: 40, view: 380, zStreet: 15.6, zWide: 14.2 },
};
const MAP_MODES = ['route', 'street', 'wide'];
const MAP_LABEL = { route: 'ROUTE', street: 'STREET', wide: 'WIDE' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('nav.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nav.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const S = {
  gen: 0,                 // bumps on every screen render so stale async results are dropped
  screen: 'home',
  mode: MODES[store.get('mode')] ? store.get('mode') : 'foot-walking',
  mapMode: MAP_MODES.includes(store.get('mapMode')) ? store.get('mapMode') : 'route',
  voice: store.get('voice', true),
  compass: false,
  pos: null,              // {lat, lon, acc, heading, speed, t}
  geoErr: false,
  course: null,           // heading derived from successive fixes
  headingCompass: null, headingT: 0,
  dest: null,             // {name, lat, lon}
  route: null,
  query: '', results: [], choices: [],
  timer: null, watch: null,
  expanded: new Set(),
  demo: /[?&]demo\b/.test(location.search),
  sim: null, simAlong: 0,
};

// ---------------------------------------------------------------- formatting
const fmtDist = (m) => {
  if (m == null || !isFinite(m)) return '--';
  if (m < 100) return Math.max(0, Math.round(m / 5) * 5) + ' m';
  if (m < 1000) return Math.round(m / 10) * 10 + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
};
const spokenDist = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' metres' : (m / 1000).toFixed(1) + ' kilometres');
const fmtDur = (s) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const hhmm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

let toastT;
function toast(msg, ms = 2600, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.classList.add('is-visible');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('is-visible'), ms);
}

// ---------------------------------------------------------------- speech
function say(text, lang = 'en-GB') {
  if (!S.voice || !text || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.onerror = (e) => { if (lang !== 'en-US' && e.error === 'synthesis-failed') say(text, 'en-US'); };
    speechSynthesis.speak(u);
  } catch { /* speech is optional */ }
}

// ---------------------------------------------------------------- server calls
// Access code (APP_CODE in Vercel). Open the app once as  https://…vercel.app/?code=YOURCODE
// and it's remembered on the glasses; or enter it on the lock screen.
(function captureCode() {
  try {
    const u = new URL(location.href);
    const c = u.searchParams.get('code') || u.searchParams.get('c');
    if (c) {
      store.set('code', c.trim());
      u.searchParams.delete('code'); u.searchParams.delete('c');
      history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch { /* ignore */ }
})();

async function api(path, params) {
  if (S.demo) return NavDemo.api(path, params || {});
  const q = new URLSearchParams(params || {});
  const code = store.get('code', '');
  if (code) q.set('c', code);
  const qs = q.toString();
  const url = '/api/' + path + (qs ? '?' + qs : '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.locked) {
      // No code on these glasses yet -> demo mode; a saved code that's wrong -> lock screen
      if (store.get('code', '')) showLock(j.error); else enterDemo();
      throw new Error(j.error);
    }
    if (!r.ok) throw new Error(j.error || 'Server error ' + r.status);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally { clearTimeout(t); }
}

function enterDemo() {
  if (S.demo) return;
  S.demo = true;
  S.route = null;
  S.pos = null;
  toast('Demo mode · sample data', 3500);
  updateGps();
  S.gen++;
  goHome();
}

function showLock(msg) {
  stopTimers();
  stopGuidance();
  S.gen++;               // drop whatever the current screen was waiting for
  S.screen = 'lock';
  setHeader('Locked', 'Access code');
  setHints([['Pinch', 'the box to write or speak the code']]);
  app.innerHTML = `<div class="state">
    <div class="state-title err">${esc(msg || 'Access code needed')}</div>
    <div class="state-msg">Enter the access code set as APP_CODE in Vercel. It's remembered on these glasses.</div>
    <label class="field-wrap" style="width:100%;max-width:460px">${icon('lock')}
      <input id="codeIn" class="field" type="text" placeholder="Access code" aria-label="Access code" autocomplete="off" spellcheck="false">
    </label>
    <div class="keys">
      ${key('saveCode', 'check', 'Unlock', { cls: 'key-speak' })}
      ${key('demoMode', 'resume', 'Try demo')}
    </div>
  </div>`;
  requestAnimationFrame(() => { const i = $('#codeIn'); if (i) i.focus(); });
}

// ---------------------------------------------------------------- location
function geoMsg(e) {
  if (!e) return 'Location unavailable';
  if (e.code === 1) return 'Location permission denied';
  if (e.code === 3) return 'Location timed out — is the phone connected?';
  return 'Location unavailable';
}
function toPos(p) {
  const c = p.coords;
  return { lat: c.latitude, lon: c.longitude, acc: c.accuracy, heading: c.heading, speed: c.speed, t: p.timestamp || Date.now() };
}
function setPos(p) {
  if (S.pos && haversine(S.pos, p) > Math.max(6, p.acc / 3)) S.course = bearing(S.pos, p);
  S.pos = p;
  S.geoErr = false;
  updateGps();
}
function locate() {
  if (S.demo) {
    if (!S.pos || !S.sim) setPos({ lat: NavDemo.start.lat, lon: NavDemo.start.lon, acc: 5, heading: null, speed: 0, t: Date.now() });
    return Promise.resolve(S.pos);
  }
  // Our own deadline: on the glasses the position comes from the paired phone and can hang
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not supported'));
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const fail = (msg) => {
      S.geoErr = true; updateGps();
      if (S.pos) { toast('Using last known position', 2500); finish(resolve, S.pos); }
      else finish(reject, new Error(msg));
    };
    const timer = setTimeout(() => fail('No location from your phone yet. Check the phone is nearby, connected, and location is on for the Meta AI app.'), 14000);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => { setPos(toPos(p)); finish(resolve, S.pos); },
        (e) => fail(geoMsg(e)),
        { timeout: 12000 },
      );
    } catch (e) { fail('Location unavailable'); }
  });
}
// Show which step a screen is waiting on
const stage = (msg) => { const t = app.querySelector('.state .state-title'); if (t) t.textContent = msg; };
async function getPos(maxAgeMs = 45000) {
  if (S.pos && Date.now() - S.pos.t < maxAgeMs) return S.pos;
  return locate();
}

// ---------------------------------------------------------------- HUD + hints
function setHeader(title, sub = '') {
  $('#title').textContent = title;
  $('#sub').textContent = sub;
  const depth = (history.state && history.state.depth) || 1;
  $('#back').hidden = depth <= 1;
}
function setHints(pairs) {
  $('#hints').innerHTML = pairs.map(([k, v]) => `<span><b>${esc(k)}</b>${esc(v)}</span>`).join('');
}
const HINTS = {
  home: [['Swipe', 'move'], ['Pinch', 'open']],
  list: [['Swipe', 'move'], ['Pinch', 'select'], ['Back', 'return']],
  guide: [['Map', 'route / street / wide'], ['Back', 'end']],
  board: [['Swipe', 'scroll'], ['Pinch', 'details'], ['Auto', '30 s']],
  bus: [['Swipe', 'scroll'], ['Refresh', 'when needed'], ['Back', 'return']],
};
function updateGps() {
  const el = $('#gps'), dot = $('#dot');
  if (S.demo) { el.textContent = 'DEMO'; dot.dataset.status = 'demo'; return; }
  if (!S.pos) {
    el.textContent = S.geoErr ? 'NO GPS' : 'GPS';
    dot.dataset.status = S.geoErr ? 'offline' : '';
    return;
  }
  const age = (Date.now() - S.pos.t) / 1000;
  const guiding = S.watch != null || S.sim != null;
  const acc = '±' + Math.round(S.pos.acc) + 'M';
  if (!guiding && age > 60) {
    // Not navigating, so no live tracking: the last fix is just old, not lost
    el.textContent = 'GPS'; dot.dataset.status = '';
  } else if (S.geoErr && age > 20) {
    el.textContent = 'GPS LOST'; dot.dataset.status = 'offline';
  } else if (age > 45) {
    // Standing still often means no new fixes; keep the last one, shown amber
    el.textContent = acc; dot.dataset.status = 'cached';
  } else {
    el.textContent = acc; dot.dataset.status = S.pos.acc > 50 ? 'cached' : 'live';
  }
}
function tick() { $('#clock').textContent = hhmm(new Date()); updateGps(); }
setInterval(tick, 10000);
tick();

// ---------------------------------------------------------------- icons (stroke icons, 24 grid, matching .ico)
const ICONS = {
  nav: '<path d="M12 2.5 19.5 21 12 16.5 4.5 21Z"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10.5h14M8 21l2-4M16 21l-2-4"/><circle cx="8.8" cy="13.8" r=".6"/><circle cx="15.2" cy="13.8" r=".6"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 10h16M7 21v-3M17 21v-3"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/>',
  locate: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  resume: '<path d="M7 4.5 19.5 12 7 19.5Z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  voice: '<path d="M4 9.5v5h4l5 4v-13l-5 4Z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  map: '<path d="M3 6.5 9 4l6 2.5 6-2.5v13.5L15 20l-6-2.5-6 2.5Z"/><path d="M9 4v13.5M15 6.5V20"/>',
  stop: '<path d="M6 6l12 12M18 6 6 18"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  go: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  retry: '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V9h-4.5"/>',
};
const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ''}</svg>`;

// Manoeuvre arrows (openrouteservice step types). 100x100 box, up = straight on.
function arrowSvg(type) {
  const angle = { 0: -90, 1: 90, 2: -135, 3: 135, 4: -45, 5: 45, 6: 0, 11: 0, 12: -30, 13: 30 }[type];
  let body;
  if (type === 10) {
    body = '<circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="9" fill="currentColor"/>';
  } else if (type === 7 || type === 8) {
    body = '<circle cx="50" cy="46" r="18"/><path d="M50 92V64M50 28V8M38 18 50 6 62 18"/>';
  } else if (type === 9) {
    body = '<path d="M34 92V44a16 16 0 0 1 32 0v18"/><path d="M52 50 66 64 80 50"/>';
  } else {
    const rad = ((angle ?? 0) * Math.PI) / 180;
    const ex = 50 + Math.sin(rad) * 36, ey = 46 - Math.cos(rad) * 36;
    const hx1 = ex - Math.sin(rad + 0.6) * 18, hy1 = ey + Math.cos(rad + 0.6) * 18;
    const hx2 = ex - Math.sin(rad - 0.6) * 18, hy2 = ey + Math.cos(rad - 0.6) * 18;
    body = `<path d="M50 94V46L${ex.toFixed(1)} ${ey.toFixed(1)}"/><path d="M${hx1.toFixed(1)} ${hy1.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${hx2.toFixed(1)} ${hy2.toFixed(1)}"/>`;
  }
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${body}</svg>`;
}

// ---------------------------------------------------------------- markup helpers (house classes)
const key = (act, ico, label, { cls = '', attrs = '' } = {}) =>
  `<button class="key focusable ${cls}" type="button" data-act="${act}" ${attrs}>${icon(ico)}<span class="key-label">${esc(label)}</span></button>`;
const tile = (act, ico, title, meta, { cls = '', attrs = '' } = {}) =>
  `<button class="card focusable tile ${cls}" type="button" data-act="${act}" ${attrs}>${icon(ico)}<span class="tile-title">${esc(title)}</span><span class="card-meta">${esc(meta)}</span></button>`;
const row = (act, ico, title, sub, side, { attrs = '', cls = '' } = {}) =>
  `<button class="card focusable row ${cls}" type="button" data-act="${act}" ${attrs}>${ico ? icon(ico) : ''}
    <span class="row-main"><span class="row-title">${esc(title)}</span>${sub ? `<span class="card-meta row-sub">${esc(sub)}</span>` : ''}</span>
    ${side ? `<span class="row-side">${esc(side)}</span>` : ''}</button>`;
const loading = (msg) => `<div class="state"><div class="spin"></div><div class="state-title">${esc(msg)}</div></div>`;
const errorView = (msg) => `<div class="state"><div class="state-title err">Link error</div><div class="state-msg">${esc(msg)}</div>
  ${key('retry', 'retry', 'Retry', { attrs: 'data-focus' })}</div>`;

// ---------------------------------------------------------------- navigation / history
function go(screen, params = {}, replace = false) {
  const cur = history.state && history.state.depth ? history.state.depth : 1;
  const st = { screen, params, depth: replace ? cur : cur + 1 };
  if (replace) history.replaceState(st, ''); else history.pushState(st, '');
  render(st);
}
function goHome() {
  const d = (history.state && history.state.depth) || 1;
  if (d > 1) history.go(-(d - 1)); else render({ screen: 'home', depth: 1 });
}
window.addEventListener('popstate', (e) => render(e.state || { screen: 'home', depth: 1 }));
$('#back').addEventListener('click', () => history.back());

function stopTimers() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

function render(st) {
  stopTimers();
  if (st.screen !== 'guide' && st.screen !== 'steps') stopGuidance();
  S.gen++;
  S.screen = st.screen;
  (SCREENS[st.screen] || home)(st.params || {});
}

function focusFirst() {
  requestAnimationFrame(() => {
    const el = app.querySelector('[data-focus]') || app.querySelector('.focusable:not([disabled]), input');
    if (el) el.focus();
  });
}

// Delegated activation: every control is a native <button>, so pinch -> Enter -> click.
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = ACTIONS[b.dataset.act];
  if (fn) fn(b.dataset, b);
});
// Press feedback, matching the other decks (observes Enter only; the browser still activates)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = document.activeElement;
  if (el && el.classList && el.classList.contains('focusable')) {
    el.classList.add('is-pressed');
    setTimeout(() => el.classList.remove('is-pressed'), 140);
  }
});

// ---------------------------------------------------------------- saved things
const savedPlaces = () => dedupe([...(CFG.places || []), ...store.get('saved', [])], (p) => p.name.toLowerCase());
const favStations = () => dedupe([...(CFG.stations || []), ...store.get('favStations', [])], (s) => s.crs);
const favStops = () => dedupe([...(CFG.stops || []), ...store.get('favStops', [])], (s) => s.atco);
function dedupe(arr, k) { const seen = new Set(); return arr.filter((x) => x && !seen.has(k(x)) && seen.add(k(x))); }
function toggleIn(storeKey, item, k) {
  const list = store.get(storeKey, []);
  const i = list.findIndex((x) => k(x) === k(item));
  if (i >= 0) list.splice(i, 1); else list.unshift(item);
  store.set(storeKey, list.slice(0, 20));
  return i < 0;
}

// ================================================================ SCREENS

function home() {
  setHeader('Nav', S.demo ? 'Demo' : 'Deck');
  setHints(HINTS.home);
  const resume = S.route && !S.route.arrived && S.dest;
  app.innerHTML = `<div class="home-grid">
    ${tile('goDest', 'nav', 'Navigate', MODES[S.mode].label + ' · OpenStreetMap', { attrs: 'data-focus' })}
    ${tile('goStations', 'train', 'Trains', 'Live departures')}
    ${tile('goStops', 'bus', 'Buses', 'Nearby stops')}
    ${resume
      ? tile('resume', 'resume', 'Resume', S.dest.name, { cls: 'is-on' })
      : S.demo
        ? tile('unlock', 'lock', 'Unlock', 'Demo mode · enter code', { cls: 'is-on' })
        : tile('locate', 'locate', 'Locate', S.pos ? '±' + Math.round(S.pos.acc) + ' m fix' : 'Get GPS fix')}
  </div>`;
  focusFirst();
}

// ---------------- destination picker
function dest() {
  setHeader('Destination', MODES[S.mode].label);
  setHints(HINTS.list);
  app.innerHTML = `
    <div class="dest-top">
      <label class="field-wrap">${icon('search')}
        <input id="q" class="field" type="search" placeholder="Place, street or postcode" aria-label="Search for a place, street or postcode" value="${esc(S.query)}" autocomplete="off">
      </label>
      <button class="key focusable clear-key" type="button" data-act="clearSearch" aria-label="Clear search" ${S.query ? '' : 'hidden'}>${icon('stop')}</button>
      <div class="tabs">${modeTab('foot-walking')}${modeTab('cycling-regular')}</div>
    </div>
    <div class="list" id="list"></div>`;
  fillDestList();
  const q = $('#q');
  let deb;
  const showClear = () => { const c = app.querySelector('.clear-key'); if (c) c.hidden = !q.value.trim(); };
  q.addEventListener('change', () => { clearTimeout(deb); showClear(); search(q.value); });
  q.addEventListener('input', () => { clearTimeout(deb); showClear(); deb = setTimeout(() => search(q.value), 800); });
  focusFirst();
}
const modeTab = (m) => `<button class="tab ${S.mode === m ? 'is-active' : ''}" type="button" aria-pressed="${S.mode === m}" data-act="setMode" data-mode="${m}">${MODES[m].label}</button>`;

function fillDestList(note) {
  const list = $('#list');
  if (!list) return;
  S.choices = [];
  let html = note ? `<div class="notice">${esc(note)}</div>` : '';
  let first = true;
  const section = (title, ico, items) => {
    if (!items.length) return;
    html += `<div class="sec">// ${esc(title)}</div>`;
    for (const p of items) {
      const d = S.pos ? fmtDist(haversine(S.pos, p)) : '';
      html += row('pickDest', ico, p.name, p.sub || '', d, { attrs: `data-i="${S.choices.length}" ${first ? 'data-focus' : ''}` });
      S.choices.push(p);
      first = false;
    }
  };
  section('Results', 'pin', S.results);
  section('Saved', 'star', savedPlaces());
  section('Recent', 'clock', store.get('recent', []).filter((r) => !savedPlaces().some((s) => s.name === r.name)));
  if (!S.choices.length && !note) html += '<div class="notice">Select the search box to write or speak a place, street or postcode.</div>';
  list.innerHTML = html;
}

let lastSearch = '';
async function search(text) {
  text = String(text || '').trim();
  if (text.length < 2 || text === lastSearch) return;
  lastSearch = text;
  S.query = text;
  const gen = S.gen;
  const list = $('#list');
  if (list) list.innerHTML = loading('Getting location');
  let bias = CENTRE;
  try { bias = await getPos(120000); } catch { /* search without GPS */ }
  if (gen !== S.gen) return;
  { const t = $('#list .state-title'); if (t) t.textContent = 'Searching'; }
  try {
    const j = await api('geocode', { text, lat: bias.lat.toFixed(4), lon: bias.lon.toFixed(4) });
    if (gen !== S.gen) return;
    S.results = j.results || [];
    fillDestList(S.results.length ? '' : `No matches for “${text}”`);
    const firstResult = app.querySelector('#list [data-act="pickDest"]');
    if (firstResult && S.results.length) firstResult.focus();
  } catch (e) {
    if (gen !== S.gen) return;
    lastSearch = '';
    fillDestList(e.message);
  }
}

// ---------------- shared map area (route-line canvas or street map)
const mapSlotHtml = () => `<div class="map-slot" id="mapSlot">
  <canvas class="route-canvas" id="map"></canvas>
  <span class="map-tag" id="mapTag">ROUTE</span>
  <span class="map-attr" id="mapAttr" hidden>OpenFreeMap © OpenMapTiles © OpenStreetMap</span></div>`;
const useStreet = () => S.mapMode !== 'route' && StreetMap.supported();
const streetZoom = () => (S.mapMode === 'wide' ? MODES[S.route.mode].zWide : MODES[S.route.mode].zStreet);

let mapToken = 0;
// If the graphics context is ever lost, drop back to the route view instead of freezing
StreetMap.onContextLost(() => {
  S.mapMode = 'route';
  store.set('mapMode', 'route');
  toast('Street map stopped — showing route view', 4000, true);
  updateMapKey();
  refreshMapView();
});
async function refreshMapView() {
  const slot = $('#mapSlot');
  if (!slot || !S.route) return;
  const token = ++mapToken;          // a newer switch cancels this one
  const gen = S.gen;
  const follow = S.screen === 'guide';
  const cv = $('#map'), tag = $('#mapTag'), attr = $('#mapAttr');
  if (useStreet()) {
    if (!StreetMap.ready()) {
      // Keep the route view on screen while the street map downloads and starts
      cv.hidden = false;
      drawMap({ follow });
      tag.textContent = 'LOADING STREET MAP…';
      slot.classList.add('street-loading');
    }
    try {
      await StreetMap.mount(slot);
    } catch (e) {
      if (token !== mapToken) return;
      slot.classList.remove('street-loading');
      S.mapMode = 'route';
      store.set('mapMode', 'route');
      toast('Street map unavailable — ' + e.message, 4500, true);
      updateMapKey();
      if (gen === S.gen) refreshMapView();
      return;
    }
    if (token !== mapToken || gen !== S.gen || !$('#mapSlot') || !useStreet()) return;
    slot.classList.remove('street-loading');
    cv.hidden = true;
    tag.textContent = S.mapMode === 'wide' ? 'STREET · WIDE' : 'STREET';
    attr.hidden = false;
    StreetMap.setRoute(S.route);
    if (follow && S.pos) drawStreet(true); else StreetMap.fit(S.route);
  } else {
    slot.classList.remove('street-loading');
    const street = slot.querySelector('.street');
    if (street) street.remove();
    cv.hidden = false;
    tag.textContent = 'ROUTE';
    attr.hidden = true;
    drawMap({ follow });
  }
}
function drawStreet(force) {
  const r = S.route;
  if (!r || !S.pos) return;
  StreetMap.setProgress(r, r.seg);
  StreetMap.follow(S.pos, currentHeading(), streetZoom(), force);
}
function updateMapKey() {
  const b = app.querySelector('[data-act="cycleMap"]');
  if (b) b.querySelector('.key-label').textContent = MAP_LABEL[S.mapMode];
}

// ---------------- route preview
async function preview() {
  setHeader('Route', S.dest ? S.dest.name : '');
  setHints(HINTS.list);
  if (!S.dest) return goHome();
  const gen = S.gen;
  app.innerHTML = loading('Getting location');
  try {
    const pos = await getPos();
    if (gen !== S.gen) return;
    stage('Plotting route');
    await fetchRoute(pos, S.dest);
    if (gen !== S.gen) return;
    renderPreview();
  } catch (e) {
    if (gen !== S.gen) return;
    app.innerHTML = errorView(e.message);
    focusFirst();
  }
}
function renderPreview() {
  const r = S.route;
  const other = S.mode === 'foot-walking' ? 'cycling-regular' : 'foot-walking';
  const isSaved = savedPlaces().some((p) => p.name === S.dest.name);
  app.innerHTML = `<div class="pv">
    <div><div class="pv-name">${esc(S.dest.name)}</div><div class="card-meta"><b>${MODES[r.mode].label}</b> · ${r.steps.length - 1} steps · openrouteservice</div></div>
    <div class="mid">
      ${mapSlotHtml()}
      <div class="stats">
        <div class="stat"><span class="card-meta">Dist</span><span class="stat-v">${fmtDist(r.distance)}</span></div>
        <div class="stat"><span class="card-meta">Time</span><span class="stat-v">${fmtDur(r.duration)}</span></div>
        <div class="stat"><span class="card-meta">Arrive</span><span class="stat-v">${hhmm(new Date(Date.now() + r.duration * 1000))}</span></div>
      </div>
    </div>
    <div class="keys k4">
      ${key('start', 'go', 'Start', { cls: 'key-speak', attrs: 'data-focus' })}
      ${key('swapMode', 'swap', MODES[other].label, { attrs: `data-mode="${other}"` })}
      ${key('cycleMap', 'map', MAP_LABEL[S.mapMode])}
      ${key('toggleSave', 'star', isSaved ? 'Saved' : 'Save', { cls: isSaved ? 'is-on' : '' })}
    </div>
  </div>`;
  requestAnimationFrame(refreshMapView);
  focusFirst();
}

async function fetchRoute(from, to) {
  const j = await api('route', {
    flat: from.lat.toFixed(6), flon: from.lon.toFixed(6),
    tlat: to.lat.toFixed(6), tlon: to.lon.toFixed(6), mode: S.mode,
  });
  S.route = prepRoute(j, S.mode);
  return S.route;
}

// Local flat projection (metres) is plenty accurate at walking/cycling scale
function prepRoute(j, mode) {
  const r = { ...j, mode, ann: {}, along: 0, offCount: 0, lastReroute: 0, arrived: false };
  const lat0 = (j.coords[0][0] * Math.PI) / 180;
  r.kx = 111320 * Math.cos(lat0);
  r.ky = 110540;
  r.xy = j.coords.map(([lat, lon]) => [lon * r.kx, lat * r.ky]);
  r.cum = [0];
  for (let i = 1; i < r.xy.length; i++) r.cum[i] = r.cum[i - 1] + Math.hypot(r.xy[i][0] - r.xy[i - 1][0], r.xy[i][1] - r.xy[i - 1][1]);
  r.total = r.cum[r.cum.length - 1] || j.distance || 0;
  return r;
}
const toXY = (r, p) => [p.lon * r.kx, p.lat * r.ky];

function project(r, p) {
  const P = toXY(r, p);
  let best = null, fwd = null;
  for (let i = 0; i < r.xy.length - 1; i++) {
    const A = r.xy[i], B = r.xy[i + 1];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
    const along = r.cum[i] + t * Math.sqrt(L2);
    const c = { d, i, along };
    if (!best || d < best.d) best = c;
    if (along >= r.along - 25 && (!fwd || d < fwd.d)) fwd = c;
  }
  // Prefer continuing forward when a route doubles back on itself
  return fwd && fwd.d < best.d + 15 ? fwd : best;
}
function stepAt(r, segIdx) {
  for (let k = 0; k < r.steps.length; k++) {
    const s = r.steps[k];
    if (segIdx >= s.from && segIdx < s.to) return k;
  }
  return Math.max(0, r.steps.length - 2);
}

// ---------------- guidance
function guide() {
  const r = S.route;
  if (!r || !S.dest) return goHome();
  setHeader('Guidance', S.dest.name);
  setHints(HINTS.guide);
  if (r.arrived) return renderArrived();
  app.innerHTML = `<div class="gd">
    <div class="man" id="man">
      <div class="man-icon" id="manIcon">${arrowSvg(r.steps[0] ? r.steps[0].type : 11)}</div>
      <div class="man-text"><div class="man-dist" id="manDist">--</div><div class="man-inst" id="manInst">${esc(r.steps[0] ? r.steps[0].text : 'Acquiring position')}</div></div>
    </div>
    <div class="mid">
      ${mapSlotHtml()}
      <div class="stats">
        <div class="stat"><span class="card-meta">Left</span><span class="stat-v" id="sLeft">${fmtDist(r.total)}</span></div>
        <div class="stat"><span class="card-meta">ETA</span><span class="stat-v" id="sEta">--</span></div>
        <div class="stat"><span class="card-meta">Then</span><span class="stat-v small" id="sThen">--</span></div>
      </div>
    </div>
    <div class="keys k5">
      ${key('openSteps', 'list', 'Steps', { attrs: 'data-focus' })}
      ${key('toggleVoice', 'voice', 'Voice', { cls: S.voice ? 'is-on' : '', attrs: `aria-pressed="${S.voice}"` })}
      ${key('toggleCompass', 'compass', 'Head up', { cls: S.compass ? 'is-on' : '', attrs: `aria-pressed="${S.compass}"` })}
      ${key('cycleMap', 'map', MAP_LABEL[S.mapMode])}
      ${key('endRoute', 'stop', 'End', { cls: 'is-warn' })}
    </div>
  </div>`;
  startGuidance();
  requestAnimationFrame(refreshMapView);
  updateGuide();
  focusFirst();
}

// Demo: walk (or ride) along the route at a few times real speed
function startSim() {
  if (S.sim) return;
  const r = S.route;
  S.simAlong = r.along || 0;
  S.sim = setInterval(() => {
    const rr = S.route;
    if (!rr || rr.arrived) { clearInterval(S.sim); S.sim = null; return; }
    S.simAlong = Math.min(rr.total, S.simAlong + (rr.mode === 'cycling-regular' ? 16 : 8));
    let i = 0;
    while (i < rr.cum.length - 2 && rr.cum[i + 1] < S.simAlong) i++;
    const seg = rr.cum[i + 1] - rr.cum[i] || 1;
    const t = Math.min(1, (S.simAlong - rr.cum[i]) / seg);
    const a = rr.coords[i], b = rr.coords[Math.min(i + 1, rr.coords.length - 1)];
    const p = { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t };
    setPos({ ...p, acc: 5, heading: bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }), speed: 4, t: Date.now() });
    progress();
  }, 1000);
}

function startGuidance() {
  if (S.demo) return startSim();
  if (S.watch != null || !navigator.geolocation) return;
  // Back-up: if the live feed goes quiet, ask the phone directly every few seconds
  S.poll = setInterval(() => {
    if (S.polling || (S.pos && Date.now() - S.pos.t < 6000)) return;
    S.polling = true;
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => { S.polling = false; setPos(toPos(p)); progress(); },
        () => { S.polling = false; },
        { timeout: 8000 },
      );
    } catch { S.polling = false; }
  }, 5000);
  S.watch = navigator.geolocation.watchPosition(
    (p) => { setPos(toPos(p)); progress(); },
    (e) => {
      // Only complain if we've genuinely had no fix for a while (watch errors can be transient)
      if (!S.pos || Date.now() - S.pos.t > 20000) {
        S.geoErr = true; updateGps();
        if (Date.now() - (S.geoToastT || 0) > 30000) { S.geoToastT = Date.now(); toast(geoMsg(e), 3000, true); }
      }
    },
    { enableHighAccuracy: true },
  );
}
function stopGuidance() {
  if (S.watch != null) { navigator.geolocation.clearWatch(S.watch); S.watch = null; }
  if (S.sim) { clearInterval(S.sim); S.sim = null; }
  if (S.poll) { clearInterval(S.poll); S.poll = null; S.polling = false; }
  stopCompass();
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch { /* ignore */ }
}

function progress() {
  const r = S.route, p = S.pos;
  if (!r || !p || r.arrived || r.busy) return;
  const pr = project(r, p);
  r.along = pr.along;
  r.seg = pr.i;
  r.off = pr.d;
  const remaining = Math.max(0, r.total - pr.along);

  if (remaining < 20 || haversine(p, S.dest) < 20) return arrive();

  const offLimit = Math.max(35, (p.acc || 0) * 0.8);
  r.offCount = pr.d > offLimit ? r.offCount + 1 : 0;
  if (r.offCount >= 3 && Date.now() - r.lastReroute > 20000) { reroute(); return; }

  const k = stepAt(r, pr.i);
  const next = r.steps[k + 1];
  const distNext = r.cum[Math.min(r.steps[k].to, r.cum.length - 1)] - pr.along;
  r.view = { k, next, distNext, remaining };

  if (next) {
    const m = MODES[r.mode];
    const kk = k + 1;
    if (distNext <= m.near && !r.ann[kk + 'n']) {
      r.ann[kk + 'n'] = r.ann[kk + 'f'] = true;
      say(next.type === 10 ? 'You are arriving at your destination' : next.text);
    } else if (distNext <= m.far && distNext > m.near + 15 && !r.ann[kk + 'f']) {
      r.ann[kk + 'f'] = true;
      say('In ' + spokenDist(distNext) + ', ' + lowerFirst(next.text));
    }
  }
  updateGuide();
}

async function reroute() {
  const r = S.route;
  r.lastReroute = Date.now();
  r.busy = true;
  toast('Off route · rerouting');
  say('Rerouting');
  try {
    await fetchRoute(S.pos, S.dest);
    if (S.screen === 'guide') {
      if (useStreet()) StreetMap.setRoute(S.route);
      updateGuide();
    }
  } catch (e) {
    r.busy = false;
    toast('Reroute failed', 3000, true);
  }
}

function updateGuide() {
  if (S.screen !== 'guide') return;
  const r = S.route, v = r && r.view;
  const man = $('#man');
  if (!man) return;
  if (!v && !S.pos) {
    $('#manDist').textContent = '--';
    $('#manInst').textContent = 'Waiting for GPS from your phone…';
  }
  if (v) {
    const next = v.next;
    const off = r.offCount > 0;
    man.classList.toggle('off', off);
    $('#manIcon').innerHTML = arrowSvg(next ? next.type : 10);
    $('#manDist').textContent = fmtDist(v.distNext);
    $('#manInst').textContent = (off ? 'Off route · ' : '') + (next ? next.text : 'Arrive at destination');
    $('#sLeft').textContent = fmtDist(v.remaining);
    const secs = r.total ? (r.duration * v.remaining) / r.total : 0;
    $('#sEta').textContent = hhmm(new Date(Date.now() + secs * 1000));
    const then = r.steps[v.k + 2];
    $('#sThen').textContent = then ? then.text : '—';
  }
  scheduleDraw();
}

let drawPending = false;
function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    if (S.screen !== 'guide') return;
    if (useStreet() && StreetMap.ready()) drawStreet(false); else drawMap({ follow: true });
  });
}

function currentHeading() {
  if (S.compass && S.headingCompass != null && performance.now() - S.headingT < 2500) return S.headingCompass;
  const p = S.pos;
  if (p && p.heading != null && isFinite(p.heading) && (p.speed || 0) > 0.7) return p.heading;
  return S.course; // may be null -> north up
}

function arrive() {
  S.route.arrived = true;
  stopGuidance();
  S.voice && say('You have arrived');
  renderArrived();
}
function renderArrived() {
  setHeader('Arrived', S.dest ? S.dest.name : '');
  setHints(HINTS.list);
  app.innerHTML = `<div class="state">
    <div class="arrive-big">Arrived</div>
    <div class="state-msg">${esc(S.dest ? S.dest.name : '')}</div>
    <div class="keys">
      ${key('done', 'check', 'Done', { attrs: 'data-focus' })}
      ${key('goStops', 'bus', 'Buses here')}
    </div></div>`;
  focusFirst();
}

// ---------------- steps list
function steps() {
  setHeader('Steps', S.dest ? S.dest.name : '');
  setHints(HINTS.list);
  const r = S.route;
  if (!r) return goHome();
  const cur = r.view ? r.view.k + 1 : 0;
  const rows = r.steps.map((s, k) => {
    const cls = k === cur ? 'is-on' : k < cur ? 'is-done' : '';
    return `<button class="card focusable row ${cls}" type="button" data-act="noop" ${k === cur ? 'data-focus' : ''}>
      <span class="step-ico">${arrowSvg(s.type)}</span>
      <span class="row-main"><span class="row-title wrap">${esc(s.text)}</span></span>
      <span class="row-side">${s.dist ? fmtDist(s.dist) : ''}</span></button>`;
  }).join('');
  app.innerHTML = `<div class="list">${rows}</div>`;
  focusFirst();
}

// ---------------- route-line canvas (fallback / ROUTE mode) — vector only, black stays see-through
let colours;
function cssColours() {
  if (colours) return colours;
  const cs = getComputedStyle(document.documentElement);
  const g = (n, d) => (cs.getPropertyValue(n) || d).trim() || d;
  colours = { accent: g('--accent', '#3fe0ff'), line: g('--line', 'rgba(120,220,255,.3)'), amber: g('--amber', '#ffc24a'), text: g('--text', '#f4fbff'), dim: g('--dim', '#a9c2cf') };
  return colours;
}

function drawMap({ follow }) {
  const cv = $('#map');
  const r = S.route;
  if (!cv || cv.hidden || !r || !r.xy.length) return;
  const C = cssColours();
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  let cx, cy, scale, rot = 0, ox = w / 2, oy = h / 2;
  const hasPos = follow && S.pos;
  const heading = hasPos ? currentHeading() : null;
  if (hasPos) {
    [cx, cy] = toXY(r, S.pos);
    scale = (h * 0.6) / MODES[r.mode].view;
    if (heading != null) rot = (heading * Math.PI) / 180;
    oy = h * 0.66;
  } else {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r.xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
    scale = Math.min((w - 36) / Math.max(1, x1 - x0), (h - 36) / Math.max(1, y1 - y0));
  }
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const T = (X, Y) => {
    const dx = (X - cx) * scale, dy = -(Y - cy) * scale;
    return [ox + dx * c - dy * s, oy + dx * s + dy * c];
  };

  if (hasPos) {
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (const m of [MODES[r.mode].view / 2, MODES[r.mode].view]) { ctx.beginPath(); ctx.arc(ox, oy, m * scale, 0, Math.PI * 2); ctx.stroke(); }
    const nx = ox + Math.sin(-rot) * (h * 0.3), ny = oy - Math.cos(-rot) * (h * 0.3);
    ctx.fillStyle = C.dim; ctx.font = '700 13px "Chakra Petch", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
  }

  const path = (from, to) => {
    ctx.beginPath();
    for (let i = from; i <= to; i++) { const [x, y] = T(r.xy[i][0], r.xy[i][1]); i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const split = hasPos && r.seg != null ? r.seg : 0;
  if (split > 0) { path(0, Math.min(split + 1, r.xy.length - 1)); ctx.strokeStyle = C.line; ctx.lineWidth = 3; ctx.stroke(); }
  path(split, r.xy.length - 1);
  ctx.strokeStyle = C.accent; ctx.lineWidth = hasPos ? 6 : 4; ctx.shadowColor = C.accent; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;

  if (hasPos && r.view && r.view.next) {
    const p = r.xy[r.steps[r.view.k].to];
    if (p) { const [x, y] = T(p[0], p[1]); ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); }
  }
  const last = r.xy[r.xy.length - 1];
  const [dx, dy] = T(last[0], last[1]);
  ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(dx, dy, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(dx, dy, 3, 0, Math.PI * 2); ctx.fillStyle = C.amber; ctx.fill();
  if (!hasPos) { const [sx, sy] = T(r.xy[0][0], r.xy[0][1]); ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill(); }

  if (hasPos) {
    ctx.save();
    ctx.translate(ox, oy);
    if (heading == null) {
      ctx.strokeStyle = C.text; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = C.text; ctx.shadowColor = C.accent; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(10, 11); ctx.lineTo(0, 5); ctx.lineTo(-10, 11); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------- compass (head direction from the glasses' own sensors)
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
  else if ((e.absolute === true || e.type === 'deviceorientationabsolute') && typeof e.alpha === 'number' && isFinite(e.alpha)) h = (360 - e.alpha) % 360;
  if (h == null) return;
  S.headingCompass = h;
  S.headingT = performance.now();
  scheduleDraw();
}
let compassOn = false;
function startCompass() {
  if (compassOn) return;
  window.addEventListener('deviceorientationabsolute', onOrient);
  window.addEventListener('deviceorientation', onOrient);
  compassOn = true;
}
function stopCompass() {
  if (!compassOn) return;
  window.removeEventListener('deviceorientationabsolute', onOrient);
  window.removeEventListener('deviceorientation', onOrient);
  compassOn = false;
}
async function requestCompass() {
  const O = window.DeviceOrientationEvent, M = window.DeviceMotionEvent;
  if (!O && !M) return false;
  const owner = O && typeof O.requestPermission === 'function' ? O : M && typeof M.requestPermission === 'function' ? M : null;
  try { if (owner && (await owner.requestPermission()) !== 'granted') return false; } catch { return false; }
  startCompass();
  return true;
}

// ---------------- trains
async function stations() {
  setHeader('Trains', 'Stations');
  setHints(HINTS.list);
  const gen = S.gen;
  app.innerHTML = loading('Getting location');
  let near = [], note = '';
  try {
    const pos = await getPos();
    if (gen !== S.gen) return;
    stage('Finding stations');
    const j = await api('nearby', { type: 'rail', lat: pos.lat.toFixed(3), lon: pos.lon.toFixed(3) });
    near = (j.results || []).map((s) => ({ ...s, dist: haversine(pos, s) })).sort((a, b) => a.dist - b.dist);
  } catch (e) { note = e.message; }
  if (gen !== S.gen) return;
  const r = (s, focus) => row('openBoard', 'train', s.name, s.crs, s.dist != null ? fmtDist(s.dist) : '',
    { attrs: `data-crs="${esc(s.crs)}" data-name="${esc(s.name)}" ${focus ? 'data-focus' : ''}` });
  let html = '';
  if (near.length) html += '<div class="sec">// Nearest</div>' + near.map((s, i) => r(s, i === 0)).join('');
  if (note) html += `<div class="notice">${esc(note)}</div>`;
  const favOnly = favStations().filter((f) => !near.some((n) => n.crs === f.crs));
  if (favOnly.length) html += '<div class="sec">// Saved</div>' + favOnly.map((s, i) => r(s, !near.length && i === 0)).join('');
  app.innerHTML = `<div class="list">${html || '<div class="notice">No stations found.</div>'}</div>`;
  focusFirst();
}

function board({ crs, name }) {
  setHeader(crs || 'Board', 'Departures');
  setHints(HINTS.board);
  if (!crs) return goHome();
  S.expanded = new Set();
  app.innerHTML = loading('Reading departures');
  const gen = S.gen;
  const load = async (quiet) => {
    try {
      const j = await api('trains', { crs });
      if (gen !== S.gen) return;
      renderBoard(j, name, quiet);
    } catch (e) {
      if (gen !== S.gen) return;
      if (quiet) toast('Update failed', 2600, true);
      else { app.innerHTML = errorView(e.message); focusFirst(); }
    }
  };
  load(false);
  S.timer = setInterval(() => load(true), 30000);
}

function trainStatus(s) {
  if (s.canc) return ['canc', 'CANC'];
  const etd = (s.etd || '').trim();
  if (/^on time$/i.test(etd)) return ['ok', 'ON TIME'];
  if (/^\d\d:\d\d$/.test(etd)) return ['late', 'EXP ' + etd];
  if (/delayed/i.test(etd)) return ['late', 'DELAYED'];
  return ['ok', etd.toUpperCase() || '—'];
}

function renderBoard(j, name, quiet) {
  const focusedKey = quiet && document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  const isFav = favStations().some((f) => f.crs === j.crs);
  const msgs = (j.messages || []).filter(Boolean);
  const rows = (j.services || []).map((s, i) => {
    const [cls, txt] = trainStatus(s);
    const k = s.id || String(i);
    const open = S.expanded.has(k);
    const callsHtml = s.calls && s.calls.length ? s.calls.map((c) => `<b>${esc(c.n)}</b> ${esc(c.et && c.et !== 'On time' ? c.et : c.st)}`).join(' · ') : '';
    const extra = open && (callsHtml || s.reason) ? `<div class="calls">${callsHtml}${callsHtml && s.reason ? '<br>' : ''}${esc(s.reason || '')}</div>` : '';
    const sub = [s.plat ? 'Plat ' + s.plat : '', s.bus ? 'Replacement bus' : s.op].filter(Boolean).join(' · ');
    return `<button class="card focusable dep ${s.canc ? 'cancelled' : ''}" type="button" data-act="toggleCalls" data-k="${esc(k)}" ${i === 0 ? 'data-focus' : ''}>
      <span class="dep-time">${esc(s.std)}</span>
      <span class="dep-main"><span class="dep-dest">${esc(s.dest)}</span><span class="card-meta dep-sub">${esc(sub)}</span></span>
      <span class="dep-st ${cls}">${txt}</span></button>${extra}`;
  }).join('');
  setHeader(j.crs || 'Trains', 'Departures');
  app.innerHTML = `
    <div class="bh"><div class="bh-main"><div class="bh-name">${esc(j.name || name)}</div><div class="card-meta">Updated <b>${hhmm(new Date())}</b></div></div>
      ${key('favStation', 'star', isFav ? 'Saved' : 'Save', { cls: isFav ? 'is-on' : '', attrs: `data-crs="${esc(j.crs)}" data-name="${esc(j.name || name)}" aria-pressed="${isFav}"` })}</div>
    <div class="list">
      ${msgs.length ? `<button class="card focusable card-brief msg" type="button" data-act="toggleMsg"><span class="msg-text">${esc(msgs.join(' · '))}</span></button>` : ''}
      ${rows || '<div class="notice">No departures in the next two hours.</div>'}
    </div>`;
  S.lastBoard = j;
  if (focusedKey) {
    const el = app.querySelector(`[data-k="${CSS.escape(focusedKey)}"]`);
    if (el) { el.focus(); return; }
  }
  if (!quiet) focusFirst();
}

// ---------------- buses
const stopName = (s) => (s.ind ? `${s.name} (${s.ind})` : s.name);
async function stops() {
  setHeader('Buses', 'Stops');
  setHints(HINTS.list);
  const gen = S.gen;
  app.innerHTML = loading('Getting location');
  let near = [], note = '';
  try {
    const pos = await getPos();
    if (gen !== S.gen) return;
    stage('Finding stops');
    const j = await api('nearby', { type: 'bus', lat: pos.lat.toFixed(4), lon: pos.lon.toFixed(4) });
    near = (j.results || []).map((s) => ({ ...s, dist: haversine(pos, s) })).sort((a, b) => a.dist - b.dist).slice(0, 10);
  } catch (e) { note = e.message; }
  if (gen !== S.gen) return;
  const r = (s, focus) => row('openStop', 'bus', s.name, [s.ind, s.bearing ? 'Heading ' + s.bearing : ''].filter(Boolean).join(' · '),
    s.dist != null ? fmtDist(s.dist) : '', { attrs: `data-atco="${esc(s.atco)}" data-name="${esc(stopName(s))}" ${focus ? 'data-focus' : ''}` });
  let html = '';
  if (near.length) html += '<div class="sec">// Nearest</div>' + near.map((s, i) => r(s, i === 0)).join('');
  if (note) html += `<div class="notice">${esc(note)}</div>`;
  const favOnly = favStops().filter((f) => !near.some((n) => n.atco === f.atco));
  if (favOnly.length) html += '<div class="sec">// Saved</div>' + favOnly.map((s, i) => r(s, !near.length && i === 0)).join('');
  app.innerHTML = `<div class="list">${html || '<div class="notice">No stops found nearby.</div>'}</div>`;
  focusFirst();
}

function stop({ atco, name }) {
  setHeader('Buses', 'Departures');
  setHints(HINTS.bus);
  if (!atco) return goHome();
  app.innerHTML = loading('Reading departures');
  const gen = S.gen;
  const load = async (quiet) => {
    try {
      const j = await api('buses', { atco });
      if (gen !== S.gen) return;
      renderStop(j, atco, name, quiet);
      // Free plan (30/day): only auto-refresh if the server says a paid plan allows it
      if (!S.timer && j.refresh > 0) S.timer = setInterval(() => load(true), Math.max(30, j.refresh) * 1000);
    } catch (e) {
      if (gen !== S.gen) return;
      if (quiet) toast(e.message, 3500, true);
      else { app.innerHTML = errorView(e.message); focusFirst(); }
    }
  };
  S.reloadStop = () => load(true);
  load(false);
}

function busDue(d) {
  const t = new Date(d.expected || d.aimed);
  if (isNaN(t)) return '—';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'DUE';
  if (mins <= 30) return mins + ' MIN';
  return hhmm(t);
}

function renderStop(j, atco, name, quiet) {
  const focusedKey = quiet && document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  const isFav = favStops().some((f) => f.atco === atco);
  const rows = (j.departures || []).map((d, i) => {
    const k = d.line + '|' + d.aimed;
    return `<button class="card focusable dep" type="button" data-act="noop" data-k="${esc(k)}" ${i === 0 ? 'data-focus' : ''}>
      <span class="line-badge">${esc(d.line)}</span>
      <span class="dep-main"><span class="dep-dest">${esc(d.dest)}</span>${d.op ? `<span class="card-meta dep-sub">${esc(d.op)}</span>` : ''}</span>
      <span class="dep-st ${d.expected ? 'live' : 'sched'}">${busDue(d)}${d.expected ? '' : '<small>SCHED</small>'}</span></button>`;
  }).join('');
  app.innerHTML = `
    <div class="bh"><div class="bh-main"><div class="bh-name">${esc(name || atco)}</div><div class="card-meta">Updated <b>${hhmm(new Date())}</b></div></div>
      ${key('refreshStop', 'retry', 'Refresh')}
      ${key('favStop', 'star', isFav ? 'Saved' : 'Save', { cls: isFav ? 'is-on' : '', attrs: `data-atco="${esc(atco)}" data-name="${esc(name || atco)}" aria-pressed="${isFav}"` })}</div>
    <div class="list">${rows || '<div class="notice">No departures listed for this stop right now.</div>'}</div>`;
  if (focusedKey) {
    const el = app.querySelector(`[data-k="${CSS.escape(focusedKey)}"]`);
    if (el) { el.focus(); return; }
  }
  if (!quiet) focusFirst();
}

// ================================================================ ACTIONS
const SCREENS = { home, dest, preview, guide, steps, stations, board, stops, stop };

function setKeyOn(b, on, label) {
  b.classList.toggle('is-on', on);
  b.setAttribute('aria-pressed', on);
  if (label) b.querySelector('.key-label').textContent = label;
}

const ACTIONS = {
  noop() {},
  async saveCode() {
    const v = ($('#codeIn') || {}).value || '';
    if (!v.trim()) return toast('Enter the code first', 2500, true);
    store.set('code', v.trim());
    S.demo = false;
    S.route = null;
    S.pos = null;
    updateGps();
    try {
      await api('status');          // a wrong code comes back to the lock screen
      toast('Unlocked');
      S.gen++;
      goHome();
      render({ screen: 'home', depth: 1 });
    } catch { /* lock screen already shown */ }
  },
  unlock() { showLock('Enter your access code'); },
  clearSearch(d, b) {
    const q = $('#q');
    if (q) q.value = '';
    S.query = ''; S.results = []; lastSearch = '';
    b.hidden = true;
    fillDestList();
    if (q) q.focus();             // ready for the next search: pinch to write or speak
  },
  demoMode() {
    S.demo = false;               // let enterDemo switch cleanly
    enterDemo();
    render({ screen: 'home', depth: 1 });
  },
  retry() { render(history.state || { screen: 'home', depth: 1 }); },
  goDest() { S.results = []; S.query = ''; lastSearch = ''; go('dest'); },
  goStations() { go('stations'); },
  goStops() { go('stops'); },
  resume() { go('guide'); },
  done() { S.route = null; goHome(); },
  async locate() {
    toast('Acquiring fix');
    try { await locate(); toast('Fix ±' + Math.round(S.pos.acc) + ' m'); } catch (e) { toast(e.message, 3500, true); }
    if (S.screen === 'home') home();
  },
  setMode(d) {
    S.mode = d.mode;
    store.set('mode', S.mode);
    $('#sub').textContent = MODES[S.mode].label;
    app.querySelectorAll('[data-act="setMode"]').forEach((b) => {
      const on = b.dataset.mode === S.mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on);
    });
  },
  pickDest(d) {
    const p = S.choices[Number(d.i)];
    if (!p) return;
    S.dest = { name: p.name, lat: p.lat, lon: p.lon };
    const recent = store.get('recent', []).filter((x) => x.name !== p.name);
    recent.unshift(S.dest);
    store.set('recent', recent.slice(0, 6));
    go('preview');
  },
  swapMode(d) {
    S.mode = d.mode;
    store.set('mode', S.mode);
    render(history.state);
  },
  cycleMap() {
    let next = MAP_MODES[(MAP_MODES.indexOf(S.mapMode) + 1) % MAP_MODES.length];
    if (next !== 'route' && !StreetMap.supported()) {
      toast('Street map unavailable on this device', 3500, true);
      next = 'route';
    }
    S.mapMode = next;
    store.set('mapMode', S.mapMode);
    updateMapKey();
    refreshMapView();
  },
  toggleSave(d, b) {
    const added = toggleIn('saved', S.dest, (x) => x.name);
    setKeyOn(b, added, added ? 'Saved' : 'Save');
    toast(added ? 'Place saved' : 'Removed');
  },
  start() {
    const r = S.route;
    if (!r) return;
    r.ann = {}; r.arrived = false; r.along = 0; r.offCount = 0;
    if (r.steps[0]) say(r.steps[0].text); // spoken from a user action, as the platform recommends
    go('guide', {}, true);                 // replace the preview so Back returns to the destination list
  },
  openSteps() { go('steps'); },
  toggleVoice(d, b) {
    S.voice = !S.voice;
    store.set('voice', S.voice);
    setKeyOn(b, S.voice);
    if (!S.voice) { try { speechSynthesis.cancel(); } catch { /* ignore */ } } else say('Voice on');
  },
  async toggleCompass(d, b) {
    if (S.compass) {
      S.compass = false;
      stopCompass();
    } else {
      const ok = await requestCompass();
      if (!ok) { toast('Compass unavailable', 3000, true); return; }
      S.compass = true;
      setTimeout(() => { if (S.compass && S.headingCompass == null) toast('No compass heading · using GPS'); }, 4000);
    }
    setKeyOn(b, S.compass);
    scheduleDraw();
  },
  endRoute() { S.route = null; stopGuidance(); history.back(); },
  openBoard(d) { go('board', { crs: d.crs, name: d.name }); },
  openStop(d) { go('stop', { atco: d.atco, name: d.name }); },
  toggleCalls(d) {
    if (S.expanded.has(d.k)) S.expanded.delete(d.k); else S.expanded.add(d.k);
    if (S.lastBoard) {
      renderBoard(S.lastBoard, S.lastBoard.name, true);
      const el = app.querySelector(`[data-k="${CSS.escape(d.k)}"]`);
      if (el) el.focus();
    }
  },
  toggleMsg(d, b) { b.classList.toggle('open'); },
  favStation(d, b) {
    const added = toggleIn('favStations', { crs: d.crs, name: d.name }, (x) => x.crs);
    setKeyOn(b, added, added ? 'Saved' : 'Save');
    toast(added ? 'Station saved' : 'Removed');
  },
  refreshStop(d, b) {
    if (b.disabled) return;
    b.disabled = true;
    toast('Checking…', 1200);
    if (S.reloadStop) S.reloadStop();
    setTimeout(() => { b.disabled = false; }, 15000); // no rapid repeat taps eating the daily allowance
  },
  favStop(d, b) {
    const added = toggleIn('favStops', { atco: d.atco, name: d.name }, (x) => x.atco);
    setKeyOn(b, added, added ? 'Saved' : 'Save');
    toast(added ? 'Stop saved' : 'Removed');
  },
};

// ---------------------------------------------------------------- boot
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimers();
  else if (S.screen === 'board') render(history.state); // bus stops refresh only on request (daily allowance)
});
history.replaceState({ screen: 'home', params: {}, depth: 1 }, '');
render(history.state);
if (S.demo) toast('Demo mode · sample data', 3500);
else {
  api('status').catch(() => { /* no code: demo mode; wrong code: lock screen */ });
  locate().catch(() => { /* first fix in the background; screens retry when needed */ });
}
