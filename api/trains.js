// Live train departures from National Rail Darwin, via the Rail Data Marketplace "Live Departure Board" product
const { cleanKey, send, fetchT, upstreamError, allowed } = require('./_lib.js');

// The Live Departure Board product as listed on Rail Data Marketplace. Override with RAILDATA_DEPARTURES_URL
// (paste it exactly as the product page shows it, "{crs}" and all).
const DEFAULT_URL = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepartureBoard/{crs}';

// Turn the configured URL into a list to try: the detailed board first (gives calling points), then the basic one.
function candidates(raw) {
  let u = String(raw || '').trim();
  if (!/^https:\/\/[a-z0-9.-]+\.raildata\.org\.uk\//i.test(u)) u = DEFAULT_URL;
  u = u.replace(/\/\{crs\}\/?$/i, '').replace(/\/+$/, '');
  const m = u.match(/^(.*)\/(GetDepartureBoard|GetDepBoardWithDetails)$/i);
  if (!m) return [u];
  const root = m[1];
  return [...new Set([root + '/GetDepBoardWithDetails', u])];
}
let working = null; // remembers which address worked, while this server instance is warm

const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function mapService(s, bus) {
  const dest = arr(s.destination).map((d) => d.locationName + (d.via ? ' ' + d.via : '')).join(' & ');
  const cp = arr(s.subsequentCallingPoints)[0];
  const calls = arr(cp && cp.callingPoint).map((c) => ({ n: c.locationName, st: c.st, et: c.et }));
  return {
    id: s.serviceID || s.serviceIdUrlSafe || '',
    std: s.std || '',
    etd: s.etd || '',
    plat: s.platform || '',
    op: s.operator || '',
    dest,
    canc: !!s.isCancelled || /cancel/i.test(s.etd || ''),
    reason: s.cancelReason || s.delayReason || '',
    calls,
    bus,
  };
}

module.exports = async (req, res) => {
  if (!allowed(req, res)) return;
  const key = cleanKey(process.env.RAILDATA_API_KEY);
  if (!key) return send(res, 500, { error: 'RAILDATA_API_KEY is not set in Vercel' });

  const crs = String(req.query.crs || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(crs)) return send(res, 400, { error: 'Station code must be three letters' });

  const list = candidates(process.env.RAILDATA_DEPARTURES_URL);
  const order = working && list.includes(working) ? [working, ...list.filter((u) => u !== working)] : list;

  try {
    let r, lastErr;
    for (const base of order) {
      r = await fetchT(`${base}/${crs}?numRows=12&timeWindow=120`, { headers: { 'x-apikey': key, Accept: 'application/json' } });
      if (r.ok) { working = base; break; }
      lastErr = await upstreamError(r, 'Rail Data Marketplace');
      // 401/403/404 on the detailed board usually means it isn't part of your subscription: try the next one
      if (![401, 403, 404].includes(r.status)) break;
    }
    if (!r || !r.ok) return send(res, 502, { error: lastErr || 'Rail Data Marketplace error' });
    const j = await r.json();
    const services = [
      ...arr(j.trainServices).map((s) => mapService(s, false)),
      ...arr(j.busServices).map((s) => mapService(s, true)),
    ].sort((a, b) => (a.std > b.std ? 1 : a.std < b.std ? -1 : 0));
    const messages = arr(j.nrccMessages).map((m) => strip(m.Value ?? m.value ?? m.xhtmlMessage ?? m)).filter(Boolean);
    send(res, 200, { crs: j.crs || crs, name: j.locationName || crs, generated: j.generatedAt || null, services, messages }, 20);
  } catch (e) {
    send(res, 502, { error: e.message || 'Train times failed' });
  }
};
