// api/fitbit/callback.js
// Receives the OAuth2 authorization code from Google, exchanges it for
// access + refresh tokens, stores them in Supabase, then redirects back.

const REDIRECT_URI  = 'https://row-zeta.vercel.app/api/fitbit/callback';
const TOKEN_KEY     = 'google_health_tokens';

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
    return res.redirect(302, '/health.html?fb_error=' + (error || 'no_code'));
  }

  const clientId     = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;

  // Exchange authorization code for tokens
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
    return res.redirect(302, '/health.html?fb_error=token_exchange_failed');
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
