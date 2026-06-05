// api/fitbit/login.js
// Redirects to Google Health OAuth2 consent screen.
// Required env vars: GOOGLE_HEALTH_CLIENT_ID

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'GOOGLE_HEALTH_CLIENT_ID not configured' });
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  'https://row-zeta.vercel.app/api/fitbit/callback',
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/fitness.sleep.read',
      'https://www.googleapis.com/auth/fitness.heart_rate.read',
      'https://www.googleapis.com/auth/fitness.body.read',
      'https://www.googleapis.com/auth/fitness.activity.read',
    ].join(' '),
    access_type: 'offline',
    prompt:      'consent',
  });

  return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
