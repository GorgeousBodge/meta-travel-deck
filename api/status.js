// Quick setup check: open /api/status in a browser. Shows which keys are set — never their values.
const { cleanKey, send, allowed } = require('./_lib.js');

const check = (name) => {
  const raw = String(process.env[name] || '');
  const clean = cleanKey(raw);
  return { set: clean.length > 0, length: clean.length, strippedChars: raw.trim().length !== clean.length };
};

module.exports = (req, res) => {
  if (!allowed(req, res)) return;
  send(res, 200, {
    ORS_API_KEY: check('ORS_API_KEY'),
    RAILDATA_API_KEY: check('RAILDATA_API_KEY'),
    RAILDATA_DEPARTURES_URL: { set: !!process.env.RAILDATA_DEPARTURES_URL, note: 'optional' },
    TRANSPORTAPI_APP_ID: check('TRANSPORTAPI_APP_ID'),
    TRANSPORTAPI_APP_KEY: check('TRANSPORTAPI_APP_KEY'),
    APP_CODE: { set: !!cleanKey(process.env.APP_CODE), length: cleanKey(process.env.APP_CODE).length },
    BUS_REFRESH_SECONDS: { set: !!process.env.BUS_REFRESH_SECONDS, note: 'optional, paid plans only' },
  });
};
