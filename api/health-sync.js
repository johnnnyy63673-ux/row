// api/health-sync.js
// Vercel serverless function — receives Apple Health data from an iPhone
// Shortcut and upserts it into Supabase under key 'apple_health_v1'.
//
// Required environment variables (set in Vercel project settings):
//   SUPABASE_URL         — e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY — service-role key (preferred) or anon key
//   HEALTH_SYNC_SECRET   — any random string; sent as x-health-secret header by the Shortcut

export default async function handler(req, res) {
  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth — require the shared secret so random callers can't write your data
  const incoming = req.headers['x-health-secret'] || '';
  const secret   = process.env.HEALTH_SYNC_SECRET  || '';
  if (!secret || incoming !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  // Parse body (Vercel parses JSON automatically when Content-Type is application/json)
  const body = req.body || {};
  const { sleepDuration, sleepScore, steps, calories, restingHeartRate, date, sleepStages } = body;

  // Basic validation
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }

  const payload = {
    sleepScore:        sleepScore        != null ? Number(sleepScore)        : null,
    sleepDuration:     sleepDuration     || null,
    steps:             steps             != null ? Number(steps)             : null,
    calories:          calories          != null ? Number(calories)          : null,
    restingHeartRate:  restingHeartRate  != null ? Number(restingHeartRate)  : null,
    date:              String(date),
    sleepStages:       sleepStages       || null,
    syncedAt:          new Date().toISOString(),
  };

  // Upsert into Supabase app_state table via REST API (no SDK needed)
  const endpoint = supabaseUrl.replace(/\/$/, '') + '/rest/v1/app_state';
  let supaRes;
  try {
    supaRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey':        supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        key:        'apple_health_v1',
        data:       payload,
        updated_at: payload.syncedAt,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Supabase request failed', detail: err.message });
  }

  if (!supaRes.ok) {
    const text = await supaRes.text().catch(() => '');
    return res.status(502).json({ error: 'Supabase error', status: supaRes.status, detail: text });
  }

  return res.status(200).json({ ok: true, date: payload.date, syncedAt: payload.syncedAt });
}
