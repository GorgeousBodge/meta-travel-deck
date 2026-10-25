// Shared helpers for the server functions. Files starting with "_" are not exposed as routes on Vercel.

// Keep letters, numbers and the symbols base64-style keys use (= + / - _), e.g. HEIGIT/openrouteservice
// keys ending in "=". Strip everything else (stray spaces, quotes, newlines from pasting).
const cleanKey = (v) => String(v || '').replace(/[^A-Za-z0-9=+/_-]/g, '');

function send(res, status, body, cacheSeconds) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    cacheSeconds ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}` : 'no-store',
  );
  res.status(status).send(JSON.stringify(body));
}

function num(v, min, max) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

async function fetchT(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Upstream service timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Turn an upstream failure into a short message without leaking anything sensitive
async function upstreamError(r, name) {
  let detail = '';
  try {
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error)) || j.message || j.fault || '';
    } catch {
      detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  } catch { /* ignore */ }
  if (r.status === 401 || r.status === 403) return `${name} rejected the key (${r.status}). Check the Vercel environment variable.`;
  if (r.status === 429) return `${name} rate limit reached. Try again shortly.`;
  return `${name} error ${r.status}${detail ? ': ' + String(detail).slice(0, 140) : ''}`;
}

module.exports = { cleanKey, send, num, fetchT, upstreamError };
