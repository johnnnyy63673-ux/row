// api/fitbit/data.js
// Fetches health metrics from the Google Fitness REST API using stored
// OAuth tokens. Refreshes the access token automatically if expired.
// Returns: { connected, recovery, hrv, rhr, sleepHours, sleepPerf,
//            sleepTargetHours, bedtime, wakeTime, strain, calories,
//            steps, sleepDebt, syncedAt }

const TOKEN_KEY    = 'google_health_tokens';
const FIT_BASE     = 'https://www.googleapis.com/fitness/v1/users/me';
const SLEEP_TARGET = 8; // hours

// ── Supabase helpers ────────────────────────────────────────────────────────

async function supaGet(url, key) {
  const res = await fetch(url, {
    headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
  });
  return res.json();
}

async function supaUpsert(url, key, payload) {
  await fetch(url, {
    method:  'POST',
    headers: {
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
}

async function getTokens(supabaseUrl, supabaseKey) {
  const rows = await supaGet(
    `${supabaseUrl}/rest/v1/app_state?key=eq.${TOKEN_KEY}&select=data`,
    supabaseKey,
  );
  return (Array.isArray(rows) && rows[0] && rows[0].data) || null;
}

async function saveTokens(supabaseUrl, supabaseKey, tokens) {
  await supaUpsert(`${supabaseUrl}/rest/v1/app_state`, supabaseKey, {
    key:        TOKEN_KEY,
    data:       tokens,
    updated_at: new Date().toISOString(),
  });
}

// ── Token refresh ────────────────────────────────────────────────────────────

async function refreshAccessToken(tokens) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id:     process.env.GOOGLE_HEALTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_HEALTH_CLIENT_SECRET,
      grant_type:    'refresh_token',
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

// ── Google Fitness API helpers ───────────────────────────────────────────────

async function fitGet(path, accessToken) {
  const res = await fetch(`${FIT_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Fitness GET ${path} → ${res.status}`);
  return res.json();
}

async function fitAggregate(body, accessToken) {
  const res = await fetch(`${FIT_BASE}/dataset:aggregate`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Fitness aggregate → ${res.status}`);
  return res.json();
}

// ── Data parsing helpers ─────────────────────────────────────────────────────

function parseFpMin(bucket) {
  let min = null;
  for (const b of (bucket || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          const n = v.fpVal;
          if (n && n > 20 && n < 250) min = (min === null ? n : Math.min(min, n));
        }
      }
    }
  }
  return min ? Math.round(min) : 0;
}

function parseFpAvg(bucket) {
  let sum = 0, count = 0;
  for (const b of (bucket || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          if (v.fpVal) { sum += v.fpVal; count++; }
        }
      }
    }
  }
  return count ? Math.round(sum / count) : 0;
}

function parseIntSum(bucket) {
  let total = 0;
  for (const b of (bucket || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          total += (v.intVal || 0);
        }
      }
    }
  }
  return total;
}

function parseFpSum(bucket) {
  let total = 0;
  for (const b of (bucket || [])) {
    for (const ds of (b.dataset || [])) {
      for (const pt of (ds.point || [])) {
        for (const v of (pt.value || [])) {
          total += (v.fpVal || 0);
        }
      }
    }
  }
  return Math.round(total);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Main handler ─────────────────────────────────────────────────────────────

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
      return res.status(401).json({ connected: false, error: 'Token expired' });
    }
  }

  const now     = Date.now();
  const dayAgo  = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;
  const at      = tokens.access_token;

  try {
    // ── Sleep ────────────────────────────────────────────────────────────────
    const sleepRes  = await fitGet(
      `/sessions?startTime=${new Date(dayAgo).toISOString()}&endTime=${new Date(now).toISOString()}&activityType=72`,
      at,
    );
    const sessions  = (sleepRes.session || []).filter(s => s.activityType === '72' || s.activityType === 72);
    let sleepMs = 0, bedtime = '—', wakeTime = '—';
    if (sessions.length > 0) {
      // Use the longest sleep session (not naps)
      const main = sessions.reduce((a, b) =>
        (parseInt(b.endTimeMillis) - parseInt(b.startTimeMillis)) >
        (parseInt(a.endTimeMillis) - parseInt(a.startTimeMillis)) ? b : a
      );
      sleepMs  = parseInt(main.endTimeMillis) - parseInt(main.startTimeMillis);
      bedtime  = fmtTime(parseInt(main.startTimeMillis));
      wakeTime = fmtTime(parseInt(main.endTimeMillis));
    }
    const sleepHours = parseFloat((sleepMs / 3_600_000).toFixed(1));
    const sleepPerf  = Math.min(100, Math.round(sleepHours / SLEEP_TARGET * 100));

    // ── Weekly sleep debt ────────────────────────────────────────────────────
    const weekSleepRes = await fitGet(
      `/sessions?startTime=${new Date(weekAgo).toISOString()}&endTime=${new Date(now).toISOString()}&activityType=72`,
      at,
    );
    const weekSessions = (weekSleepRes.session || []).filter(s => s.activityType === '72' || s.activityType === 72);
    const weekSleepHrs = weekSessions.reduce(
      (s, sess) => s + (parseInt(sess.endTimeMillis) - parseInt(sess.startTimeMillis)) / 3_600_000,
      0,
    );
    const sleepDebt = parseFloat(Math.max(0, SLEEP_TARGET * 7 - weekSleepHrs).toFixed(1));

    // ── Heart rate (resting = daily minimum) ────────────────────────────────
    const hrAgg = await fitAggregate({
      aggregateBy:   [{ dataTypeName: 'com.google.heart_rate.bpm' }],
      bucketByTime:  { durationMillis: 86_400_000 },
      startTimeMillis: dayAgo,
      endTimeMillis:   now,
    }, at);
    const rhr = parseFpMin(hrAgg.bucket);

    // ── HRV ─────────────────────────────────────────────────────────────────
    let hrv = 0;
    try {
      const hrvAgg = await fitAggregate({
        aggregateBy:   [{ dataTypeName: 'com.google.heart_rate.variability.rmssd' }],
        bucketByTime:  { durationMillis: 86_400_000 },
        startTimeMillis: dayAgo,
        endTimeMillis:   now,
      }, at);
      hrv = parseFpAvg(hrvAgg.bucket);
    } catch {}

    // ── Steps + calories ─────────────────────────────────────────────────────
    const actAgg = await fitAggregate({
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
      ],
      bucketByTime:  { durationMillis: 86_400_000 },
      startTimeMillis: dayAgo,
      endTimeMillis:   now,
    }, at);
    const steps    = parseIntSum(actAgg.bucket);
    const calories = parseFpSum(actAgg.bucket);

    // ── Derived scores ───────────────────────────────────────────────────────
    // Recovery (0-100): HRV-weighted if available, otherwise sleep-only
    let recovery;
    if (hrv > 0) {
      const hrvScore = Math.min(100, Math.max(0, Math.round((hrv - 20) / 60 * 100)));
      recovery = Math.round(sleepPerf * 0.4 + hrvScore * 0.6);
    } else {
      recovery = sleepPerf;
    }

    // Strain (0-21 WHOOP scale approximation from calories)
    const strain = parseFloat(Math.min(21, calories / 100).toFixed(1));

    return res.status(200).json({
      connected:        true,
      recovery:         Math.min(100, Math.max(0, recovery)),
      hrv:              hrv || 0,
      rhr:              rhr || 0,
      sleepHours,
      sleepPerf,
      sleepTargetHours: SLEEP_TARGET,
      bedtime,
      wakeTime,
      strain,
      calories,
      steps,
      sleepDebt,
      weeklyAvgSleep:   parseFloat((weekSleepHrs / Math.max(1, weekSessions.length)).toFixed(1)),
      syncedAt:         new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ connected: true, error: err.message });
  }
}
