// api/fitbit/callback.js
// Handles the Google Health OAuth2 callback: exchanges the authorization code
// for access + refresh tokens and stores them in Supabase.

const REDIRECT_URI = 'https://row-zeta.vercel.app/api/fitbit/callback';
const TOKEN_KEY    = 'google_health_tokens';

async function storeTokens(supabaseUrl, supabaseKey, tokens) {
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

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(302, '/health.html?fb_error=' + encodeURIComponent(error || 'no_code'));
  }

  const clientId     = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.redirect(302, '/health.html?fb_error=credentials_not_configured');
  }

  let tokenRes, tokens;
  try {
    tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await tokenRes.json();
  } catch (err) {
    return res.redirect(302, '/health.html?fb_error=fetch_failed');
  }

  if (!tokenRes.ok || tokens.error) {
    return res.redirect(302, '/health.html?fb_error=' + encodeURIComponent(tokens.error || tokenRes.status));
  }

  const stored = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
  };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    try { await storeTokens(supabaseUrl, supabaseKey, stored); } catch {}
  }

  return res.redirect(302, '/health.html?fb_connected=1');
}
