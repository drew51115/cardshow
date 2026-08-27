// Netlify Scheduled Function: expire-trade-posts
// Runs hourly (see netlify.toml). Calls the expire_stale_trade_posts()
// Postgres RPC, which flips trade_posts.status to 'expired' for any
// open/matched post whose show's ends_at was more than 1 day ago.
// Rows are never deleted — this only hides posts from the live board.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY (already set for
// comp-lookup.js / trading-card-lookup.js's cache writes — reused here,
// no new secret needed). service_role is required because
// expire_stale_trade_posts() is locked to that role only.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.warn('[expire-trade-posts] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const db = createClient(url, key);

  const { data, error } = await db.rpc('expire_stale_trade_posts');

  if (error) {
    console.error('[expire-trade-posts] RPC failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  console.log(`[expire-trade-posts] expired ${data} post(s)`);
  return { statusCode: 200, body: JSON.stringify({ expired: data }) };
};
