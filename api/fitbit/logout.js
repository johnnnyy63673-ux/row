// api/fitbit/logout.js
// Deletes stored Fitbit tokens from Supabase and redirects back to health page.

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/app_state?key=eq.google_health_tokens`, {
        method:  'DELETE',
        headers: {
          'apikey':        supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      });
    } catch {}
  }

  return res.redirect(302, '/health.html?fb_disconnected=1');
}
