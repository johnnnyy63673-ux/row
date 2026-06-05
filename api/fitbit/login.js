// api/fitbit/login.js
// Redirects to the Fitbit OAuth2 consent screen.
// Required env vars: FITBIT_CLIENT_ID

export default function handler(req, res) {
  const clientId = process.env.FITBIT_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'FITBIT_CLIENT_ID not configured' });
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  'https://row-zeta.vercel.app/api/fitbit/callback',
    scope:         'sleep heartrate activity profile',
    expires_in:    '604800', // 7-day token lifetime
  });

  return res.redirect(302, `https://www.fitbit.com/oauth2/authorize?${params}`);
}
