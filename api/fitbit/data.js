// api/fitbit/data.js
// Fetches health metrics from the Google Fitness REST API using Google OAuth
// tokens obtained via GOOGLE_HEALTH_CLIENT_ID / GOOGLE_HEALTH_CLIENT_SECRET.
//
// Google Fitness endpoints used:
//   GET  /fitness/v1/users/me/sessions          — sleep sessions (activityType=72)
//   POST /fitness/v1/users/me/dataset:aggregate — heart rate, HRV, steps, calories
//
// Returns: { connected, recovery, hrv, rhr, sleepHours, sleepPerf,
//            sleepTargetHours, bedtime, wakeTime, strain, calories,
//            steps, sleepDebt, syncedAt }

const TOKEN_KEY    = 'google_health_tokens';
const FIT_BASE     = 'https://www.googleapis.com/fitness/v1/users/me';
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
    body: JSON.stringify({
      key:        TOKEN_KEY,
      data:       tokens,
      updated_at: new Date().toISOString(),
    }),
  });
}

// ── Google OAuth token refresh ────────────────────────────────────────────────

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
  if (!res.ok || data.error) {
    throw new Error('Token refresh failed: ' + (data.error || res.status));
  }
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
  };
}

// ── Google Fitness REST helpers ───────────────────────────────────────────────

async function fitGet(path, at) {
  const res = await fetch(`${FIT_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${at}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(body?.error?.message || body)}`);
  }
  return res.json();
}

async function fitAggregate(body, at) {
  const res = await fetch(`${FIT_BASE}/dataset:aggregate`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${at}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`aggregate → ${res.status} ${JSON.stringify(errBody?.error?.message || errBody)}`);
  }
  return res.json();
}

// ── Data parsing helpers ──────────────────────────────────────────────────────

// Minimum fp value across all buckets (used for resting HR)
function parseFpMin(buckets) {
  let min = null;
  for (const b of (buckets || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          if (v.fpVal > 30 && v.fpVal < 200) {
            min = min === null ? v.fpVal : Math.min(min, v.fpVal);
          }
        }
      }
    }
  }
  return min ? Math.round(min) : 0;
}

// Average fp value across all buckets (used for HRV)
function parseFpAvg(buckets) {
  let sum = 0, n = 0;
  for (const b of (buckets || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          if (v.fpVal) { sum += v.fpVal; n++; }
        }
      }
    }
  }
  return n ? Math.round(sum / n) : 0;
}

// Sum of integer values (steps)
function parseIntSum(buckets) {
  let total = 0;
  for (const b of (buckets || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) { total += (v.intVal || 0); }
      }
    }
  }
  return total;
}

// Sum of fp values (calories)
function parseFpSum(buckets) {
  let total = 0;
  for (const b of (buckets || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) { total += (v.fpVal || 0); }
      }
    }
  }
  return Math.round(total);
}

function fmtMs(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  let tokens = await getTokens(supabaseUrl, supabaseKey);
  if (!tokens) return res.status(401).json({ connected: false });

  // Refresh token if expiring within 5 minutes
  if (tokens.expires_at < Date.now() + 300_000) {
    try {
      tokens = await refreshAccessToken(tokens);
      await saveTokens(supabaseUrl, supabaseKey, tokens);
    } catch {
      return res.status(401).json({ connected: false, error: 'Token expired — please reconnect' });
    }
  }

  const now    = Date.now();
  const dayAgo = now - 86_400_000;
  const at     = tokens.access_token;

  try {
    // Fire all requests in parallel; HRV is optional
    const [sleepData, hrAgg, actAgg, hrvAgg] = await Promise.all([
      fitGet(
        `/sessions?startTime=${new Date(dayAgo).toISOString()}&endTime=${new Date(now).toISOString()}&activityType=72`,
        at,
      ),
      fitAggregate({
        aggregateBy:     [{ dataTypeName: 'com.google.heart_rate.bpm' }],
        bucketByTime:    { durationMillis: 86_400_000 },
        startTimeMillis: dayAgo,
        endTimeMillis:   now,
      }, at),
      fitAggregate({
        aggregateBy: [
          { dataTypeName: 'com.google.step_count.delta'  },
          { dataTypeName: 'com.google.calories.expended' },
        ],
        bucketByTime:    { durationMillis: 86_400_000 },
        startTimeMillis: dayAgo,
        endTimeMillis:   now,
      }, at),
      fitAggregate({
        aggregateBy:     [{ dataTypeName: 'com.google.heart_rate.variability.rmssd' }],
        bucketByTime:    { durationMillis: 86_400_000 },
        startTimeMillis: dayAgo,
        endTimeMillis:   now,
      }, at).catch(() => null),
    ]);

    // ── Sleep ─────────────────────────────────────────────────────────────────
    const sessions = (sleepData.session || []).filter(
      s => s.activityType === '72' || s.activityType === 72,
    );
    // Pick the longest session (main sleep, not naps)
    const main = sessions.reduce(
      (best, s) => {
        const dur = parseInt(s.endTimeMillis) - parseInt(s.startTimeMillis);
        const bDur = best ? parseInt(best.endTimeMillis) - parseInt(best.startTimeMillis) : 0;
        return dur > bDur ? s : best;
      },
      null,
    );

    const sleepMs    = main ? parseInt(main.endTimeMillis) - parseInt(main.startTimeMillis) : 0;
    const sleepHours = parseFloat((sleepMs / 3_600_000).toFixed(1));
    // Google Fit gives no efficiency field — use sleep hours vs target as proxy
    const sleepPerf  = Math.min(100, Math.round((sleepHours / SLEEP_TARGET) * 100));
    const bedtime    = main ? fmtMs(parseInt(main.startTimeMillis)) : '—';
    const wakeTime   = main ? fmtMs(parseInt(main.endTimeMillis))   : '—';

    // ── Heart rate (min = resting HR proxy) ──────────────────────────────────
    const rhr = parseFpMin(hrAgg.bucket);

    // ── HRV ──────────────────────────────────────────────────────────────────
    const hrv = hrvAgg ? parseFpAvg(hrvAgg.bucket) : 0;

    // ── Steps + calories ──────────────────────────────────────────────────────
    const steps    = parseIntSum(actAgg.bucket);
    const calories = parseFpSum(actAgg.bucket);

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

    // ── Sleep debt ────────────────────────────────────────────────────────────
    const sleepDebt = parseFloat(Math.max(0, SLEEP_TARGET - sleepHours).toFixed(1));

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
      sleepDebt,
      syncedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ connected: true, error: err.message });
  }
}
