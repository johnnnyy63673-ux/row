// api/fitbit/debug.js — diagnostic endpoint, visit /api/fitbit/debug in browser

const TOKEN_KEY   = 'google_health_tokens';
const HEALTH_BASE = 'https://health.googleapis.com/v4';

async function getTokens(supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/app_state?key=eq.${TOKEN_KEY}&select=data`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } },
  );
  return res.json();
}

async function tryFetch(label, url, options = {}) {
  try {
    const r    = await fetch(url, options);
    const body = await r.json().catch(() => null);
    return { label, status: r.status, ok: r.ok, body };
  } catch (e) {
    return { label, error: e.message };
  }
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Supabase env vars missing' });

  const rows = await getTokens(supabaseUrl, supabaseKey);
  if (!Array.isArray(rows) || !rows[0]) return res.status(200).json({ connected: false, message: 'No tokens in Supabase' });

  const tokens   = rows[0].data;
  const at       = tokens?.access_token;
  const expiresAt = tokens?.expires_at;
  if (!at) return res.status(200).json({ connected: false, message: 'No access_token stored' });

  const auth    = { 'Authorization': `Bearer ${at}` };
  const now     = Date.now();
  const d       = new Date();
  const tmr     = new Date(now + 86_400_000);
  const yest    = new Date(now - 86_400_000);
  const cd      = (x) => ({ year: x.getFullYear(), month: x.getMonth()+1, day: x.getDate() });

  const results = await Promise.all([
    tryFetch('token_info',
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${at}`),
    tryFetch('sleep',
      `${HEALTH_BASE}/users/me/dataTypes/sleep/dataPoints?pageSize=5`,
      { headers: auth }),
    tryFetch('daily_resting_heart_rate',
      `${HEALTH_BASE}/users/me/dataTypes/daily-resting-heart-rate/dataPoints?pageSize=5`,
      { headers: auth }),
    tryFetch('heart_rate_variability',
      `${HEALTH_BASE}/users/me/dataTypes/heart-rate-variability/dataPoints?pageSize=10`,
      { headers: auth }),
    tryFetch('steps_rollup',
      `${HEALTH_BASE}/users/me/dataTypes/steps/dataPoints:dailyRollUp`,
      {
        method:  'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: { startDate: cd(yest), endDate: cd(tmr) } }),
      }),
    tryFetch('calories_rollup',
      `${HEALTH_BASE}/users/me/dataTypes/active-energy-burned/dataPoints:dailyRollUp`,
      {
        method:  'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: { startDate: cd(yest), endDate: cd(tmr) } }),
      }),
  ]);

  return res.status(200).json({
    tokenExpiresAt:  new Date(expiresAt).toISOString(),
    tokenExpired:    expiresAt < now,
    results,
  });
}
