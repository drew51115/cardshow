// Netlify Scheduled Function: refresh-show-statuses
// Runs hourly (see netlify.toml). Calls the refresh_show_statuses() Postgres
// RPC, which sets each show's status from its dates: Upcoming before the start
// date, Active (Live) through the end date, Past after it. app.html works the
// status out the same way when it loads shows; this keeps the stored value
// right for show.html and anything else that reads shows.status.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (same as expire-trade-posts.js).

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.warn('[refresh-show-statuses] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const db = createClient(url, key);
  const { data, error } = await db.rpc('refresh_show_statuses');

  if (error) {
    console.error('[refresh-show-statuses] RPC failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  console.log(`[refresh-show-statuses] updated ${data} show(s)`);
  return { statusCode: 200, body: JSON.stringify({ updated: data }) };
};
