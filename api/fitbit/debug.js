// api/fitbit/debug.js
// Temporary diagnostic endpoint — visit /api/fitbit/debug in the browser
// to see the raw Google Fitness API responses and spot the failure point.
// Remove this file once the issue is resolved.

const TOKEN_KEY = 'google_health_tokens';
const FIT_BASE  = 'https://www.googleapis.com/fitness/v1/users/me';

async function getTokens(supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/app_state?key=eq.${TOKEN_KEY}&select=data`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } },
  );
  return res.json();
}

async function tryFetch(label, url, options) {
  try {
    const r = await fetch(url, options);
    const body = await r.json().catch(() => null);
    return { label, status: r.status, ok: r.ok, body };
  } catch (e) {
    return { label, error: e.message };
  }
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }

  const rows = await getTokens(supabaseUrl, supabaseKey);
  if (!Array.isArray(rows) || !rows[0]) {
    return res.status(200).json({ connected: false, message: 'No tokens in Supabase' });
  }

  const tokens = rows[0].data;
  const at = tokens?.access_token;
  const expiresAt = tokens?.expires_at;

  if (!at) return res.status(200).json({ connected: false, message: 'No access_token stored' });

  const authHeader = { 'Authorization': `Bearer ${at}` };
  const now = Date.now();
  const dayAgo = now - 86_400_000;

  const results = await Promise.all([
    // 1. Token info — tells us if the token is valid and what scopes are granted
    tryFetch('token_info',
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${at}`,
      {}),

    // 2. Sleep sessions
    tryFetch('sleep_sessions',
      `${FIT_BASE}/sessions?startTime=${new Date(dayAgo).toISOString()}&endTime=${new Date(now).toISOString()}&activityType=72`,
      { headers: authHeader }),

    // 3. Heart rate aggregate
    tryFetch('heart_rate',
      `${FIT_BASE}/dataset:aggregate`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregateBy:     [{ dataTypeName: 'com.google.heart_rate.bpm' }],
          bucketByTime:    { durationMillis: 86_400_000 },
          startTimeMillis: dayAgo,
          endTimeMillis:   now,
        }),
      }),

    // 4. HRV
    tryFetch('hrv',
      `${FIT_BASE}/dataset:aggregate`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregateBy:     [{ dataTypeName: 'com.google.heart_rate.variability.rmssd' }],
          bucketByTime:    { durationMillis: 86_400_000 },
          startTimeMillis: dayAgo,
          endTimeMillis:   now,
        }),
      }),

    // 5. Steps + calories
    tryFetch('activity',
      `${FIT_BASE}/dataset:aggregate`,
      {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aggregateBy: [
            { dataTypeName: 'com.google.step_count.delta' },
            { dataTypeName: 'com.google.calories.expended' },
          ],
          bucketByTime:    { durationMillis: 86_400_000 },
          startTimeMillis: dayAgo,
          endTimeMillis:   now,
        }),
      }),

    // 6. List all data sources — shows what data types are actually available
    tryFetch('data_sources',
      `${FIT_BASE}/dataSources`,
      { headers: authHeader }),
  ]);

  return res.status(200).json({
    tokenExpiresAt:   new Date(expiresAt).toISOString(),
    tokenExpired:     expiresAt < now,
    tokenAgeMinutes:  Math.round((now - (expiresAt - 3600_000)) / 60_000),
    results,
  });
}
