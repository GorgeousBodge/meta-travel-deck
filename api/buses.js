// Live bus departures from TransportAPI (which now runs Traveline NextBuses).
// Real-time where operators provide it, scheduled times otherwise.
// Free plan = 30 requests/day, so responses are cached at Vercel's edge for 90 s per stop,
// and the app only refreshes when you ask (unless BUS_REFRESH_SECONDS is set for a paid plan).
const { cleanKey, send, fetchT } = require('./_lib.js');

// "2026-10-25" + "17:42" (UK local time) -> ISO string with the right offset (GMT or BST)
function londonISO(date, time) {
  if (!date || !time || !/^\d\d:\d\d/.test(time)) return '';
  const guess = new Date(`${date}T${time}:00Z`);
  if (isNaN(guess)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(guess).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const asLondon = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const offsetMin = Math.round((asLondon - guess.getTime()) / 60000);
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

module.exports = async (req, res) => {
  const appId = cleanKey(process.env.TRANSPORTAPI_APP_ID);
  const appKey = cleanKey(process.env.TRANSPORTAPI_APP_KEY);
  if (!appId || !appKey) return send(res, 500, { error: 'TRANSPORTAPI_APP_ID / TRANSPORTAPI_APP_KEY are not set in Vercel' });

  const atco = String(req.query.atco || '').trim();
  if (!/^[0-9A-Za-z]{6,16}$/.test(atco)) return send(res, 400, { error: 'Invalid stop code' });

  const refresh = Math.max(0, Math.min(600, parseInt(process.env.BUS_REFRESH_SECONDS || '0', 10) || 0));
  const url = `https://transportapi.com/v3/uk/bus/stop/${encodeURIComponent(atco)}/live.json?group=no&nextbuses=yes&limit=12`;

  try {
    const r = await fetchT(url, { headers: { 'X-App-Id': appId, 'X-App-Key': appKey, Accept: 'application/json' } });
    if (!r.ok) {
      let msg = `TransportAPI error ${r.status}`;
      if (r.status === 401) msg = 'TransportAPI rejected the app ID / key. Check the Vercel environment variables.';
      else if (r.status === 403 || r.status === 429) msg = 'Bus allowance used up for today (free plan: 30 checks a day). Resets at midnight.';
      else if (r.status === 404) msg = 'TransportAPI doesn\u2019t recognise this stop.';
      else { try { const j = await r.json(); if (j && j.error) msg += ': ' + String(j.error).slice(0, 120); } catch { /* ignore */ } }
      return send(res, 502, { error: msg });
    }
    const j = await r.json();
    const groups = j.departures || {};
    const list = Array.isArray(groups) ? groups : Object.values(groups).flat();

    const departures = list
      .map((d) => {
        const aimed = londonISO(d.date, d.aimed_departure_time);
        const live = !!(d.status && d.status.live) || !!d.expected_departure_time;
        const expected = d.expected_departure_time ? londonISO(d.expected_departure_date || d.date, d.expected_departure_time) : '';
        return {
          line: d.line_name || d.line || '',
          dest: d.direction || '',
          op: d.operator_name || d.operator || '',
          aimed,
          expected: live ? expected : '',
        };
      })
      .filter((d) => d.line && (d.aimed || d.expected))
      .sort((a, b) => new Date(a.expected || a.aimed) - new Date(b.expected || b.aimed))
      .slice(0, 12);

    send(res, 200, { atco, name: j.stop_name || '', departures, refresh }, 90);
  } catch (e) {
    send(res, 502, { error: e.message || 'Bus times failed' });
  }
};
