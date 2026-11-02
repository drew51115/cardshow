// Netlify Scheduled Function: gtcr-daily-recheck
// Runs hourly (see netlify.toml). Asks gtcr-trust-check.js to re-check the
// next batch of unsold graded cards whose last GTCR Trust Check is over 20h
// old, so every card is re-checked about once a day and the buyer
// "✓ GTCR CLEAR" badge (7-day max age) doesn't lapse.
//
// The Trust Check itself stays in gtcr-trust-check.js, the only function that
// holds GTCR_READ_API_KEY. This function only holds SUPABASE_SERVICE_KEY and
// sends a token derived from it (sha256), which gtcr-trust-check.js derives
// the same way. Each call does up to ~8s of lookups; this keeps calling while
// cards remain, within its own time limit.
//
// Scheduled functions only run on the published production deploy.

const crypto = require('crypto');

const RUN_BUDGET_MS = 24000;
const MAX_CALLS = 3;

exports.handler = async () => {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const base = process.env.URL; // set by Netlify to the site's main URL
  if (!key || !base) {
    console.warn('[gtcr-daily-recheck] SUPABASE_SERVICE_KEY / URL not set, skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }
  const token = crypto.createHash('sha256').update('gtcr-daily-recheck:' + key).digest('hex');
  const started = Date.now();
  const totals = { checked: 0, clean: 0, flagged: 0, failed: 0, calls: 0 };

  for (let i = 0; i < MAX_CALLS && Date.now() - started < RUN_BUDGET_MS - 10000; i++) {
    let body;
    try {
      const res = await fetch(`${base}/.netlify/functions/gtcr-trust-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cardshow-cron': token },
        body: JSON.stringify({ action: 'daily_recheck' }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        console.warn('[gtcr-daily-recheck] call failed:', res.status, body.error || '');
        break;
      }
    } catch (err) {
      console.warn('[gtcr-daily-recheck] call failed:', err.message);
      break;
    }
    totals.calls++;
    for (const k of ['checked', 'clean', 'flagged', 'failed']) totals[k] += body[k] || 0;
    if (body.auth_error || !body.remaining || !(body.checked + body.failed)) break;
  }

  console.log('[gtcr-daily-recheck]', JSON.stringify(totals));
  return { statusCode: 200, body: JSON.stringify(totals) };
};
