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

async function healthRollup(dataType, startDate, endDate, at) {
  const res = await fetch(`${HEALTH_BASE}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${at}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      range: {
        startDate: civilDate(startDate),
        endDate:   civilDate(endDate),
      },
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`rollUp ${dataType} → ${res.status}: ${body?.error?.message || JSON.stringify(body)}`);
  }
  return res.json();
}

function civilDate(d) {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
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
      healthRollup('steps', yesterday, tomorrow, at).catch(() => null),
      healthRollup('active-energy-burned', yesterday, tomorrow, at).catch(() => null),
    ]);

    // ── Sleep ─────────────────────────────────────────────────────────────────
    const sleepPoints = sleepData?.dataPoints || [];
    // Pick longest sleep session
    const mainSleep = sleepPoints.reduce((best, s) => {
      const dur = s.sleep?.durationMs || s.durationMs || 0;
      const bDur = best?.sleep?.durationMs || best?.durationMs || 0;
      return Number(dur) > Number(bDur) ? s : best;
    }, null);

    const sleepMs    = mainSleep ? Number(mainSleep.sleep?.durationMs || mainSleep.durationMs || 0) : 0;
    const sleepHours = parseFloat((sleepMs / 3_600_000).toFixed(1));
    const sleepPerf  = Math.min(100, Math.round((sleepHours / SLEEP_TARGET) * 100));
    const bedtime    = mainSleep ? fmtTime(mainSleep.startTime || mainSleep.sessionStartTime) : '—';
    const wakeTime   = mainSleep ? fmtTime(mainSleep.endTime   || mainSleep.sessionEndTime)   : '—';

    // ── Resting heart rate ────────────────────────────────────────────────────
    const rhrPoints = rhrData?.dataPoints || [];
    const rhr = rhrPoints.length
      ? Math.round(rhrPoints[rhrPoints.length - 1]?.dailyRestingHeartRate?.beatsPerMinute
          || rhrPoints[rhrPoints.length - 1]?.value?.fpVal
          || 0)
      : 0;

    // ── HRV ──────────────────────────────────────────────────────────────────
    const hrvPoints = hrvData?.dataPoints || [];
    const hrv = hrvPoints.length
      ? Math.round(
          hrvPoints.reduce((sum, p) => sum + (p.heartRateVariability?.rmssd || p.value?.fpVal || 0), 0)
          / hrvPoints.length,
        )
      : 0;

    // ── Steps + calories ──────────────────────────────────────────────────────
    const stepsRollup = stepsData?.rollupDataPoints?.[0];
    const calsRollup  = calsData?.rollupDataPoints?.[0];
    const steps    = stepsRollup?.steps?.count || stepsRollup?.value?.intVal || 0;
    const calories = Math.round(calsRollup?.activeEnergyBurned?.kilocalories || calsRollup?.value?.fpVal || 0);

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
