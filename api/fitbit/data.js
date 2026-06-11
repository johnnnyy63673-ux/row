// api/fitbit/data.js
// Fetches health metrics from the Google Health API v4 (new Fitbit platform).
// Base: https://health.googleapis.com/v4

const TOKEN_KEY    = 'google_health_tokens';
const HEALTH_BASE  = 'https://health.googleapis.com/v4';
const SLEEP_TARGET = 8;

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getTokens(supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/app_state?key=eq.${TOKEN_KEY}&select=data`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } },
  );
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0] && rows[0].data) || null;
}

async function saveTokens(supabaseUrl, supabaseKey, tokens) {
  await fetch(`${supabaseUrl}/rest/v1/app_state`, {
    method:  'POST',
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ key: TOKEN_KEY, data: tokens, updated_at: new Date().toISOString() }),
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshAccessToken(tokens) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id:     process.env.GOOGLE_HEALTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_HEALTH_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Token refresh failed: ' + (data.error || res.status));
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
  };
}

// ── Google Health API helpers ─────────────────────────────────────────────────

async function healthGet(dataType, at, params = {}) {
  const url = new URL(`${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${at}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GET ${dataType} → ${res.status}: ${body?.error?.message || JSON.stringify(body)}`);
  }
  return res.json();
}

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Supabase not configured' });

  let tokens = await getTokens(supabaseUrl, supabaseKey);
  if (!tokens) return res.status(401).json({ connected: false });

  if (tokens.expires_at < Date.now() + 300_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      await saveTokens(supabaseUrl, supabaseKey, tokens);
    } catch {
      return res.status(401).json({ connected: false, error: 'Token expired — please reconnect' });
    }
  }

  const at      = tokens.access_token;
  const today   = new Date();
  const tomorrow  = new Date(Date.now() + 86_400_000);
  const yesterday = new Date(Date.now() - 86_400_000);

  try {
    const [sleepData, rhrData, hrvData, stepsData, calsData] = await Promise.all([
      healthGet('sleep', at, { pageSize: 10 }).catch(() => null),
      healthGet('daily-resting-heart-rate', at, { pageSize: 10 }).catch(() => null),
      healthGet('heart-rate-variability', at, { pageSize: 50 }).catch(() => null),
      healthGet('steps', at, { pageSize: 50 }).catch(() => null),
      healthGet('active-energy-burned', at, { pageSize: 50 }).catch(() => null),
    ]);

    // ── Sleep ─────────────────────────────────────────────────────────────────
    const sleepPoints = sleepData?.dataPoints || [];
    // API returns newest first — take the most recent session
    const mainSleep = sleepPoints[0] || null;

    const sleepMins  = mainSleep ? Number(mainSleep.sleep?.summary?.minutesAsleep || 0) : 0;
    const sleepHours = parseFloat((sleepMins / 60).toFixed(1));
    const sleepPerf  = Math.min(100, Math.round((sleepHours / SLEEP_TARGET) * 100));
    const bedtime    = mainSleep ? fmtTime(mainSleep.sleep?.interval?.startTime) : '—';
    const wakeTime   = mainSleep ? fmtTime(mainSleep.sleep?.interval?.endTime)   : '—';

    // ── Resting heart rate ────────────────────────────────────────────────────
    const rhrPoints = rhrData?.dataPoints || [];
    const rhr = rhrPoints.length
      ? Math.round(Number(rhrPoints[0]?.dailyRestingHeartRate?.beatsPerMinute || 0))
      : 0;

    // ── HRV ──────────────────────────────────────────────────────────────────
    const hrvPoints = hrvData?.dataPoints || [];
    const hrv = hrvPoints.length
      ? Math.round(
          hrvPoints.reduce((sum, p) => sum + (p.heartRateVariability?.rootMeanSquareOfSuccessiveDifferencesMilliseconds || 0), 0)
          / hrvPoints.length,
        )
      : 0;

    // ── Steps + calories (sum today's individual records) ─────────────────────
    const todayStr = today.toISOString().split('T')[0];
    const stepsPoints = stepsData?.dataPoints || [];
    const calsPoints  = calsData?.dataPoints  || [];
    const steps    = stepsPoints.reduce((sum, p) => sum + Number(p.steps?.count || p.value?.intVal || 0), 0);
    const calories = Math.round(calsPoints.reduce((sum, p) => sum + Number(p.activeEnergyBurned?.kilocalories || p.value?.fpVal || 0), 0));

    // ── Recovery (0-100) ─────────────────────────────────────────────────────
    let recovery;
    if (hrv > 0) {
      const hrvScore = Math.min(100, Math.max(0, Math.round((hrv - 20) / 60 * 100)));
      recovery = Math.min(100, Math.round(sleepPerf * 0.4 + hrvScore * 0.6));
    } else {
      recovery = sleepPerf;
    }

    // ── Strain (WHOOP-style 0-21) ─────────────────────────────────────────────
    const strain = parseFloat(Math.min(21, calories / 100).toFixed(1));

    return res.status(200).json({
      connected:        true,
      recovery:         Math.max(0, recovery),
      hrv,
      rhr,
      sleepHours,
      sleepPerf,
      sleepTargetHours: SLEEP_TARGET,
      bedtime,
      wakeTime,
      strain,
      calories,
      steps,
      sleepDebt: parseFloat(Math.max(0, SLEEP_TARGET - sleepHours).toFixed(1)),
      syncedAt:  new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ connected: true, error: err.message });
  }
}
