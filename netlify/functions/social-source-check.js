// social-source-check.js — weekly "is this Instagram post still up?" check
// (IG Social Ingest spec, Phase 1). Scheduled Mondays 08:00 UTC in netlify.toml.
// See "Instagram Social Ingest" in CLAUDE.md.
//
// For Instagram posts from the last 90 days that produced an approved sale:
//   Method A: GET /{ig_media_id}?fields=id with the system user token.
//             Graph usually refuses this for media owned by another account
//             (error 100, "does not exist or missing permissions"), so a
//             failure here proves nothing on its own.
//   Method B: GET /instagram_oembed?url={permalink} with the app token
//             (META_APP_ID|META_APP_SECRET). Needs the "oEmbed Read" feature.
// A post is marked deleted (social_posts.source_deleted_at) only when method B
// says it doesn't exist. Anything else counts as unknown and is retried next week.
//
// Approved social sales live in social_sales (not show_floor_transactions,
// decided 2026-11-01), and one social_sales row can merge several posts. How a
// deleted post updates that row is left for Phase 2, so this only marks the post.
//
// The health row's detail records which method answered, so CLAUDE.md can be
// updated with the one that works on the live token.

const P = require('../lib/social-pipeline');
const G = require('../lib/meta-graph');

const INTEGRATION = 'ig_source_check';
const WINDOW_DAYS = 90;
const MAX_POSTS = 60;
const TIME_BUDGET_MS = 22000;
const APPROVED = ['approved', 'approved_offfloor', 'auto_approved'];

exports.handler = async () => {
  const db = P.getDb();
  if (!db) { console.error('[ig-source-check] no service key'); return { statusCode: 503 }; }
  const started = Date.now();
  const stats = { checked: 0, present_media_id: 0, present_oembed: 0, deleted: 0, unknown: 0, oembed_unavailable: 0 };
  try {
    const posts = await duePosts(db);
    for (const post of posts) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const verdict = await checkPost(post);
      stats.checked++;
      stats[verdict.outcome]++;
      if (verdict.oembedUnavailable) stats.oembed_unavailable++;
      const now = new Date().toISOString();
      await db.from('social_posts').update({
        source_checked_at: now,
        ...(verdict.outcome === 'deleted' ? { source_deleted_at: now } : {}),
        updated_at: now,
      }).eq('id', post.id);
      if (verdict.outcome === 'deleted') console.log(`[ig-source-check] post ${post.id} is gone from Instagram`);
    }
    await G.recordHealth(db, 'ok', stats, INTEGRATION);
    console.log('[ig-source-check]', JSON.stringify(stats));
    return { statusCode: 200 };
  } catch (err) {
    const status = G.healthStatusFor(err);
    console.error(`[ig-source-check] stopped (${status}):`, G.scrub(err.message));
    await G.recordHealth(db, status, { message: err.message, ...stats }, INTEGRATION);
    return { statusCode: 500 };
  }
};

async function duePosts(db) {
  const since = P.addDays(new Date(), -WINDOW_DAYS).toISOString();
  const { data: exts, error } = await db.from('social_extractions').select('post_id').in('status', APPROVED).gte('created_at', since);
  if (error) throw new Error(`extractions query failed: ${error.message}`);
  const ids = [...new Set((exts || []).map(e => e.post_id))];
  if (!ids.length) return [];
  const { data: posts, error: pErr } = await db.from('social_posts')
    .select('id, ig_media_id, permalink, posted_at, source_checked_at')
    .in('id', ids.slice(0, 500)).not('ig_media_id', 'is', null).is('source_deleted_at', null)
    .order('source_checked_at', { ascending: true, nullsFirst: true }).limit(MAX_POSTS);
  if (pErr) throw new Error(`posts query failed: ${pErr.message}`);
  return posts || [];
}

// { outcome: 'present_media_id' | 'present_oembed' | 'deleted' | 'unknown', oembedUnavailable? }
async function checkPost(post) {
  try {
    const r = await G.graphGet(post.ig_media_id, { fields: 'id' });
    if (r?.id) return { outcome: 'present_media_id' };
  } catch (err) {
    if (err instanceof G.TokenError || err instanceof G.RateLimitError) throw err;  // stop the run
  }

  const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
  if (!post.permalink || !appId || !secret) return { outcome: 'unknown', oembedUnavailable: true };
  try {
    const r = await G.graphGet('instagram_oembed', { url: post.permalink, fields: 'author_name' }, { accessToken: `${appId}|${secret}` });
    return r ? { outcome: 'present_oembed' } : { outcome: 'unknown' };
  } catch (err) {
    if (err instanceof G.RateLimitError) throw err;
    if (err instanceof G.TokenError || err instanceof G.PermissionError) return { outcome: 'unknown', oembedUnavailable: true };
    // oEmbed answers a removed or private post with code 24 or 100 ("does not exist").
    if (err.code === 24 || (err.code === 100 && /exist|not found|private/i.test(err.message))) return { outcome: 'deleted' };
    return { outcome: 'unknown' };
  }
}

exports._internal = { checkPost, duePosts };
