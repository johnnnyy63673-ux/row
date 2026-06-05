// api/fitbit/callback.js
// Handles the Fitbit OAuth2 callback: exchanges the authorization code for
// access + refresh tokens and stores them in Supabase.
// Fitbit token exchange uses HTTP Basic Auth (client_id:client_secret).

const REDIRECT_URI = 'https://row-zeta.vercel.app/api/fitbit/callback';
const TOKEN_KEY    = 'google_health_tokens'; // reuse existing Supabase row key

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

  const clientId     = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.redirect(302, '/health.html?fb_error=credentials_not_configured');
  }

  // Fitbit requires Basic Auth for token exchange
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let tokenRes, tokens;
  try {
    tokenRes = await fetch('https://api.fitbit.com/oauth2/token', {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        grant_type:   'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });
    tokens = await tokenRes.json();
  } catch (err) {
    return res.redirect(302, '/health.html?fb_error=fetch_failed');
  }

  if (!tokenRes.ok || tokens.errors) {
    const detail = tokens.errors ? tokens.errors[0].message : tokenRes.status;
    return res.redirect(302, '/health.html?fb_error=' + encodeURIComponent(detail));
  }

  const stored = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    user_id:       tokens.user_id,
    expires_at:    Date.now() + (tokens.expires_in || 28800) * 1000,
  };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    try { await storeTokens(supabaseUrl, supabaseKey, stored); } catch {}
  }

  return res.redirect(302, '/health.html?fb_connected=1');
}
