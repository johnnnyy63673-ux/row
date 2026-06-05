// api/fitbit/data.js
// Fetches today's health metrics directly from the Fitbit Web API.
// Automatically refreshes the access token if it has expired.
//
// Fitbit endpoints used:
//   /1.2/user/-/sleep/date/{date}.json          — sleep duration, efficiency, stages
//   /1/user/-/activities/heart/date/{date}/1d   — resting heart rate
//   /1/user/-/hrv/date/{date}.json              — HRV (RMSSD)
//   /1/user/-/activities/date/{date}.json       — steps, calories
//
// Returns: { connected, recovery, hrv, rhr, sleepHours, sleepPerf,
//            sleepTargetHours, bedtime, wakeTime, strain, calories,
//            steps, sleepDebt, stageDeep, stageRem, stageLight,
//            stageWake, syncedAt }

const TOKEN_KEY    = 'google_health_tokens';
const FITBIT       = 'https://api.fitbit.com';
const SLEEP_TARGET = 8;

// ── Supabase ──────────────────────────────────────────────────────────────────

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
    body: JSON.stringify({
      key:        TOKEN_KEY,
      data:       tokens,
      updated_at: new Date().toISOString(),
    }),
  });
}

// ── Fitbit OAuth token refresh ────────────────────────────────────────────────

async function refreshAccessToken(tokens) {
  const clientId     = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  const basicAuth    = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${FITBIT}/oauth2/token`, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error('Token refresh failed: ' + (data.errors?.[0]?.message || res.status));
  }
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    user_id:       tokens.user_id,
    expires_at:    Date.now() + (data.expires_in || 28800) * 1000,
  };
}

// ── Fitbit REST GET ───────────────────────────────────────────────────────────

async function fitGet(endpoint, accessToken) {
  const res = await fetch(`${FITBIT}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg  = body.errors?.[0]?.message || res.status;
    throw new Error(`Fitbit ${endpoint} → ${msg}`);
  }
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Parse Fitbit local-time string "2026-06-04T07:30:00.000" without timezone
// conversion (Fitbit times are already in the user's local time).
function fmtFitbitTime(s) {
  if (!s) return '—';
  const m = s.match(/T(\d{1,2}):(\d{2})/);
  if (!m) return '—';
  let h = parseInt(m[1], 10);
  const min  = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${ampm}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Load stored tokens
  let tokens = await getTokens(supabaseUrl, supabaseKey);
  if (!tokens) return res.status(401).json({ connected: false });

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at < Date.now() + 300_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      await saveTokens(supabaseUrl, supabaseKey, tokens);
    } catch {
      return res.status(401).json({ connected: false, error: 'Token expired — please reconnect' });
    }
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const at    = tokens.access_token;

  try {
    // Fetch all four endpoints in parallel; HRV is optional (not all devices support it)
    const [sleepData, hrData, actData, hrvData] = await Promise.all([
      fitGet(`/1.2/user/-/sleep/date/${today}.json`, at),
      fitGet(`/1/user/-/activities/heart/date/${today}/1d.json`, at),
      fitGet(`/1/user/-/activities/date/${today}.json`, at),
      fitGet(`/1/user/-/hrv/date/${today}.json`, at).catch(() => null),
    ]);

    // ── Sleep ──────────────────────────────────────────────────────────────
    const sleepLogs = sleepData.sleep || [];
    // Pick the longest (main) sleep record, ignoring naps
    const mainSleep = sleepLogs.reduce(
      (best, s) => (!best || s.minutesAsleep > best.minutesAsleep) ? s : best,
      null,
    );

    const sleepMinutes  = mainSleep ? (mainSleep.minutesAsleep || 0) : 0;
    const sleepHours    = parseFloat((sleepMinutes / 60).toFixed(1));
    // Fitbit efficiency is already 0-100 (time asleep / time in bed × 100)
    const sleepPerf     = mainSleep ? (mainSleep.efficiency || 0) : 0;
    const bedtime       = mainSleep ? fmtFitbitTime(mainSleep.startTime) : '—';
    const wakeTime      = mainSleep ? fmtFitbitTime(mainSleep.endTime)   : '—';

    // Sleep stages (minutes) — only available on newer Fitbit devices
    const stagesSum = mainSleep?.levels?.summary || {};
    const stageDeep  = stagesSum.deep?.minutes  ?? 0;
    const stageRem   = stagesSum.rem?.minutes   ?? 0;
    const stageLight = stagesSum.light?.minutes ?? 0;
    const stageWake  = stagesSum.wake?.minutes  ?? 0;

    // ── Resting Heart Rate ─────────────────────────────────────────────────
    const hrArr = hrData['activities-heart'] || [];
    const hrVal = hrArr.length ? (hrArr[hrArr.length - 1].value || {}) : {};
    const rhr   = hrVal.restingHeartRate || 0;

    // ── HRV ───────────────────────────────────────────────────────────────
    // dailyRmssd: average RMSSD over the full sleep period (ms)
    const hrvArr   = hrvData?.hrv || [];
    const hrvEntry = hrvArr.length ? hrvArr[hrvArr.length - 1] : null;
    const hrv      = hrvEntry ? Math.round(hrvEntry.value?.dailyRmssd || 0) : 0;

    // ── Activity ──────────────────────────────────────────────────────────
    const actSummary = actData.summary || {};
    const steps      = actSummary.steps             || 0;
    const calories   = actSummary.caloriesOut        || 0;
    const actCal     = actSummary.activityCalories   || 0; // active-only calories

    // ── Recovery score (0-100) ────────────────────────────────────────────
    // If HRV is available: weighted average of HRV score + sleep efficiency.
    // Otherwise fall back to sleep efficiency alone.
    let recovery;
    if (hrv > 0) {
      // Normalise RMSSD: 20 ms = 0 pts, 80 ms = 100 pts
      const hrvScore = Math.min(100, Math.max(0, Math.round((hrv - 20) / 60 * 100)));
      recovery = Math.min(100, Math.round(sleepPerf * 0.4 + hrvScore * 0.6));
    } else {
      recovery = sleepPerf;
    }

    // ── Strain (WHOOP-style 0-21, estimated from active calories) ─────────
    // Active calories ÷ 75 maps ~1500 active cal day → 20 strain
    const strain = parseFloat(Math.min(21, actCal / 75).toFixed(1));

    // ── Sleep debt (last night vs target) ─────────────────────────────────
    const sleepDebt = parseFloat(Math.max(0, SLEEP_TARGET - sleepHours).toFixed(1));

    return res.status(200).json({
      connected:        true,
      recovery,
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
      sleepDebt,
      stageDeep,
      stageRem,
      stageLight,
      stageWake,
      syncedAt: new Date().toISOString(),
    });

  } catch (err) {
    // Return connected:true so the UI doesn't flip to empty state;
    // the error message will surface in the sync line.
    return res.status(500).json({ connected: true, error: err.message });
  }
}
